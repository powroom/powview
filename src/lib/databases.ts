import type { ConnectionInfo, ServerInfo } from './types'

/** Why a new database cannot be created now (shown on a disabled button), or null. */
export function createDatabaseBlock(
  connection: Pick<ConnectionInfo, 'readOnly'> | undefined,
  server: Pick<ServerInfo, 'canCreateDatabase'> | undefined,
): string | null {
  if (connection?.readOnly) return 'This connection is read-only'
  if (server?.canCreateDatabase === false) return 'Your database user cannot create databases'
  return null
}
