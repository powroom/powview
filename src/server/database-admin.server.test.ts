import { describe, expect, test } from 'bun:test'
import { friendlyDropError, maintenanceCandidates } from './database-admin.server'

describe('maintenanceCandidates', () => {
  test('the default database first, then postgres and template1', () => {
    expect(maintenanceCandidates('app', 'shop')).toEqual(['app', 'postgres', 'template1'])
  })

  test('the target is never a candidate', () => {
    expect(maintenanceCandidates('shop', 'shop')).toEqual(['postgres', 'template1'])
    expect(maintenanceCandidates('app', 'postgres')).toEqual(['app', 'template1'])
    expect(maintenanceCandidates('postgres', 'template1')).toEqual(['postgres'])
  })

  test('no duplicates when the default database is postgres', () => {
    expect(maintenanceCandidates('postgres', 'shop')).toEqual(['postgres', 'template1'])
  })
})

describe('friendlyDropError', () => {
  test('SQLSTATE 55006 gets the sessions message and keeps the other fields', () => {
    const info = { message: 'database "shop" is being accessed by other users', code: '55006', detail: 'x' }
    expect(friendlyDropError(info)).toEqual({
      message:
        'Other sessions are connected to this database. Turn on "Disconnect active sessions" or close them first.',
      code: '55006',
      detail: 'x',
    })
  })

  test('other errors are returned unchanged', () => {
    const info = { message: 'database "shop" does not exist', code: '3D000' }
    expect(friendlyDropError(info)).toBe(info)
  })
})
