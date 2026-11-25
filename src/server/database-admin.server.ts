// Changing and dropping whole databases. The client sends the wanted state, never SQL: the
// server reads the current state itself and builds every statement with the ddl.ts builders.
import {
  alterDatabaseSql,
  createDatabaseProblem,
  createDatabaseSql,
  dropDatabaseSql,
  nameProblem,
  type DatabaseDraft,
} from '@/lib/ddl'
import type { ConnectionConfig, DatabaseAdminResult, DatabaseCreateDraft, PgErrorInfo } from '@/lib/types'
import { listDatabases, serverVersionNum } from './introspect.server'
import { closeDatabasePool, isPgError, pgErrorInfo, poolFor, query, toError } from './pool.server'
import { getConnection } from './store.server'

const DEFAULT_DATABASE_MESSAGE = "This is the connection's default database. Change the connection's database first."
const OTHER_SESSIONS_MESSAGE =
  'Other sessions are connected to this database. Turn on "Disconnect active sessions" or close them first.'

/**
 * The databases to run ALTER and DROP from, in the order to try them. The target is never
 * one of them: RENAME and DROP fail while a session is connected to the target.
 */
export function maintenanceCandidates(defaultDatabase: string, target: string): string[] {
  return [...new Set([defaultDatabase, 'postgres', 'template1'])].filter((name) => name !== target)
}

/** Maps SQLSTATE 55006 (other sessions connected) to a message the user can act on. */
export function friendlyDropError(info: PgErrorInfo): PgErrorInfo {
  return info.code === '55006' ? { ...info, message: OTHER_SESSIONS_MESSAGE } : info
}

/** Throws for a read-only connection. Shared with the role changes. */
export function refuseReadOnly(conn: ConnectionConfig): void {
  if (conn.readOnly) throw new Error('This connection is read-only.')
}

/** The first maintenance candidate that accepts a connection. */
async function maintenanceDatabase(conn: ConnectionConfig, target: string): Promise<string> {
  const candidates = maintenanceCandidates(conn.database, target)
  let failure: unknown
  for (const name of candidates) {
    try {
      await query(conn.id, name, 'SELECT 1')
      return name
    } catch (err) {
      failure = err
    }
  }
  throw new Error(`Could not connect to ${candidates.join(' or ')} to run this change. ${toError(failure).message}`)
}

/**
 * Runs the statements one by one on one client, from `database`, stopping at the first error.
 * No transaction: each statement commits on its own.
 */
export async function runStatements(
  connectionId: string,
  database: string,
  statements: string[],
): Promise<DatabaseAdminResult> {
  const { pool } = await poolFor(connectionId, database)
  const client = await pool.connect()
  let ran = 0
  let broken: Error | undefined
  try {
    for (const statement of statements) {
      try {
        await client.query(statement)
      } catch (err) {
        // A failure that is not a SQL error (network, for example) means the client is not reused.
        if (!isPgError(err)) broken = toError(err)
        return { ok: false, statements, ran, failedStatement: statement, error: pgErrorInfo(err) }
      }
      ran++
    }
    return { ok: true, statements, ran, failedStatement: null, error: null }
  } finally {
    client.release(broken)
  }
}

/**
 * Runs the statements in one transaction on one client of `database`. Either all of them commit
 * or none does: on the first error the transaction is rolled back, so `ran` is 0.
 */
export async function runTransaction(
  connectionId: string,
  database: string,
  statements: string[],
): Promise<DatabaseAdminResult> {
  const { pool } = await poolFor(connectionId, database)
  const client = await pool.connect()
  let broken: Error | undefined
  let failed = 'BEGIN'
  try {
    await client.query('BEGIN')
    for (const statement of statements) {
      failed = statement
      await client.query(statement)
    }
    failed = 'COMMIT'
    await client.query('COMMIT')
    return { ok: true, statements, ran: statements.length, failedStatement: null, error: null }
  } catch (err) {
    if (!isPgError(err)) broken = toError(err)
    await client.query('ROLLBACK').catch((rollbackErr) => {
      broken ??= toError(rollbackErr)
    })
    return { ok: false, statements, ran: 0, failedStatement: failed, error: pgErrorInfo(err) }
  } finally {
    client.release(broken)
  }
}

/**
 * Applies the wanted state to a database: owner, limits, comment, settings and name. Only what
 * differs from the current state runs. Throws on refusals; SQL errors come back in the result.
 */
export async function alterDatabase(
  connectionId: string,
  database: string,
  desired: DatabaseDraft,
): Promise<DatabaseAdminResult> {
  const conn = await getConnection(connectionId)
  refuseReadOnly(conn)
  const current = (await listDatabases(connectionId, { all: true })).find((d) => d.name === database)
  if (!current) throw new Error(`Database "${database}" was not found, or it cannot be changed.`)
  const problem = nameProblem(desired.name)
  if (problem) throw new Error(`Database name: ${problem}`)

  // The connection points at its default database by name. Renaming it, or closing it to new
  // sessions, would leave the connection unable to reach the server.
  const renames = desired.name.trim() !== database
  const closes = current.allowConnections && !desired.allowConnections
  if (database === conn.database && (renames || closes)) throw new Error(DEFAULT_DATABASE_MESSAGE)

  const statements = alterDatabaseSql(current, desired)
  if (statements.length === 0) return { ok: true, statements, ran: 0, failedStatement: null, error: null }
  // RENAME needs no sessions on the old name, so our own idle pool for it must go first.
  if (renames) await closeDatabasePool(connectionId, database)
  const from = await maintenanceDatabase(conn, database)
  return runStatements(connectionId, from, statements)
}

/**
 * CREATE DATABASE from the maintenance database, with the options of the draft. A copied
 * database (not template0 or template1) must have no sessions, so our idle pools to it close
 * first. Throws on refusals and invalid input; SQL errors come back in the result.
 */
export async function createDatabase(connectionId: string, draft: DatabaseCreateDraft): Promise<DatabaseAdminResult> {
  const conn = await getConnection(connectionId)
  refuseReadOnly(conn)
  const versionNum = await serverVersionNum(connectionId)
  const takenNames = (await listDatabases(connectionId, { all: true })).map((d) => d.name)
  const problem = createDatabaseProblem(draft, { versionNum, takenNames })
  if (problem) throw new Error(problem)
  const statements = createDatabaseSql(draft, versionNum)

  // Without a TEMPLATE clause PostgreSQL copies template1, so that is the database to keep free.
  const template = draft.template?.trim() || null
  const source = template ?? 'template1'
  if (template && template !== 'template0' && template !== 'template1') {
    await closeDatabasePool(connectionId, template)
  }
  const from = await maintenanceDatabase(conn, source)
  const result = await runStatements(connectionId, from, statements)
  // The first statement is the CREATE: SQLSTATE 55006 there means the source has sessions.
  if (result.ran === 0 && result.error?.code === '55006') {
    const message = `Someone is connected to ${source}, so it cannot be copied right now. Close those sessions and try again.`
    return { ...result, error: { ...result.error, message } }
  }
  return result
}

/**
 * DROP DATABASE from the maintenance database. With `force`, PostgreSQL ends the sessions
 * connected to it. Throws on refusals; SQL errors come back in the result.
 */
export async function dropDatabase(
  connectionId: string,
  database: string,
  force: boolean,
): Promise<DatabaseAdminResult> {
  const conn = await getConnection(connectionId)
  refuseReadOnly(conn)
  if (database === conn.database) throw new Error(DEFAULT_DATABASE_MESSAGE)
  const statements = [dropDatabaseSql(database, force)]
  await closeDatabasePool(connectionId, database)
  const from = await maintenanceDatabase(conn, database)
  const result = await runStatements(connectionId, from, statements)
  return { ...result, error: result.error && friendlyDropError(result.error) }
}
