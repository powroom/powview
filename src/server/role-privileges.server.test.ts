import { describe, expect, test } from 'bun:test'
import { privilegesRefusal } from './role-privileges.server'

describe('privilegesRefusal', () => {
  test('pow/view own user is refused, even when it is not a superuser', () => {
    expect(privilegesRefusal('powview', 'powview', false)).toBe(
      'This is the user pow/view connects as. Change its privileges from another connection.',
    )
  })

  test('a superuser is refused, with the nothing-to-change message', () => {
    expect(privilegesRefusal('admin', 'powview', true)).toBe(
      'Superusers can already do everything; there is nothing to change.',
    )
  })

  test('another role may be changed', () => {
    expect(privilegesRefusal('app', 'powview', false)).toBeNull()
  })

  test('the own-user check comes first', () => {
    expect(privilegesRefusal('powview', 'powview', true)).toContain('pow/view connects as')
  })
})
