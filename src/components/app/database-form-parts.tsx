/**
 * Pieces the database sheet and the New database dialog share: the failure alert and the
 * settings editor (name and value rows for ALTER DATABASE ... SET).
 */
import { CircleAlertIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { Problem } from '@/components/table/schema-editor'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { settingNameProblem } from '@/lib/ddl'
import type { DatabaseAdminResult, PgErrorInfo } from '@/lib/types'

/** What a failed change shows in its alert. */
export interface Failure {
  title: string
  message: string
  statement: string | null
}

/** What a failed ALTER, DROP or CREATE (database or role) shows: how far it got, and the error. */
export function adminResultFailure(result: DatabaseAdminResult): Failure {
  return {
    title:
      result.ran === 0 ? 'Nothing was changed.' : `${result.ran} of ${result.statements.length} changes were applied.`,
    message: pgErrorMessage(result.error),
    statement: result.failedStatement,
  }
}

/** The error text, with its detail and hint on their own lines. */
export function pgErrorMessage(error: PgErrorInfo | null): string {
  return [error?.message ?? 'The change failed.', error?.detail, error?.hint && `Hint: ${error.hint}`]
    .filter(Boolean)
    .join('\n')
}

export function FailureAlert({ failure }: { failure: Failure }) {
  return (
    <div className="p-0.5">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertTitle>{failure.title}</AlertTitle>
        <AlertDescription className="whitespace-pre-wrap break-words">
          {failure.message}
          {failure.statement && <code className="mt-1 block font-mono text-xs">{failure.statement}</code>}
        </AlertDescription>
      </Alert>
    </div>
  )
}

export interface SettingRow {
  id: string
  name: string
  value: string
}

/** The problem with each row, by row id. Duplicate names: the second row is the one flagged. */
export function settingRowProblems(rows: SettingRow[]): Map<string, string> {
  const problems = new Map<string, string>()
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.name.trim()
    const problem = settingNameProblem(key) ?? (seen.has(key) ? 'Listed twice' : null)
    seen.add(key)
    if (problem) problems.set(row.id, `Setting name: ${problem}`)
  }
  return problems
}

/**
 * Setting rows. A row shows its problem once its name was typed in, or when `showAll` is set
 * (after a Save or Create attempt). Never on blur.
 */
export function DatabaseSettingsEditor({
  rows,
  onChange,
  disabled = false,
  showAll,
  help = 'Defaults for every session in this database, such as search_path or statement_timeout.',
}: {
  rows: SettingRow[]
  onChange: (rows: SettingRow[]) => void
  disabled?: boolean
  showAll: boolean
  /** the line above the rows: what the settings apply to */
  help?: string
}) {
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const problems = settingRowProblems(rows)
  const update = (id: string, patch: Partial<Omit<SettingRow, 'id'>>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">{help}</p>
      {rows.map((row) => {
        const problem = showAll || touched.has(row.id) ? problems.get(row.id) : undefined
        return (
          <div className="flex flex-col gap-1" key={row.id}>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
              <Input
                aria-invalid={Boolean(problem) || undefined}
                aria-label="Setting name"
                autoComplete="off"
                className="font-mono text-[13px]"
                disabled={disabled}
                onChange={(e) => {
                  update(row.id, { name: e.target.value })
                  setTouched((t) => new Set(t).add(row.id))
                }}
                placeholder="search_path"
                size="sm"
                spellCheck={false}
                value={row.name}
              />
              <Input
                aria-label="Setting value"
                autoComplete="off"
                className="font-mono text-[13px]"
                disabled={disabled}
                onChange={(e) => update(row.id, { value: e.target.value })}
                placeholder="value"
                size="sm"
                spellCheck={false}
                value={row.value}
              />
              <Button
                aria-label="Remove setting"
                disabled={disabled}
                onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </div>
            <Problem>{problem}</Problem>
          </div>
        )
      })}
      <div>
        <Button
          disabled={disabled}
          onClick={() => onChange([...rows, { id: crypto.randomUUID(), name: '', value: '' }])}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon aria-hidden="true" />
          Add setting
        </Button>
      </div>
    </div>
  )
}
