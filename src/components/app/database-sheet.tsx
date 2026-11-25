/**
 * Edit sheet for one database (name, owner, comment, connection limit, connections, settings),
 * and the delete dialog it opens. Each change shows the SQL it will run before it runs.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { alterDatabaseFn, dropDatabaseFn } from '@/api/explorer.functions'
import {
  adminResultFailure,
  DatabaseSettingsEditor,
  FailureAlert,
  type Failure,
  settingRowProblems,
  type SettingRow,
} from '@/components/app/database-form-parts'
import { SqlCodeView } from '@/components/sql/codemirror'
import { Problem } from '@/components/table/schema-editor'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NumberField, NumberFieldGroup, NumberFieldInput } from '@/components/ui/number-field'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { useRetained } from '@/hooks/use-retained'
import { alterDatabaseSql, dropDatabaseSql, nameProblem } from '@/lib/ddl'
import type { DatabaseDraft } from '@/lib/ddl'
import { useProductionGuard } from '@/lib/production-guard'
import { keys, rolesQuery } from '@/lib/queries'
import type { DatabaseInfo } from '@/lib/types'

export function DatabaseSheet({
  connectionId,
  database,
  names,
  currentDatabase,
  defaultDatabase,
  readOnly,
  onClose,
}: {
  connectionId: string
  /** the database to edit; null while the sheet is closed */
  database: DatabaseInfo | null
  /** every database name on the server */
  names: string[]
  /** the database open in the app */
  currentDatabase: string
  /** the database the connection points at */
  defaultDatabase: string
  readOnly: boolean
  onClose: () => void
}) {
  // keeps the last database while the sheet slides out
  const shown = useRetained(database)
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open={database !== null}
    >
      {/* the popup unmounts when the sheet closes, so each opening starts from the saved state */}
      <SheetPopup className="max-sm:w-full">
        {shown && (
          <DatabaseForm
            connectionId={connectionId}
            currentDatabase={currentDatabase}
            database={shown}
            defaultDatabase={defaultDatabase}
            names={names}
            onClose={onClose}
            readOnly={readOnly}
          />
        )}
      </SheetPopup>
    </Sheet>
  )
}

function DatabaseForm({
  connectionId,
  database,
  names,
  currentDatabase,
  defaultDatabase,
  readOnly,
  onClose,
}: {
  connectionId: string
  database: DatabaseInfo
  names: string[]
  currentDatabase: string
  defaultDatabase: string
  readOnly: boolean
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database.name)
  const { data: roles } = useQuery(rolesQuery(connectionId))
  const save = useMutation({
    mutationFn: (desired: Required<DatabaseDraft>) =>
      alterDatabaseFn({ data: { connectionId, database: database.name, desired } }),
  })
  const [name, setName] = useState(database.name)
  const [owner, setOwner] = useState(database.owner)
  const [comment, setComment] = useState(database.comment ?? '')
  const [limit, setLimit] = useState<number | null>(database.connectionLimit)
  const [allowConnections, setAllowConnections] = useState(database.allowConnections)
  const [settings, setSettings] = useState<SettingRow[]>(() =>
    database.settings.map((s) => ({ id: crypto.randomUUID(), name: s.name, value: s.value })),
  )
  // a field shows its problem once it was typed in, or after a Save attempt; never on blur
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const [attempted, setAttempted] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const isDefault = database.name === defaultDatabase
  const locked = readOnly || !database.canManage
  const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)))
  const shownFor = (key: string) => attempted || touched.has(key)

  // every problem, keyed by field; the first one explains why Save is off
  const issues = new Map<string, string>()
  const nameIssue = nameProblem(
    name,
    names.filter((n) => n !== database.name),
  )
  if (nameIssue) issues.set('name', nameIssue)
  if (limit !== null && !Number.isInteger(limit)) issues.set('limit', 'Use a whole number')
  const settingIssue = [...settingRowProblems(settings).values()][0]
  if (settingIssue) issues.set('settings', settingIssue)
  const firstIssue = [...issues.values()][0] ?? null

  const desired: Required<DatabaseDraft> = {
    name: name.trim(),
    owner,
    comment: comment.trim() || null,
    connectionLimit: limit,
    allowConnections,
    settings: settings.map((s) => ({ name: s.name.trim(), value: s.value })),
  }
  const statements = firstIssue ? [] : alterDatabaseSql(database, desired)
  const sql = firstIssue
    ? '-- Fix the fields above first'
    : statements.length > 0
      ? `${statements.join(';\n')};`
      : '-- No changes yet'
  const blocked = locked ? null : (firstIssue ?? (statements.length === 0 ? 'No changes yet' : null))

  const roleNames = [...new Set([...(roles ?? []), database.owner])]
  const failure: Failure | null = save.error
    ? { title: 'Nothing was changed.', message: save.error.message, statement: null }
    : save.data && !save.data.ok
      ? adminResultFailure(save.data)
      : null

  const onSave = () => {
    if (blocked) {
      setAttempted(true)
      return
    }
    void guard({ action: 'Change a database', sql }).then((ok) => {
      if (!ok) return
      save.mutate(desired, {
        onSuccess: (result) => {
          // a partly applied change also changed the list
          void queryClient.invalidateQueries({ queryKey: keys.databases(connectionId) })
          if (!result.ok) return
          const newName = desired.name
          toastManager.add({ type: 'success', title: 'Database updated' })
          onClose()
          if (newName !== database.name && database.name === currentDatabase) {
            void navigate({ to: '/c/$connId/$db/databases', params: { connId: connectionId, db: newName } })
          }
        },
      })
    })
  }

  return (
    <>
      <form
        className="contents"
        // Enter in a field does not submit while Save is off, so it is caught here
        onKeyDown={(e) => {
          const field = e.target as HTMLElement
          if (e.key !== 'Enter' || !blocked || e.nativeEvent.isComposing || field.tagName !== 'INPUT') return
          e.preventDefault()
          setAttempted(true)
        }}
        onSubmit={(e) => {
          e.preventDefault()
          onSave()
        }}
      >
        <SheetHeader>
          <SheetTitle className="truncate pe-8">{database.name}</SheetTitle>
          <SheetDescription className="truncate">
            {database.encoding} · {database.collate} · {database.tablespace}
          </SheetDescription>
        </SheetHeader>

        <SheetPanel className="flex flex-col gap-5">
          {locked && (
            <p className="text-muted-foreground text-sm">
              {readOnly
                ? 'This connection is read-only.'
                : 'You are not the owner of this database, so you cannot change it.'}
            </p>
          )}

          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              aria-invalid={Boolean(shownFor('name') && nameIssue) || undefined}
              autoComplete="off"
              className="font-mono text-[13px]"
              disabled={locked || isDefault}
              onChange={(e) => {
                setName(e.target.value)
                touch('name')
              }}
              size="sm"
              spellCheck={false}
              value={name}
            />
            <Problem>{shownFor('name') && nameIssue}</Problem>
            <FieldDescription>
              {isDefault
                ? 'The connection uses this database, so it cannot be renamed.'
                : 'Renames the database on save.'}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Owner</FieldLabel>
            <Select
              disabled={locked}
              items={roleNames.map((r) => ({ label: r, value: r }))}
              onValueChange={(v) => {
                if (v) setOwner(v)
              }}
              value={owner}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {roleNames.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <FieldDescription>The role that owns the database.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Comment</FieldLabel>
            <Textarea
              disabled={locked}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What this database is for"
              rows={2}
              value={comment}
            />
            <FieldDescription>A short note for the people who use it.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Connection limit</FieldLabel>
            <NumberField
              disabled={locked}
              min={0}
              onValueChange={(v) => {
                setLimit(v)
                touch('limit')
              }}
              size="sm"
              value={limit}
            >
              <NumberFieldGroup>
                <NumberFieldInput
                  aria-invalid={Boolean(shownFor('limit') && issues.get('limit')) || undefined}
                  placeholder="No limit"
                />
              </NumberFieldGroup>
            </NumberField>
            <Problem>{shownFor('limit') && issues.get('limit')}</Problem>
            <FieldDescription>Most sessions that can connect at once. Empty means no limit.</FieldDescription>
          </Field>

          <Label className="justify-between rounded-lg border px-3 py-2.5 font-normal">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">Allow connections</span>
              <span className="text-muted-foreground text-xs">
                {isDefault
                  ? 'The connection uses this database, so it stays open.'
                  : 'When off, nobody can connect to this database.'}
              </span>
            </span>
            <Switch
              checked={allowConnections}
              disabled={locked || isDefault}
              onCheckedChange={(checked) => setAllowConnections(checked)}
            />
          </Label>

          <Collapsible>
            <CollapsibleTrigger
              className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1 font-medium text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring data-panel-open:*:data-[slot=advanced-indicator]:rotate-180"
              type="button"
            >
              Advanced
              {settings.length > 0 && (
                <span className="font-normal text-muted-foreground text-xs">
                  {settings.length} {settings.length === 1 ? 'setting' : 'settings'}
                </span>
              )}
              <ChevronDownIcon
                aria-hidden="true"
                className="ms-auto size-4 shrink-0 opacity-80 transition-transform duration-200"
                data-slot="advanced-indicator"
              />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="pt-2">
                <DatabaseSettingsEditor disabled={locked} onChange={setSettings} rows={settings} showAll={attempted} />
              </div>
            </CollapsiblePanel>
          </Collapsible>

          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">SQL that will run</span>
            {/* fixed height: the sheet keeps its size as the SQL changes, and the box scrolls */}
            <div className="h-40 shrink-0 overflow-hidden rounded-lg border bg-muted/30">
              <SqlCodeView className="h-full" value={sql} />
            </div>
          </div>

          {failure && <FailureAlert failure={failure} />}
        </SheetPanel>

        <SheetFooter className="flex-row items-center justify-between sm:justify-between">
          {locked ? (
            <SheetClose render={<Button variant="ghost" />}>Close</SheetClose>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <Button
                    disabled={isDefault}
                    onClick={() => setDeleteOpen(true)}
                    type="button"
                    variant="destructive-outline"
                  >
                    <Trash2Icon aria-hidden="true" />
                    {/* on phones only the icon fits next to Cancel and Save */}
                    <span className="max-sm:sr-only">Delete database</span>
                  </Button>
                </TooltipTrigger>
                {isDefault && (
                  <TooltipPopup>This is the connection's database. Change the connection first.</TooltipPopup>
                )}
              </Tooltip>
              <div className="flex items-center gap-2">
                <SheetClose render={<Button variant="ghost" />}>Cancel</SheetClose>
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex" />}>
                    <Button disabled={Boolean(blocked)} loading={save.isPending} type="submit">
                      Save changes
                    </Button>
                  </TooltipTrigger>
                  {blocked && <TooltipPopup>{blocked}</TooltipPopup>}
                </Tooltip>
              </div>
            </>
          )}
        </SheetFooter>
      </form>

      {/* outside the form, so typing in the dialog never reaches the form's keyboard handling */}
      {!locked && (
        <DeleteDatabaseDialog
          connectionId={connectionId}
          currentDatabase={currentDatabase}
          fallbackDatabase={defaultDatabase}
          name={database.name}
          onDeleted={onClose}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          sessions={database.sessions}
        />
      )}
    </>
  )
}

function DeleteDatabaseDialog({
  connectionId,
  name,
  sessions,
  currentDatabase,
  fallbackDatabase,
  open,
  onOpenChange,
  onDeleted,
}: {
  connectionId: string
  name: string
  sessions: number
  /** the database open in the app */
  currentDatabase: string
  /** where to go when the open database is deleted: the connection's own database */
  fallbackDatabase: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, name)
  const drop = useMutation({
    mutationFn: (force: boolean) => dropDatabaseFn({ data: { connectionId, database: name, force } }),
  })
  const [typed, setTyped] = useState('')
  const [force, setForce] = useState(false)
  // each opening starts empty (see ConfirmDialog)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTyped('')
      setForce(false)
    }
  }

  const sql = dropDatabaseSql(name, force)
  const failure: Failure | null = drop.error
    ? { title: 'Nothing was changed.', message: drop.error.message, statement: null }
    : drop.data && !drop.data.ok
      ? adminResultFailure(drop.data)
      : null

  const onConfirm = () => {
    if (typed !== name) return
    void guard({ action: 'Delete a database', sql, destructive: true }).then((ok) => {
      if (!ok) return
      drop.mutate(force, {
        onSuccess: (result) => {
          void queryClient.invalidateQueries({ queryKey: keys.databases(connectionId) })
          if (!result.ok) return
          toastManager.add({ type: 'success', title: 'Database deleted', description: name })
          onOpenChange(false)
          onDeleted()
          if (name === currentDatabase) {
            void navigate({ to: '/c/$connId/$db', params: { connId: connectionId, db: fallbackDatabase } })
          }
        },
      })
    })
  }

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete database ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the database and everything in it. It cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-4">
          <Field>
            <FieldLabel className="font-normal text-muted-foreground">
              Type <span className="font-medium font-mono text-foreground">{name}</span> to confirm
            </FieldLabel>
            <Input
              autoFocus
              className="font-mono text-[13px]"
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              value={typed}
            />
          </Field>
          <Label className="justify-between rounded-lg border px-3 py-2.5 font-normal">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">Disconnect active sessions</span>
              <span className="text-muted-foreground text-xs">
                {sessions > 0
                  ? `${sessions} ${sessions === 1 ? 'session is' : 'sessions are'} connected.`
                  : 'Nobody is connected right now.'}
              </span>
            </span>
            <Switch checked={force} onCheckedChange={(checked) => setForce(checked)} />
          </Label>
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">SQL that will run</span>
            <div className="h-20 shrink-0 overflow-hidden rounded-lg border bg-muted/30">
              <SqlCodeView className="h-full" value={sql} />
            </div>
          </div>
          {failure && <FailureAlert failure={failure} />}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button disabled={typed !== name} loading={drop.isPending} onClick={onConfirm} variant="destructive">
            Delete database
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}
