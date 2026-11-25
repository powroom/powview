import pg from 'pg'
import type { ConnectionConfig, PgErrorInfo, SslMode } from '@/lib/types'
import { redactSecrets } from '@/lib/redact'
import { getConnection, resolvePassword } from './store.server'
import { closeTunnel, ensureTunnel, tunnelOpen, type TunnelEndpoint } from './tunnel.server'

/** Type parsers that keep values exactly as PostgreSQL prints them (lossless), except booleans. */
export const rawTypes = {
  getTypeParser(oid: number) {
    if (oid === 16) return (value: string) => value === 't'
    return (value: string) => value
  },
}

/**
 * TLS settings. Through a tunnel the socket goes to 127.0.0.1, so the certificate is checked
 * against the real host name (servername) instead.
 */
function sslConfig(mode: SslMode, servername?: string): pg.ClientConfig['ssl'] {
  if (mode === 'disable') return false
  // "require" encrypts without checking the certificate; the other modes check it.
  return { rejectUnauthorized: mode !== 'require', ...(servername ? { servername } : {}) }
}

/** pg settings for a connection. With `endpoint` (an SSH tunnel) pg connects there instead of conn.host. */
export function clientConfig(conn: ConnectionConfig, database?: string, endpoint?: TunnelEndpoint): pg.ClientConfig {
  return {
    host: endpoint ? endpoint.host : conn.host,
    port: endpoint ? endpoint.port : conn.port,
    user: conn.user,
    password: resolvePassword(conn),
    database: database || conn.database,
    ssl: sslConfig(conn.ssl, endpoint ? conn.host : undefined),
    application_name: 'powview',
    connectionTimeoutMillis: 10_000,
    options: conn.readOnly ? '-c default_transaction_read_only=on' : undefined,
  }
}

/** pg settings for a connection, starting its SSH tunnel first when it has one. */
export async function connectConfig(conn: ConnectionConfig, database?: string): Promise<pg.ClientConfig> {
  if (!conn.ssh) return clientConfig(conn, database)
  return clientConfig(conn, database, await ensureTunnel(conn))
}

// Keep pools across dev-server module reloads.
const globalPools = globalThis as unknown as {
  __dbxPools?: Map<string, { pool: pg.Pool; fingerprint: string }>
}
const pools = (globalPools.__dbxPools ??= new Map())

/**
 * Logs errors from a client that is not owned by a pool, so an error while it is idle or
 * connecting cannot crash the process. Logs only the message, with secrets hidden.
 */
export function watchClient(client: pg.Client, label: string): void {
  client.on('error', (err) => {
    console.warn(`[powview] ${label}: connection error: ${redactSecrets(err.message)}`)
  })
}

function fingerprint(conn: ConnectionConfig, config: pg.ClientConfig): string {
  // Include the resolved password so a changed env var or stored password replaces the pool.
  // The endpoint and the SSH settings are included too: a new tunnel means a new local port.
  return JSON.stringify([
    conn.host,
    conn.port,
    conn.user,
    resolvePassword(conn),
    conn.ssl,
    conn.readOnly,
    config.host,
    config.port,
    conn.ssh ?? null,
  ])
}

/** The pool for one database of a connection. `config` comes from connectConfig. */
function getPool(conn: ConnectionConfig, database: string, config: pg.ClientConfig): pg.Pool {
  const key = `${conn.id}::${database}`
  const fp = fingerprint(conn, config)
  const existing = pools.get(key)
  if (existing && existing.fingerprint === fp) return existing.pool
  if (existing) {
    pools.delete(key)
    void existing.pool.end().catch(() => {})
  }
  const pool = new pg.Pool({
    ...config,
    max: 5,
    idleTimeoutMillis: 60_000,
  })
  // Every client the pool creates gets a logging error listener. pg-pool drops its own listener
  // while a client is checked out, so without this an error mid-query would crash the process.
  pool.on('connect', (client) => watchClient(client, `pool ${key}`))
  // Errors are reported by the listener above (idle and checked-out clients alike).
  pool.on('error', () => {})
  pools.set(key, { pool, fingerprint: fp })
  return pool
}

/** Closes the pools and the SSH tunnel of a connection. Called when it changes or is removed. */
export async function closePools(connectionId: string): Promise<void> {
  const closing: Promise<void>[] = []
  for (const [key, entry] of pools) {
    if (key.startsWith(`${connectionId}::`)) {
      pools.delete(key)
      closing.push(entry.pool.end().catch(() => {}))
    }
  }
  await Promise.all(closing)
  await closeTunnel(connectionId)
}

/** Closes the pool of one database of a connection. RENAME and DROP need the database to have no sessions. */
export async function closeDatabasePool(connectionId: string, database: string): Promise<void> {
  const key = `${connectionId}::${database}`
  const entry = pools.get(key)
  if (!entry) return
  pools.delete(key)
  await entry.pool.end().catch(() => {})
}

/** Ids of the connections with a checked-out database connection or an open SSH session. */
export function connectedIds(): string[] {
  const ids = new Set<string>()
  for (const [key, entry] of pools) {
    const id = key.slice(0, key.indexOf('::'))
    if (entry.pool.totalCount > 0 || tunnelOpen(id)) ids.add(id)
  }
  return [...ids]
}

/** The one way to get a pool for a connection. Every query path (UI, SQL editor, REST, MCP, introspection) comes through here. */
export async function poolFor(connectionId: string, database?: string) {
  const conn = await getConnection(connectionId)
  const db = database || conn.database
  const config = await connectConfig(conn, db)
  return { conn, pool: getPool(conn, db, config) }
}

/** Run a metadata query with default type parsing. */
export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  connectionId: string,
  database: string | undefined,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const { pool } = await poolFor(connectionId, database)
  try {
    const result = await pool.query<T>({ text, values, queryMode: 'extended' } as pg.QueryConfig)
    return result.rows
  } catch (err) {
    throw toError(err)
  }
}

export function isPgError(err: unknown): err is pg.DatabaseError {
  return err instanceof Error && 'severity' in err && 'code' in err
}

export function pgErrorInfo(err: unknown): PgErrorInfo {
  if (isPgError(err)) {
    return {
      message: err.message,
      code: err.code,
      detail: err.detail,
      hint: err.hint,
      where: err.where,
      severity: err.severity,
      position: err.position ? Number(err.position) - 1 : undefined,
      column: err.column || undefined,
      constraint: err.constraint || undefined,
    }
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return { message: friendlyNetworkError(err.message, code), code }
  }
  return { message: String(err) }
}

function friendlyNetworkError(message: string, code?: string): string {
  switch (code) {
    case 'ECONNREFUSED':
      return `Connection refused. Is PostgreSQL running, and can this machine reach it? (${message})`
    case 'ENOTFOUND':
      return `Host not found (${message})`
    case 'ETIMEDOUT':
      return `Connection timed out (${message})`
    default:
      return message
  }
}

/** Convert anything thrown by pg into a plain Error with a helpful message. */
export function toError(err: unknown): Error {
  const info = pgErrorInfo(err)
  const parts = [info.message]
  if (info.detail) parts.push(info.detail)
  if (info.hint) parts.push(`Hint: ${info.hint}`)
  return new Error(parts.join('\n'))
}
