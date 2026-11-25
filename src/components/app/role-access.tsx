/**
 * The Access tab of a role: its database switches and its schema levels in the open database.
 * Only what changed is sent, and the server applies it in one transaction.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { applyRolePrivilegesFn } from '@/api/explorer.functions'
import { type Failure, FailureAlert, pgErrorMessage } from '@/components/app/database-form-parts'
import { Segments } from '@/components/app/form-parts'
import { SqlCodeView } from '@/components/sql/codemirror'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Frame, FramePanel } from '@/components/ui/frame'
import { SheetFooter, SheetPanel } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { rolePrivilegesSql } from '@/lib/ddl'
import { useProductionGuard } from '@/lib/production-guard'
import { keys, rolePrivilegesQuery } from '@/lib/queries'
import type { RolePrivileges, RolePrivilegesDraft, SchemaAccessLevel } from '@/lib/types'

type DbRow = RolePrivileges['databases'][number]
type SchemaRow = RolePrivileges['schemas'][number]
type DbSwitches = Pick<DbRow, 'connect' | 'create' | 'temporary'>
/** a level that can be picked; `custom` only ever comes from the server */
type ChosenLevel = Exclude<SchemaAccessLevel, 'custom'>

/** The database PostgreSQL uses as a template: never shown here. */
const HIDDEN_DATABASE = 'template0'

const SKELETON_NAME_WIDTHS = ['w-32', 'w-40', 'w-28']

function switchesOf(d: DbRow): DbSwitches {
  return { connect: d.connect, create: d.create, temporary: d.temporary }
}

/** One schema line: what the role can do with its tables. A chosen level describes every table. */
function schemaLine(s: SchemaRow, level: SchemaAccessLevel, chosen: boolean): string {
  if (level === 'none') return 'No table access'
  if (level === 'custom')
    return `Custom: read on ${s.canRead} of ${s.tables} tables, write on ${s.anyWrite} of ${s.tables}`
  const write = level === 'write'
  const verb = write ? 'Read and write' : 'Read'
  const suffix = (chosen ? true : write ? s.futureWrite : s.futureRead) ? ', new tables too' : ''
  if (s.tables === 0) return `No tables yet${suffix}`
  if (chosen) return `${verb} on all ${s.tables} tables${suffix}`
  return `${verb} on ${write ? s.canWrite : s.canRead} of ${s.tables} tables${suffix}`
}

export function RoleAccess({
  connectionId,
  database,
  role,
  readOnly,
}: {
  connectionId: string
  /** the database open in the app: schema levels apply here */
  database: string
  role: string
  readOnly: boolean
}) {
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database)
  const { data, error } = useQuery(rolePrivilegesQuery(connectionId, database, role))
  const apply = useMutation({
    mutationFn: (draft: RolePrivilegesDraft) =>
      applyRolePrivilegesFn({ data: { connectionId, database, role, draft } }),
  })
  // the switches and levels the user changed; everything else shows the saved state
  const [dbEdits, setDbEdits] = useState<Record<string, Partial<DbSwitches>>>({})
  const [levels, setLevels] = useState<Record<string, ChosenLevel>>({})

  const setSwitch = (name: string, changes: Partial<DbSwitches>) =>
    setDbEdits((prev) => ({ ...prev, [name]: { ...prev[name], ...changes } }))
  const setLevel = (name: string, level: ChosenLevel) => setLevels((prev) => ({ ...prev, [name]: level }))

  const privilegesKey = [...keys.db(connectionId, database), 'role-privileges', role]

  if (!data) {
    return (
      <SheetPanel className="flex flex-col gap-4">
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : (
          <div aria-busy="true" className="flex flex-col gap-3">
            {SKELETON_NAME_WIDTHS.map((width, i) => (
              <Skeleton className={`h-4 ${width}`} key={i} />
            ))}
          </div>
        )}
      </SheetPanel>
    )
  }

  // what the save would change: only the switches and schemas that differ from the saved state
  const draft: RolePrivilegesDraft = {
    databases: data.databases.flatMap((d) => {
      const next = { ...switchesOf(d), ...dbEdits[d.name] }
      const same = next.connect === d.connect && next.create === d.create && next.temporary === d.temporary
      return same ? [] : [{ name: d.name, ...next }]
    }),
    schemas: data.schemas.flatMap((s) => {
      const level = levels[s.name]
      return level !== undefined && level !== s.level ? [{ name: s.name, level }] : []
    }),
  }
  const changed = draft.databases.length + draft.schemas.length > 0
  const sql = changed ? `${rolePrivilegesSql(data, draft).join(';\n')};` : '-- No changes yet'
  // the switches as they will be after the save: the saved state with the edits on top
  const rows = data.databases
    .filter((d) => d.name !== HIDDEN_DATABASE)
    .map((d) => ({ db: d, sw: { ...switchesOf(d), ...dbEdits[d.name] } }))
  // PUBLIC can connect here, and this role's own Connect is off (now or after the edit)
  const openThroughPublic = rows.filter((r) => r.db.publicConnect && !r.sw.connect).map((r) => r.db.name)
  const failure: Failure | null = apply.error
    ? { title: 'Nothing was changed.', message: apply.error.message, statement: null }
    : apply.data && !apply.data.ok
      ? {
          title: 'Nothing was changed.',
          message: pgErrorMessage(apply.data.error),
          statement: apply.data.failedStatement,
        }
      : null

  const onSave = () => {
    void guard({ action: `Change access for ${role}`, sql }).then((ok) => {
      if (!ok) return
      apply.mutate(draft, {
        onSuccess: (result) => {
          if (!result.ok) return
          toastManager.add({ type: 'success', title: 'Access updated' })
          // the edits stay until the fresh state arrives, so the rows do not flicker back
          void queryClient.invalidateQueries({ queryKey: privilegesKey }).then(() => {
            setDbEdits({})
            setLevels({})
          })
        },
      })
    })
  }

  // a superuser needs no grants, and pow/view's own user is changed from another connection
  const isSelf = data.role === data.currentUser
  const locked = readOnly || isSelf

  if (data.superuser) {
    return (
      <SheetPanel>
        <p className="text-muted-foreground text-sm">Superusers can do everything. Nothing to set here.</p>
      </SheetPanel>
    )
  }

  return (
    <>
      <SheetPanel className="flex flex-col gap-5">
        {isSelf ? (
          <p className="text-muted-foreground text-sm">
            This is the user pow/view connects as. Change its privileges from another connection.
          </p>
        ) : (
          readOnly && <p className="text-muted-foreground text-sm">This connection is read-only.</p>
        )}

        <section className="flex flex-col gap-2">
          <span className="font-medium text-sm">Databases</span>
          <Frame>
            <FramePanel className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-end">Connect</TableHead>
                    <TableHead className="text-end">Create</TableHead>
                    <TableHead className="text-end">Temporary</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ db: d, sw }) => (
                    <TableRow key={d.name}>
                      <TableCell className="max-w-32 truncate font-medium">{d.name}</TableCell>
                      <TableCell className="text-end">
                        <Switch
                          aria-label={`Connect to ${d.name}`}
                          checked={sw.connect}
                          disabled={locked}
                          onCheckedChange={(connect) => setSwitch(d.name, { connect })}
                        />
                      </TableCell>
                      <TableCell className="text-end">
                        <Switch
                          aria-label={`Create in ${d.name}`}
                          checked={sw.create}
                          disabled={locked}
                          onCheckedChange={(create) => setSwitch(d.name, { create })}
                        />
                      </TableCell>
                      <TableCell className="text-end">
                        <Switch
                          aria-label={`Temporary tables in ${d.name}`}
                          checked={sw.temporary}
                          disabled={locked}
                          onCheckedChange={(temporary) => setSwitch(d.name, { temporary })}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </FramePanel>
          </Frame>
          {openThroughPublic.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Everyone can connect to {openThroughPublic.join(', ')} through PUBLIC, so turning Connect off here does
              not block this role there.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="font-medium text-sm">Schemas in {database}</span>
            <p className="text-muted-foreground text-xs">
              Read lets it SELECT. Read and write adds INSERT, UPDATE and DELETE. Both also cover tables created later
              by {data.currentUser}.
            </p>
          </div>
          {data.schemas.map((s) => {
            const chosen = levels[s.name] !== undefined
            const level = levels[s.name] ?? s.level
            return (
              <div className="flex flex-col gap-1.5" key={s.name}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-[13px]">{s.name}</span>
                  {s.level === 'custom' && !chosen && (
                    <Badge size="sm" variant="secondary">
                      Custom
                    </Badge>
                  )}
                </div>
                <Segments<SchemaAccessLevel>
                  choices={[
                    { label: 'None', value: 'none' },
                    { label: 'Read', value: 'read' },
                    { label: 'Read and write', value: 'write' },
                  ]}
                  disabled={locked}
                  label={`Access to schema ${s.name}`}
                  onChange={(v) => {
                    if (v !== 'custom') setLevel(s.name, v)
                  }}
                  value={level}
                />
                <p className="text-muted-foreground text-xs">{schemaLine(s, level, chosen)}</p>
              </div>
            )
          })}
        </section>

        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">SQL that will run</span>
          <div className="h-32 shrink-0 overflow-hidden rounded-lg border bg-muted/30">
            <SqlCodeView className="h-full" value={sql} />
          </div>
        </div>

        {failure && <FailureAlert failure={failure} />}
      </SheetPanel>

      {!locked && (
        <SheetFooter className="flex-row items-center justify-end">
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button disabled={!changed} loading={apply.isPending} onClick={onSave} type="button">
                Save access
              </Button>
            </TooltipTrigger>
            {!changed && <TooltipPopup>No changes yet</TooltipPopup>}
          </Tooltip>
        </SheetFooter>
      )}
    </>
  )
}
