/**
 * New database from the database picker: one name field. The owner, encoding and template
 * come from the server defaults.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { DdlDialog, Problem } from '@/components/table/schema-editor'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { createDatabaseSql, nameProblem } from '@/lib/ddl'
import { databasesQuery, keys } from '@/lib/queries'

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
  const { data: databases } = useQuery(databasesQuery(connectionId))
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName('')
      setTouched(false)
    }
  }

  const trimmed = name.trim()
  const issue = nameProblem(
    name,
    (databases ?? []).map((d) => d.name),
  )

  return (
    <DdlDialog
      applyLabel="Create database"
      description="Creates an empty database on this server."
      onApplied={() => {
        void queryClient.invalidateQueries({ queryKey: keys.databases(connectionId) })
        void navigate({ to: '/c/$connId/$db', params: { connId: connectionId, db: trimmed } })
      }}
      onInvalidSubmit={() => setTouched(true)}
      onOpenChange={onOpenChange}
      open={open}
      problem={issue}
      statements={issue ? [] : createDatabaseSql(name)}
      successToast={{ title: 'Database created', description: trimmed }}
      target={{ connectionId, database }}
      title="New database"
    >
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input
          aria-invalid={Boolean(touched && issue) || undefined}
          autoFocus
          className="font-mono text-[13px]"
          onChange={(e) => {
            setTouched(true)
            setName(e.target.value)
          }}
          placeholder="e.g. analytics"
          size="sm"
          spellCheck={false}
          value={name}
        />
        <Problem>{touched && issue}</Problem>
      </Field>
    </DdlDialog>
  )
}
