import { afterEach, describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { RESTORE_FORMAT_LABELS, detectRestoreFormat, restoreFormatMismatch, restoreUrl } from '@/lib/db-restore'
import { HttpError } from './http/util.server'
import type { DumpTarget } from './dump.server'
import {
  StderrTally,
  buildRestorePlan,
  buildScriptRestorePlan,
  dropTransactionTimeout,
  filterHeaderLine,
  isErrorLine,
  parseRestoreParams,
  predatesTransactionTimeout,
  restoreLimitMb,
  restoreResponse,
  toolFor,
} from './restore.server'

const PSQL = '/usr/lib/postgresql/18/bin/psql'
const PG_RESTORE = '/usr/lib/postgresql/18/bin/pg_restore'
const FILE = '/tmp/powview-restore-x/dump.sql'
const SECRET = 'p@ss w\'o"rd\\1'

function target(overrides: Partial<DumpTarget> = {}): DumpTarget {
  return {
    host: '127.0.0.1',
    port: 55432,
    user: 'demo',
    database: 'shop',
    ssl: 'disable',
    password: SECRET,
    ...overrides,
  }
}

const bytes = (...values: number[]) => Uint8Array.from(values)
const ascii = (text: string) => new TextEncoder().encode(text)

/** A stderr-like reader that yields each string as one chunk. */
function streamOf(...chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(ascii(chunk))
      controller.close()
    },
  }).getReader()
}

/** The text that comes out of dropTransactionTimeout for the given byte chunks. */
async function filterDump(chunks: Uint8Array[]): Promise<string> {
  const out: Buffer[] = []
  for await (const piece of Readable.from(chunks).pipe(dropTransactionTimeout())) out.push(piece as Buffer)
  return Buffer.concat(out).toString('utf8')
}

/** The first 13 lines of a pg_dump 18 plain dump taken from a PostgreSQL 16 server. */
const DUMP_HEAD = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '-- Dumped from database version 16.4',
  '-- Dumped by pg_dump version 18.0',
  '',
  'SET statement_timeout = 0;',
  'SET lock_timeout = 0;',
  'SET idle_in_transaction_session_timeout = 0;',
  "SET client_encoding = 'UTF8';",
  'SET standard_conforming_strings = on;',
  'SET transaction_timeout = 0;',
]
const DUMP_BODY = [
  "SELECT pg_catalog.set_config('search_path', '', false);",
  'SET row_security = off;',
  '',
  'CREATE TABLE public.t (id integer);',
  '',
  'COPY public.t (id) FROM stdin;',
  'SET transaction_timeout = 0;',
  '\\.',
  '',
  '-- PostgreSQL database dump complete',
  '',
]

const ORIGINAL_LIMIT = process.env.POWVIEW_MAX_RESTORE_MB
afterEach(() => {
  if (ORIGINAL_LIMIT === undefined) delete process.env.POWVIEW_MAX_RESTORE_MB
  else process.env.POWVIEW_MAX_RESTORE_MB = ORIGINAL_LIMIT
})

describe('buildRestorePlan: SQL files (psql)', () => {
  test('atomic: one transaction and stop on the first error', () => {
    const { args } = buildRestorePlan(PSQL, target(), { format: 'sql', atomic: true, clean: false }, FILE)
    expect(args[0]).toBe(PSQL)
    expect(args).toContain('--single-transaction')
    expect(args).toContain('--set=ON_ERROR_STOP=1')
    expect(args).toContain(`--file=${FILE}`)
    expect(args).toContain('--no-psqlrc')
    expect(args).toContain('--quiet')
    expect(args).toContain('--no-password')
    expect(args.some((a) => a.startsWith('--clean') || a === '--exit-on-error')).toBe(false)
  })

  test('not all or nothing: no transaction and errors do not stop the run', () => {
    const { args } = buildRestorePlan(PSQL, target(), { format: 'sql-gz', atomic: false, clean: false }, FILE)
    expect(args).toContain('--set=ON_ERROR_STOP=0')
    expect(args).not.toContain('--single-transaction')
    expect(args).toContain(`--file=${FILE}`)
  })

  test('the file is the last part of --file, never a shell string', () => {
    const { args } = buildRestorePlan(PSQL, target(), { format: 'sql', atomic: true, clean: false }, FILE)
    expect(args.every((a) => typeof a === 'string')).toBe(true)
    expect(args.join(' ')).not.toContain('sh -c')
  })
})

describe('buildRestorePlan: custom files (pg_restore)', () => {
  test('atomic: single transaction and exit on the first error', () => {
    const { args } = buildRestorePlan(PG_RESTORE, target(), { format: 'custom', atomic: true, clean: false }, FILE)
    expect(args[0]).toBe(PG_RESTORE)
    expect(args).toContain('--single-transaction')
    expect(args).toContain('--exit-on-error')
    expect(args).toContain('--no-owner')
    expect(args).toContain('--no-privileges')
    expect(args).toContain('--no-password')
    expect(args).not.toContain('--clean')
    expect(args).not.toContain('--if-exists')
    expect(args[args.length - 1]).toBe(FILE)
  })

  test('not all or nothing: neither transaction nor exit-on-error', () => {
    const { args } = buildRestorePlan(PG_RESTORE, target(), { format: 'custom', atomic: false, clean: false }, FILE)
    expect(args).not.toContain('--single-transaction')
    expect(args).not.toContain('--exit-on-error')
    expect(args[args.length - 1]).toBe(FILE)
  })

  test('clean adds --clean --if-exists', () => {
    const { args } = buildRestorePlan(PG_RESTORE, target(), { format: 'custom', atomic: true, clean: true }, FILE)
    expect(args).toContain('--clean')
    expect(args).toContain('--if-exists')
    expect(args[args.length - 1]).toBe(FILE)
  })
})

describe('buildScriptRestorePlan: custom files on servers older than 17', () => {
  test('pg_restore writes the script without connecting; psql reads it from stdin', () => {
    const { dump, psql } = buildScriptRestorePlan(PG_RESTORE, PSQL, target(), { atomic: true, clean: false }, FILE)
    expect(dump.args).toEqual([PG_RESTORE, '--file=-', '--no-owner', '--no-privileges', FILE])
    expect(dump.args.some((a) => a.startsWith('--dbname'))).toBe(false)
    expect(psql.args[0]).toBe(PSQL)
    expect(psql.args).toContain('--file=-')
    expect(psql.args).toContain('--no-password')
    expect(psql.args).toContain('--no-psqlrc')
    expect(psql.args).toContain('--quiet')
    expect(psql.args.some((a) => a.startsWith('--dbname='))).toBe(true)
  })

  test('atomic: psql runs one transaction and stops on the first error', () => {
    const { psql } = buildScriptRestorePlan(PG_RESTORE, PSQL, target(), { atomic: true, clean: false }, FILE)
    expect(psql.args).toContain('--single-transaction')
    expect(psql.args).toContain('--set=ON_ERROR_STOP=1')
  })

  test('not all or nothing: no transaction and errors do not stop psql', () => {
    const { psql } = buildScriptRestorePlan(PG_RESTORE, PSQL, target(), { atomic: false, clean: false }, FILE)
    expect(psql.args).toContain('--set=ON_ERROR_STOP=0')
    expect(psql.args).not.toContain('--single-transaction')
  })

  test('pg_restore never gets the atomic flags; psql owns the transaction', () => {
    const { dump } = buildScriptRestorePlan(PG_RESTORE, PSQL, target(), { atomic: true, clean: false }, FILE)
    expect(dump.args).not.toContain('--single-transaction')
    expect(dump.args).not.toContain('--exit-on-error')
  })

  test('clean goes to pg_restore only, before the file', () => {
    const { dump, psql } = buildScriptRestorePlan(PG_RESTORE, PSQL, target(), { atomic: true, clean: true }, FILE)
    expect(dump.args).toEqual([PG_RESTORE, '--file=-', '--no-owner', '--no-privileges', '--clean', '--if-exists', FILE])
    expect(psql.args).not.toContain('--clean')
  })

  test('the password only travels in PGPASSWORD, for both programs', () => {
    const { dump, psql } = buildScriptRestorePlan(PG_RESTORE, PSQL, target(), { atomic: true, clean: false }, FILE)
    expect(dump.env.PGPASSWORD).toBe(SECRET)
    expect(psql.env.PGPASSWORD).toBe(SECRET)
    expect(dump.args.join('\n')).not.toContain(SECRET)
    expect(psql.args.join('\n')).not.toContain(SECRET)
  })
})

describe('buildRestorePlan: connection and environment', () => {
  test('the connection string names host, port, user and database, each quoted', () => {
    const { args } = buildRestorePlan(PSQL, target(), { format: 'sql', atomic: true, clean: false }, FILE)
    const dbname = args.find((a) => a.startsWith('--dbname='))!
    expect(dbname).toBe("--dbname=host='127.0.0.1' port='55432' user='demo' dbname='shop'")
  })

  test('through a tunnel, hostaddr carries the socket and host the real name', () => {
    const { args } = buildRestorePlan(
      PSQL,
      target({ host: '127.0.0.1', tlsHost: 'db.internal' }),
      { format: 'sql', atomic: true, clean: false },
      FILE,
    )
    const dbname = args.find((a) => a.startsWith('--dbname='))!
    expect(dbname).toContain("host='db.internal' hostaddr='127.0.0.1'")
  })

  test('the password only travels in PGPASSWORD', () => {
    const { args, env } = buildRestorePlan(PG_RESTORE, target(), { format: 'custom', atomic: true, clean: false }, FILE)
    expect(env.PGPASSWORD).toBe(SECRET)
    expect(args.join('\n')).not.toContain(SECRET)
  })

  test('no password means no PGPASSWORD', () => {
    const { env } = buildRestorePlan(
      PSQL,
      target({ password: undefined }),
      { format: 'sql', atomic: true, clean: false },
      FILE,
    )
    expect(env).not.toHaveProperty('PGPASSWORD')
  })

  test('environment carries the TLS mode, the timeout and the application name', () => {
    const { env } = buildRestorePlan(
      PSQL,
      target({ ssl: 'require' }),
      { format: 'sql', atomic: true, clean: false },
      FILE,
    )
    expect(env.PGSSLMODE).toBe('require')
    expect(env.PGCONNECT_TIMEOUT).toBe('10')
    expect(env.PGAPPNAME).toBe('powview')
  })
})

describe('format detection', () => {
  test('PGDMP is pg_dump custom', () => {
    expect(detectRestoreFormat(ascii('PGDMP\u0000\u0001'))).toBe('custom')
  })

  test('gzip magic 1f 8b is compressed SQL', () => {
    expect(detectRestoreFormat(bytes(0x1f, 0x8b, 0x08, 0x00, 0x00))).toBe('sql-gz')
  })

  test('anything else is plain SQL, including a short file', () => {
    expect(detectRestoreFormat(ascii('-- PostgreSQL database dump'))).toBe('sql')
    expect(detectRestoreFormat(ascii('PGD'))).toBe('sql')
    expect(detectRestoreFormat(new Uint8Array(0))).toBe('sql')
  })

  test('a file that only starts like the magic is not custom', () => {
    expect(detectRestoreFormat(ascii('PGDMX'))).toBe('sql')
    expect(detectRestoreFormat(bytes(0x1f, 0x00))).toBe('sql')
  })

  test('a mismatch names what the file looks like and what was expected', () => {
    expect(restoreFormatMismatch(ascii('PGDMP\u0000'), 'sql')).toBe('The file looks like pg_dump custom, not SQL.')
    expect(restoreFormatMismatch(bytes(0x1f, 0x8b, 8, 0, 0), 'sql')).toBe(
      'The file looks like Compressed SQL, not SQL.',
    )
    expect(restoreFormatMismatch(ascii('SELECT 1;'), 'custom')).toBe('The file looks like SQL, not pg_dump custom.')
    expect(restoreFormatMismatch(ascii('SELECT 1;'), 'sql-gz')).toBe('The file looks like SQL, not Compressed SQL.')
  })

  test('a matching file has no mismatch', () => {
    expect(restoreFormatMismatch(ascii('PGDMP\u0000'), 'custom')).toBeNull()
    expect(restoreFormatMismatch(bytes(0x1f, 0x8b, 8, 0, 0), 'sql-gz')).toBeNull()
    expect(restoreFormatMismatch(ascii('CREATE TABLE t();'), 'sql')).toBeNull()
  })

  test('labels are the names the UI shows', () => {
    expect(RESTORE_FORMAT_LABELS).toEqual({ sql: 'SQL', 'sql-gz': 'Compressed SQL', custom: 'pg_dump custom' })
  })

  test('tool per format', () => {
    expect(toolFor('custom')).toBe('pg_restore')
    expect(toolFor('sql')).toBe('psql')
    expect(toolFor('sql-gz')).toBe('psql')
  })
})

describe('error counting', () => {
  test('counts psql and pg_restore error lines', () => {
    expect(isErrorLine('ERROR:  relation "t" already exists')).toBe(true)
    expect(isErrorLine('psql:/tmp/powview-restore-x/dump.sql:12: ERROR:  syntax error')).toBe(true)
    expect(isErrorLine('pg_restore: error: could not execute query: ERROR:  boom')).toBe(true)
    expect(isErrorLine('psql: error: connection failed')).toBe(true)
  })

  test('notices, warnings and mentions in the middle of a line are not errors', () => {
    expect(isErrorLine('NOTICE:  table "t" does not exist, skipping')).toBe(false)
    expect(isErrorLine('pg_restore: warning: errors ignored on restore: 1')).toBe(false)
    expect(isErrorLine('  got ERROR: in the middle')).toBe(false)
    expect(isErrorLine('psql:/tmp/x.sql:3: NOTICE: ERROR: not an error line')).toBe(false)
  })

  test('the tally counts across chunk boundaries and an unterminated last line', async () => {
    const tally = new StderrTally()
    await tally.read(
      streamOf(
        'NOTICE: fine\nERR',
        'OR:  first problem\npsql:/tmp/x.sql:4: ERR',
        'OR:  second problem\npg_restore: error: third',
      ),
    )
    expect(tally.errors).toBe(3)
  })

  test('two streams read at once do not merge their lines', async () => {
    const tally = new StderrTally()
    await Promise.all([
      tally.read(streamOf('ERR', 'OR:  from a\n')),
      tally.read(streamOf('NOTICE: b\n', 'pg_restore: error: from b\n')),
    ])
    expect(tally.errors).toBe(2)
    expect(tally.log()).toContain('ERROR:  from a')
  })

  test('the log holds the last 60 lines', async () => {
    const tally = new StderrTally()
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    await tally.read(streamOf(lines.join('\n') + '\n'))
    const log = tally.log().split('\n')
    expect(log).toHaveLength(60)
    expect(log[0]).toBe('line 41')
    expect(log[59]).toBe('line 100')
  })

  test('an empty stderr gives an empty log', async () => {
    const tally = new StderrTally()
    await tally.read(streamOf())
    expect(tally.log()).toBe('')
    expect(tally.errors).toBe(0)
  })
})

describe('response shape', () => {
  test('exit 0 is 200 even when errors were counted (not all or nothing)', async () => {
    const res = restoreResponse(false, { exitCode: 0, errors: 2, log: 'ERROR:  x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, exitCode: 0, errors: 2, log: 'ERROR:  x' })
  })

  test('a failed atomic run is 422 with the rollback message', async () => {
    const res = restoreResponse(true, { exitCode: 3, errors: 1, log: 'psql:x:1: ERROR:  boom' })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.log).toBe('psql:x:1: ERROR:  boom')
    expect(body.error).toEqual({
      code: 'restore_failed',
      message: 'The restore stopped with an error. Nothing was changed.',
    })
  })

  test('a failed run that is not atomic says it finished with errors', async () => {
    const res = restoreResponse(false, { exitCode: 1, errors: 3, log: '' })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { message: string }; log: string }
    expect(body.error.message).toBe('The restore finished with errors.')
    expect(body.log).toBe('')
  })
})

describe('parseRestoreParams', () => {
  const base = 'connection=c1&database=shop&format=sql&atomic=1&clean=0'

  test('a complete request parses', () => {
    expect(parseRestoreParams(new URLSearchParams(base))).toEqual({
      connection: 'c1',
      database: 'shop',
      format: 'sql',
      atomic: true,
      clean: false,
    })
  })

  test('each format is accepted', () => {
    for (const format of ['sql', 'sql-gz', 'custom'] as const) {
      expect(parseRestoreParams(new URLSearchParams(base.replace('format=sql', `format=${format}`))).format).toBe(
        format,
      )
    }
  })

  test('missing or unknown values are 400', () => {
    const cases = [
      base.replace('connection=c1&', ''),
      base.replace('database=shop', 'database='),
      base.replace('format=sql', 'format=zip'),
      base.replace('format=sql&', ''),
      base.replace('atomic=1', 'atomic=yes'),
      base.replace('clean=0', ''),
    ]
    for (const query of cases) {
      let caught: unknown
      try {
        parseRestoreParams(new URLSearchParams(query))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(HttpError)
      expect((caught as HttpError).status).toBe(400)
    }
  })

  test('clean is only for custom files', () => {
    expect(() => parseRestoreParams(new URLSearchParams(base.replace('clean=0', 'clean=1')))).toThrow(HttpError)
    expect(
      parseRestoreParams(new URLSearchParams(base.replace('format=sql', 'format=custom').replace('clean=0', 'clean=1')))
        .clean,
    ).toBe(true)
  })

  test('a database name with a NUL byte is refused', () => {
    expect(() => parseRestoreParams(new URLSearchParams(base.replace('database=shop', 'database=a%00b')))).toThrow(
      HttpError,
    )
  })
})

describe('restoreLimitMb', () => {
  test('defaults to 2048 MB', () => {
    delete process.env.POWVIEW_MAX_RESTORE_MB
    expect(restoreLimitMb()).toBe(2048)
  })

  test('reads POWVIEW_MAX_RESTORE_MB and ignores nonsense', () => {
    process.env.POWVIEW_MAX_RESTORE_MB = '512'
    expect(restoreLimitMb()).toBe(512)
    process.env.POWVIEW_MAX_RESTORE_MB = 'lots'
    expect(restoreLimitMb()).toBe(2048)
    process.env.POWVIEW_MAX_RESTORE_MB = '0'
    expect(restoreLimitMb()).toBe(2048)
  })
})

describe('restoreUrl', () => {
  test('builds the route with 1 and 0 flags', () => {
    const url = restoreUrl({ connection: 'c1', database: 'my shop', format: 'custom', atomic: false, clean: true })
    const params = new URL(url, 'http://x').searchParams
    expect(url.startsWith('/api/import/restore?')).toBe(true)
    expect(params.get('connection')).toBe('c1')
    expect(params.get('database')).toBe('my shop')
    expect(params.get('format')).toBe('custom')
    expect(params.get('atomic')).toBe('0')
    expect(params.get('clean')).toBe('1')
  })
})

describe('tidyLog', () => {
  test('replaces the temp path with the line number', async () => {
    const { tidyLog } = await import('./restore.server')
    const f = '/tmp/powview-restore-abc/dump.sql'
    expect(tidyLog(`psql:${f}:26: ERROR:  schema "a" already exists`, f)).toBe(
      'line 26: ERROR:  schema "a" already exists',
    )
    expect(tidyLog(`could not open ${f}`, f)).toBe('could not open the file')
  })

  test('errors from a script on stdin get the line number too', async () => {
    const { tidyLog } = await import('./restore.server')
    expect(tidyLog('psql:<stdin>:13: ERROR:  unrecognized configuration parameter', '/tmp/x/dump.sql')).toBe(
      'line 13: ERROR:  unrecognized configuration parameter',
    )
  })
})

describe('filterHeaderLine', () => {
  test('the transaction_timeout line in the header becomes an empty line', () => {
    expect(filterHeaderLine('SET transaction_timeout = 0;', true)).toEqual({ line: '', inHeader: true })
  })

  test('CRLF line endings keep their carriage return', () => {
    expect(filterHeaderLine('SET transaction_timeout = 0;\r', true)).toEqual({ line: '\r', inHeader: true })
  })

  test('other header lines pass and stay in the header', () => {
    for (const line of [
      '',
      '\r',
      '-- a comment',
      'SET lock_timeout = 0;',
      "SELECT pg_catalog.set_config('search_path', '', false);",
    ]) {
      expect(filterHeaderLine(line, true)).toEqual({ line, inHeader: true })
    }
  })

  test('the first line that is not header ends the header, and that line passes', () => {
    expect(filterHeaderLine('CREATE TABLE t ();', true)).toEqual({ line: 'CREATE TABLE t ();', inHeader: false })
  })

  test('after the header nothing is filtered', () => {
    expect(filterHeaderLine('SET transaction_timeout = 0;', false)).toEqual({
      line: 'SET transaction_timeout = 0;',
      inHeader: false,
    })
  })

  test('a line with more after the setting is not the setting, so it is not changed', () => {
    expect(filterHeaderLine('SET transaction_timeout = 0; SELECT 1;', true).line).toBe(
      'SET transaction_timeout = 0; SELECT 1;',
    )
  })
})

describe('dropTransactionTimeout', () => {
  const dump = [...DUMP_HEAD, ...DUMP_BODY].join('\n')

  test('line 13 of a dump header is emptied, and the line count stays the same', async () => {
    const out = await filterDump([ascii(dump)])
    const lines = out.split('\n')
    expect(lines[12]).toBe('')
    expect(lines).toHaveLength(dump.split('\n').length)
    expect(lines.slice(0, 12)).toEqual(DUMP_HEAD.slice(0, 12))
  })

  test('the header of a real pg_dump 18 dump, with its \\restrict line before the SET lines', async () => {
    const real = [
      '--',
      '-- PostgreSQL database dump',
      '--',
      '',
      '\\restrict 9EcM7RLWTyZRr5ImzT3I6ZR5c53SXRBq9iC54QkzCfgbcO2dWSklgFNOhEjIOxl',
      '',
      '-- Dumped from database version 16.15',
      '-- Dumped by pg_dump version 18.7',
      '',
      'SET statement_timeout = 0;',
      'SET lock_timeout = 0;',
      'SET idle_in_transaction_session_timeout = 0;',
      'SET transaction_timeout = 0;',
      "SET client_encoding = 'UTF8';",
      'CREATE TABLE public.a (id integer);',
    ].join('\n')
    const lines = (await filterDump([ascii(real)])).split('\n')
    expect(lines[12]).toBe('')
    expect(lines[4]).toStartWith('\\restrict ')
    expect(lines[13]).toBe("SET client_encoding = 'UTF8';")
  })

  test('CRLF line endings: the line becomes a bare carriage return and newline', async () => {
    const crlf = [...DUMP_HEAD, ...DUMP_BODY].join('\r\n')
    const out = await filterDump([ascii(crlf)])
    expect(out.split('\r\n')[12]).toBe('')
    expect(out).toContain('\r\nSELECT pg_catalog.set_config')
  })

  test('chunk boundaries anywhere, even inside a line or a UTF-8 character', async () => {
    const text = [...DUMP_HEAD.slice(0, 2), '-- Dumped by café', ...DUMP_HEAD.slice(2), ...DUMP_BODY].join('\n')
    const oneByteChunks = Array.from(ascii(text), (byte) => Uint8Array.of(byte))
    expect(await filterDump(oneByteChunks)).toBe(await filterDump([ascii(text)]))
    const out = await filterDump(oneByteChunks)
    expect(out.split('\n')[13]).toBe('')
    expect(out).toContain('-- Dumped by café')
  })

  test('the same text later in the file, inside COPY data, stays', async () => {
    const out = await filterDump([ascii([...DUMP_HEAD, ...DUMP_BODY].join('\n'))])
    expect(out).toContain('COPY public.t (id) FROM stdin;\nSET transaction_timeout = 0;\n')
  })

  test('a file without the line passes unchanged', async () => {
    const without = [...DUMP_HEAD.filter((line) => !line.startsWith('SET transaction_timeout')), ...DUMP_BODY].join(
      '\n',
    )
    expect(await filterDump([ascii(without)])).toBe(without)
  })

  test('a header line that ends the file without a newline is still filtered', async () => {
    expect(await filterDump([ascii('SET transaction_timeout = 0;')])).toBe('')
    expect(await filterDump([ascii('SELECT 1;')])).toBe('SELECT 1;')
  })
})

describe('predatesTransactionTimeout', () => {
  test('PostgreSQL 14, 15 and 16 predate it', () => {
    expect(predatesTransactionTimeout('140020')).toBe(true)
    expect(predatesTransactionTimeout('150010')).toBe(true)
    expect(predatesTransactionTimeout('160004')).toBe(true)
  })

  test('17 and newer do not', () => {
    expect(predatesTransactionTimeout('170000')).toBe(false)
    expect(predatesTransactionTimeout('180000')).toBe(false)
  })

  test('an unreadable version counts as 17 or newer', () => {
    expect(predatesTransactionTimeout(undefined)).toBe(false)
    expect(predatesTransactionTimeout('')).toBe(false)
    expect(predatesTransactionTimeout('new')).toBe(false)
  })
})
