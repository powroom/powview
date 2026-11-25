/**
 * The role sheet. The General tab edits the role: name, type, password, permissions,
 * membership, limits and advanced options. The Access tab sets what the role may do in the open
 * database. Each change shows the SQL it will run before it runs. Delete asks for the name first.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { alterRoleFn, dropRoleFn } from '@/api/explorer.functions'
import { adminResultFailure, type Failure, FailureAlert } from '@/components/app/database-form-parts'
import { PickSelect, SwitchRow } from '@/components/app/form-parts'
import { RoleAccess } from '@/components/app/role-access'
import {
  type RoleForm,
  RolePasswordField,
  RoleSections,
  RoleTypeField,
  roleDraftOf,
  roleFormOf,
  roleNameProblem,
} from '@/components/app/role-form-parts'
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { alterRoleSql, dropRoleSql, PASSWORD_MASK, roleProblem } from '@/lib/ddl'
import { useProductionGuard } from '@/lib/production-guard'
import { keys } from '@/lib/queries'
import { useRetained } from '@/hooks/use-retained'
import type { RoleDraft, RoleInfo } from '@/lib/types'

type RoleTab = 'general' | 'access'

export function RoleSheet({
  connectionId,
  database,
  role,
  names,
  currentUser,
  readOnly,
  onClose,
}: {
  connectionId: string
  /** the database open in the app: the Access tab applies here */
  database: string
  /** the role to edit; null while the sheet is closed */
  role: RoleInfo | null
  /** every role name on the server */
  names: string[]
  /** the user pow/view connects as */
  currentUser: string
  readOnly: boolean
  onClose: () => void
}) {
  // keeps the last role while the sheet slides out
  const shown = useRetained(role)
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open={role !== null}
    >
      {/* the popup unmounts when the sheet closes, so each opening starts from the saved state */}
      <SheetPopup className="max-sm:w-full">
        {shown && (
          <RoleEditor
            connectionId={connectionId}
            currentUser={currentUser}
            database={database}
            names={names}
            onClose={onClose}
            readOnly={readOnly}
            role={shown}
          />
        )}
      </SheetPopup>
    </Sheet>
  )
}

function RoleEditor({
  connectionId,
  database,
  role,
  names,
  currentUser,
  readOnly,
  onClose,
}: {
  connectionId: string
  database: string
  role: RoleInfo
  names: string[]
  currentUser: string
  readOnly: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database)
  const save = useMutation({
    mutationFn: (draft: RoleDraft) => alterRoleFn({ data: { connectionId, name: role.name, draft } }),
  })
  const [f, setForm] = useState<RoleForm>(() => roleFormOf(role))
  // a field shows its problem once it was typed in, or after a Save attempt; never on blur
  const [nameTouched, setNameTouched] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [tab, setTab] = useState<RoleTab>('general')
  const [deleteOpen, setDeleteOpen] = useState(false)

  const patch = (changes: Partial<RoleForm>) => setForm((prev) => ({ ...prev, ...changes }))
  // pow/view's own user cannot be renamed, changed to a group, or deleted from here
  const isSelf = role.isCurrentUser
  const locked = readOnly
  const identityLocked = readOnly || isSelf
  const others = names.filter((n) => n !== role.name)

  const draft = roleDraftOf(f)
  // the first problem, shown on the Save button; null only when the draft can be sent
  const problem = roleProblem(draft, { taken: others })
  const statements = problem ? [] : alterRoleSql(role, draft, draft.password === null ? null : PASSWORD_MASK)
  const sql = problem ? `-- ${problem}` : statements.length > 0 ? `${statements.join(';\n')};` : '-- No changes yet'
  const blocked = locked ? null : (problem ?? (statements.length === 0 ? 'No changes yet' : null))
  const shownNameIssue = nameTouched || attempted ? roleNameProblem(f.name, others) : null
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
    void guard({ action: 'Change a role', sql }).then((ok) => {
      if (!ok) return
      save.mutate(draft, {
        onSuccess: (result) => {
          // a partly applied change also changed the roles
          void queryClient.invalidateQueries({ queryKey: keys.roles(connectionId) })
          if (!result.ok) return
          toastManager.add({ type: 'success', title: 'Role updated' })
          onClose()
        },
      })
    })
  }

  const kind = role.canLogin ? 'User' : 'Group'
  const sessions = `${role.sessions} ${role.sessions === 1 ? 'session' : 'sessions'}`

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col gap-0" onValueChange={(v) => setTab(v as RoleTab)} value={tab}>
      <SheetHeader>
        <SheetTitle className="truncate pe-8">{role.name}</SheetTitle>
        <SheetDescription className="truncate">{`${kind} · ${sessions}`}</SheetDescription>
      </SheetHeader>
      <div className="px-6 pb-3">
        <TabsList>
          <TabsTab value="general">General</TabsTab>
          <TabsTab value="access">Access</TabsTab>
        </TabsList>
      </div>

      <TabsPanel className="flex min-h-0 flex-1 flex-col" keepMounted value="general">
        <form
          className="contents"
          // Enter in a field does not submit while Save is off, so it is caught here
          onKeyDown={(e) => {
            const field = e.target as HTMLElement
            if (e.key !== 'Enter' || !blocked || e.nativeEvent.isComposing || field.tagName !== 'INPUT') return
            if (field.getAttribute('aria-expanded') === 'true') return
            e.preventDefault()
            setAttempted(true)
          }}
          onSubmit={(e) => {
            e.preventDefault()
            onSave()
          }}
        >
          <SheetPanel className="flex flex-col gap-5">
            {readOnly ? (
              <p className="text-muted-foreground text-sm">This connection is read-only.</p>
            ) : (
              isSelf && (
                <p className="text-muted-foreground text-sm">
                  This is the user pow/view connects as. Its name and type cannot change here.
                </p>
              )
            )}

            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                aria-invalid={Boolean(shownNameIssue) || undefined}
                autoComplete="off"
                className="font-mono text-[13px]"
                disabled={identityLocked}
                onChange={(e) => {
                  patch({ name: e.target.value })
                  setNameTouched(true)
                }}
                size="sm"
                spellCheck={false}
                value={f.name}
              />
              <Problem>{shownNameIssue}</Problem>
              <FieldDescription>
                {isSelf ? 'The connection logs in as this role, so it cannot be renamed.' : 'Renames the role on save.'}
              </FieldDescription>
            </Field>

            <RoleTypeField
              canLogin={f.canLogin}
              disabled={identityLocked}
              onChange={(canLogin) => patch({ canLogin })}
            />

            {f.canLogin && (
              <div className="flex flex-col gap-2">
                {role.hasPassword !== null && (
                  <p className="text-muted-foreground text-xs">{role.hasPassword ? 'Has a password' : 'No password'}</p>
                )}
                {f.password === null ? (
                  <div>
                    <Button disabled={locked} onClick={() => patch({ password: '' })} size="sm" variant="outline">
                      Change password
                    </Button>
                  </div>
                ) : (
                  <RolePasswordField
                    disabled={locked}
                    onChange={(password) => patch({ password })}
                    placeholder="Leave empty to keep it"
                    value={f.password}
                  />
                )}
              </div>
            )}

            <RoleSections disabled={locked} form={f} options={others} patch={patch} showAll={attempted} />

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
                      disabled={isSelf}
                      onClick={() => setDeleteOpen(true)}
                      type="button"
                      variant="destructive-outline"
                    >
                      <Trash2Icon aria-hidden="true" />
                      {/* on phones only the icon fits next to Cancel and Save */}
                      <span className="max-sm:sr-only">Delete role</span>
                    </Button>
                  </TooltipTrigger>
                  {isSelf && (
                    <TooltipPopup>This is the user pow/view connects as, so it cannot be deleted.</TooltipPopup>
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
          <DeleteRoleDialog
            connectionId={connectionId}
            currentUser={currentUser}
            database={database}
            name={role.name}
            onDeleted={onClose}
            onOpenChange={setDeleteOpen}
            open={deleteOpen}
            others={others}
          />
        )}
      </TabsPanel>

      <TabsPanel className="flex min-h-0 flex-1 flex-col" keepMounted value="access">
        <RoleAccess connectionId={connectionId} database={database} readOnly={readOnly} role={role.name} />
      </TabsPanel>
    </Tabs>
  )
}

function DeleteRoleDialog({
  connectionId,
  database,
  name,
  others,
  currentUser,
  open,
  onOpenChange,
  onDeleted,
}: {
  connectionId: string
  /** the database open in the app, for the production guard and the privileges note */
  database: string
  name: string
  /** the other roles, for the owner of the objects */
  others: string[]
  /** the default owner of the objects the role leaves behind */
  currentUser: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database)
  const drop = useMutation({
    mutationFn: (options: { reassignTo: string | null; dropOwned: boolean }) =>
      dropRoleFn({ data: { connectionId, name, ...options } }),
  })
  const [typed, setTyped] = useState('')
  const [reassign, setReassign] = useState(currentUser)
  const [dropOwned, setDropOwned] = useState(false)
  // each opening starts empty (see ConfirmDialog)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTyped('')
      setReassign(currentUser)
      setDropOwned(false)
    }
  }

  const reassignTo = reassign || null
  const sql = `${dropRoleSql(name, reassignTo, dropOwned).join(';\n')};`
  const choices = [{ label: 'Nobody', value: '' }, ...others.map((r) => ({ label: r, value: r }))]
  const failure: Failure | null = drop.error
    ? { title: 'Nothing was changed.', message: drop.error.message, statement: null }
    : drop.data && !drop.data.ok
      ? adminResultFailure(drop.data)
      : null

  const onConfirm = () => {
    if (typed !== name) return
    void guard({ action: 'Delete a role', sql, destructive: true }).then((ok) => {
      if (!ok) return
      drop.mutate(
        { reassignTo, dropOwned },
        {
          onSuccess: (result) => {
            void queryClient.invalidateQueries({ queryKey: keys.roles(connectionId) })
            if (!result.ok) return
            toastManager.add({ type: 'success', title: 'Role deleted', description: name })
            onOpenChange(false)
            onDeleted()
          },
        },
      )
    })
  }

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete role ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>This removes the role. It cannot be undone.</AlertDialogDescription>
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
          <Field>
            <FieldLabel>Give its objects to</FieldLabel>
            <PickSelect choices={choices} onChange={setReassign} value={reassign} />
            <FieldDescription>{`Objects it owns in ${database} go to this role.`}</FieldDescription>
          </Field>
          <SwitchRow
            checked={dropOwned}
            help={`Also removes what it was granted, in ${database}.`}
            onChange={setDropOwned}
            title="Remove its privileges"
          />
          <p className="text-muted-foreground text-xs">Objects and privileges in other databases are not touched.</p>
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
            Delete role
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}
