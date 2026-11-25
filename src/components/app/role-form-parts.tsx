/**
 * Pieces the New role dialog and the role sheet share: the form state and the draft it becomes,
 * the password field with its generator, and the four sections (permissions, membership, limits,
 * advanced).
 */
import { CopyIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import { useState } from 'react'
import { copyWithToast } from '@/components/app/copy-feedback'
import { DatabaseSettingsEditor, type SettingRow } from '@/components/app/database-form-parts'
import { SectionTitle, Segments, SwitchRow } from '@/components/app/form-parts'
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from '@/components/ui/combobox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { NumberField, NumberFieldGroup, NumberFieldInput } from '@/components/ui/number-field'
import { Textarea } from '@/components/ui/textarea'
import { nameProblem } from '@/lib/ddl'
import type { RoleDraft, RoleInfo } from '@/lib/types'

/** Everything the role forms edit. Text stays text; blank means "leave the clause out". */
export interface RoleForm {
  name: string
  canLogin: boolean
  /** null: no password field is shown (the sheet, until Change password). Otherwise the field shows. */
  password: string | null
  superuser: boolean
  createDb: boolean
  createRole: boolean
  inherit: boolean
  replication: boolean
  bypassRls: boolean
  /** null: no limit */
  limit: number | null
  /** a date (yyyy-mm-dd), or the ISO time the role already has; null: never expires */
  validUntil: string | null
  memberOf: string[]
  comment: string
  settings: SettingRow[]
}

/** A new role: a user with no password yet, and the server defaults for the rest. */
export const EMPTY_ROLE_FORM: RoleForm = {
  name: '',
  canLogin: true,
  password: '',
  superuser: false,
  createDb: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRls: false,
  limit: null,
  validUntil: null,
  memberOf: [],
  comment: '',
  settings: [],
}

/** The form of an existing role. The password field stays closed until Change password is pressed. */
export function roleFormOf(role: RoleInfo): RoleForm {
  return {
    name: role.name,
    canLogin: role.canLogin,
    password: null,
    superuser: role.superuser,
    createDb: role.createDb,
    createRole: role.createRole,
    inherit: role.inherit,
    replication: role.replication,
    bypassRls: role.bypassRls,
    limit: role.connectionLimit,
    validUntil: role.validUntil,
    memberOf: role.memberOf,
    comment: role.comment ?? '',
    settings: role.settings.map((s) => ({ id: crypto.randomUUID(), name: s.name, value: s.value })),
  }
}

/**
 * The draft the server receives. A password counts only for a user. An empty password means
 * none when creating, and unchanged when editing, so the draft never carries ''.
 */
export function roleDraftOf(f: RoleForm): RoleDraft {
  return {
    name: f.name.trim(),
    canLogin: f.canLogin,
    password: f.canLogin && f.password ? f.password : null,
    superuser: f.superuser,
    createDb: f.createDb,
    createRole: f.createRole,
    inherit: f.inherit,
    replication: f.replication,
    bypassRls: f.bypassRls,
    connectionLimit: f.limit,
    validUntil: f.validUntil || null,
    memberOf: f.memberOf,
    comment: f.comment.trim() || null,
    settings: f.settings.map((r) => ({ name: r.name.trim(), value: r.value })),
  }
}

/** The first problem with a role name, or null. Names starting with pg_ are reserved by PostgreSQL. */
export function roleNameProblem(name: string, taken: readonly string[]): string | null {
  const problem = nameProblem(name, taken)
  if (problem) return problem
  return name.trim().startsWith('pg_') ? 'Names starting with pg_ are reserved.' : null
}

const PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const PASSWORD_LENGTH = 24

/** A random password of letters and digits. Bytes past the last multiple of 62 are skipped, so each character is equally likely. */
function generatePassword(): string {
  const limit = 256 - (256 % PASSWORD_CHARS.length)
  let out = ''
  while (out.length < PASSWORD_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(PASSWORD_LENGTH))) {
      if (byte < limit && out.length < PASSWORD_LENGTH) out += PASSWORD_CHARS.charAt(byte % PASSWORD_CHARS.length)
    }
  }
  return out
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** User or group. Both choices have a line of help, so the difference is clear. */
export function RoleTypeField({
  canLogin,
  disabled,
  onChange,
}: {
  canLogin: boolean
  disabled: boolean
  onChange: (canLogin: boolean) => void
}) {
  return (
    <Field>
      <FieldLabel>Type</FieldLabel>
      <Segments<'user' | 'group'>
        choices={[
          { label: 'User', value: 'user' },
          { label: 'Group', value: 'group' },
        ]}
        disabled={disabled}
        label="Type"
        onChange={(v) => onChange(v === 'user')}
        value={canLogin ? 'user' : 'group'}
      />
      <FieldDescription>User: can log in.</FieldDescription>
      <FieldDescription>Group: cannot log in. Other roles can be members of it.</FieldDescription>
    </Field>
  )
}

/** The password, with a show button, a copy button and a generator. Empty means no password here. */
export function RolePasswordField({
  value,
  placeholder,
  disabled,
  onChange,
}: {
  value: string
  placeholder: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [visible, setVisible] = useState(false)
  return (
    <Field>
      <FieldLabel>Password</FieldLabel>
      <div className="flex w-full gap-2">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupInput
            autoComplete="new-password"
            className="font-mono text-[13px]"
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            type={visible ? 'text' : 'password'}
            value={value}
          />
          <InputGroupAddon align="inline-end">
            <Button
              aria-label={visible ? 'Hide password' : 'Show password'}
              onClick={() => setVisible((v) => !v)}
              size="icon-xs"
              variant="ghost"
            >
              {visible ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
            <Button
              aria-label="Copy password"
              disabled={!value}
              onClick={() => void copyWithToast(value, 'Password copied')}
              size="icon-xs"
              variant="ghost"
            >
              <CopyIcon />
            </Button>
          </InputGroupAddon>
        </InputGroup>
        <Button
          disabled={disabled}
          onClick={() => {
            onChange(generatePassword())
            setVisible(true)
          }}
          variant="outline"
        >
          Generate
        </Button>
      </div>
      <FieldDescription>Copy it now; it cannot be shown again.</FieldDescription>
    </Field>
  )
}

/** Roles this role can be a member of. Roles it already belongs to show as chips, even if not listed. */
function MembershipField({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string[]
  options: string[]
  disabled: boolean
  onChange: (value: string[]) => void
}) {
  const items = [...new Set([...options, ...value])].sort()
  return (
    <Field>
      <FieldLabel>Member of</FieldLabel>
      <Combobox disabled={disabled} items={items} multiple onValueChange={(v) => onChange(v)} value={value}>
        <ComboboxChips>
          {value.map((name) => (
            <ComboboxChip key={name}>{name}</ComboboxChip>
          ))}
          <ComboboxChipsInput
            aria-label="Add a role"
            placeholder={value.length ? undefined : 'Choose roles'}
            size="sm"
          />
        </ComboboxChips>
        <ComboboxPopup>
          <ComboboxEmpty>No roles found.</ComboboxEmpty>
          <ComboboxList>
            {(name: string) => (
              <ComboboxItem key={name} value={name}>
                {name}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      <FieldDescription>The groups whose permissions this role gets.</FieldDescription>
    </Field>
  )
}

/**
 * The four collapsible sections of a role form. `options` lists the other roles for Member of.
 * `showAll` shows every settings problem (after a Save or Create attempt).
 */
export function RoleSections({
  form,
  patch,
  options,
  disabled,
  showAll,
}: {
  form: RoleForm
  patch: (changes: Partial<RoleForm>) => void
  options: string[]
  disabled: boolean
  showAll: boolean
}) {
  const changedFlags = [form.superuser, form.createDb, form.createRole, form.replication, form.bypassRls, !form.inherit]
  const permissionCount = changedFlags.filter(Boolean).length
  const limitCount = [form.limit !== null, form.validUntil !== null, form.comment.trim() !== ''].filter(Boolean).length

  return (
    <Accordion multiple>
      <AccordionItem value="permissions">
        <AccordionTrigger>
          <SectionTitle summary={permissionCount ? `${permissionCount} changed` : ''} title="Permissions" />
        </AccordionTrigger>
        <AccordionPanel className="flex flex-col gap-3">
          <SwitchRow
            checked={form.superuser}
            disabled={disabled}
            help="Can do anything, including changing other roles. Use with care."
            onChange={(superuser) => patch({ superuser })}
            title="Superuser"
          />
          <SwitchRow
            checked={form.createDb}
            disabled={disabled}
            help="Can create new databases."
            onChange={(createDb) => patch({ createDb })}
            title="Create databases"
          />
          <SwitchRow
            checked={form.createRole}
            disabled={disabled}
            help="Can create, change and drop other roles."
            onChange={(createRole) => patch({ createRole })}
            title="Create roles"
          />
          <SwitchRow
            checked={form.inherit}
            disabled={disabled}
            help="Gets the privileges of the groups it belongs to."
            onChange={(inherit) => patch({ inherit })}
            title="Inherit"
          />
          <SwitchRow
            checked={form.replication}
            disabled={disabled}
            help="Can start and stop streaming replication."
            onChange={(replication) => patch({ replication })}
            title="Replication"
          />
          <SwitchRow
            checked={form.bypassRls}
            disabled={disabled}
            help="Skips row level security policies."
            onChange={(bypassRls) => patch({ bypassRls })}
            title="Bypass row level security"
          />
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem value="membership">
        <AccordionTrigger>
          <SectionTitle
            summary={form.memberOf.length ? plural(form.memberOf.length, 'role', 'roles') : ''}
            title="Membership"
          />
        </AccordionTrigger>
        <AccordionPanel className="flex flex-col gap-4">
          <MembershipField
            disabled={disabled}
            onChange={(memberOf) => patch({ memberOf })}
            options={options}
            value={form.memberOf}
          />
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem value="limits">
        <AccordionTrigger>
          <SectionTitle summary={limitCount ? `${limitCount} set` : ''} title="Limits" />
        </AccordionTrigger>
        <AccordionPanel className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Connection limit</FieldLabel>
            <NumberField
              disabled={disabled}
              min={0}
              onValueChange={(limit) => patch({ limit })}
              size="sm"
              value={form.limit}
            >
              <NumberFieldGroup>
                <NumberFieldInput placeholder="No limit" />
              </NumberFieldGroup>
            </NumberField>
            <FieldDescription>Most sessions this role can open at once. Empty means no limit.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Valid until</FieldLabel>
            <Input
              disabled={disabled}
              onChange={(e) => patch({ validUntil: e.target.value || null })}
              size="sm"
              type="date"
              value={form.validUntil?.slice(0, 10) ?? ''}
            />
            <FieldDescription>After this date the role cannot log in. Empty means it never expires.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Comment</FieldLabel>
            <Textarea
              disabled={disabled}
              onChange={(e) => patch({ comment: e.target.value })}
              placeholder="What this role is for"
              rows={2}
              value={form.comment}
            />
          </Field>
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem value="advanced">
        <AccordionTrigger>
          <SectionTitle
            summary={form.settings.length ? plural(form.settings.length, 'setting', 'settings') : ''}
            title="Advanced"
          />
        </AccordionTrigger>
        <AccordionPanel className="flex flex-col gap-4">
          <DatabaseSettingsEditor
            disabled={disabled}
            help="Defaults for every session of this role, such as search_path or statement_timeout."
            onChange={(settings) => patch({ settings })}
            rows={form.settings}
            showAll={showAll}
          />
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  )
}
