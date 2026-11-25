/**
 * Form controls the database and role forms share: a row of segments, a select, a switch in a
 * bordered row, and a section title.
 */
import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

/** Section title, with a short muted summary of the values that are set. */
export function SectionTitle({ title, summary }: { title: string; summary?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
      {title}
      {summary && <span className="font-normal text-muted-foreground text-xs">{summary}</span>}
    </span>
  )
}

/** A row of segments, one per choice. */
export function Segments<T extends string>({
  label,
  value,
  choices,
  disabled = false,
  onChange,
}: {
  label: string
  value: T
  choices: { label: string; value: T }[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <SegmentedControl aria-label={label} role="radiogroup">
      {choices.map((c) => (
        <SegmentedControlItem
          aria-checked={value === c.value}
          data-checked={value === c.value ? '' : undefined}
          disabled={disabled}
          key={c.value}
          onClick={() => onChange(c.value)}
          role="radio"
        >
          {c.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  )
}

export function PickSelect({
  value,
  choices,
  placeholder,
  onChange,
}: {
  value: string | null
  choices: { label: string; value: string }[]
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <Select
      items={choices.map((c) => ({ label: c.label, value: c.value }))}
      onValueChange={(v) => {
        if (v !== null) onChange(v)
      }}
      value={value}
    >
      <SelectTrigger className="w-full" size="sm">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}

/** A switch in a bordered row, with a short help line. The whole row is the label. */
export function SwitchRow({
  title,
  help,
  checked,
  disabled = false,
  onChange,
}: {
  title: ReactNode
  help: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Label className="justify-between rounded-lg border px-3 py-2.5 font-normal">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">{help}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={(c) => onChange(c)} />
    </Label>
  )
}
