/**
 * New role dialog. Name and type come first, then the password for a user. Permissions,
 * membership, limits and advanced options sit in collapsible sections. The SQL box shows the
 * statements the server will run, with the password masked.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { createRoleFn } from '@/api/explorer.functions'
import { adminResultFailure, type Failure, FailureAlert } from '@/components/app/database-form-parts'
import {
  EMPTY_ROLE_FORM,
  RolePasswordField,
  RoleSections,
  RoleTypeField,
  type RoleForm,
  roleDraftOf,
  roleNameProblem,
} from '@/components/app/role-form-parts'
import { SqlCodeView } from '@/components/sql/codemirror'
import { Problem } from '@/components/table/schema-editor'
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
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { createRoleSql, PASSWORD_MASK, roleProblem } from '@/lib/ddl'
import { useProductionGuard } from '@/lib/production-guard'
import { keys } from '@/lib/queries'
import type { RoleDraft } from '@/lib/types'

export function CreateRoleDialog({
  connectionId,
  database,
  names,
  open,
  onOpenChange,
}: {
  connectionId: string
  /** the database open in the app, for the production guard */
  database: string
  /** every role name on the server, or undefined while the list loads */
  names: string[] | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database)
  const create = useMutation({
    mutationFn: (draft: RoleDraft) => createRoleFn({ data: { connectionId, draft } }),
  })

  const [f, setForm] = useState<RoleForm>(EMPTY_ROLE_FORM)
  // the name was typed in, so its problem may show
  const [nameTouched, setNameTouched] = useState(false)
  // Create was pressed or Enter was pressed while blocked, so every problem may show
  const [attempted, setAttempted] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // each opening starts from the empty form
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setForm(EMPTY_ROLE_FORM)
      setNameTouched(false)
      setAttempted(false)
      setFailure(null)
    }
  }
  const patch = (changes: Partial<RoleForm>) => setForm((prev) => ({ ...prev, ...changes }))

  const taken = names ?? []
  const draft = roleDraftOf(f)
  // the first problem, shown on the Create button; null only when the draft can be sent
  const problem = names ? roleProblem(draft, { taken }) : 'Still loading the roles.'
  // an empty name reads as a prompt, like the New database dialog; other problems are shown as they are
  const sql = problem
    ? `-- ${f.name.trim() ? problem : 'Enter a name'}`
    : `${createRoleSql(draft, draft.password === null ? null : PASSWORD_MASK).join(';\n')};`
  const shownNameIssue = nameTouched || attempted ? roleNameProblem(f.name, taken) : null

  const onCreate = () => {
    if (problem) {
      setAttempted(true)
      return
    }
    void guard({ action: 'Create a role', sql }).then((ok) => {
      if (!ok) return
      create.mutate(draft, {
        onSuccess: (result) => {
          // a partly applied create also created the role
          void queryClient.invalidateQueries({ queryKey: keys.roles(connectionId) })
          if (!result.ok) {
            setFailure(adminResultFailure(result))
            return
          }
          toastManager.add({ type: 'success', title: 'Role created', description: draft.name })
          onOpenChange(false)
        },
        onError: (error) => setFailure({ title: 'Nothing was changed.', message: error.message, statement: null }),
      })
    })
  }

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
            setAttempted(true)
          }}
          onSubmit={(e) => {
            e.preventDefault()
            onCreate()
          }}
        >
          <DialogHeader>
            <DialogTitle>New role</DialogTitle>
            <DialogDescription>Only the name is needed. The other options are optional.</DialogDescription>
          </DialogHeader>

          {/* fixed height: the dialog keeps its size while typing and while the roles load */}
          <div className="h-[min(33rem,calc(100dvh-21rem))]">
            <DialogPanel className="flex flex-col gap-5">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  aria-invalid={Boolean(shownNameIssue) || undefined}
                  autoFocus
                  className="font-mono text-[13px]"
                  onChange={(e) => {
                    patch({ name: e.target.value })
                    setNameTouched(true)
                  }}
                  placeholder="e.g. analyst"
                  size="sm"
                  spellCheck={false}
                  value={f.name}
                />
                <Problem>{shownNameIssue}</Problem>
              </Field>

              <RoleTypeField canLogin={f.canLogin} disabled={false} onChange={(canLogin) => patch({ canLogin })} />

              {f.canLogin && (
                <RolePasswordField
                  disabled={false}
                  onChange={(password) => patch({ password })}
                  placeholder="Leave empty for no password"
                  value={f.password ?? ''}
                />
              )}

              <RoleSections disabled={false} form={f} options={taken} patch={patch} showAll={attempted} />
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
                  Create role
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
