// Types shared between the server (src/server) and the client.

export type SslMode = 'disable' | 'require' | 'verify-full'

export const CONNECTION_COLORS = ['neutral', 'blue', 'emerald', 'amber', 'rose', 'violet', 'cyan', 'orange'] as const
export type ConnectionColor = (typeof CONNECTION_COLORS)[number]

/** How AI agents (MCP, REST tokens) may use a connection. Users are not affected. */
export type AiAccess = 'off' | 'read' | 'write'
export type TokenScope = 'read' | 'write' | 'admin'
export type Access = 'none' | 'read' | 'write'

export type SshAuth = 'password' | 'key'

/** SSH tunnel (bastion) settings for a connection. Secrets are encrypted at rest, like the DB password. */
export interface SshSettings {
  host: string
  port: number
  user: string
  auth: SshAuth
  /** encrypted when stored */
  password?: string
  /** encrypted when stored; PEM or OpenSSH private key text */
  privateKey?: string
  /** encrypted when stored */
  passphrase?: string
  /** SHA256 host key fingerprint, e.g. "SHA256:abc...". Remembered on first use, or pinned in powview.yaml. */
  hostKey?: string
  /** managed only: environment variables and files, read at connect time (never stored) */
  passwordEnv?: string
  privateKeyEnv?: string
  privateKeyFile?: string
  passphraseEnv?: string
}

export interface ConnectionConfig {
  id: string
  name: string
  color: ConnectionColor
  host: string
  port: number
  database: string
  user: string
  password?: string
  /** managed only: name of the environment variable that holds the password */
  passwordEnv?: string
  ssl: SslMode
  readOnly: boolean
  /** Production connections show a marker and ask before every change. */
  production: boolean
  aiAccess: AiAccess
  /** SSH tunnel: pow/view connects to this server and reaches host:port from there */
  ssh?: SshSettings
  /** true when the connection comes from powview.yaml (read-only in the UI and API) */
  managed?: boolean
  createdAt: string
  lastUsedAt?: string
}

/** What the client gets about an SSH tunnel: never a secret or the name of an env var or file. */
export interface SshInfo {
  host: string
  port: number
  user: string
  auth: SshAuth
  hasPassword: boolean
  hasKey: boolean
  hostKey?: string
}

/** What the client gets: never includes the password, the name of its env var, or SSH secrets. */
export type ConnectionInfo = Omit<ConnectionConfig, 'password' | 'passwordEnv' | 'ssh'> & {
  hasPassword: boolean
  ssh?: SshInfo
}

/** SSH tunnel as sent by the client. Empty secret on update = keep the stored one. */
export interface SshInput {
  host: string
  port: number
  user: string
  auth: SshAuth
  password?: string
  privateKey?: string
  passphrase?: string
  /** explicitly clear the stored SSH password */
  clearPassword?: boolean
  /** explicitly clear the stored private key (and its passphrase) */
  clearKey?: boolean
}

export interface ConnectionInput {
  name: string
  color: ConnectionColor
  host: string
  port: number
  database: string
  user: string
  /** undefined/empty on update = keep the stored password */
  password?: string
  /** explicitly clear the stored password */
  clearPassword?: boolean
  ssl: SslMode
  readOnly: boolean
  /** optional so the UI dialog compiles unchanged; the server defaults it to 'read' */
  aiAccess?: AiAccess
  /** undefined on update = keep; the server defaults new connections to false */
  production?: boolean
  /** undefined on update = keep the tunnel as it is; null = remove it */
  ssh?: SshInput | null
}

export interface ApiTokenInfo {
  id: string // 8 chars
  name: string
  prefix: string // first 12 chars of the token, e.g. "powview_a1B2c3"
  scope: TokenScope
  connections: 'all' | string[]
  createdAt: string
  /** null = never expires */
  expiresAt: string | null
  lastUsedAt?: string
}

export interface AuditEntry {
  at: string // ISO time
  source: 'mcp' | 'api' | 'cli'
  actor: string // token name, "local CLI" or the admin username
  tokenId?: string
  connectionId: string
  connectionName: string
  database: string
  access: 'read' | 'write'
  sql: string // truncated to 5000 chars
  ok: boolean
  error?: string
  rowCount?: number | null
  durationMs: number
}

export interface AuthState {
  authEnabled: boolean
  setupRequired: boolean // no admin yet (and auth enabled)
  authenticated: boolean
  username: string | null
}

export interface TestConnectionResult {
  ok: boolean
  latencyMs?: number
  serverVersion?: string
  /** SSH host key seen during the test (shown so the user can check it) */
  hostKey?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export interface ServerInfo {
  version: string
  versionShort: string
  user: string
  database: string
  encoding: string
  timezone: string
  startedAt: string
  databaseSize: number
  isSuperuser: boolean
  /** superuser or CREATEDB: the role may run CREATE DATABASE */
  canCreateDatabase: boolean
  readOnly: boolean
}

export interface DatabaseInfo {
  name: string
  size: number | null
  owner: string
  isCurrent: boolean
}

export interface SchemaInfo {
  name: string
  owner: string
  comment: string | null
  isSystem: boolean
  relationCount: number
}

/** r = table, p = partitioned table, v = view, m = materialized view, f = foreign table */
export type RelationKind = 'r' | 'p' | 'v' | 'm' | 'f'

export interface RelationInfo {
  oid: number
  schema: string
  name: string
  kind: RelationKind
  estimatedRows: number | null
  comment: string | null
  isPartition: boolean
  /** name of the partitioned table this one is a partition of (same schema) */
  partitionOf?: string | null
}

export interface FunctionInfo {
  oid: number
  schema: string
  name: string
  args: string
  result: string | null
  /** f = function, p = procedure, a = aggregate, w = window */
  kind: 'f' | 'p' | 'a' | 'w'
  language: string
  comment: string | null
}

export interface SequenceInfo {
  oid: number
  schema: string
  name: string
}

export interface TypeInfo {
  oid: number
  schema: string
  name: string
  /** e = enum, d = domain, c = composite, r = range */
  kind: 'e' | 'd' | 'c' | 'r'
  labels: string[] | null
  comment: string | null
}

export interface SchemaObjects {
  relations: RelationInfo[]
  functions: FunctionInfo[]
  sequences: SequenceInfo[]
  types: TypeInfo[]
}

/** Simplified type category used to render and edit values. */
export type ValueKind =
  | 'number'
  | 'boolean'
  | 'text'
  | 'json'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'interval'
  | 'uuid'
  | 'binary'
  | 'array'
  | 'network'
  | 'enum'
  | 'other'

export interface ColumnInfo {
  position: number
  name: string
  /** formatted type, e.g. "character varying(255)" */
  type: string
  /** short type name, e.g. "varchar", "int4", "order_status" */
  udtName: string
  typeOid: number
  kind: ValueKind
  nullable: boolean
  defaultValue: string | null
  /** '' | 'a' (always) | 'd' (by default) */
  identity: string
  /** '' | 's' (stored) */
  generated: string
  comment: string | null
  enumValues: string[] | null
  isPrimaryKey: boolean
  foreignKey: { schema: string; table: string; column: string } | null
  isUnique: boolean
}

export interface ConstraintInfo {
  name: string
  /** p = primary key, f = foreign key, u = unique, c = check, x = exclusion */
  type: 'p' | 'f' | 'u' | 'c' | 'x' | 't' | 'n'
  definition: string
  columns: string[]
  refSchema: string | null
  refTable: string | null
  refColumns: string[] | null
}

export interface IndexInfo {
  name: string
  definition: string
  isUnique: boolean
  isPrimary: boolean
  method: string
  size: number
  columns: string[]
  predicate: string | null
  scans: number | null
  isConstraint: boolean
}

export interface TriggerInfo {
  name: string
  definition: string
  enabled: boolean
}

export interface ReferenceInfo {
  name: string
  schema: string
  table: string
  columns: string[]
  refColumns: string[]
}

export interface RelationDetails {
  oid: number
  schema: string
  name: string
  kind: RelationKind
  owner: string
  comment: string | null
  estimatedRows: number | null
  tableBytes: number
  indexBytes: number
  totalBytes: number
  columns: ColumnInfo[]
  primaryKey: string[]
  constraints: ConstraintInfo[]
  indexes: IndexInfo[]
  triggers: TriggerInfo[]
  referencedBy: ReferenceInfo[]
  /** whether rows can be edited and how they are identified */
  editable: boolean
  rowIdentity: 'pk' | 'ctid' | 'none'
  stats: {
    seqScan: number | null
    idxScan: number | null
    liveTuples: number | null
    deadTuples: number | null
    lastVacuum: string | null
    lastAutovacuum: string | null
    lastAnalyze: string | null
    lastAutoanalyze: string | null
  } | null
}

// ---------------------------------------------------------------------------
// Data browsing / editing
// ---------------------------------------------------------------------------

export type Cell = string | boolean | null

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'in',
  'is_null',
  'not_null',
] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

export interface Filter {
  column: string
  op: FilterOperator
  value?: string
}

export interface Sort {
  column: string
  direction: 'asc' | 'desc'
}

export interface RowsRequest {
  schema: string
  table: string
  page: number
  pageSize: number
  sort: Sort[]
  filters: Filter[]
  where?: string
  search?: string
}

export interface ResultField {
  name: string
  typeOid: number
  typeName: string
  kind: ValueKind
}

export interface RowsResult {
  fields: ResultField[]
  rows: Cell[][]
  /** ctid of every row when the table has no primary key */
  ctids: string[] | null
  hasMore: boolean
  durationMs: number
  sql: string
}

export interface CountResult {
  count: number | null
  exact: boolean
}

export type RowKey = Record<string, Cell>

/** Value written to a cell. `{ default: true }` means "use the column default". */
export type EditValue = Cell | { default: true }

export interface RowChanges {
  schema: string
  table: string
  updates: { key: RowKey; values: Record<string, Cell> }[]
  inserts: { values: Record<string, EditValue> }[]
  deletes: { key: RowKey }[]
}

export interface ApplyChangesResult {
  ok: boolean
  updated: number
  inserted: number
  deleted: number
  error?: PgErrorInfo & {
    change?: string
    /** which staged change failed (index into that list of the request) */
    failed?: { kind: 'delete' | 'update' | 'insert'; index: number }
  }
}

export interface ReferenceOption {
  value: string
  label: string | null
  /** a second readable column (e.g. e-mail) to tell rows with the same label apart */
  detail?: string | null
}

export interface ReferenceLookup {
  /** column shown next to the key, e.g. "name" */
  labelColumn: string | null
  detailColumn?: string | null
  items: ReferenceOption[]
}

// ---------------------------------------------------------------------------
// SQL editor
// ---------------------------------------------------------------------------

export interface PgErrorInfo {
  message: string
  code?: string
  detail?: string
  hint?: string
  /** 0-based offset in the full script, when known */
  position?: number
  where?: string
  severity?: string
  /** column / constraint the error is about, when PostgreSQL reports it */
  column?: string
  constraint?: string
}

export interface StatementResult {
  statement: string
  /** 0-based offsets of the statement in the submitted script */
  from: number
  to: number
  command: string | null
  rowCount: number | null
  fields: ResultField[]
  rows: Cell[][]
  truncated: boolean
  durationMs: number
}

export interface ExecuteResult {
  results: StatementResult[]
  error: (PgErrorInfo & { statementIndex: number; from: number; to: number }) | null
  notices: { severity: string; message: string }[]
  durationMs: number
  rolledBack: boolean
  cancelled: boolean
}

/** A value from JSON, such as the plan Postgres returns. Typed so server functions can send it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Why no plan is shown for a statement, when that is not an error. 'needs-values': Postgres could not plan
 * the $n parameters. 'needs-values-analyze': Explain Analyze needs real values. 'needs-newer-postgres': a
 * plain EXPLAIN needs PostgreSQL 16 or newer for the parameters.
 */
export type ExplainUnavailable = 'needs-values' | 'needs-values-analyze' | 'needs-newer-postgres'

/**
 * The result of an EXPLAIN run. `plan` is the JSON plan (null when Postgres gave none); `results` is always [].
 * `generic` is true when the plan was made with EXPLAIN (GENERIC_PLAN) for a statement with $n parameters.
 * `unavailable` is set (and `error` is null) when the plan cannot be shown for a reason that is not a failure.
 */
export type ExplainResult = ExecuteResult & {
  plan: JsonValue | null
  analyzed: boolean
  generic: boolean
  unavailable: ExplainUnavailable | null
}

/** A SQL query saved on the server. connectionId null = shown for every connection. */
export interface SavedQuery {
  id: string
  name: string
  sql: string
  connectionId: string | null
  database: string | null
  createdAt: string
  updatedAt: string
}

/** The table view state a saved view keeps: the filters, sort, search and hidden columns of a table. */
export interface SavedViewState {
  sort: Sort[]
  filters: Filter[]
  /** SQL condition, null when there is none */
  where: string | null
  /** search text, null when there is none */
  q: string | null
  hiddenColumns: string[]
}

/** A table view saved under a name. It belongs to one table of one connection and database. */
export interface SavedView {
  id: string
  name: string
  connectionId: string
  database: string
  schema: string
  table: string
  state: SavedViewState
  createdAt: string
  updatedAt: string
}
