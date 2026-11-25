/**
 * New database dialog. The name comes first, then what to start from. Owner, encoding and
 * locale, access and advanced options sit in collapsible sections, and each option shows only
 * when it applies to the chosen start and server version. The SQL box shows the statements the
 * server will run.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createDatabaseFn } from '@/api/explorer.functions'
import {
  DatabaseSettingsEditor,
  type Failure,
  FailureAlert,
  pgErrorMessage,
  type SettingRow,
  settingRowProblems,
} from '@/components/app/database-form-parts'
import { PickSelect, SectionTitle, Segments, SwitchRow } from '@/components/app/form-parts'
import { SqlCodeView } from '@/components/sql/codemirror'
import { Problem } from '@/components/table/schema-editor'
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from '@/components/ui/accordion'
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from '@/components/ui/autocomplete'
import { Button } from '@/components/ui/button'
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
import { NumberField, NumberFieldGroup, NumberFieldInput } from '@/components/ui/number-field'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { createDatabaseProblem, createDatabaseSql, nameProblem } from '@/lib/ddl'
import { useProductionGuard } from '@/lib/production-guard'
import { allDatabasesQuery, databaseCreateOptionsQuery, keys, rolesQuery, serverInfoQuery } from '@/lib/queries'
import type { DatabaseAdminResult, DatabaseCreateDraft, DatabaseCreateOptions, DatabaseInfo } from '@/lib/types'

type StartFrom = 'empty' | 'clean' | 'copy'
type Provider = 'libc' | 'icu' | 'builtin'
type Strategy = '' | 'wal_log' | 'file_copy'

/** Everything the dialog edits. Text fields stay strings; blank means "leave the clause out". */
interface FormState {
  name: string
  /** the name was typed in, so its problem may show */
  nameTouched: boolean
  /** Create was pressed or Enter was pressed while blocked, so every problem may show */
  attempted: boolean
  startFrom: StartFrom
  copyFrom: string
  /** '' is the current user */
  owner: string
  encoding: string
  provider: Provider
  locale: string
  /** LC_COLLATE and LC_CTYPE instead of LOCALE */
  splitLocale: boolean
  lcCollate: string
  lcCtype: string
  icuLocale: string
  icuRules: string
  builtinLocale: string
  collationVersion: string
  comment: string
  limit: number | null
  allowConnections: boolean
  /** '' is the default tablespace */
  tablespace: string
  strategy: Strategy
  isTemplate: boolean
  oid: number | null
  settings: SettingRow[]
}

const initialForm: FormState = {
  name: '',
  nameTouched: false,
  attempted: false,
  startFrom: 'empty',
  copyFrom: '',
  owner: '',
  encoding: 'UTF8',
  provider: 'libc',
  locale: '',
  splitLocale: false,
  lcCollate: '',
  lcCtype: '',
  icuLocale: '',
  icuRules: '',
  builtinLocale: 'C.UTF-8',
  collationVersion: '',
  comment: '',
  limit: null,
  allowConnections: true,
  tablespace: '',
  strategy: '',
  isTemplate: false,
  oid: null,
  settings: [],
}

const START_HINTS: Record<StartFrom, string> = {
  empty: 'A new database like template1, the server default.',
  clean: 'A bare database from template0. Lets you pick another encoding and locale.',
  copy: 'Copies every table and row. Nobody may be connected to it while it copies; pow/view closes its own connections first.',
}

const START_CHOICES: { label: string; value: StartFrom }[] = [
  { label: 'Empty', value: 'empty' },
  { label: 'Clean', value: 'clean' },
  { label: 'Copy', value: 'copy' },
]

const SKELETON_FIELD = 'h-8 w-full rounded-lg'

const none = (value: string) => value.trim() || null

/** The draft the server receives. Options that do not apply are left out here, as the SQL builder would. */
function draftOf(f: FormState): DatabaseCreateDraft {
  const clean = f.startFrom === 'clean'
  const libc = clean && f.provider === 'libc'
  const icu = clean && f.provider === 'icu'
  const builtin = clean && f.provider === 'builtin'
  return {
    name: f.name.trim(),
    owner: none(f.owner),
    template: f.startFrom === 'clean' ? 'template0' : f.startFrom === 'copy' ? none(f.copyFrom) : null,
    encoding: clean ? f.encoding : null,
    localeProvider: clean ? f.provider : null,
    locale: libc && !f.splitLocale ? none(f.locale) : null,
    lcCollate: libc && f.splitLocale ? none(f.lcCollate) : null,
    lcCtype: libc && f.splitLocale ? none(f.lcCtype) : null,
    icuLocale: icu ? none(f.icuLocale) : null,
    icuRules: icu ? none(f.icuRules) : null,
    builtinLocale: builtin ? none(f.builtinLocale) : null,
    collationVersion: clean ? none(f.collationVersion) : null,
    tablespace: none(f.tablespace),
    strategy: f.strategy || null,
    allowConnections: f.allowConnections,
    connectionLimit: f.limit,
    isTemplate: f.isTemplate,
    oid: f.oid,
    comment: none(f.comment),
    settings: f.settings.map((r) => ({ name: r.name, value: r.value })),
  }
}

/** What a server reply that failed shows. The CREATE may have worked even when a later statement failed. */
function resultFailure(result: DatabaseAdminResult): Failure {
  const message = pgErrorMessage(result.error)
  if (result.ran === 0) return { title: 'Nothing was changed.', message, statement: result.failedStatement }
  const followUps = result.statements.length - 1
  const notApplied = result.statements.length - result.ran
  return {
    title: `The database was created, but ${notApplied} of ${followUps} follow-up changes failed.`,
    message,
    statement: result.failedStatement,
  }
}

function encodingSummary(f: FormState): string {
  if (f.startFrom !== 'clean') return ''
  let locale = ''
  if (f.provider === 'icu') locale = f.icuLocale.trim() && `${f.icuLocale.trim()} (ICU)`
  else if (f.provider === 'builtin') locale = `${f.builtinLocale} (builtin)`
  else if (f.splitLocale) locale = [f.lcCollate.trim(), f.lcCtype.trim()].filter(Boolean).join(' / ')
  else locale = f.locale.trim()
  return [f.encoding, locale].filter(Boolean).join(' · ')
}

function accessSummary(f: FormState): string {
  const changed = [f.comment.trim() !== '', f.limit !== null, !f.allowConnections, f.tablespace !== ''].filter(Boolean)
  return changed.length === 0 ? '' : `${changed.length} changed`
}

function advancedSummary(f: FormState): string {
  const changed = [
    f.strategy !== '',
    f.isTemplate,
    f.oid !== null,
    f.startFrom === 'clean' && f.collationVersion.trim() !== '',
  ].filter(Boolean)
  const count = changed.length + f.settings.length
  return count === 0 ? '' : `${count} changed`
}

/** A text box with suggestions. It also accepts any text the suggestions do not list. */
function SuggestInput({
  value,
  suggestions,
  placeholder,
  onChange,
}: {
  value: string
  suggestions: string[]
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <Autocomplete items={suggestions} onValueChange={(v) => onChange(v)} openOnInputClick value={value}>
      <AutocompleteInput className="font-mono text-[13px]" placeholder={placeholder} size="sm" spellCheck={false} />
      <AutocompletePopup>
        <AutocompleteList>
          {(item: string) => (
            <AutocompleteItem className="font-mono text-[13px]" key={item} value={item}>
              {item}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  )
}

type Patch = (changes: Partial<FormState>) => void

/** The server version is 0 while the options load, so every version-gated option stays hidden. */
function EncodingSection({
  f,
  patch,
  options,
  version,
  databases,
}: {
  f: FormState
  patch: Patch
  options: DatabaseCreateOptions | undefined
  version: number
  databases: DatabaseInfo[] | undefined
}) {
  if (f.startFrom !== 'clean') {
    const source = f.startFrom === 'copy' ? databases?.find((d) => d.name === f.copyFrom) : undefined
    const from =
      f.startFrom === 'empty' && options
        ? `${options.templateDefaults.encoding} · ${options.templateDefaults.collate} · ${options.templateDefaults.localeProvider}`
        : source
          ? `${source.encoding} · ${source.collate}`
          : ''
    return (
      <>
        <p className="min-h-5 text-sm">{from && `From the template: ${from}`}</p>
        <p className="text-muted-foreground text-xs">Choose Clean to pick another encoding or locale.</p>
      </>
    )
  }

  const icuAvailable = version >= 150000 && (options?.icuLocales.length ?? 0) > 0
  const providers: { label: string; value: Provider }[] = [{ label: 'libc', value: 'libc' }]
  if (icuAvailable) providers.push({ label: 'ICU', value: 'icu' })
  if (version >= 170000) providers.push({ label: 'Builtin', value: 'builtin' })
  const builtinLocales = [
    { label: 'C', value: 'C' },
    { label: 'C.UTF-8', value: 'C.UTF-8' },
    ...(version >= 180000 ? [{ label: 'PG_UNICODE_FAST', value: 'PG_UNICODE_FAST' }] : []),
  ]

  return (
    <>
      <Field>
        <FieldLabel>Encoding</FieldLabel>
        {options ? (
          <PickSelect
            choices={options.encodings.map((e) => ({ label: e, value: e }))}
            onChange={(encoding) => patch({ encoding })}
            value={f.encoding}
          />
        ) : (
          <Skeleton className={SKELETON_FIELD} />
        )}
      </Field>

      <Field>
        <FieldLabel>Locale provider</FieldLabel>
        <Segments<Provider>
          choices={providers}
          label="Locale provider"
          onChange={(provider) => patch({ provider })}
          value={f.provider}
        />
      </Field>

      {f.provider === 'libc' && (
        <>
          {!f.splitLocale && (
            <Field>
              <FieldLabel>Locale</FieldLabel>
              {options ? (
                <SuggestInput
                  onChange={(locale) => patch({ locale })}
                  placeholder="Server default"
                  suggestions={options.libcLocales}
                  value={f.locale}
                />
              ) : (
                <Skeleton className={SKELETON_FIELD} />
              )}
            </Field>
          )}
          <SwitchRow
            checked={f.splitLocale}
            help="Sets LC_COLLATE and LC_CTYPE separately."
            onChange={(splitLocale) => patch({ splitLocale })}
            title="Set collation and character type separately"
          />
          {f.splitLocale && (
            <>
              <Field>
                <FieldLabel>LC_COLLATE</FieldLabel>
                {options ? (
                  <SuggestInput
                    onChange={(lcCollate) => patch({ lcCollate })}
                    placeholder="Server default"
                    suggestions={options.libcLocales}
                    value={f.lcCollate}
                  />
                ) : (
                  <Skeleton className={SKELETON_FIELD} />
                )}
              </Field>
              <Field>
                <FieldLabel>LC_CTYPE</FieldLabel>
                {options ? (
                  <SuggestInput
                    onChange={(lcCtype) => patch({ lcCtype })}
                    placeholder="Server default"
                    suggestions={options.libcLocales}
                    value={f.lcCtype}
                  />
                ) : (
                  <Skeleton className={SKELETON_FIELD} />
                )}
              </Field>
            </>
          )}
        </>
      )}

      {f.provider === 'icu' && (
        <>
          <Field>
            <FieldLabel>ICU locale</FieldLabel>
            {options ? (
              <SuggestInput
                onChange={(icuLocale) => patch({ icuLocale })}
                placeholder="e.g. de-DE"
                suggestions={options.icuLocales}
                value={f.icuLocale}
              />
            ) : (
              <Skeleton className={SKELETON_FIELD} />
            )}
          </Field>
          {version >= 160000 && (
            <Field>
              <FieldLabel>ICU rules</FieldLabel>
              <Textarea
                onChange={(e) => patch({ icuRules: e.target.value })}
                rows={2}
                spellCheck={false}
                value={f.icuRules}
              />
              <FieldDescription>{'Extra collation rules, for example &a < b'}</FieldDescription>
            </Field>
          )}
        </>
      )}

      {f.provider === 'builtin' && (
        <Field>
          <FieldLabel>Builtin locale</FieldLabel>
          <PickSelect
            choices={builtinLocales}
            onChange={(builtinLocale) => patch({ builtinLocale })}
            value={f.builtinLocale}
          />
        </Field>
      )}
    </>
  )
}

function AccessSection({
  f,
  patch,
  options,
}: {
  f: FormState
  patch: Patch
  options: DatabaseCreateOptions | undefined
}) {
  return (
    <>
      <Field>
        <FieldLabel>Comment</FieldLabel>
        <Textarea
          onChange={(e) => patch({ comment: e.target.value })}
          placeholder="What this database is for"
          rows={2}
          value={f.comment}
        />
      </Field>
      <Field>
        <FieldLabel>Connection limit</FieldLabel>
        <NumberField min={0} onValueChange={(limit) => patch({ limit })} size="sm" value={f.limit}>
          <NumberFieldGroup>
            <NumberFieldInput placeholder="No limit" />
          </NumberFieldGroup>
        </NumberField>
      </Field>
      <SwitchRow
        checked={f.allowConnections}
        help="When off, nobody can connect to the new database."
        onChange={(allowConnections) => patch({ allowConnections })}
        title="Allow connections"
      />
      {options && options.tablespaces.length > 1 && (
        <Field>
          <FieldLabel>Tablespace</FieldLabel>
          <PickSelect
            choices={[{ label: 'Default', value: '' }, ...options.tablespaces.map((t) => ({ label: t, value: t }))]}
            onChange={(tablespace) => patch({ tablespace })}
            value={f.tablespace}
          />
        </Field>
      )}
    </>
  )
}

function AdvancedSection({ f, patch, version }: { f: FormState; patch: Patch; version: number }) {
  const modern = version >= 150000
  return (
    <>
      {modern && (
        <Field>
          <FieldLabel>Strategy</FieldLabel>
          <Segments<Strategy>
            choices={[
              { label: 'Default', value: '' },
              { label: 'WAL log', value: 'wal_log' },
              { label: 'File copy', value: 'file_copy' },
            ]}
            label="Strategy"
            onChange={(strategy) => patch({ strategy })}
            value={f.strategy}
          />
          <FieldDescription>
            How the files are copied from the template. File copy is faster for big templates but writes a checkpoint.
          </FieldDescription>
        </Field>
      )}
      <SwitchRow
        checked={f.isTemplate}
        help="Lets others create databases from this one."
        onChange={(isTemplate) => patch({ isTemplate })}
        title="Is template"
      />
      {modern && (
        <Field>
          <FieldLabel>OID</FieldLabel>
          <NumberField min={1} onValueChange={(oid) => patch({ oid })} size="sm" value={f.oid}>
            <NumberFieldGroup>
              <NumberFieldInput placeholder="Automatic" />
            </NumberFieldGroup>
          </NumberField>
          <FieldDescription>Leave empty. Only for special cases such as matching another server.</FieldDescription>
        </Field>
      )}
      {modern && f.startFrom === 'clean' && (
        <Field>
          <FieldLabel>Collation version</FieldLabel>
          <Input
            className="font-mono text-[13px]"
            onChange={(e) => patch({ collationVersion: e.target.value })}
            placeholder="Automatic"
            size="sm"
            spellCheck={false}
            value={f.collationVersion}
          />
          <FieldDescription>Leave empty to use the version the system reports.</FieldDescription>
        </Field>
      )}
      <div className="flex flex-col gap-2">
        <span className="font-medium text-sm">Database settings</span>
        <DatabaseSettingsEditor onChange={(settings) => patch({ settings })} rows={f.settings} showAll={f.attempted} />
      </div>
    </>
  )
}

export function CreateDatabaseDialog({
  connectionId,
  database,
  open,
  onOpenChange,
}: {
  connectionId: string
  database: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database)
  // every query waits for the dialog to open
  const options = useQuery({ ...databaseCreateOptionsQuery(connectionId), enabled: open }).data
  const databases = useQuery({ ...allDatabasesQuery(connectionId), enabled: open }).data
  const roles = useQuery({ ...rolesQuery(connectionId), enabled: open }).data
  const user = useQuery({ ...serverInfoQuery(connectionId, database), enabled: open }).data?.user
  const create = useMutation({
    mutationFn: (draft: DatabaseCreateDraft) => createDatabaseFn({ data: { connectionId, draft } }),
  })

  const [f, setForm] = useState<FormState>(initialForm)
  const [failure, setFailure] = useState<Failure | null>(null)
  // each opening starts from the empty form
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setForm(initialForm)
      setFailure(null)
    }
  }
  const patch: Patch = (changes) => setForm((prev) => ({ ...prev, ...changes }))

  const name = f.name.trim()
  const takenNames = (databases ?? []).map((d) => d.name)
  const draft = draftOf(f)
  const version = options?.versionNum ?? 0
  const copyIssue = f.startFrom === 'copy' && !f.copyFrom ? 'Choose a database to copy.' : null
  const settingIssue = [...settingRowProblems(f.settings).values()][0] ?? null
  // the first problem, shown on the Create button; null only when the draft can be sent
  const problem =
    copyIssue ??
    (options && databases
      ? (createDatabaseProblem(draft, { versionNum: options.versionNum, takenNames }) ?? settingIssue)
      : 'Still loading the server options.')
  const sql =
    !problem && options
      ? `${createDatabaseSql(draft, options.versionNum).join(';\n')};`
      : name
        ? `-- ${problem}`
        : '-- Enter a name'
  const nameIssue = nameProblem(f.name, takenNames)
  const shownNameIssue = f.nameTouched || f.attempted ? nameIssue : null

  const onCreate = () => {
    if (problem || !options) {
      patch({ attempted: true })
      return
    }
    void guard({ action: 'Create a database', sql }).then((ok) => {
      if (!ok) return
      create.mutate(draft, {
        onSuccess: (result) => {
          // a partly applied create also changed the list
          void queryClient.invalidateQueries({ queryKey: keys.databases(connectionId) })
          if (!result.ok) {
            setFailure(resultFailure(result))
            return
          }
          toastManager.add({ type: 'success', title: 'Database created', description: name })
          onOpenChange(false)
          void navigate({ to: '/c/$connId/$db', params: { connId: connectionId, db: name } })
        },
        onError: (error) => setFailure({ title: 'Nothing was changed.', message: error.message, statement: null }),
      })
    })
  }

  const roleChoices = [
    { label: user ? `You (${user})` : 'You', value: '' },
    ...(roles ?? []).map((r) => ({ label: r, value: r })),
  ]
  const copyChoices = (databases ?? []).filter((d) => d.name !== name).map((d) => ({ label: d.name, value: d.name }))
  const encodingDetail = encodingSummary(f)
  const accessDetail = accessSummary(f)
  const advancedDetail = advancedSummary(f)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-2xl">
        <form
          className="contents"
          // Enter in a field does not submit while Create is off, so it is caught here
          onKeyDown={(e) => {
            const field = e.target as HTMLElement
            if (e.key !== 'Enter' || !problem || e.nativeEvent.isComposing || field.tagName !== 'INPUT') return
            if (field.getAttribute('aria-expanded') === 'true') return
            e.preventDefault()
            patch({ attempted: true })
          }}
          onSubmit={(e) => {
            e.preventDefault()
            onCreate()
          }}
        >
          <DialogHeader>
            <DialogTitle>New database</DialogTitle>
            <DialogDescription>Only the name is needed. The other options are optional.</DialogDescription>
          </DialogHeader>

          {/* fixed height: the dialog keeps its size while typing and while the options load */}
          <div className="h-[min(33rem,calc(100dvh-21rem))]">
            <DialogPanel className="flex flex-col gap-5">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  aria-invalid={Boolean(shownNameIssue) || undefined}
                  autoFocus
                  className="font-mono text-[13px]"
                  onChange={(e) => patch({ name: e.target.value, nameTouched: true })}
                  placeholder="e.g. analytics"
                  size="sm"
                  spellCheck={false}
                  value={f.name}
                />
                <Problem>{shownNameIssue}</Problem>
              </Field>

              <Field>
                <FieldLabel>Start from</FieldLabel>
                <Segments<StartFrom>
                  choices={START_CHOICES}
                  label="Start from"
                  onChange={(startFrom) => patch({ startFrom })}
                  value={f.startFrom}
                />
                <FieldDescription>{START_HINTS[f.startFrom]}</FieldDescription>
                {f.startFrom === 'copy' &&
                  (databases ? (
                    <PickSelect
                      choices={copyChoices}
                      onChange={(copyFrom) => patch({ copyFrom })}
                      placeholder="Choose a database"
                      value={f.copyFrom || null}
                    />
                  ) : (
                    <Skeleton className={SKELETON_FIELD} />
                  ))}
              </Field>

              <Field>
                <FieldLabel>Owner</FieldLabel>
                {roles ? (
                  <PickSelect choices={roleChoices} onChange={(owner) => patch({ owner })} value={f.owner} />
                ) : (
                  <Skeleton className={SKELETON_FIELD} />
                )}
              </Field>

              <Accordion multiple>
                <AccordionItem value="encoding">
                  <AccordionTrigger>
                    <SectionTitle summary={encodingDetail} title="Encoding and locale" />
                  </AccordionTrigger>
                  <AccordionPanel className="flex flex-col gap-4">
                    <EncodingSection databases={databases} f={f} options={options} patch={patch} version={version} />
                  </AccordionPanel>
                </AccordionItem>
                <AccordionItem value="access">
                  <AccordionTrigger>
                    <SectionTitle summary={accessDetail} title="Access" />
                  </AccordionTrigger>
                  <AccordionPanel className="flex flex-col gap-4">
                    <AccessSection f={f} options={options} patch={patch} />
                  </AccordionPanel>
                </AccordionItem>
                <AccordionItem value="advanced">
                  <AccordionTrigger>
                    <SectionTitle summary={advancedDetail} title="Advanced" />
                  </AccordionTrigger>
                  <AccordionPanel className="flex flex-col gap-4">
                    <AdvancedSection f={f} patch={patch} version={version} />
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
            </DialogPanel>
          </div>

          <div className="flex flex-col gap-1.5 px-6 pt-1 pb-4">
            <span className="text-muted-foreground text-xs">SQL that will run</span>
            <div className="h-20 shrink-0 overflow-hidden rounded-lg border bg-muted/30 sm:h-24">
              <SqlCodeView className="h-full" value={sql} />
            </div>
            {failure && <FailureAlert failure={failure} />}
          </div>

          {/* one row on phones too: Cancel and Create side by side */}
          <DialogFooter className="flex-row justify-end">
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Tooltip>
              <TooltipTrigger
                render={
                  // a disabled button gets no pointer events: the wrapper shows why
                  <span className="inline-flex" />
                }
              >
                <Button disabled={Boolean(problem)} loading={create.isPending} type="submit">
                  Create database
                </Button>
              </TooltipTrigger>
              {problem && <TooltipPopup>{problem}</TooltipPopup>}
            </Tooltip>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
