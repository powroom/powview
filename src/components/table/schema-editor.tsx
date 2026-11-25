/**
 * Changing a table's structure from forms: columns, indexes, constraints, the table's
 * name and comment, and new tables. Every dialog shows the SQL it will run.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon, KeyRoundIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react'
import { Fragment, useEffect, useEffectEvent, useState } from 'react'
import type { ReactNode } from 'react'
import { executeSqlFn } from '@/api/explorer.functions'
import { SqlCodeView } from '@/components/sql/codemirror'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from '@/components/ui/autocomplete'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { useRetained } from '@/hooks/use-retained'
import {
  COMMON_TYPES,
  addColumnSql,
  addConstraintSql,
  alterColumnSql,
  createIndexSql,
  createSchemaSql,
  createTableSql,
  ddlScript,
  nameProblem,
  renameTableSql,
  schemaNameProblem,
  suggestIndexName,
  tableCommentSql,
} from '@/lib/ddl'
import type { ColumnDraft, ConstraintDraft, IndexDraft, ReferentialAction } from '@/lib/ddl'
import { useProductionGuard } from '@/lib/production-guard'
import { allRelationsQuery, keys, relationDetailsQuery, schemaObjectsQuery } from '@/lib/queries'
import { classifySql } from '@/lib/sql-safety'
import { displayQualified } from '@/lib/sql'
import type { ColumnInfo, RelationDetails } from '@/lib/types'

interface DdlTarget {
  connectionId: string
  database: string
  schema: string
}

// ---------------------------------------------------------------------------
// running a script
// ---------------------------------------------------------------------------

function useApplyDdl(target: Pick<DdlTarget, 'connectionId' | 'database'>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (sql: string) => {
      const res = await executeSqlFn({
        data: {
          connectionId: target.connectionId,
          database: target.database,
          sql,
          maxRows: 1,
          executionId: crypto.randomUUID(),
        },
      })
      if (res.error) {
        throw new Error(
          [res.error.message, res.error.detail, res.error.hint && `Hint: ${res.error.hint}`].filter(Boolean).join('\n'),
        )
      }
      return res
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.db(target.connectionId, target.database) })
    },
  })
}

/** Types offered for a column: the usual ones plus the database's own (enums, domains, …). */
function useTypeOptions(target: DdlTarget) {
  const { data } = useQuery(schemaObjectsQuery(target.connectionId, target.database, target.schema))
  const own = (data?.types ?? []).map((t) => displayQualified(t.schema, t.name))
  const enums = new Set((data?.types ?? []).filter((t) => t.kind === 'e').map((t) => t.name))
  return { options: [...own, ...COMMON_TYPES], enums }
}

// ---------------------------------------------------------------------------
// dialog shell
// ---------------------------------------------------------------------------

export function DdlDialog({
  open,
  onOpenChange,
  title,
  description,
  statements,
  problem,
  applyLabel,
  target,
  onApplied,
  onInvalidSubmit,
  children,
  wide,
  destructive,
  successToast,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  statements: string[]
  /** why it cannot be applied yet (shown on the button's tooltip) */
  problem?: string | null
  applyLabel: string
  /** the connection and database the statements run on; the schema is not needed here */
  target: Pick<DdlTarget, 'connectionId' | 'database'>
  onApplied?: () => void
  children?: ReactNode
  wide?: boolean
  destructive?: boolean
  /** replaces the default "Structure updated" toast */
  successToast?: { title: string; description?: string }
  /** Enter pressed while blocked: lets the dialog reveal the field's problem */
  onInvalidSubmit?: () => void
}) {
  const apply = useApplyDdl(target)
  const guard = useProductionGuard(target.connectionId, target.database)
  const sql = ddlScript(statements)
  const resetApply = useEffectEvent(() => {
    apply.reset()
  })
  useEffect(() => {
    if (open) resetApply()
  }, [open])
  const blocked = problem ?? (statements.length === 0 ? 'Nothing to change yet' : null)
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className={wide ? 'sm:max-w-3xl' : 'sm:max-w-xl'}>
        <form
          className="contents"
          // Enter in a field does not submit while the Apply button is disabled, so it is caught here
          onKeyDown={(e) => {
            const field = e.target as HTMLElement
            if (e.key !== 'Enter' || !blocked || e.nativeEvent.isComposing || field.tagName !== 'INPUT') return
            if (field.getAttribute('aria-expanded') === 'true') return
            e.preventDefault()
            onInvalidSubmit?.()
          }}
          onSubmit={(e) => {
            e.preventDefault()
            if (blocked) {
              onInvalidSubmit?.()
              return
            }
            void guard({
              action:
                statements.length === 1 ? 'Run one structure change' : `Run ${statements.length} structure changes`,
              sql,
              destructive: classifySql(sql).destructive,
            }).then((ok) => {
              if (!ok) return
              apply.mutate(sql, {
                onSuccess: () => {
                  toastManager.add({
                    type: 'success',
                    title: successToast?.title ?? 'Structure updated',
                    description:
                      successToast?.description ??
                      (statements.length === 1
                        ? statements[0]!.split('\n')[0]
                        : `${statements.length} changes applied`),
                  })
                  onApplied?.()
                  onOpenChange(false)
                },
              })
            })
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {children}
            {apply.error && (
              <Alert variant="error">
                <CircleAlertIcon />
                <AlertTitle>Not applied. Nothing was changed.</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap break-words">{apply.error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">SQL that will run</span>
              {/* fixed height: the dialog keeps its size as the SQL grows, and the box scrolls */}
              <div className="h-40 shrink-0 overflow-hidden rounded-lg border bg-muted/30">
                <SqlCodeView className="h-full" value={sql || '-- fill in the form'} />
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Tooltip>
              <TooltipTrigger
                render={
                  // a disabled button gets no pointer events: the wrapper shows why
                  <span className="inline-flex" />
                }
              >
                <Button
                  disabled={Boolean(blocked)}
                  loading={apply.isPending}
                  type="submit"
                  variant={destructive ? 'destructive' : 'default'}
                >
                  {applyLabel}
                </Button>
              </TooltipTrigger>
              {blocked && <TooltipPopup>{blocked}</TooltipPopup>}
            </Tooltip>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function Problem({ children }: { children: ReactNode }) {
  if (!children) return null
  return <p className="text-destructive-foreground text-xs">{children}</p>
}

// ---------------------------------------------------------------------------
// type picker
// ---------------------------------------------------------------------------

function TypeInput({
  value,
  onChange,
  options,
  invalid,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  invalid?: boolean
}) {
  return (
    <Autocomplete items={options} onValueChange={(v) => onChange(v)} openOnInputClick value={value}>
      <AutocompleteInput
        aria-invalid={invalid || undefined}
        className="font-mono text-[13px]"
        placeholder="e.g. text"
        size="sm"
        spellCheck={false}
      />
      <AutocompletePopup>
        <AutocompleteList>
          {(t: string) => (
            <AutocompleteItem className="font-mono text-[13px]" key={t} value={t}>
              {t}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  )
}

// ---------------------------------------------------------------------------
// column
// ---------------------------------------------------------------------------

const emptyColumn = (): ColumnDraft => ({ name: '', type: 'text', nullable: true, defaultValue: '', comment: '' })

function columnToDraft(c: ColumnInfo): ColumnDraft {
  return {
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    defaultValue: c.identity || c.generated ? '' : (c.defaultValue ?? ''),
    comment: c.comment ?? '',
  }
}

/** Add a column (`column` null) or change one. */
export function ColumnDialog({
  open,
  onOpenChange,
  target,
  table,
  column,
  takenNames,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DdlTarget
  table: string
  column: ColumnInfo | null
  takenNames: string[]
}) {
  const shown = useRetained(open ? { column } : null)
  const editing = shown?.column ?? null
  const [draft, setDraft] = useState<ColumnDraft>(emptyColumn)
  const [touched, setTouched] = useState(false)
  const { options, enums } = useTypeOptions(target)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDraft(column ? columnToDraft(column) : emptyColumn())
      setTouched(false)
    }
  }

  const set = (patch: Partial<ColumnDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const nameIssue = nameProblem(
    draft.name,
    takenNames.filter((n) => n !== editing?.name),
  )
  const typeIssue = draft.type.trim() ? null : 'Required'
  const statements =
    nameIssue || typeIssue
      ? []
      : editing
        ? alterColumnSql(target.schema, table, columnToDraft(editing), draft, enums)
        : addColumnSql(target.schema, table, draft, enums)
  const lockedDefault = Boolean(editing?.identity || editing?.generated)

  return (
    <DdlDialog
      applyLabel={editing ? 'Apply changes' : 'Add column'}
      description={
        editing ? (
          <>
            Column <span className="font-mono text-foreground">{editing.name}</span> of{' '}
            <span className="font-mono">{displayQualified(target.schema, table)}</span>
          </>
        ) : (
          <>
            New column in <span className="font-mono">{displayQualified(target.schema, table)}</span>
          </>
        )
      }
      onInvalidSubmit={() => setTouched(true)}
      onOpenChange={onOpenChange}
      open={open}
      problem={touched || draft.name ? (nameIssue ?? typeIssue) : nameIssue && 'Give the column a name'}
      statements={statements}
      target={target}
      title={editing ? 'Edit column' : 'Add column'}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            aria-invalid={Boolean(touched && nameIssue) || undefined}
            autoFocus
            className="font-mono text-[13px]"
            onChange={(e) => {
              setTouched(true)
              set({ name: e.target.value })
            }}
            placeholder="e.g. status"
            size="sm"
            spellCheck={false}
            value={draft.name}
          />
          <Problem>{touched && nameIssue}</Problem>
        </Field>
        <Field>
          <FieldLabel>Type</FieldLabel>
          <TypeInput
            invalid={Boolean(typeIssue)}
            onChange={(type) => set({ type })}
            options={options}
            value={draft.type}
          />
          {editing && draft.type.trim() !== editing.type && (
            <FieldDescription>
              Existing values are converted. If one does not fit the new type, nothing is changed.
            </FieldDescription>
          )}
        </Field>
      </div>
      <Field>
        <FieldLabel>Default</FieldLabel>
        <Input
          className="font-mono text-[13px]"
          disabled={lockedDefault}
          onChange={(e) => set({ defaultValue: e.target.value })}
          placeholder={
            lockedDefault ? 'Identity / generated column' : 'e.g. now(), 0 or draft. Leave empty for no default'
          }
          size="sm"
          spellCheck={false}
          value={draft.defaultValue}
        />
        <FieldDescription>
          Plain words are saved as text (draft becomes 'draft'). Expressions like now() are used as written.
        </FieldDescription>
      </Field>
      <Label className="justify-between rounded-lg border px-3 py-2.5 font-normal">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Allow NULL</span>
          <span className="text-muted-foreground text-xs">
            {draft.nullable ? 'The value may be left empty.' : 'Every row needs a value (NOT NULL).'}
          </span>
        </span>
        <Switch checked={draft.nullable} onCheckedChange={(nullable) => set({ nullable })} />
      </Label>
      {!editing && (
        <Label className="justify-between rounded-lg border px-3 py-2.5 font-normal">
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Unique</span>
            <span className="text-muted-foreground text-xs">No two rows may have the same value.</span>
          </span>
          <Switch checked={Boolean(draft.unique)} onCheckedChange={(unique) => set({ unique })} />
        </Label>
      )}
      {!editing && !draft.nullable && !draft.defaultValue.trim() && (
        <p className="text-muted-foreground text-xs">
          The table already has rows? Then a NOT NULL column needs a default, or adding it fails.
        </p>
      )}
      <Field>
        <FieldLabel>Comment</FieldLabel>
        <Input
          onChange={(e) => set({ comment: e.target.value })}
          placeholder="Optional"
          size="sm"
          value={draft.comment}
        />
      </Field>
    </DdlDialog>
  )
}

// ---------------------------------------------------------------------------
// column picker (index / constraint)
// ---------------------------------------------------------------------------

/** Columns in the order they were ticked (that order matters for an index). */
function ColumnPicker({
  columns,
  value,
  onChange,
  types,
}: {
  columns: string[]
  value: string[]
  onChange: (v: string[]) => void
  types?: Record<string, string>
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  // matches the name or the type, so "json" finds jsonb columns
  const shown = needle
    ? columns.filter((c) => c.toLowerCase().includes(needle) || types?.[c]?.toLowerCase().includes(needle))
    : columns
  return (
    <div className="w-full rounded-lg border">
      {columns.length > 8 && (
        <div className="border-b p-1">
          <InputGroup>
            <InputGroupInput
              aria-label="Filter columns"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or type…"
              size="sm"
              spellCheck={false}
              value={query}
            />
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
          </InputGroup>
        </div>
      )}
      <div className="scrollbar-thin flex max-h-48 flex-col gap-0.5 overflow-y-auto p-1">
        {shown.map((c) => {
          const at = value.indexOf(c)
          const type = types?.[c]
          return (
            <Label className="cursor-pointer rounded-md px-2 py-1.5 font-normal hover:bg-accent" key={c}>
              <Checkbox
                checked={at >= 0}
                onCheckedChange={(checked) => onChange(checked ? [...value, c] : value.filter((x) => x !== c))}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{c}</span>
              {at >= 0 && value.length > 1 && (
                <Badge className="tabular-nums" size="sm" variant="outline">
                  {at + 1}
                </Badge>
              )}
              {type && (
                <span className="max-w-[45%] shrink-0 truncate font-mono text-muted-foreground text-xs">{type}</span>
              )}
            </Label>
          )
        })}
        {shown.length === 0 && <p className="px-2 py-1.5 text-muted-foreground text-xs">No columns match.</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

const METHODS: IndexDraft['method'][] = ['btree', 'hash', 'gin', 'gist', 'brin']
const METHOD_HINTS: Record<IndexDraft['method'], string> = {
  btree: 'default',
  hash: 'equality only',
  gin: 'jsonb, arrays, full text',
  gist: 'ranges, geometry',
  brin: 'huge, ordered tables',
}

export function IndexDialog({
  open,
  onOpenChange,
  target,
  table,
  columns,
  takenNames,
  columnTypes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DdlTarget
  table: string
  columns: string[]
  takenNames: string[]
  columnTypes?: Record<string, string>
}) {
  const [draft, setDraft] = useState<IndexDraft>({ name: '', columns: [], unique: false, method: 'btree', where: '' })
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setDraft({ name: '', columns: [], unique: false, method: 'btree', where: '' })
  }
  const set = (patch: Partial<IndexDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const name = draft.name.trim() || suggestIndexName(table, draft.columns, draft.unique)
  const problem = draft.columns.length === 0 ? 'Pick at least one column' : nameProblem(name, takenNames)
  const wantsGin =
    draft.method === 'btree' &&
    draft.columns.some((c) => {
      const t = columnTypes?.[c]
      return !!t && (t === 'jsonb' || t === 'tsvector' || t.endsWith('[]'))
    })
  return (
    <DdlDialog
      applyLabel="Create index"
      description="Speeds up filtering and sorting on these columns. A unique index also rejects duplicates."
      onOpenChange={onOpenChange}
      open={open}
      problem={problem}
      statements={problem ? [] : [createIndexSql(target.schema, table, { ...draft, name })]}
      target={target}
      title="Add index"
    >
      <Field className="w-full">
        <FieldLabel>Columns</FieldLabel>
        <ColumnPicker
          columns={columns}
          onChange={(c) => set({ columns: c })}
          types={columnTypes}
          value={draft.columns}
        />
        {draft.columns.length >= 2 && (
          <FieldDescription>
            Order:{' '}
            {draft.columns.map((c, i) => (
              <Fragment key={c}>
                {i > 0 && ', '}
                <span className="font-mono">{c}</span>
              </Fragment>
            ))}
            . Put the column you filter on most first.
          </FieldDescription>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            className="font-mono text-[13px]"
            onChange={(e) => set({ name: e.target.value })}
            placeholder={suggestIndexName(table, draft.columns, draft.unique)}
            size="sm"
            spellCheck={false}
            value={draft.name}
          />
        </Field>
        <Field>
          <FieldLabel>Method</FieldLabel>
          <Select
            items={METHODS.map((m) => ({ label: m, value: m }))}
            onValueChange={(v) => set({ method: v as IndexDraft['method'] })}
            value={draft.method}
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                  <span className="ms-2 text-muted-foreground text-xs">{METHOD_HINTS[m]}</span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {wantsGin && (
            <p className="text-muted-foreground text-xs">
              jsonb, array and full text columns usually need gin.{' '}
              <Button className="h-auto px-0 sm:h-auto" onClick={() => set({ method: 'gin' })} size="xs" variant="link">
                Use gin
              </Button>
            </p>
          )}
        </Field>
      </div>
      <Label className="justify-between rounded-lg border px-3 py-2.5 font-normal">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Unique</span>
          <span className="text-muted-foreground text-xs">Rejects two rows with the same values in these columns.</span>
        </span>
        <Switch checked={draft.unique} onCheckedChange={(unique) => set({ unique })} />
      </Label>
      <Field>
        <FieldLabel>Only rows where (optional)</FieldLabel>
        <Input
          className="font-mono text-[13px]"
          onChange={(e) => set({ where: e.target.value })}
          placeholder="e.g. deleted_at IS NULL"
          size="sm"
          spellCheck={false}
          value={draft.where}
        />
      </Field>
    </DdlDialog>
  )
}

// ---------------------------------------------------------------------------
// constraint
// ---------------------------------------------------------------------------

const ACTIONS: ReferentialAction[] = ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT']
const ACTION_LABELS: Record<ReferentialAction, string> = {
  'NO ACTION': 'Block the delete',
  RESTRICT: 'Block the delete',
  CASCADE: 'Delete these rows too',
  'SET NULL': 'Set this column to NULL',
  'SET DEFAULT': 'Set this column to its default',
}
type ConstraintType = ConstraintDraft['type']

const CONSTRAINT_KINDS: { value: ConstraintType; label: string }[] = [
  { value: 'foreign', label: 'Foreign key: refers to a row in another table' },
  { value: 'unique', label: 'Unique: no two rows may have the same value' },
  { value: 'check', label: 'Check: a condition every row must meet' },
]

export function ConstraintDialog({
  open,
  onOpenChange,
  target,
  table,
  columns,
  takenNames,
  columnTypes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DdlTarget
  table: string
  columns: string[]
  takenNames: string[]
  columnTypes?: Record<string, string>
}) {
  const [type, setType] = useState<ConstraintType>('foreign')
  const [name, setName] = useState('')
  const [cols, setCols] = useState<string[]>([])
  const [ref, setRef] = useState<{ schema: string; table: string } | null>(null)
  const [refCol, setRefCol] = useState('')
  const [onDelete, setOnDelete] = useState<ReferentialAction>('NO ACTION')
  const [expression, setExpression] = useState('')
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setType('foreign')
      setName('')
      setCols([])
      setRef(null)
      setRefCol('')
      setOnDelete('NO ACTION')
      setExpression('')
    }
  }

  const relations = useQuery({
    ...allRelationsQuery(target.connectionId, target.database),
    enabled: open && type === 'foreign',
  })
  const tables = (relations.data ?? []).filter((r) => (r.kind === 'r' || r.kind === 'p') && !r.isPartition)
  const refDetails = useQuery({
    ...relationDetailsQuery(target.connectionId, target.database, ref?.schema ?? '', ref?.table ?? ''),
    enabled: Boolean(ref),
  })
  // the referenced table's primary key is what is usually meant
  const [prevRefData, setPrevRefData] = useState<typeof refDetails.data | null>(null)
  if (refDetails.data !== prevRefData) {
    setPrevRefData(refDetails.data)
    const d = refDetails.data
    if (d) setRefCol(d.primaryKey.length === 1 ? d.primaryKey[0]! : (d.columns[0]?.name ?? ''))
  }

  const draft: ConstraintDraft | null =
    type === 'foreign'
      ? cols.length === 1 && ref && refCol
        ? {
            type,
            name,
            columns: cols,
            refSchema: ref.schema,
            refTable: ref.table,
            refColumns: [refCol],
            onDelete,
            onUpdate: 'NO ACTION',
          }
        : null
      : type === 'unique'
        ? cols.length
          ? { type, name, columns: cols }
          : null
        : expression.trim()
          ? { type, name, expression }
          : null
  const nameIssue = name.trim() ? nameProblem(name, takenNames) : null
  const missing =
    type === 'foreign'
      ? 'Pick a column and the table it refers to'
      : type === 'unique'
        ? 'Pick at least one column'
        : 'Write the condition'
  const problem = nameIssue ?? (draft ? null : missing)
  const tableItems = tables.map((t) => ({
    label: displayQualified(t.schema, t.name),
    value: `${t.schema}\u0000${t.name}`,
  }))

  return (
    <DdlDialog
      applyLabel="Add constraint"
      description="Rules PostgreSQL checks on every insert and update. Existing rows must already follow them."
      onOpenChange={onOpenChange}
      open={open}
      problem={problem}
      statements={draft && !problem ? [addConstraintSql(target.schema, table, draft)] : []}
      target={target}
      title="Add constraint"
    >
      <Field>
        <FieldLabel>Kind</FieldLabel>
        <Select
          items={CONSTRAINT_KINDS}
          onValueChange={(v) => {
            setType(v as ConstraintType)
            setCols([])
          }}
          value={type}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {CONSTRAINT_KINDS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      {/* as tall as the foreign key form, so switching kinds does not move the dialog */}
      <div className="flex flex-col gap-4 max-sm:min-h-[8.25rem] sm:min-h-[7.5rem]">
        {type === 'foreign' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Column</FieldLabel>
                <Select
                  items={columns.map((c) => ({ label: c, value: c }))}
                  onValueChange={(v) => setCols(v ? [v as string] : [])}
                  value={cols[0] ?? null}
                >
                  <SelectTrigger className="font-mono text-[13px]" size="sm">
                    <SelectValue placeholder="Pick a column" />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {columns.map((c) => (
                      <SelectItem className="font-mono text-[13px]" key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Refers to table</FieldLabel>
                <Select
                  items={tableItems}
                  onValueChange={(v) => {
                    const [schema, t] = String(v).split('\u0000')
                    setRef(schema && t ? { schema, table: t } : null)
                  }}
                  value={ref ? `${ref.schema}\u0000${ref.table}` : null}
                >
                  <SelectTrigger className="font-mono text-[13px]" size="sm">
                    <SelectValue placeholder={relations.isPending ? 'Loading…' : 'Pick a table'} />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {tableItems.map((t) => (
                      <SelectItem className="font-mono text-[13px]" key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Column in that table</FieldLabel>
                <Select
                  disabled={!refDetails.data}
                  items={(refDetails.data?.columns ?? []).map((c) => ({ label: c.name, value: c.name }))}
                  onValueChange={(v) => setRefCol(String(v ?? ''))}
                  value={refCol || null}
                >
                  <SelectTrigger className="font-mono text-[13px]" size="sm">
                    <SelectValue placeholder="Pick a column" />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {(refDetails.data?.columns ?? []).map((c) => (
                      <SelectItem className="font-mono text-[13px]" key={c.name} value={c.name}>
                        <span className="flex items-center gap-1.5">
                          {c.name}
                          {c.isPrimaryKey && (
                            <KeyRoundIcon aria-label="Primary key" className="size-3 text-amber-500" />
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>When that row is deleted</FieldLabel>
                <Select
                  items={ACTIONS.map((a) => ({ label: ACTION_LABELS[a], value: a }))}
                  onValueChange={(v) => setOnDelete(v as ReferentialAction)}
                  value={onDelete}
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {ACTIONS.map((a) => (
                      <SelectItem key={a} value={a}>
                        {ACTION_LABELS[a]}
                        <span className="ms-2 font-mono text-[11px] text-muted-foreground">{a}</span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
          </>
        )}
        {type === 'unique' && (
          <Field className="w-full">
            <FieldLabel>Columns</FieldLabel>
            <ColumnPicker columns={columns} onChange={setCols} types={columnTypes} value={cols} />
          </Field>
        )}
        {type === 'check' && (
          <Field>
            <FieldLabel>Condition</FieldLabel>
            <Textarea
              className="font-mono text-[13px]"
              onChange={(e) => setExpression(e.target.value)}
              placeholder="e.g. price >= 0"
              rows={2}
              spellCheck={false}
              value={expression}
            />
          </Field>
        )}
      </div>
      <Field>
        <FieldLabel>Name (optional)</FieldLabel>
        <Input
          className="font-mono text-[13px]"
          onChange={(e) => setName(e.target.value)}
          placeholder="PostgreSQL picks one"
          size="sm"
          spellCheck={false}
          value={name}
        />
      </Field>
    </DdlDialog>
  )
}

// ---------------------------------------------------------------------------
// table name & comment
// ---------------------------------------------------------------------------

export function TableSettingsDialog({
  open,
  onOpenChange,
  target,
  details,
  takenNames = [],
  onRenamed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DdlTarget
  details: Pick<RelationDetails, 'name' | 'kind' | 'comment'>
  /** other relation names in the schema (the new name must not be one of them) */
  takenNames?: string[]
  onRenamed?: (name: string) => void
}) {
  const [name, setName] = useState(details.name)
  const [comment, setComment] = useState(details.comment ?? '')
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName(details.name)
      setComment(details.comment ?? '')
    }
  }
  const kind =
    details.kind === 'v'
      ? 'VIEW'
      : details.kind === 'm'
        ? 'MATERIALIZED VIEW'
        : details.kind === 'f'
          ? 'FOREIGN TABLE'
          : 'TABLE'
  const issue = nameProblem(
    name,
    takenNames.filter((n) => n !== details.name),
  )
  const statements: string[] = []
  if (!issue && comment.trim() !== (details.comment ?? '').trim()) {
    statements.push(tableCommentSql(target.schema, details.name, comment, kind))
  }
  if (!issue && name.trim() !== details.name) statements.push(renameTableSql(target.schema, details.name, name, kind))
  return (
    <DdlDialog
      applyLabel="Apply changes"
      description={<span className="font-mono">{displayQualified(target.schema, details.name)}</span>}
      onApplied={() => name.trim() !== details.name && onRenamed?.(name.trim())}
      onOpenChange={onOpenChange}
      open={open}
      problem={issue}
      statements={statements}
      target={target}
      title="Name and description"
    >
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input
          autoFocus
          className="font-mono text-[13px]"
          onChange={(e) => setName(e.target.value)}
          size="sm"
          spellCheck={false}
          value={name}
        />
        <Problem>{name !== details.name && issue}</Problem>
        {name.trim() !== details.name && (
          <FieldDescription>Queries, views and code that use the old name stop working.</FieldDescription>
        )}
      </Field>
      <Field>
        <FieldLabel>Comment</FieldLabel>
        <Textarea
          onChange={(e) => setComment(e.target.value)}
          placeholder="What this table holds"
          rows={2}
          value={comment}
        />
      </Field>
    </DdlDialog>
  )
}

// ---------------------------------------------------------------------------
// drop (column / index / constraint)
// ---------------------------------------------------------------------------

export function DropDialog({
  open,
  onOpenChange,
  target,
  title,
  description,
  statement,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DdlTarget
  title: string
  description: ReactNode
  statement: string | null
}) {
  const shown = useRetained(open ? { title, description, statement } : null)
  return (
    <DdlDialog
      applyLabel="Drop"
      description={shown?.description}
      destructive
      onOpenChange={onOpenChange}
      open={open}
      statements={shown?.statement ? [shown.statement] : []}
      target={target}
      title={shown?.title}
    />
  )
}

// ---------------------------------------------------------------------------
// new table
// ---------------------------------------------------------------------------

/** A column in the create-table draft. `rowId` is only for React keys and is never sent to the server. */
type DraftColumn = ColumnDraft & { rowId: string }

const starterColumns = (): DraftColumn[] => [
  {
    rowId: crypto.randomUUID(),
    name: 'id',
    type: 'bigint',
    nullable: false,
    defaultValue: '',
    comment: '',
    primaryKey: true,
    identity: true,
  },
  { rowId: crypto.randomUUID(), name: 'name', type: 'text', nullable: false, defaultValue: '', comment: '' },
  {
    rowId: crypto.randomUUID(),
    name: 'created_at',
    type: 'timestamptz',
    nullable: false,
    defaultValue: 'now()',
    comment: '',
  },
]

type DialogTab = 'table' | 'schema'

/** One dialog for new objects: a table in the current schema, or a schema. */
export function CreateObjectDialog({
  open,
  onOpenChange,
  target,
  tableNames,
  schemaNames,
  onTableCreated,
  onSchemaCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DdlTarget
  tableNames: string[]
  schemaNames: string[]
  onTableCreated?: (name: string) => void
  onSchemaCreated?: (name: string) => void
}) {
  const [tab, setTab] = useState<DialogTab>('table')
  const [name, setName] = useState('')
  const [comment, setComment] = useState('')
  const [cols, setCols] = useState<DraftColumn[]>(starterColumns)
  const [touched, setTouched] = useState(false)
  const [schemaName, setSchemaName] = useState('')
  const [schemaComment, setSchemaComment] = useState('')
  const [schemaTouched, setSchemaTouched] = useState(false)
  const { options, enums } = useTypeOptions(target)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTab('table')
      setName('')
      setComment('')
      setCols(starterColumns())
      setTouched(false)
      setSchemaName('')
      setSchemaComment('')
      setSchemaTouched(false)
    }
  }

  const update = (i: number, patch: Partial<DraftColumn>) =>
    setCols((cs) =>
      cs.map((c, j) => {
        if (j !== i) return c
        const next = { ...c, ...patch }
        // identity needs an integer type and implies a value
        if (patch.identity) Object.assign(next, { nullable: false, defaultValue: '' })
        if (next.identity && !/^(smallint|integer|int|bigint|int[248])$/i.test(next.type.trim())) next.identity = false
        if (patch.primaryKey) next.nullable = false
        return next
      }),
    )
  const tableIssue = nameProblem(name, tableNames)
  const colIssues = cols.map(
    (c, i) =>
      nameProblem(
        c.name,
        cols.filter((_, j) => j !== i).map((x) => x.name.trim()),
      ) ?? (c.type.trim() ? null : 'Type required'),
  )
  const firstIssue = tableIssue
    ? `Table name: ${tableIssue}`
    : (colIssues.find(Boolean) ?? (cols.length ? null : 'Add a column'))
  const tableStatements = firstIssue ? [] : createTableSql(target.schema, name, cols, comment, enums)

  const schemaIssue = schemaNameProblem(schemaName, schemaNames)
  const schemaStatements = schemaIssue ? [] : createSchemaSql(schemaName, schemaComment)

  const isTable = tab === 'table'

  return (
    <DdlDialog
      applyLabel={isTable ? 'Create table' : 'Create schema'}
      description={
        isTable ? (
          <>
            In schema <span className="font-mono text-foreground">{target.schema}</span>. Columns and keys can be
            changed later.
          </>
        ) : (
          'Tables, views and other objects can then be created in it.'
        )
      }
      onApplied={() => (isTable ? onTableCreated?.(name.trim()) : onSchemaCreated?.(schemaName.trim()))}
      onInvalidSubmit={() => (isTable ? setTouched(true) : setSchemaTouched(true))}
      onOpenChange={onOpenChange}
      open={open}
      problem={isTable ? firstIssue : schemaIssue ? `Schema name: ${schemaIssue}` : null}
      statements={isTable ? tableStatements : schemaStatements}
      successToast={
        isTable
          ? undefined
          : { title: 'Schema created', description: `${schemaName.trim()} is ready for tables and views.` }
      }
      target={target}
      title={isTable ? 'New table' : 'New schema'}
      wide
    >
      <Tabs className="gap-4" onValueChange={(v) => setTab(v as DialogTab)} value={tab}>
        <TabsList>
          <TabsTab value="table">Table</TabsTab>
          <TabsTab value="schema">Schema</TabsTab>
        </TabsList>
        <TabsPanel className="flex flex-col gap-4" value="table">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Table name</FieldLabel>
              <Input
                aria-invalid={Boolean(touched && tableIssue) || undefined}
                autoFocus
                className="font-mono text-[13px]"
                onChange={(e) => {
                  setTouched(true)
                  setName(e.target.value)
                }}
                placeholder="e.g. invoices"
                size="sm"
                spellCheck={false}
                value={name}
              />
              <Problem>{touched && tableIssue}</Problem>
            </Field>
            <Field>
              <FieldLabel>Comment</FieldLabel>
              <Input onChange={(e) => setComment(e.target.value)} placeholder="Optional" size="sm" value={comment} />
            </Field>
          </div>
          <div className="flex flex-col gap-2">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto] items-end gap-2 px-0.5 text-muted-foreground text-xs sm:grid">
              <span>Column</span>
              <span>Type</span>
              <span>Default</span>
              <span className="w-9 text-center">Key</span>
              <span className="w-12 text-center">NULL</span>
              <span className="w-7" />
            </div>
            {/* Below sm each column is a card; from sm up the wrappers use `contents`, so the grid is the desktop row. */}
            {cols.map((c, i) => (
              <div
                className="flex flex-col gap-2 rounded-lg border p-2.5 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto] sm:items-center sm:rounded-none sm:border-0 sm:p-0"
                key={c.rowId}
              >
                <Input
                  aria-invalid={Boolean(c.name !== '' && colIssues[i]) || undefined}
                  aria-label="Column name"
                  className="font-mono text-[13px]"
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="name"
                  size="sm"
                  spellCheck={false}
                  value={c.name}
                />
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 sm:contents">
                  <TypeInput onChange={(type) => update(i, { type })} options={options} value={c.type} />
                  <Input
                    aria-label="Default"
                    className="font-mono text-[13px]"
                    disabled={c.identity}
                    onChange={(e) => update(i, { defaultValue: e.target.value })}
                    placeholder={c.identity ? 'Automatic' : 'None'}
                    size="sm"
                    spellCheck={false}
                    value={c.defaultValue}
                  />
                </div>
                <div className="flex items-center gap-3 sm:contents">
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex items-center gap-1.5 sm:w-9 sm:justify-center" />}>
                      <Checkbox
                        aria-label="Primary key"
                        checked={Boolean(c.primaryKey)}
                        onCheckedChange={(primaryKey) => update(i, { primaryKey })}
                      />
                      <span className="text-muted-foreground text-xs sm:hidden">Primary key</span>
                    </TooltipTrigger>
                    <TooltipPopup>Primary key{c.identity ? ' · auto-numbered' : ''}</TooltipPopup>
                  </Tooltip>
                  <span className="flex items-center gap-1.5 sm:w-12 sm:justify-center">
                    <Switch
                      aria-label="Allow NULL"
                      checked={c.nullable}
                      disabled={c.primaryKey}
                      onCheckedChange={(nullable) => update(i, { nullable })}
                    />
                    <span className="text-muted-foreground text-xs sm:hidden">NULL</span>
                  </span>
                  <Button
                    aria-label={`Remove column ${c.name || i + 1}`}
                    className="ml-auto sm:ml-0"
                    disabled={cols.length === 1}
                    onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button
                onClick={() =>
                  setCols((cs) => [
                    ...cs,
                    {
                      rowId: crypto.randomUUID(),
                      name: '',
                      type: 'text',
                      nullable: true,
                      defaultValue: '',
                      comment: '',
                    },
                  ])
                }
                size="sm"
                type="button"
                variant="outline"
              >
                <PlusIcon aria-hidden="true" />
                Add column
              </Button>
            </div>
          </div>
        </TabsPanel>
        {/* as tall as the Table tab with its three starter columns (measured), so switching tabs does not resize the dialog */}
        <TabsPanel className="flex min-h-[606px] flex-col gap-4 sm:min-h-[228px]" value="schema">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Schema name</FieldLabel>
              <Input
                aria-invalid={Boolean(schemaTouched && schemaIssue) || undefined}
                autoFocus
                className="font-mono text-[13px]"
                onChange={(e) => {
                  setSchemaTouched(true)
                  setSchemaName(e.target.value)
                }}
                placeholder="e.g. billing"
                size="sm"
                spellCheck={false}
                value={schemaName}
              />
              <Problem>{schemaTouched && schemaIssue}</Problem>
            </Field>
            <Field>
              <FieldLabel>Comment</FieldLabel>
              <Input
                onChange={(e) => setSchemaComment(e.target.value)}
                placeholder="Optional"
                size="sm"
                value={schemaComment}
              />
            </Field>
          </div>
        </TabsPanel>
      </Tabs>
    </DdlDialog>
  )
}
