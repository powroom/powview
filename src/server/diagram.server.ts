import { DIAGRAM_TABLE_LIMIT } from '@/lib/diagram'
import type { DiagramColumn, DiagramForeignKey, DiagramTable, SchemaDiagram } from '@/lib/diagram'
import type { RelationKind } from '@/lib/types'
import { NOT_EXTENSION_MEMBER, numOrNull } from './introspect.server'
import { query } from './pool.server'

/**
 * Schema diagram in exactly two catalog queries:
 *  A. relations (capped at DIAGRAM_TABLE_LIMIT + 1 by name) joined with their columns;
 *  B. foreign keys whose source table is one of the returned (capped) tables.
 */
export async function schemaDiagram(connectionId: string, database: string, schema: string): Promise<SchemaDiagram> {
  // Query A: the LIMIT 301 lets us detect truncation without fetching the whole schema.
  const relRows = await query<{
    table_name: string
    kind: RelationKind
    estimated_rows: number | null
    column_name: string | null
    column_type: string | null
    nullable: boolean | null
    is_primary_key: boolean | null
    is_foreign_key: boolean | null
  }>(
    connectionId,
    database,
    `WITH rels AS (
       SELECT c.oid, c.relname, c.relkind, c.reltuples
         FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND NOT c.relispartition
          -- objects of an extension (such as the pg_stat_statements views) are left out, as in the sidebar
          AND ${NOT_EXTENSION_MEMBER('c.oid', 'pg_class')}
        ORDER BY c.relname
        LIMIT ${DIAGRAM_TABLE_LIMIT + 1}
     )
     SELECT r.relname AS table_name,
            r.relkind::text AS kind,
            CASE WHEN r.reltuples < 0 THEN NULL ELSE r.reltuples::float8 END AS estimated_rows,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS column_type,
            NOT a.attnotnull AS nullable,
            EXISTS (SELECT 1 FROM pg_constraint con
                     WHERE con.conrelid = r.oid AND con.contype = 'p' AND a.attnum = ANY(con.conkey)) AS is_primary_key,
            EXISTS (SELECT 1 FROM pg_constraint con
                     WHERE con.conrelid = r.oid AND con.contype = 'f' AND a.attnum = ANY(con.conkey)) AS is_foreign_key
       FROM rels r
       LEFT JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY r.relname, a.attnum`,
    [schema],
  )

  // Group the flat rows into tables, preserving the query's name order and attnum order.
  const byName = new Map<string, DiagramTable>()
  for (const r of relRows) {
    let table = byName.get(r.table_name)
    if (!table) {
      table = {
        name: r.table_name,
        kind: r.kind,
        columns: [],
        estimatedRows: numOrNull(r.estimated_rows),
      }
      byName.set(r.table_name, table)
    }
    // A relation with no columns comes back as one row with null column fields. Otherwise the
    // other column fields are set too, since they come from the same pg_attribute row.
    if (r.column_name != null) {
      const column: DiagramColumn = {
        name: r.column_name,
        type: r.column_type!,
        nullable: r.nullable!,
        isPrimaryKey: r.is_primary_key!,
        isForeignKey: r.is_foreign_key!,
      }
      table.columns.push(column)
    }
  }

  const allTables = [...byName.values()]
  const truncated = allTables.length > DIAGRAM_TABLE_LIMIT
  const tables = allTables.slice(0, DIAGRAM_TABLE_LIMIT)

  // Query B: foreign keys from the capped set only, so the diagram stays self-consistent.
  // Names are unique per namespace, so filtering by name within the schema selects exactly the kept tables.
  const fkRows = await query<{
    name: string
    from_table: string
    to_schema: string
    to_table: string
    from_columns: string[] | null
    to_columns: string[] | null
  }>(
    connectionId,
    database,
    `SELECT con.conname AS name,
            c.relname AS from_table,
            fn.nspname AS to_schema,
            fc.relname AS to_table,
            array_agg(fa.attname::text ORDER BY k.ord) AS from_columns,
            array_agg(ta.attname::text ORDER BY k.ord) AS to_columns
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(fnum, tnum, ord)
       JOIN pg_attribute fa ON fa.attrelid = con.conrelid AND fa.attnum = k.fnum
       JOIN pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = k.tnum
      WHERE con.contype = 'f'
        AND con.conrelid IN (
              SELECT c2.oid FROM pg_class c2
               WHERE c2.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
                 AND c2.relname = ANY($2::text[]))
      GROUP BY con.oid, con.conname, c.relname, fn.nspname, fc.relname
      ORDER BY c.relname, con.conname`,
    [schema, tables.map((t) => t.name)],
  )

  const foreignKeys: DiagramForeignKey[] = fkRows.map((r) => ({
    name: r.name,
    fromTable: r.from_table,
    // array_agg over a group with at least one row is never NULL
    fromColumns: r.from_columns!,
    toSchema: r.to_schema,
    toTable: r.to_table,
    toColumns: r.to_columns!,
  }))

  return { schema, tables, foreignKeys, truncated }
}
