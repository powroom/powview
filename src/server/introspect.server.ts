import { kindFromPgType } from '@/lib/pg-types'
import { describedColumnSql } from '@/lib/ddl'
import { qualifiedName, quoteIdent } from '@/lib/sql'
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseInfo,
  FunctionInfo,
  IndexInfo,
  ReferenceInfo,
  RelationDetails,
  RelationInfo,
  RelationKind,
  SchemaInfo,
  SchemaObjects,
  SequenceInfo,
  ServerInfo,
  TriggerInfo,
  TypeInfo,
} from '@/lib/types'
import { query } from './pool.server'

const num = (v: unknown): number => (v == null ? 0 : Number(v))
export const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))

export async function getServerInfo(connectionId: string, database?: string): Promise<ServerInfo> {
  const [row] = await query<{
    version: string
    version_short: string
    user: string
    database: string
    encoding: string
    timezone: string
    started_at: string
    size: string
    is_superuser: boolean
    can_create_db: boolean
    read_only: string
  }>(
    connectionId,
    database,
    `SELECT version() AS version,
            current_setting('server_version') AS version_short,
            current_user AS "user",
            current_database() AS database,
            pg_encoding_to_char(d.encoding) AS encoding,
            current_setting('TimeZone') AS timezone,
            pg_postmaster_start_time()::text AS started_at,
            pg_database_size(current_database()) AS size,
            coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser,
            coalesce((SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname = current_user), false) AS can_create_db,
            current_setting('default_transaction_read_only') AS read_only
       FROM pg_database d WHERE d.datname = current_database()`,
  )
  if (!row) throw new Error('Could not read server information')
  return {
    version: row.version,
    versionShort: row.version_short,
    user: row.user,
    database: row.database,
    encoding: row.encoding,
    timezone: row.timezone,
    startedAt: row.started_at,
    databaseSize: num(row.size),
    isSuperuser: row.is_superuser,
    canCreateDatabase: row.can_create_db,
    readOnly: row.read_only === 'on',
  }
}

/** Every database on the server that accepts connections, with sizes where the role may see them. */
export async function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  const rows = await query<{ name: string; size: string | null; owner: string; is_current: boolean }>(
    connectionId,
    undefined,
    `SELECT d.datname AS name,
            CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) END AS size,
            pg_get_userbyid(d.datdba) AS owner,
            d.datname = current_database() AS is_current
       FROM pg_database d
      WHERE d.datallowconn AND NOT d.datistemplate
      ORDER BY d.datname`,
  )
  return rows.map((r) => ({
    name: r.name,
    size: numOrNull(r.size),
    owner: r.owner,
    isCurrent: r.is_current,
  }))
}

export async function listSchemas(connectionId: string, database: string): Promise<SchemaInfo[]> {
  const rows = await query<{
    name: string
    owner: string
    comment: string | null
    is_system: boolean
    relation_count: number
  }>(
    connectionId,
    database,
    `SELECT n.nspname AS name,
            pg_get_userbyid(n.nspowner) AS owner,
            obj_description(n.oid, 'pg_namespace') AS comment,
            (n.nspname IN ('pg_catalog', 'information_schema')) AS is_system,
            (SELECT count(*)::int FROM pg_class c
              WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')) AS relation_count
       FROM pg_namespace n
      WHERE n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_'
      ORDER BY is_system, (n.nspname = 'public') DESC, n.nspname`,
  )
  return rows.map((r) => ({
    name: r.name,
    owner: r.owner,
    comment: r.comment,
    isSystem: r.is_system,
    relationCount: r.relation_count,
  }))
}

const NOT_EXTENSION_MEMBER = (oidExpr: string, catalog: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend dep
                WHERE dep.objid = ${oidExpr} AND dep.classid = '${catalog}'::regclass AND dep.deptype = 'e')`

export async function listSchemaObjects(
  connectionId: string,
  database: string,
  schema: string,
): Promise<SchemaObjects> {
  const [relations, functions, sequences, types] = await Promise.all([
    query<{
      oid: number
      name: string
      kind: RelationKind
      estimated_rows: number | null
      comment: string | null
      is_partition: boolean
      partition_of: string | null
    }>(
      connectionId,
      database,
      `SELECT c.oid::int AS oid, c.relname AS name, c.relkind::text AS kind,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::float8 END AS estimated_rows,
              obj_description(c.oid, 'pg_class') AS comment,
              c.relispartition AS is_partition,
              CASE WHEN c.relispartition THEN
                (SELECT pc.relname FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent
                  WHERE i.inhrelid = c.oid AND pc.relnamespace = c.relnamespace LIMIT 1)
              END AS partition_of
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND ${NOT_EXTENSION_MEMBER('c.oid', 'pg_class')}
        ORDER BY c.relname`,
      [schema],
    ),
    query<{
      oid: number
      name: string
      args: string
      result: string | null
      kind: FunctionInfo['kind']
      language: string
      comment: string | null
    }>(
      connectionId,
      database,
      `SELECT p.oid::int AS oid, p.proname AS name,
              pg_get_function_identity_arguments(p.oid) AS args,
              pg_get_function_result(p.oid) AS result,
              p.prokind::text AS kind, l.lanname AS language,
              obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = $1
          AND ${NOT_EXTENSION_MEMBER('p.oid', 'pg_proc')}
        ORDER BY p.proname, args`,
      [schema],
    ),
    query<{ oid: number; name: string }>(
      connectionId,
      database,
      `SELECT c.oid::int AS oid, c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'S'
          AND ${NOT_EXTENSION_MEMBER('c.oid', 'pg_class')}
        ORDER BY c.relname`,
      [schema],
    ),
    query<{ oid: number; name: string; kind: TypeInfo['kind']; labels: string[] | null; comment: string | null }>(
      connectionId,
      database,
      `SELECT t.oid::int AS oid, t.typname AS name, t.typtype::text AS kind,
              CASE WHEN t.typtype = 'e' THEN
                (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
              END AS labels,
              obj_description(t.oid, 'pg_type') AS comment
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1
          AND (t.typtype IN ('e', 'd', 'r')
               OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
          AND ${NOT_EXTENSION_MEMBER('t.oid', 'pg_type')}
        ORDER BY t.typname`,
      [schema],
    ),
  ])

  return {
    relations: relations.map((r): RelationInfo => ({
      oid: r.oid,
      schema,
      name: r.name,
      kind: r.kind,
      estimatedRows: r.estimated_rows,
      comment: r.comment,
      isPartition: r.is_partition,
      partitionOf: r.partition_of,
    })),
    functions: functions.map((f): FunctionInfo => ({ ...f, schema })),
    sequences: sequences.map((s): SequenceInfo => ({ ...s, schema })),
    types: types.map((t): TypeInfo => ({ ...t, schema })),
  }
}

/** Every relation of the database (for the command palette). */
export async function listAllRelations(connectionId: string, database: string): Promise<RelationInfo[]> {
  const rows = await query<{
    oid: number
    schema: string
    name: string
    kind: RelationKind
    estimated_rows: number | null
    comment: string | null
    is_partition: boolean
  }>(
    connectionId,
    database,
    `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::float8 END AS estimated_rows,
            obj_description(c.oid, 'pg_class') AS comment,
            c.relispartition AS is_partition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_'
        AND ${NOT_EXTENSION_MEMBER('c.oid', 'pg_class')}
      ORDER BY n.nspname = 'public' DESC, n.nspname, c.relname
      LIMIT 5000`,
  )
  return rows.map((r) => ({
    oid: r.oid,
    schema: r.schema,
    name: r.name,
    kind: r.kind,
    estimatedRows: r.estimated_rows,
    comment: r.comment,
    isPartition: r.is_partition,
  }))
}

async function relationOid(
  connectionId: string,
  database: string,
  schema: string,
  name: string,
): Promise<{ oid: number; kind: RelationKind }> {
  const [row] = await query<{ oid: number; kind: RelationKind }>(
    connectionId,
    database,
    `SELECT c.oid::int AS oid, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  )
  if (!row) throw new Error(`Relation ${schema}.${name} does not exist`)
  return row
}

export async function getRelationDetails(
  connectionId: string,
  database: string,
  schema: string,
  name: string,
): Promise<RelationDetails> {
  const { oid } = await relationOid(connectionId, database, schema, name)

  const [infoRows, columnRows, constraintRows, indexRows, triggerRows, referencedRows, statsRows] = await Promise.all([
    query<{
      kind: RelationKind
      owner: string
      comment: string | null
      estimated_rows: number | null
      table_bytes: string
      index_bytes: string
      total_bytes: string
    }>(
      connectionId,
      database,
      `SELECT c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner,
                obj_description(c.oid, 'pg_class') AS comment,
                CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::float8 END AS estimated_rows,
                CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_table_size(c.oid) ELSE 0 END AS table_bytes,
                CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_indexes_size(c.oid) ELSE 0 END AS index_bytes,
                CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_total_relation_size(c.oid) ELSE 0 END AS total_bytes
           FROM pg_class c WHERE c.oid = $1`,
      [oid],
    ),
    query<{
      position: number
      name: string
      type: string
      udt_name: string
      type_oid: number
      typtype: string
      typcategory: string
      base_typname: string | null
      base_category: string | null
      nullable: boolean
      default_value: string | null
      identity: string
      generated: string
      comment: string | null
      enum_values: string[] | null
    }>(
      connectionId,
      database,
      `SELECT a.attnum::int AS position, a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                t.typname AS udt_name, a.atttypid::int AS type_oid,
                t.typtype::text AS typtype, t.typcategory::text AS typcategory,
                bt.typname AS base_typname, bt.typcategory::text AS base_category,
                NOT a.attnotnull AS nullable,
                pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
                a.attidentity::text AS identity, a.attgenerated::text AS generated,
                col_description(a.attrelid, a.attnum) AS comment,
                CASE WHEN t.typtype = 'e' THEN
                  (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
                END AS enum_values
           FROM pg_attribute a
           JOIN pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
           LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
      [oid],
    ),
    query<{
      name: string
      type: ConstraintInfo['type']
      definition: string
      columns: string[] | null
      ref_schema: string | null
      ref_table: string | null
      ref_columns: string[] | null
    }>(
      connectionId,
      database,
      `SELECT con.conname AS name, con.contype::text AS type,
                pg_get_constraintdef(con.oid, true) AS definition,
                (SELECT array_agg(att.attname::text ORDER BY k.ord)
                   FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum) AS columns,
                fn.nspname AS ref_schema, fc.relname AS ref_table,
                (SELECT array_agg(att.attname::text ORDER BY k.ord)
                   FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum) AS ref_columns
           FROM pg_constraint con
           LEFT JOIN pg_class fc ON fc.oid = con.confrelid
           LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
          WHERE con.conrelid = $1 AND con.contype <> 'n'
          ORDER BY array_position(ARRAY['p', 'u', 'f', 'c', 'x', 't']::"char"[], con.contype), con.conname`,
      [oid],
    ),
    query<{
      name: string
      definition: string
      is_unique: boolean
      is_primary: boolean
      method: string
      size: string
      columns: string[] | null
      predicate: string | null
      scans: string | null
      is_constraint: boolean
    }>(
      connectionId,
      database,
      `SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS definition,
                ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
                am.amname AS method, pg_relation_size(ix.indexrelid) AS size,
                (SELECT array_agg(pg_get_indexdef(ix.indexrelid, k.n, true) ORDER BY k.n)
                   FROM generate_series(1, ix.indnkeyatts) AS k(n)) AS columns,
                pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
                s.idx_scan AS scans,
                EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid
                          AND con.conrelid = ix.indrelid AND con.contype IN ('p', 'u', 'x')) AS is_constraint
           FROM pg_index ix
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_am am ON am.oid = i.relam
           LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = ix.indexrelid
          WHERE ix.indrelid = $1
          ORDER BY ix.indisprimary DESC, i.relname`,
      [oid],
    ),
    query<{ name: string; definition: string; enabled: boolean }>(
      connectionId,
      database,
      `SELECT t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition, t.tgenabled <> 'D' AS enabled
           FROM pg_trigger t WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY t.tgname`,
      [oid],
    ),
    query<{ name: string; schema: string; table: string; columns: string[]; ref_columns: string[] }>(
      connectionId,
      database,
      `SELECT con.conname AS name, n.nspname AS schema, c.relname AS table,
                (SELECT array_agg(att.attname::text ORDER BY k.ord)
                   FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum) AS columns,
                (SELECT array_agg(att.attname::text ORDER BY k.ord)
                   FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum) AS ref_columns
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE con.confrelid = $1 AND con.contype = 'f'
          ORDER BY n.nspname, c.relname, con.conname`,
      [oid],
    ),
    query<{
      seq_scan: string | null
      idx_scan: string | null
      n_live_tup: string | null
      n_dead_tup: string | null
      last_vacuum: string | null
      last_autovacuum: string | null
      last_analyze: string | null
      last_autoanalyze: string | null
    }>(
      connectionId,
      database,
      `SELECT seq_scan, idx_scan, n_live_tup, n_dead_tup,
                last_vacuum::text, last_autovacuum::text, last_analyze::text, last_autoanalyze::text
           FROM pg_stat_all_tables WHERE relid = $1`,
      [oid],
    ),
  ])

  const info = infoRows[0]
  if (!info) throw new Error(`Relation ${schema}.${name} does not exist`)

  const constraints: ConstraintInfo[] = constraintRows.map((c) => ({
    name: c.name,
    type: c.type,
    definition: c.definition,
    columns: c.columns ?? [],
    refSchema: c.ref_schema,
    refTable: c.ref_table,
    refColumns: c.ref_columns,
  }))
  const primaryKey = constraints.find((c) => c.type === 'p')?.columns ?? []
  const uniqueSingle = new Set(
    constraints.filter((c) => c.type === 'u' && c.columns.length === 1).map((c) => c.columns[0]!),
  )
  const fkByColumn = new Map<string, { schema: string; table: string; column: string }>()
  for (const c of constraints) {
    if (c.type === 'f' && c.columns.length === 1 && c.refTable && c.refColumns?.[0]) {
      fkByColumn.set(c.columns[0]!, {
        schema: c.refSchema ?? schema,
        table: c.refTable,
        column: c.refColumns[0],
      })
    }
  }

  const columns: ColumnInfo[] = columnRows.map((c) => {
    const typname = c.base_typname ?? c.udt_name
    const category = c.base_category ?? c.typcategory
    return {
      position: c.position,
      name: c.name,
      type: c.type,
      udtName: c.udt_name.startsWith('_') ? `${c.udt_name.slice(1)}[]` : c.udt_name,
      typeOid: c.type_oid,
      kind: kindFromPgType(typname, category, c.typtype),
      nullable: c.nullable,
      defaultValue: c.default_value,
      identity: c.identity,
      generated: c.generated,
      comment: c.comment,
      enumValues: c.enum_values,
      isPrimaryKey: primaryKey.includes(c.name),
      foreignKey: fkByColumn.get(c.name) ?? null,
      isUnique: uniqueSingle.has(c.name),
    }
  })

  const kind = info.kind
  const isTable = kind === 'r' || kind === 'p'
  const rowIdentity: RelationDetails['rowIdentity'] =
    isTable && primaryKey.length > 0 ? 'pk' : kind === 'r' ? 'ctid' : 'none'

  const stats = statsRows[0]
  return {
    oid,
    schema,
    name,
    kind,
    owner: info.owner,
    comment: info.comment,
    estimatedRows: info.estimated_rows,
    tableBytes: num(info.table_bytes),
    indexBytes: num(info.index_bytes),
    totalBytes: num(info.total_bytes),
    columns,
    primaryKey,
    constraints,
    indexes: indexRows.map((i): IndexInfo => ({
      name: i.name,
      definition: i.definition,
      isUnique: i.is_unique,
      isPrimary: i.is_primary,
      method: i.method,
      size: num(i.size),
      columns: i.columns ?? [],
      predicate: i.predicate,
      scans: numOrNull(i.scans),
      isConstraint: i.is_constraint,
    })),
    triggers: triggerRows.map((t): TriggerInfo => ({ ...t })),
    referencedBy: referencedRows.map((r): ReferenceInfo => ({
      name: r.name,
      schema: r.schema,
      table: r.table,
      columns: r.columns,
      refColumns: r.ref_columns,
    })),
    editable: rowIdentity !== 'none',
    rowIdentity,
    stats: stats
      ? {
          seqScan: numOrNull(stats.seq_scan),
          idxScan: numOrNull(stats.idx_scan),
          liveTuples: numOrNull(stats.n_live_tup),
          deadTuples: numOrNull(stats.n_dead_tup),
          lastVacuum: stats.last_vacuum,
          lastAutovacuum: stats.last_autovacuum,
          lastAnalyze: stats.last_analyze,
          lastAutoanalyze: stats.last_autoanalyze,
        }
      : null,
  }
}

export async function getRelationDdl(
  connectionId: string,
  database: string,
  schema: string,
  name: string,
): Promise<string> {
  const details = await getRelationDetails(connectionId, database, schema, name)
  const fq = qualifiedName(schema, name)
  const out: string[] = []

  if (details.kind === 'v' || details.kind === 'm') {
    const [row] = await query<{ def: string }>(connectionId, database, `SELECT pg_get_viewdef($1::oid, true) AS def`, [
      details.oid,
    ])
    const body = (row?.def ?? '').trim().replace(/;$/, '')
    out.push(
      details.kind === 'v'
        ? `CREATE OR REPLACE VIEW ${fq} AS\n${body};`
        : `CREATE MATERIALIZED VIEW ${fq} AS\n${body}\nWITH DATA;`,
    )
  } else {
    const [partRow] = await query<{ partkey: string | null; bound: string | null; parent: string | null }>(
      connectionId,
      database,
      `SELECT pg_get_partkeydef(c.oid) AS partkey,
              pg_get_expr(c.relpartbound, c.oid) AS bound,
              (SELECT p.oid::regclass::text FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
                WHERE i.inhrelid = c.oid LIMIT 1) AS parent
         FROM pg_class c WHERE c.oid = $1`,
      [details.oid],
    )
    const lines: string[] = []
    for (const col of details.columns) lines.push(describedColumnSql(col))
    for (const con of details.constraints) {
      if (con.type === 't') continue
      lines.push(`  CONSTRAINT ${quoteIdent(con.name)} ${con.definition}`)
    }
    let create = details.kind === 'f' ? 'CREATE FOREIGN TABLE' : 'CREATE TABLE'
    if (partRow?.parent && partRow.bound) {
      create = `CREATE TABLE ${fq} PARTITION OF ${partRow.parent} ${partRow.bound}`
      out.push(`${create};`)
    } else {
      let stmt = `${create} ${fq} (\n${lines.join(',\n')}\n)`
      if (partRow?.partkey) stmt += `\nPARTITION BY ${partRow.partkey}`
      out.push(`${stmt};`)
    }
    const extraIndexes = details.indexes.filter((i) => !i.isConstraint)
    if (extraIndexes.length) {
      out.push(extraIndexes.map((i) => `${i.definition};`).join('\n'))
    }
    if (details.triggers.length) {
      out.push(details.triggers.map((t) => `${t.definition};`).join('\n'))
    }
  }

  const comments: string[] = []
  if (details.comment) {
    const what = details.kind === 'v' ? 'VIEW' : details.kind === 'm' ? 'MATERIALIZED VIEW' : 'TABLE'
    comments.push(`COMMENT ON ${what} ${fq} IS ${literal(details.comment)};`)
  }
  for (const col of details.columns) {
    if (col.comment) {
      comments.push(`COMMENT ON COLUMN ${fq}.${quoteIdent(col.name)} IS ${literal(col.comment)};`)
    }
  }
  if (comments.length) out.push(comments.join('\n'))

  return out.join('\n\n') + '\n'
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function getFunctionDefinition(connectionId: string, database: string, oid: number): Promise<string> {
  const [row] = await query<{ def: string | null; kind: string; name: string; args: string; schema: string }>(
    connectionId,
    database,
    `SELECT CASE WHEN p.prokind IN ('f', 'p', 'w') THEN pg_get_functiondef(p.oid) END AS def,
            p.prokind::text AS kind, p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS args, n.nspname AS schema
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid = $1`,
    [oid],
  )
  if (!row) throw new Error('Function not found')
  if (row.def) return row.def.trim() + ';\n'
  return `-- Aggregate ${row.schema}.${row.name}(${row.args})\n-- Definition is not available via pg_get_functiondef.\n`
}

export async function getTypeDefinition(connectionId: string, database: string, oid: number): Promise<string> {
  const [row] = await query<{
    schema: string
    name: string
    typtype: string
    labels: string[] | null
    base: string | null
    notnull: boolean
    default_value: string | null
    checks: string[] | null
    attrs: string[] | null
    subtype: string | null
  }>(
    connectionId,
    database,
    `SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS typtype,
            (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels,
            CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS base,
            t.typnotnull AS notnull, t.typdefault AS default_value,
            (SELECT array_agg(pg_get_constraintdef(c.oid, true)) FROM pg_constraint c WHERE c.contypid = t.oid) AS checks,
            (SELECT array_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum)
               FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) AS attrs,
            (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid) AS subtype
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.oid = $1`,
    [oid],
  )
  if (!row) throw new Error('Type not found')
  const fq = qualifiedName(row.schema, row.name)
  switch (row.typtype) {
    case 'e':
      return `CREATE TYPE ${fq} AS ENUM (\n${(row.labels ?? []).map((l) => `  ${literal(l)}`).join(',\n')}\n);\n`
    case 'd': {
      let s = `CREATE DOMAIN ${fq} AS ${row.base}`
      if (row.default_value) s += `\n  DEFAULT ${row.default_value}`
      if (row.notnull) s += `\n  NOT NULL`
      for (const c of row.checks ?? []) s += `\n  ${c}`
      return `${s};\n`
    }
    case 'c':
      return `CREATE TYPE ${fq} AS (\n${(row.attrs ?? []).map((a) => `  ${a}`).join(',\n')}\n);\n`
    case 'r':
      return `CREATE TYPE ${fq} AS RANGE (SUBTYPE = ${row.subtype});\n`
    default:
      return `-- ${fq}\n`
  }
}

/** Tables and columns for SQL autocompletion. */
export async function getCompletionSchema(
  connectionId: string,
  database: string,
): Promise<{ schemas: string[]; tables: { schema: string; name: string; columns: string[] }[] }> {
  const rows = await query<{ schema: string; name: string; columns: string[] | null }>(
    connectionId,
    database,
    `SELECT n.nspname AS schema, c.relname AS name,
            (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_'
      ORDER BY n.nspname, c.relname
      LIMIT 3000`,
  )
  return {
    schemas: [...new Set(rows.map((r) => r.schema))],
    tables: rows.map((r) => ({ schema: r.schema, name: r.name, columns: r.columns ?? [] })),
  }
}

interface DatabaseOverview {
  counts: { tables: number; views: number; matviews: number; functions: number; schemas: number }
  largest: { schema: string; name: string; kind: RelationKind; bytes: number; rows: number | null }[]
  sessions: { state: string; count: number }[]
  cacheHitRatio: number | null
  extensions: { name: string; version: string }[]
}

export async function getDatabaseOverview(connectionId: string, database: string): Promise<DatabaseOverview> {
  const userSchemas = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_'`
  const [counts, largest, sessions, cache, extensions] = await Promise.all([
    query<{ tables: number; views: number; matviews: number; functions: number; schemas: number }>(
      connectionId,
      database,
      `SELECT
         (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${userSchemas}) AS tables,
         (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND ${userSchemas}) AS views,
         (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'm' AND ${userSchemas}) AS matviews,
         (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${userSchemas}
             AND ${NOT_EXTENSION_MEMBER('p.oid', 'pg_proc')}) AS functions,
         (SELECT count(*)::int FROM pg_namespace n WHERE ${userSchemas}) AS schemas`,
    ),
    query<{ schema: string; name: string; kind: RelationKind; bytes: string; rows: number | null }>(
      connectionId,
      database,
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
              CASE WHEN c.relkind = 'p' THEN t.bytes ELSE pg_total_relation_size(c.oid) END AS bytes,
              CASE WHEN c.relkind = 'p' THEN t.rows
                   WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::float8 END AS rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         -- a partitioned table counts with all of its partitions (which are not listed on their own)
         CROSS JOIN LATERAL (
           SELECT sum(pg_total_relation_size(p.relid))::bigint AS bytes,
                  sum(greatest(pc.reltuples, 0))::float8 AS rows
             FROM pg_partition_tree(c.oid) p JOIN pg_class pc ON pc.oid = p.relid WHERE p.isleaf
         ) t
        WHERE c.relkind IN ('r', 'p', 'm') AND NOT c.relispartition AND ${userSchemas}
        ORDER BY 4 DESC NULLS LAST
        LIMIT 8`,
    ),
    query<{ state: string; count: number }>(
      connectionId,
      database,
      `SELECT coalesce(state, 'background') AS state, count(*)::int AS count
         FROM pg_stat_activity WHERE datname = current_database()
        GROUP BY 1 ORDER BY 2 DESC`,
    ).catch(() => []),
    query<{ ratio: number | null }>(
      connectionId,
      database,
      `SELECT CASE WHEN blks_hit + blks_read = 0 THEN NULL
                   ELSE round(blks_hit::numeric * 100 / (blks_hit + blks_read), 2)::float8 END AS ratio
         FROM pg_stat_database WHERE datname = current_database()`,
    ).catch(() => []),
    query<{ name: string; version: string }>(
      connectionId,
      database,
      `SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname`,
    ),
  ])
  return {
    counts: counts[0]!,
    largest: largest.map((r) => ({ ...r, bytes: num(r.bytes) })),
    sessions,
    cacheHitRatio: cache[0]?.ratio ?? null,
    extensions,
  }
}
