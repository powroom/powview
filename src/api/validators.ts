// The input validators of the server functions in this folder. They live here, not in the
// *.functions.ts files, so the client build can drop them: it strips every .validator(...) call,
// which leaves this module with no browser importer and so drops the server-only SSH schema.
// The tests build the same schemas from here.
import { s, type Infer } from '@/lib/schema'
import { FILTER_OPERATORS, CONNECTION_COLORS } from '@/lib/types'
import { sshInputOptional } from '@/lib/ssh-input.server'

export function connectionValidators() {
  const connectionInput = s.object({
    name: s.string().max(120),
    color: s.enum(CONNECTION_COLORS),
    host: s.string().trim().min(1, 'Host is required'),
    port: s.number().int().min(1).max(65535),
    database: s.string().trim().min(1, 'Database is required'),
    user: s.string().trim().min(1, 'User is required'),
    password: s.string().optional(),
    clearPassword: s.boolean().optional(),
    ssl: s.enum(['disable', 'require', 'verify-full']),
    readOnly: s.boolean(),
    // omitted on update = keep; the store defaults new connections to false
    production: s.boolean().optional(),
    // omitted on update = keep; the store defaults new connections to 'read'
    aiAccess: s.enum(['off', 'read', 'write']).optional(),
    // undefined = keep the tunnel (update), null = remove it
    ssh: sshInputOptional,
  })
  const connectionId = s.object({ id: s.string() })
  return {
    connectionInput,
    connectionId,
    updateConnection: s.object({ id: s.string(), input: connectionInput }),
    testConnection: s.object({ id: s.string().optional(), input: connectionInput }),
  }
}

/** The connection form input, after validation. */
export type ConnectionInput = Infer<ReturnType<typeof connectionValidators>['connectionInput']>

export function activityValidators() {
  const target = s.object({ connectionId: s.string(), database: s.string() })
  return {
    listActivity: target.extend({ allDatabases: s.boolean() }),
    signalBackend: target.extend({
      pid: s.number().int().positive(),
      action: s.enum(['cancel', 'terminate']),
    }),
    listAudit: s.object({ limit: s.number().int().min(1).max(1000) }),
  }
}

export function authValidators() {
  return {
    credentials: s.object({ username: s.string(), password: s.string() }),
    passwordChange: s.object({ current: s.string(), next: s.string() }),
  }
}

/** `connections` takes ids or exact names. */
export function tokenValidators() {
  return {
    createToken: s.object({
      name: s.string().trim().min(1).max(80),
      scope: s.enum(['read', 'write', 'admin']).optional(),
      connections: s.union([s.literal('all'), s.array(s.string().trim().min(1)).min(1)]).optional(),
      // Omitted = 90 days, null = never expires.
      expiresInDays: s.union([s.null(), s.number().int().min(1).max(3650)]).optional(),
    }),
    revokeToken: s.object({ id: s.string() }),
  }
}

export function diagramValidators() {
  return {
    schemaDiagram: s.object({ connectionId: s.string(), database: s.string(), schema: s.string() }),
  }
}

/** The saved query inputs. The limits match saved-queries.server.ts (the server checks them again). */
export function savedQueryValidators() {
  const nameSchema = s.string().trim().min(1, 'Name is required.').max(120, 'Name must be 120 characters or fewer.')
  const sqlSchema = s.string().max(1_000_000, 'SQL is too long (max 1 MB).')
  return {
    listSavedQueries: s.object({ connectionId: s.string() }),
    createSavedQuery: s.object({
      name: nameSchema,
      sql: sqlSchema,
      connectionId: s.string().nullable(),
      database: s.string().nullable(),
    }),
    updateSavedQuery: s.object({
      id: s.string(),
      patch: s.object({
        name: nameSchema.optional(),
        sql: sqlSchema.optional(),
        connectionId: s.string().nullable().optional(),
        database: s.string().nullable().optional(),
      }),
    }),
    deleteSavedQuery: s.object({ id: s.string() }),
  }
}

/** A filter condition, as the table page sends it. */
const filterSchema = s.object({
  column: s.string(),
  op: s.enum(FILTER_OPERATORS),
  value: s.string().optional(),
})

/** A sort column, as the table page sends it. */
const sortSchema = s.object({ column: s.string(), direction: s.enum(['asc', 'desc']) })

/** The saved view inputs. The limits match saved-views.server.ts (the server checks them again). */
export function savedViewValidators() {
  const target = s.object({
    connectionId: s.string(),
    database: s.string(),
    schema: s.string(),
    table: s.string(),
  })
  const nameSchema = s.string().trim().min(1, 'Name is required.').max(80, 'Name must be 80 characters or fewer.')
  const textSchema = s.string().max(10_000, 'The text is too long (max 10,000 characters).')
  const state = s.object({
    sort: s.array(sortSchema).max(20, 'Too many sort columns (max 20).'),
    filters: s.array(filterSchema).max(50, 'Too many filters (max 50).'),
    where: textSchema.nullable(),
    q: textSchema.nullable(),
    hiddenColumns: s.array(s.string()).max(2000, 'Too many hidden columns (max 2000).'),
  })
  return {
    listSavedViews: target,
    listSavedViewsForDatabase: s.object({ connectionId: s.string(), database: s.string() }),
    createSavedView: target.extend({ name: nameSchema, state }),
    updateSavedView: s.object({
      id: s.string(),
      patch: s.object({
        name: nameSchema.optional(),
        state: state.optional(),
      }),
    }),
    deleteSavedView: s.object({ id: s.string() }),
  }
}

export function explorerValidators() {
  const target = s.object({ connectionId: s.string(), database: s.string() })

  const cell = s.union([s.string(), s.boolean(), s.null()])
  const editValue = s.union([cell, s.object({ default: s.literal(true) })])

  const rowsRequest = target.extend({
    schema: s.string(),
    table: s.string(),
    page: s.number().int().min(1),
    pageSize: s.number().int().min(1).max(5000),
    sort: s.array(sortSchema),
    filters: s.array(filterSchema),
    where: s.string().optional(),
    search: s.string().optional(),
  })

  return {
    target,
    connectionOnly: s.object({ connectionId: s.string() }),
    schemaObjects: target.extend({ schema: s.string() }),
    relation: target.extend({ schema: s.string(), table: s.string() }),
    objectDefinition: target.extend({ kind: s.enum(['function', 'type']), oid: s.number().int() }),
    rowsRequest,
    countRows: rowsRequest.pick({
      connectionId: true,
      database: true,
      schema: true,
      table: true,
      filters: true,
      where: true,
      search: true,
    }),
    applyChanges: target.extend({
      schema: s.string(),
      table: s.string(),
      updates: s.array(s.object({ key: s.record(s.string(), cell), values: s.record(s.string(), cell) })),
      inserts: s.array(s.object({ values: s.record(s.string(), editValue) })),
      deletes: s.array(s.object({ key: s.record(s.string(), cell) })),
    }),
    lookupReferences: target.extend({
      schema: s.string(),
      table: s.string(),
      column: s.string(),
      search: s.string().max(200),
      limit: s.number().int().min(1).max(100).default(20),
    }),
    referenceLabels: target.extend({
      schema: s.string(),
      table: s.string(),
      column: s.string(),
      values: s.array(s.string().max(500)).max(1000),
    }),
    executeSql: target.extend({
      sql: s.string().max(5_000_000),
      maxRows: s.number().int().min(1).max(50_000).default(1000),
      executionId: s.string(),
    }),
    explainSql: target.extend({
      sql: s.string().max(5_000_000),
      analyze: s.boolean(),
      executionId: s.string(),
    }),
    cancelSql: s.object({ executionId: s.string() }),
    // The wanted state of a database (the server builds the SQL from it). Limits: PostgreSQL's own.
    alterDatabase: target.extend({
      desired: s.object({
        name: s.string().trim().max(200),
        owner: s.string().trim().min(1, 'Owner is required.').max(200),
        comment: s.string().max(10_000).nullable(),
        connectionLimit: s.union([s.null(), s.number().int().min(-1).max(2_147_483_647)]),
        allowConnections: s.boolean(),
        settings: s.array(s.object({ name: s.string().max(200), value: s.string().max(10_000) })).max(500),
      }),
    }),
    dropDatabase: target.extend({ force: s.boolean() }),
    createDatabase: s.object({ connectionId: s.string(), draft: createDatabaseDraftSchema() }),
    // Roles: the wanted state (the server builds the SQL). A password is sent only to be hashed.
    createRole: s.object({ connectionId: s.string(), draft: roleDraftSchema() }),
    alterRole: s.object({ connectionId: s.string(), name: s.string().max(200), draft: roleDraftSchema() }),
    dropRole: s.object({
      connectionId: s.string(),
      name: s.string().max(200),
      reassignTo: s.string().max(200).nullable(),
      dropOwned: s.boolean(),
    }),
    // A role's privileges: the wanted state per database and schema (the server builds the SQL).
    rolePrivileges: target.extend({ role: s.string().max(200) }),
    applyRolePrivileges: target.extend({
      role: s.string().max(200),
      draft: s.object({
        databases: s
          .array(
            s.object({
              name: s.string().max(200),
              connect: s.boolean(),
              create: s.boolean(),
              temporary: s.boolean(),
            }),
          )
          .max(500),
        schemas: s.array(s.object({ name: s.string().max(200), level: s.enum(['none', 'read', 'write']) })).max(1000),
      }),
    }),
  }
}

/** The Roles draft. The server checks names, numbers, dates and passwords again. */
function roleDraftSchema() {
  return s.object({
    name: s.string().trim().max(200),
    canLogin: s.boolean(),
    password: s.string().max(1000).nullable(),
    superuser: s.boolean(),
    createDb: s.boolean(),
    createRole: s.boolean(),
    inherit: s.boolean(),
    replication: s.boolean(),
    bypassRls: s.boolean(),
    connectionLimit: s.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
    validUntil: s.string().max(64).nullable(),
    memberOf: s.array(s.string().max(200)).max(500),
    comment: s.string().max(10_000).nullable(),
    settings: s.array(s.object({ name: s.string().max(200), value: s.string().max(10_000) })).max(500),
  })
}

/** The New database draft. The server checks names, numbers and the options per version again. */
function createDatabaseDraftSchema() {
  const text = (max: number) => s.string().max(max).nullable()
  const locale = text(1000)
  return s.object({
    name: s.string().max(200),
    owner: text(200),
    template: text(200),
    encoding: text(200),
    localeProvider: s.enum(['libc', 'icu', 'builtin']).nullable(),
    locale,
    lcCollate: locale,
    lcCtype: locale,
    icuLocale: locale,
    icuRules: locale,
    builtinLocale: locale,
    collationVersion: locale,
    tablespace: text(200),
    strategy: s.enum(['wal_log', 'file_copy']).nullable(),
    allowConnections: s.boolean(),
    connectionLimit: s.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
    isTemplate: s.boolean(),
    oid: s.number().int().min(-2_147_483_648).max(4_294_967_295).nullable(),
    comment: s.string().max(10_000).nullable(),
    settings: s
      .array(s.object({ name: s.string().max(200), value: s.string().max(10_000) }))
      .max(100, 'Too many settings (max 100).'),
  })
}
