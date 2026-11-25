import { createServerFn } from '@tanstack/react-start'
import type {
  ApplyChangesResult,
  CountResult,
  DatabaseAdminResult,
  DatabaseCreateOptions,
  DatabaseInfo,
  ExecuteResult,
  ExplainResult,
  RelationDetails,
  RelationInfo,
  RoleAdminResult,
  RoleInfo,
  RolePrivileges,
  RowsResult,
  SchemaInfo,
  SchemaObjects,
  ServerInfo,
} from '@/lib/types'
import type { DatabaseHealth } from '@/server/health.server'
import { explorerValidators } from './validators'

export const serverInfoFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }): Promise<ServerInfo> => {
    const { getServerInfo } = await import('@/server/introspect.server')
    return getServerInfo(data.connectionId, data.database)
  })

export const listDatabasesFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().connectionOnly)
  .handler(async ({ data }): Promise<DatabaseInfo[]> => {
    const { listDatabases } = await import('@/server/introspect.server')
    return listDatabases(data.connectionId)
  })

/** Every database, including templates and closed ones (the Databases page). template0 is never listed. */
export const listAllDatabasesFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().connectionOnly)
  .handler(async ({ data }): Promise<DatabaseInfo[]> => {
    const { listDatabases } = await import('@/server/introspect.server')
    return listDatabases(data.connectionId, { all: true })
  })

/** The role names that can own a database. */
export const listRolesFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().connectionOnly)
  .handler(async ({ data }): Promise<string[]> => {
    const { listRoles } = await import('@/server/introspect.server')
    return listRoles(data.connectionId)
  })

/** Applies the wanted state (`desired`) to a database. The server builds the SQL itself. */
export const alterDatabaseFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().alterDatabase)
  .handler(async ({ data }): Promise<DatabaseAdminResult> => {
    const { alterDatabase } = await import('@/server/database-admin.server')
    return alterDatabase(data.connectionId, data.database, data.desired)
  })

export const dropDatabaseFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().dropDatabase)
  .handler(async ({ data }): Promise<DatabaseAdminResult> => {
    const { dropDatabase } = await import('@/server/database-admin.server')
    return dropDatabase(data.connectionId, data.database, data.force)
  })

/** Every role except the built-in pg_ roles, with its attributes, memberships and sessions (the Roles page). */
export const listRoleDetailsFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().connectionOnly)
  .handler(async ({ data }): Promise<RoleInfo[]> => {
    const { listRoleDetails } = await import('@/server/role-admin.server')
    return listRoleDetails(data.connectionId)
  })

/** Creates a role from the wanted state. The server builds the SQL and hashes the password itself. */
export const createRoleFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().createRole)
  .handler(async ({ data }): Promise<RoleAdminResult> => {
    const { createRole } = await import('@/server/role-admin.server')
    return createRole(data.connectionId, data.draft)
  })

/** Applies the wanted state to a role (`draft`). Only what changed runs. */
export const alterRoleFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().alterRole)
  .handler(async ({ data }): Promise<RoleAdminResult> => {
    const { alterRole } = await import('@/server/role-admin.server')
    return alterRole(data.connectionId, data.name, data.draft)
  })

export const dropRoleFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().dropRole)
  .handler(async ({ data }): Promise<RoleAdminResult> => {
    const { dropRole } = await import('@/server/role-admin.server')
    return dropRole(data.connectionId, data.name, { reassignTo: data.reassignTo, dropOwned: data.dropOwned })
  })

/** The privileges of a role: database switches, and schema levels in the open database. */
export const rolePrivilegesFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().rolePrivileges)
  .handler(async ({ data }): Promise<RolePrivileges> => {
    const { readRolePrivileges } = await import('@/server/role-privileges.server')
    return readRolePrivileges(data.connectionId, data.database, data.role)
  })

/** Applies a privilege draft to a role, in one transaction. Only what changed runs. */
export const applyRolePrivilegesFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().applyRolePrivileges)
  .handler(async ({ data }): Promise<DatabaseAdminResult> => {
    const { applyRolePrivileges } = await import('@/server/role-privileges.server')
    return applyRolePrivileges(data.connectionId, data.database, data.role, data.draft)
  })

/** The choices for the New database dialog, read from the connection's default database. */
export const databaseCreateOptionsFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().connectionOnly)
  .handler(async ({ data }): Promise<DatabaseCreateOptions> => {
    const { getDatabaseCreateOptions } = await import('@/server/introspect.server')
    return getDatabaseCreateOptions(data.connectionId)
  })

/** Creates a database from the wanted options. The server builds the SQL itself. */
export const createDatabaseFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().createDatabase)
  .handler(async ({ data }): Promise<DatabaseAdminResult> => {
    const { createDatabase } = await import('@/server/database-admin.server')
    return createDatabase(data.connectionId, data.draft)
  })

export const listSchemasFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }): Promise<SchemaInfo[]> => {
    const { listSchemas } = await import('@/server/introspect.server')
    return listSchemas(data.connectionId, data.database)
  })

export const schemaObjectsFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().schemaObjects)
  .handler(async ({ data }): Promise<SchemaObjects> => {
    const { listSchemaObjects } = await import('@/server/introspect.server')
    return listSchemaObjects(data.connectionId, data.database, data.schema)
  })

export const allRelationsFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }): Promise<RelationInfo[]> => {
    const { listAllRelations } = await import('@/server/introspect.server')
    return listAllRelations(data.connectionId, data.database)
  })

export const relationDetailsFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().relation)
  .handler(async ({ data }): Promise<RelationDetails> => {
    const { getRelationDetails } = await import('@/server/introspect.server')
    return getRelationDetails(data.connectionId, data.database, data.schema, data.table)
  })

export const relationDdlFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().relation)
  .handler(async ({ data }): Promise<string> => {
    const { getRelationDdl } = await import('@/server/introspect.server')
    return getRelationDdl(data.connectionId, data.database, data.schema, data.table)
  })

export const objectDefinitionFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().objectDefinition)
  .handler(async ({ data }): Promise<string> => {
    const { getFunctionDefinition, getTypeDefinition } = await import('@/server/introspect.server')
    return data.kind === 'function'
      ? getFunctionDefinition(data.connectionId, data.database, data.oid)
      : getTypeDefinition(data.connectionId, data.database, data.oid)
  })

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const fetchRowsFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().rowsRequest)
  .handler(async ({ data }): Promise<RowsResult> => {
    const { fetchRows } = await import('@/server/data.server')
    const { connectionId, database, ...req } = data
    return fetchRows(connectionId, database, req)
  })

export const countRowsFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().countRows)
  .handler(async ({ data }): Promise<CountResult> => {
    const { countRows } = await import('@/server/data.server')
    const { connectionId, database, ...req } = data
    return countRows(connectionId, database, req)
  })

export const applyChangesFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().applyChanges)
  .handler(async ({ data }): Promise<ApplyChangesResult> => {
    const { applyChanges } = await import('@/server/data.server')
    const { connectionId, database, ...changes } = data
    return applyChanges(connectionId, database, changes)
  })

export const lookupReferencesFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().lookupReferences)
  .handler(async ({ data }) => {
    const { lookupReferences } = await import('@/server/data.server')
    const { connectionId, database, ...req } = data
    return lookupReferences(connectionId, database, req)
  })

export const referenceLabelsFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().referenceLabels)
  .handler(async ({ data }) => {
    const { referenceLabels } = await import('@/server/data.server')
    const { connectionId, database, ...req } = data
    return referenceLabels(connectionId, database, req)
  })

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const executeSqlFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().executeSql)
  .handler(async ({ data }): Promise<ExecuteResult> => {
    const { executeSql } = await import('@/server/execute.server')
    return executeSql(data.connectionId, data.database, data.sql, {
      maxRows: data.maxRows,
      executionId: data.executionId,
    })
  })

export const explainSqlFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().explainSql)
  .handler(async ({ data }): Promise<ExplainResult> => {
    const { explainSql } = await import('@/server/execute.server')
    return explainSql(data.connectionId, data.database, data.sql, {
      analyze: data.analyze,
      executionId: data.executionId,
    })
  })

export const cancelSqlFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().cancelSql)
  .handler(async ({ data }) => {
    const { cancelExecution } = await import('@/server/execute.server')
    return { cancelled: await cancelExecution(data.executionId) }
  })

export const completionSchemaFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }) => {
    const { getCompletionSchema } = await import('@/server/introspect.server')
    return getCompletionSchema(data.connectionId, data.database)
  })

export const databaseOverviewFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }) => {
    const { getDatabaseOverview } = await import('@/server/introspect.server')
    return getDatabaseOverview(data.connectionId, data.database)
  })

export const databaseHealthFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }): Promise<DatabaseHealth> => {
    const { getDatabaseHealth } = await import('@/server/health.server')
    return getDatabaseHealth(data.connectionId, data.database)
  })
