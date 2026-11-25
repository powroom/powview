// Creating, changing and dropping PostgreSQL roles (users and groups). The client sends the wanted
// state, never SQL: the server reads the current state itself and builds every statement with the
// ddl.ts builders. A password becomes a SCRAM verifier here; the plain text never reaches PostgreSQL.
import { alterRoleSql, createRoleSql, dropRoleSql, PASSWORD_MASK, roleProblem } from '@/lib/ddl'
import { quoteLiteral } from '@/lib/sql'
import type { PgErrorInfo, RoleAdminResult, RoleDraft, RoleInfo } from '@/lib/types'
import { refuseReadOnly, runStatements } from './database-admin.server'
import { listRoles, parseSettings } from './introspect.server'
import { query } from './pool.server'
import { scramSha256Verifier } from './scram.server'
import { getConnection } from './store.server'

const OWN_USER_MESSAGE = 'This is the user pow/view connects as. Change it from another connection.'
const DEPENDENT_OBJECTS_MESSAGE =
  'This role still owns objects or has privileges. Choose a role to take over its objects, or turn on "Remove its privileges".'

/**
 * Every role except the built-in pg_ roles, with its attributes, memberships, settings and open
 * sessions. `hasPassword` is known only to a superuser (pg_authid is not readable otherwise).
 */
export async function listRoleDetails(connectionId: string): Promise<RoleInfo[]> {
  const [me] = await query<{ is_super: boolean }>(
    connectionId,
    undefined,
    `SELECT rolsuper AS is_super FROM pg_roles WHERE rolname = current_user`,
  )
  // Checked in JavaScript, not with a CASE: PostgreSQL checks table privileges before it runs a
  // query, so a pg_authid reference in an unused branch would still fail for a non-superuser.
  const hasPassword = me?.is_super
    ? `EXISTS (SELECT 1 FROM pg_authid a WHERE a.oid = r.oid AND a.rolpassword IS NOT NULL)`
    : `NULL::boolean`
  const rows = await query<{
    name: string
    can_login: boolean
    superuser: boolean
    create_db: boolean
    create_role: boolean
    inherit: boolean
    replication: boolean
    bypass_rls: boolean
    connection_limit: number | null
    valid_until: string | null
    member_of: string[]
    members: string[]
    comment: string | null
    sessions: number
    settings: string[] | null
    is_current_user: boolean
    has_password: boolean | null
  }>(
    connectionId,
    undefined,
    `SELECT r.rolname AS name,
            r.rolcanlogin AS can_login,
            r.rolsuper AS superuser,
            r.rolcreatedb AS create_db,
            r.rolcreaterole AS create_role,
            r.rolinherit AS inherit,
            r.rolreplication AS replication,
            r.rolbypassrls AS bypass_rls,
            CASE WHEN r.rolconnlimit = -1 THEN NULL ELSE r.rolconnlimit END AS connection_limit,
            CASE WHEN r.rolvaliduntil IS NULL OR r.rolvaliduntil = 'infinity'::timestamptz THEN NULL
                 ELSE to_char(r.rolvaliduntil AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS valid_until,
            (SELECT coalesce(array_agg(g.rolname ORDER BY g.rolname)::text[], '{}')
               FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
            (SELECT coalesce(array_agg(u.rolname ORDER BY u.rolname)::text[], '{}')
               FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member WHERE m.roleid = r.oid) AS members,
            shobj_description(r.oid, 'pg_authid') AS comment,
            (SELECT count(*)::int FROM pg_stat_activity a WHERE a.usename = r.rolname) AS sessions,
            (SELECT s.setconfig FROM pg_db_role_setting s WHERE s.setrole = r.oid AND s.setdatabase = 0) AS settings,
            r.rolname = current_user AS is_current_user,
            ${hasPassword} AS has_password
       FROM pg_roles r
      WHERE r.rolname !~ '^pg_'
      ORDER BY r.rolname`,
  )
  return rows.map((r) => ({
    name: r.name,
    canLogin: r.can_login,
    superuser: r.superuser,
    createDb: r.create_db,
    createRole: r.create_role,
    inherit: r.inherit,
    replication: r.replication,
    bypassRls: r.bypass_rls,
    connectionLimit: r.connection_limit,
    validUntil: r.valid_until,
    memberOf: r.member_of,
    members: r.members,
    comment: r.comment,
    sessions: r.sessions,
    settings: parseSettings(r.settings),
    isCurrentUser: r.is_current_user,
    hasPassword: r.has_password,
  }))
}

/** The quoted SCRAM verifier for a typed password, or null when no password was given. */
function passwordLiteral(password: string | null): string | null {
  return password === null ? null : quoteLiteral(scramSha256Verifier(password))
}

/** Replaces the verifier literal with PASSWORD_MASK in every string of a result, so it is never returned. */
function hidePassword(result: RoleAdminResult, passwordSql: string | null): RoleAdminResult {
  if (passwordSql === null) return result
  const hide = (text: string) => text.split(passwordSql).join(PASSWORD_MASK)
  const error = result.error
    ? (Object.fromEntries(
        Object.entries(result.error).map(([key, value]) => [key, typeof value === 'string' ? hide(value) : value]),
      ) as PgErrorInfo)
    : null
  return {
    ...result,
    statements: result.statements.map(hide),
    failedStatement: result.failedStatement === null ? null : hide(result.failedStatement),
    error,
  }
}

/** The role names other than `name`, for the name check. */
function otherNames(roles: RoleInfo[], name: string): string[] {
  return roles.map((r) => r.name).filter((n) => n !== name)
}

/**
 * CREATE ROLE with the draft's attributes, memberships, comment and settings. Throws on refusals
 * and invalid input; SQL errors come back in the result.
 */
export async function createRole(connectionId: string, draft: RoleDraft): Promise<RoleAdminResult> {
  const conn = await getConnection(connectionId)
  refuseReadOnly(conn)
  const problem = roleProblem(draft, { taken: await listRoles(connectionId) })
  if (problem) throw new Error(problem)
  const passwordSql = passwordLiteral(draft.password)
  const statements = createRoleSql(draft, passwordSql)
  return hidePassword(await runStatements(connectionId, conn.database, statements), passwordSql)
}

/**
 * Applies the wanted state to a role: only what differs from the current state runs. Throws on
 * refusals and invalid input; SQL errors come back in the result.
 */
export async function alterRole(connectionId: string, name: string, draft: RoleDraft): Promise<RoleAdminResult> {
  const conn = await getConnection(connectionId)
  refuseReadOnly(conn)
  const roles = await listRoleDetails(connectionId)
  const current = roles.find((r) => r.name === name)
  if (!current) throw new Error(`Role "${name}" was not found, or it cannot be changed.`)

  // pow/view connects as this role. Renaming it or taking its login away would cut the connection.
  const ownUser = name === conn.user
  if (ownUser && (draft.name.trim() !== name || (current.canLogin && !draft.canLogin))) {
    throw new Error(OWN_USER_MESSAGE)
  }
  const problem = roleProblem(draft, { taken: otherNames(roles, name) })
  if (problem) throw new Error(problem)

  const passwordSql = passwordLiteral(draft.password)
  const statements = alterRoleSql(current, draft, passwordSql)
  if (statements.length === 0) return { ok: true, statements, ran: 0, failedStatement: null, error: null }
  return hidePassword(await runStatements(connectionId, conn.database, statements), passwordSql)
}

/**
 * DROP ROLE, optionally after REASSIGN OWNED BY (`reassignTo`) and DROP OWNED BY (`dropOwned`).
 * Those owned-object statements act only on the database they run in: this runs them on the
 * connection's default database, so objects in other databases still block the DROP ROLE.
 * Throws on refusals; SQL errors come back in the result.
 */
export async function dropRole(
  connectionId: string,
  name: string,
  options: { reassignTo: string | null; dropOwned: boolean },
): Promise<RoleAdminResult> {
  const conn = await getConnection(connectionId)
  refuseReadOnly(conn)
  if (name === conn.user) throw new Error(OWN_USER_MESSAGE)
  const roles = await listRoleDetails(connectionId)
  const current = roles.find((r) => r.name === name)
  if (!current) throw new Error(`Role "${name}" was not found, or it cannot be changed.`)
  if (current.sessions > 0) {
    const n = current.sessions
    throw new Error(
      n === 1
        ? '1 session is logged in as this role. End it first.'
        : `${n} sessions are logged in as this role. End them first.`,
    )
  }
  const reassignTo = options.reassignTo?.trim() || null
  if (reassignTo !== null && (reassignTo === name || !roles.some((r) => r.name === reassignTo))) {
    throw new Error('Choose another existing role to take over its objects.')
  }

  const result = await runStatements(connectionId, conn.database, dropRoleSql(name, reassignTo, options.dropOwned))
  if (result.error?.code === '2BP01') {
    return { ...result, error: { ...result.error, message: DEPENDENT_OBJECTS_MESSAGE } }
  }
  return result
}
