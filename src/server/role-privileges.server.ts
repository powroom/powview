// What a role may do: database switches (connect, create, temporary) and schema levels (none, read,
// write). The client sends a draft, never SQL: the server reads the current state itself and builds
// the statements with the ddl.ts builders. Only explicit grants count, and PUBLIC is reported apart.
import { rolePrivilegesSql, schemaAccessLevel } from '@/lib/ddl'
import type { DatabaseAdminResult, RolePrivileges, RolePrivilegesDraft } from '@/lib/types'
import { refuseReadOnly, runTransaction } from './database-admin.server'
import { NOT_EXTENSION_MEMBER } from './introspect.server'
import { query } from './pool.server'
import { getConnection } from './store.server'

const OWN_USER_MESSAGE = 'This is the user pow/view connects as. Change its privileges from another connection.'
const SUPERUSER_MESSAGE = 'Superusers can already do everything; there is nothing to change.'

/**
 * Why a privilege change is refused, or null. `connectionUser` is the user the connection logs
 * in as: changing its own privileges could cut pow/view off from the database.
 */
export function privilegesRefusal(role: string, connectionUser: string, superuser: boolean): string | null {
  if (role === connectionUser) return OWN_USER_MESSAGE
  if (superuser) return SUPERUSER_MESSAGE
  return null
}

/**
 * True when the grantee (`$1::oid` for the role, `0` for PUBLIC) has one of `privileges` in the
 * object's ACL. A null ACL means the PostgreSQL defaults, as acldefault gives them for the owner.
 */
function hasGrant(acl: string, kind: string, owner: string, privileges: string[], grantee: string): string {
  const list = privileges.map((p) => `'${p}'`).join(', ')
  return `EXISTS (SELECT 1 FROM aclexplode(COALESCE(${acl}, acldefault('${kind}', ${owner}))) a
                   WHERE a.grantee = ${grantee} AND a.privilege_type IN (${list}))`
}

const ROLE_OID = '$1::oid'
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
const ALL_WRITE = ['INSERT', 'UPDATE', 'DELETE']

/** One row per database of the server. Only the database's own ACL matters here. */
const DATABASES_SQL = `SELECT d.datname AS name,
       ${hasGrant('d.datacl', 'd', 'd.datdba', ['CONNECT'], ROLE_OID)} AS connect,
       ${hasGrant('d.datacl', 'd', 'd.datdba', ['CREATE'], ROLE_OID)} AS create,
       ${hasGrant('d.datacl', 'd', 'd.datdba', ['TEMPORARY'], ROLE_OID)} AS temporary,
       ${hasGrant('d.datacl', 'd', 'd.datdba', ['CONNECT'], '0')} AS public_connect,
       ${hasGrant('d.datacl', 'd', 'd.datdba', ['TEMPORARY'], '0')} AS public_temporary
  FROM pg_database d
 ORDER BY d.datname`

/** The tables that count for a schema: not partitions, not extension members. */
const TABLES_OF_SCHEMA = `c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
  AND ${NOT_EXTENSION_MEMBER('c.oid', 'pg_class')}`

/**
 * One row per user schema of the open database. `future_grants` lists the privileges that the
 * default ACL gives the role on new tables, for tables that the current user creates.
 */
const SCHEMAS_SQL = `SELECT n.nspname AS name,
       ${hasGrant('n.nspacl', 'n', 'n.nspowner', ['USAGE'], ROLE_OID)} AS usage,
       (SELECT count(*)::int FROM pg_class c WHERE ${TABLES_OF_SCHEMA}) AS tables,
       (SELECT count(*)::int FROM pg_class c WHERE ${TABLES_OF_SCHEMA}
          AND ${hasGrant('c.relacl', 'r', 'c.relowner', ['SELECT'], ROLE_OID)}) AS can_read,
       (SELECT count(*)::int FROM pg_class c WHERE ${TABLES_OF_SCHEMA}
          AND ${hasGrant('c.relacl', 'r', 'c.relowner', ['INSERT'], ROLE_OID)}
          AND ${hasGrant('c.relacl', 'r', 'c.relowner', ['UPDATE'], ROLE_OID)}
          AND ${hasGrant('c.relacl', 'r', 'c.relowner', ['DELETE'], ROLE_OID)}) AS can_write,
       (SELECT count(*)::int FROM pg_class c WHERE ${TABLES_OF_SCHEMA}
          AND ${hasGrant('c.relacl', 'r', 'c.relowner', WRITE_PRIVILEGES, ROLE_OID)}) AS any_write,
       (SELECT coalesce(array_agg(DISTINCT a.privilege_type::text), '{}')
          FROM pg_default_acl d, aclexplode(d.defaclacl) a
         WHERE d.defaclnamespace = n.oid AND d.defaclobjtype = 'r'
           AND d.defaclrole = (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user)
           AND a.grantee = ${ROLE_OID}) AS future_grants
  FROM pg_namespace n
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_'
   AND ${NOT_EXTENSION_MEMBER('n.oid', 'pg_namespace')}
 ORDER BY n.nspname`

/** The privileges of a role. Database switches cover the whole server; schema levels cover `database`. Throws for an unknown role. */
export async function readRolePrivileges(
  connectionId: string,
  database: string,
  role: string,
): Promise<RolePrivileges> {
  const [found] = await query<{ oid: string; superuser: boolean; current_name: string }>(
    connectionId,
    undefined,
    `SELECT r.oid::text AS oid, r.rolsuper AS superuser, current_user::text AS current_name
       FROM pg_roles r WHERE r.rolname = $1`,
    [role],
  )
  if (!found) throw new Error(`Role "${role}" was not found.`)
  const [databases, schemas] = await Promise.all([
    query<{
      name: string
      connect: boolean
      create: boolean
      temporary: boolean
      public_connect: boolean
      public_temporary: boolean
    }>(connectionId, undefined, DATABASES_SQL, [found.oid]),
    query<{
      name: string
      usage: boolean
      tables: number
      can_read: number
      can_write: number
      any_write: number
      future_grants: string[]
    }>(connectionId, database, SCHEMAS_SQL, [found.oid]),
  ])
  return {
    role,
    superuser: found.superuser,
    currentUser: found.current_name,
    databases: databases.map((d) => ({
      name: d.name,
      connect: d.connect,
      create: d.create,
      temporary: d.temporary,
      publicConnect: d.public_connect,
      publicTemporary: d.public_temporary,
    })),
    schemas: schemas.map((s) => {
      const has = (privileges: string[]) => privileges.every((p) => s.future_grants.includes(p))
      const futureRead = has(['SELECT']) && !WRITE_PRIVILEGES.some((p) => s.future_grants.includes(p))
      const counts = {
        usage: s.usage,
        tables: s.tables,
        canRead: s.can_read,
        canWrite: s.can_write,
        anyWrite: s.any_write,
        futureRead,
        futureWrite: has(['SELECT', ...ALL_WRITE]),
        futureAnyWrite: WRITE_PRIVILEGES.some((p) => s.future_grants.includes(p)),
      }
      return { name: s.name, level: schemaAccessLevel(counts), ...counts }
    }),
  }
}

/**
 * Applies the draft to a role: only what differs from the current state runs, all in one
 * transaction on `database`. All or nothing: on an error everything is rolled back and `ran` is 0.
 * Throws on refusals (read-only, pow/view's own user, superuser) and for unknown databases or
 * schemas; SQL errors come back in the result.
 */
export async function applyRolePrivileges(
  connectionId: string,
  database: string,
  role: string,
  draft: RolePrivilegesDraft,
): Promise<DatabaseAdminResult> {
  const conn = await getConnection(connectionId)
  refuseReadOnly(conn)
  const current = await readRolePrivileges(connectionId, database, role)
  const refusal = privilegesRefusal(role, conn.user, current.superuser)
  if (refusal) throw new Error(refusal)
  const statements = rolePrivilegesSql(current, draft)
  if (statements.length === 0) return { ok: true, statements, ran: 0, failedStatement: null, error: null }
  return runTransaction(connectionId, database, statements)
}
