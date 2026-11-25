import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { connectedConnectionsFn, getConnectionFn, listConnectionsFn } from '@/api/connections.functions'
import { authStateFn } from '@/api/session.functions'
import { listTokensFn } from '@/api/tokens.functions'
import { updateInfoFn } from '@/api/update.functions'
import {
  allRelationsFn,
  countRowsFn,
  fetchRowsFn,
  lookupReferencesFn,
  listAllDatabasesFn,
  listDatabasesFn,
  listRoleDetailsFn,
  listRolesFn,
  listSchemasFn,
  objectDefinitionFn,
  relationDdlFn,
  relationDetailsFn,
  schemaObjectsFn,
  serverInfoFn,
  completionSchemaFn,
  databaseOverviewFn,
  databaseCreateOptionsFn,
  databaseHealthFn,
  rolePrivilegesFn,
} from '@/api/explorer.functions'
import type { Filter, Sort } from './types'

export const keys = {
  connections: () => ['connections'] as const,
  connection: (id: string) => ['connections', id] as const,
  /** ids of the open connections; under the connections prefix, so it refreshes with them */
  connected: () => ['connections', '~connected'] as const,
  /** prefix for everything that belongs to one database */
  db: (id: string, db: string) => ['c', id, db] as const,
  databases: (id: string) => ['c', id, '~databases'] as const,
  roles: (id: string) => ['c', id, '~roles'] as const,
  relation: (id: string, db: string, schema: string, table: string) => ['c', id, db, 'rel', schema, table] as const,
}

export const connectionsQuery = () =>
  queryOptions({
    queryKey: keys.connections(),
    queryFn: () => listConnectionsFn(),
    staleTime: 5_000,
  })

export const connectedConnectionsQuery = () =>
  queryOptions({
    queryKey: keys.connected(),
    queryFn: () => connectedConnectionsFn(),
    refetchInterval: 15_000,
    staleTime: 0,
  })

export const connectionQuery = (id: string) =>
  queryOptions({
    queryKey: keys.connection(id),
    queryFn: () => getConnectionFn({ data: { id } }),
  })

/** Sign-in state for the root route guard and the account page. */
export const authStateQuery = () =>
  queryOptions({
    queryKey: ['auth'] as const,
    queryFn: () => authStateFn(),
    staleTime: 30_000,
  })

/** The newest pow/view release. The server caches it, so the browser asks at most once an hour. */
export const updateInfoQuery = () =>
  queryOptions({
    queryKey: ['update-info'] as const,
    queryFn: () => updateInfoFn(),
    staleTime: 60 * 60 * 1000,
    retry: false,
  })

export const tokensQuery = () =>
  queryOptions({
    queryKey: ['tokens'] as const,
    queryFn: () => listTokensFn(),
  })

export const databasesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: keys.databases(connectionId),
    queryFn: () => listDatabasesFn({ data: { connectionId } }),
  })

/** Every database, templates and closed ones included (the Databases page). */
export const allDatabasesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: [...keys.databases(connectionId), 'all'],
    queryFn: () => listAllDatabasesFn({ data: { connectionId } }),
  })

/** What the New database dialog can offer on this server: version, encodings, locales, tablespaces. */
export const databaseCreateOptionsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: [...keys.databases(connectionId), 'create-options'],
    queryFn: () => databaseCreateOptionsFn({ data: { connectionId } }),
  })

/** Role names that can own a database. */
export const rolesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: keys.roles(connectionId),
    queryFn: () => listRolesFn({ data: { connectionId } }),
  })

/** Every role with its attributes, memberships and sessions (the Roles page and the role forms). */
export const roleDetailsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: [...keys.roles(connectionId), 'details'],
    queryFn: () => listRoleDetailsFn({ data: { connectionId } }),
  })

/** The privileges of one role in the open database: database switches and schema levels. */
export const rolePrivilegesQuery = (connectionId: string, database: string, role: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'role-privileges', role],
    queryFn: () => rolePrivilegesFn({ data: { connectionId, database, role } }),
  })

export const serverInfoQuery = (connectionId: string, database: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'server'],
    queryFn: () => serverInfoFn({ data: { connectionId, database } }),
  })

export const schemasQuery = (connectionId: string, database: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'schemas'],
    queryFn: () => listSchemasFn({ data: { connectionId, database } }),
  })

export const schemaObjectsQuery = (connectionId: string, database: string, schema: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'objects', schema],
    queryFn: () => schemaObjectsFn({ data: { connectionId, database, schema } }),
  })

export const allRelationsQuery = (connectionId: string, database: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'all-relations'],
    queryFn: () => allRelationsFn({ data: { connectionId, database } }),
  })

export const completionSchemaQuery = (connectionId: string, database: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'completion'],
    queryFn: () => completionSchemaFn({ data: { connectionId, database } }),
    staleTime: 5 * 60_000,
  })

export const relationDetailsQuery = (connectionId: string, database: string, schema: string, table: string) =>
  queryOptions({
    queryKey: [...keys.relation(connectionId, database, schema, table), 'details'],
    queryFn: () => relationDetailsFn({ data: { connectionId, database, schema, table } }),
  })

export const relationDdlQuery = (connectionId: string, database: string, schema: string, table: string) =>
  queryOptions({
    queryKey: [...keys.relation(connectionId, database, schema, table), 'ddl'],
    queryFn: () => relationDdlFn({ data: { connectionId, database, schema, table } }),
  })

export const definitionQuery = (connectionId: string, database: string, kind: 'function' | 'type', oid: number) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'definition', kind, oid],
    queryFn: () => objectDefinitionFn({ data: { connectionId, database, kind, oid } }),
  })

interface RowsParams {
  page: number
  pageSize: number
  sort: Sort[]
  filters: Filter[]
  where?: string
  search?: string
}

export const rowsQuery = (connectionId: string, database: string, schema: string, table: string, params: RowsParams) =>
  queryOptions({
    queryKey: [...keys.relation(connectionId, database, schema, table), 'rows', params],
    queryFn: () => fetchRowsFn({ data: { connectionId, database, schema, table, ...params } }),
    placeholderData: keepPreviousData,
    // fresh enough: saves and SQL that changes data invalidate this key, and a prefetch from a
    // link hover is not fetched again on mount
    staleTime: 5_000,
    retry: false,
  })

export const countQuery = (
  connectionId: string,
  database: string,
  schema: string,
  table: string,
  params: Pick<RowsParams, 'filters' | 'where' | 'search'>,
) =>
  queryOptions({
    queryKey: [...keys.relation(connectionId, database, schema, table), 'count', params],
    queryFn: () => countRowsFn({ data: { connectionId, database, schema, table, ...params } }),
    staleTime: 10_000,
    retry: false,
  })

export const overviewQuery = (connectionId: string, database: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'overview'],
    queryFn: () => databaseOverviewFn({ data: { connectionId, database } }),
  })

/** Statistics-based health checks of the database. Refetched at most every 30 seconds. */
export const healthQuery = (connectionId: string, database: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'health'],
    queryFn: () => databaseHealthFn({ data: { connectionId, database } }),
    staleTime: 30_000,
  })

/** Rows of a referenced table matching `search`, for picking a foreign key value. */
export const referenceQuery = (
  connectionId: string,
  database: string,
  fk: { schema: string; table: string; column: string },
  search: string,
) =>
  queryOptions({
    queryKey: [...keys.relation(connectionId, database, fk.schema, fk.table), 'lookup', fk.column, search],
    queryFn: () => lookupReferencesFn({ data: { connectionId, database, ...fk, search, limit: 20 } }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
