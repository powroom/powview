import { createWriteStream, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { Subprocess } from 'bun'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import {
  RESTORE_FORMATS,
  RESTORE_SNIFF_BYTES,
  restoreFormatMismatch,
  type RestoreFormat,
  type RestoreResult,
} from '@/lib/db-restore'
import {
  checkOrigin,
  conninfo,
  loadConnection,
  locatePgDump,
  pgClientEnv,
  requireUser,
  type DumpTarget,
} from './dump.server'
import { query } from './pool.server'
import { pgTarget } from './pg-target.server'
import {
  HttpError,
  badRequest,
  checkDeclaredSize,
  envMegabytes,
  errorToResponse,
  fileTooLarge,
  flagParam,
  jsonResponse,
} from './http/util.server'

/**
 * Restore: a backup file (plain SQL, gzip SQL or pg_dump custom) is run into a database with
 * psql or pg_restore. The file is the request body. Arguments are always an array, the password
 * only travels in PGPASSWORD, and nothing runs until the first bytes match the chosen format.
 */

const DEFAULT_MAX_RESTORE_MB = 2048
const MIB = 1024 * 1024
/** lines of stderr returned in the response */
const LOG_LINES = 60
/** stderr kept in memory; the end is kept */
const STDERR_CAP = 200_000
/** PostgreSQL 17 is the first release that knows the transaction_timeout setting (17.0 is 170000) */
const TRANSACTION_TIMEOUT_SINCE = 170000
/** a header line longer than this is not a header line; keeps memory small for odd files */
const MAX_HEADER_LINE = 64 * 1024
const NEWLINE = 0x0a

type PgTool = 'psql' | 'pg_restore'

interface RestoreParams {
  connection: string
  database: string
  format: RestoreFormat
  /** one transaction; an error stops the run and undoes it */
  atomic: boolean
  /** pg_restore --clean --if-exists: drop each object before it is recreated (custom only) */
  clean: boolean
}

interface RestorePlan {
  args: string[]
  env: Record<string, string>
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

export function parseRestoreParams(params: URLSearchParams): RestoreParams {
  const connection = params.get('connection')?.trim()
  if (!connection || connection.length > 200) throw badRequest('connection is required.')
  const database = params.get('database')?.trim()
  if (!database) throw badRequest('database is required.')
  if (database.length > 255 || database.includes('\0')) throw badRequest('database is not a valid name.')
  const format = params.get('format') ?? ''
  if (!(RESTORE_FORMATS as readonly string[]).includes(format)) {
    throw badRequest(`format must be one of: ${RESTORE_FORMATS.join(', ')}.`)
  }
  const atomic = flagParam(params, 'atomic')
  const clean = flagParam(params, 'clean')
  if (clean && format !== 'custom') throw badRequest('clean only applies to pg_dump custom files.')
  return { connection, database, format: format as RestoreFormat, atomic, clean }
}

/** Upper limit for the upload in MB. POWVIEW_MAX_RESTORE_MB, default 2048. */
export function restoreLimitMb(): number {
  return envMegabytes('POWVIEW_MAX_RESTORE_MB', DEFAULT_MAX_RESTORE_MB)
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function toolFor(format: RestoreFormat): PgTool {
  return format === 'custom' ? 'pg_restore' : 'psql'
}

/**
 * Finds a PostgreSQL client program: in POWVIEW_PG_BIN when set, else next to the located pg_dump,
 * else on PATH. Null when it is not there.
 */
function locatePgTool(name: PgTool): string | null {
  const dir = process.env.POWVIEW_PG_BIN?.trim()
  if (dir) {
    const candidate = join(dir, name)
    return existsSync(candidate) ? candidate : null
  }
  const pgDump = locatePgDump()
  if (pgDump) {
    const candidate = join(dirname(pgDump), name)
    if (existsSync(candidate)) return candidate
  }
  return Bun.which(name)
}

function missingToolMessage(tool: PgTool): string {
  return `${tool} is not installed. The pow/view Docker image includes it; when running from source, install the PostgreSQL 18 client, or set POWVIEW_PG_BIN to the folder that holds it.`
}

/** The path of a client program. A 501 when it is not installed. */
function requireTool(name: PgTool): string {
  const binary = locatePgTool(name)
  if (!binary) throw new HttpError(501, 'pg_tools_missing', missingToolMessage(name))
  return binary
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * The argument list and environment for one restore. Pure: no process is started.
 * `file` is the plain SQL (already decompressed) or the custom dump on disk.
 */
export function buildRestorePlan(
  binary: string,
  target: DumpTarget,
  req: Pick<RestoreParams, 'format' | 'atomic' | 'clean'>,
  file: string,
): RestorePlan {
  const args = [binary, `--dbname=${conninfo(target)}`, '--no-password']
  if (req.format === 'custom') {
    args.push('--no-owner', '--no-privileges')
    if (req.atomic) args.push('--single-transaction', '--exit-on-error')
    if (req.clean) args.push('--clean', '--if-exists')
    args.push(file)
  } else {
    args.push('--no-psqlrc', '--quiet', `--set=ON_ERROR_STOP=${req.atomic ? 1 : 0}`)
    if (req.atomic) args.push('--single-transaction')
    args.push(`--file=${file}`)
  }
  return { args, env: pgClientEnv(target) }
}

/**
 * The two commands for a custom file on a server older than 17. pg_restore writes the dump as a SQL
 * script to stdout (no --dbname, so it never connects), and psql reads that script from stdin.
 * Pure: no process is started.
 */
export function buildScriptRestorePlan(
  restoreBinary: string,
  psqlBinary: string,
  target: DumpTarget,
  req: Pick<RestoreParams, 'atomic' | 'clean'>,
  file: string,
): { dump: RestorePlan; psql: RestorePlan } {
  // --file=- writes the script to stdout; pg_restore 18 needs --file or --dbname
  const dumpArgs = [restoreBinary, '--file=-', '--no-owner', '--no-privileges']
  if (req.clean) dumpArgs.push('--clean', '--if-exists')
  dumpArgs.push(file)

  const psqlArgs = [
    psqlBinary,
    `--dbname=${conninfo(target)}`,
    '--no-password',
    '--no-psqlrc',
    '--quiet',
    `--set=ON_ERROR_STOP=${req.atomic ? 1 : 0}`,
  ]
  if (req.atomic) psqlArgs.push('--single-transaction')
  psqlArgs.push('--file=-')

  const env = pgClientEnv(target)
  return { dump: { args: dumpArgs, env }, psql: { args: psqlArgs, env } }
}

/** A line psql or pg_restore prints for an error. psql puts "psql:<file>:<line>: " in front of ERROR. */
const ERROR_LINE = /^(?:psql:[^\n]*?:\d+: )?ERROR:|^pg_restore: error:|^psql: error:/

export function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line)
}

function lastLines(text: string, count: number): string {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed === '') return ''
  return trimmed.split('\n').slice(-count).join('\n')
}

/**
 * Collects stderr as it streams in: counts error lines, keeps the end of the text for the log.
 * Several streams can be read at once; each keeps its own unfinished last line.
 */
export class StderrTally {
  errors = 0
  private text = ''

  async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder('utf-8')
    let partial = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const parts = (partial + decoder.decode(value, { stream: true })).split('\n')
      partial = parts.pop() ?? ''
      this.add(parts)
    }
    const last = partial + decoder.decode()
    if (last !== '') this.add([last])
  }

  log(): string {
    return lastLines(this.text, LOG_LINES)
  }

  private add(lines: string[]): void {
    for (const line of lines) if (isErrorLine(line)) this.errors++
    const block = lines.map((line) => `${line}\n`).join('')
    this.text = (this.text + block).slice(-STDERR_CAP)
  }
}

// ---------------------------------------------------------------------------
// Dump header for servers older than PostgreSQL 17
// ---------------------------------------------------------------------------

/**
 * The top of a dump: blank lines, comments, SET and set_config lines, and the `\restrict <key>` line
 * that pg_dump 17.6, 18 and newer write before the SET lines.
 */
const HEADER_LINE = /^(?:|--.*|\\restrict \S+|SET .*;|SELECT pg_catalog\.set_config\(.*\);)\r?$/
const TRANSACTION_TIMEOUT_LINE = /^SET transaction_timeout = [^;]*;\r?$/

/**
 * Filters one line of a dump. In the header, a transaction_timeout line becomes an empty line (the
 * newline stays, so psql's line numbers still match the user's file). The first line that is not
 * header ends the header for good. Pure: returns the line and the new state.
 */
export function filterHeaderLine(line: string, inHeader: boolean): { line: string; inHeader: boolean } {
  if (!inHeader) return { line, inHeader: false }
  if (TRANSACTION_TIMEOUT_LINE.test(line)) return { line: line.endsWith('\r') ? '\r' : '', inHeader: true }
  return { line, inHeader: HEADER_LINE.test(line) }
}

/**
 * A stream that drops the transaction_timeout line from the header of a dump (see filterHeaderLine).
 * It works on bytes and decodes a line only once it is complete, so a chunk can end anywhere.
 * After the header, every chunk passes through unchanged and unbuffered.
 */
export function dropTransactionTimeout(): Transform {
  let inHeader = true
  let partial = Buffer.alloc(0)
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!inHeader) return callback(null, chunk)
      const buf = Buffer.concat([partial, chunk])
      const out: Buffer[] = []
      let start = 0
      for (let nl = buf.indexOf(NEWLINE); nl !== -1 && inHeader; nl = buf.indexOf(NEWLINE, start)) {
        const text = buf.toString('utf8', start, nl)
        const next = filterHeaderLine(text, true)
        inHeader = next.inHeader
        out.push(next.line === text ? buf.subarray(start, nl + 1) : Buffer.from(`${next.line}\n`))
        start = nl + 1
      }
      const rest = buf.subarray(start)
      inHeader &&= rest.length <= MAX_HEADER_LINE
      if (inHeader) {
        partial = rest
      } else {
        out.push(rest)
        partial = Buffer.alloc(0)
      }
      callback(null, Buffer.concat(out))
    },
    flush(callback) {
      if (partial.length === 0) return callback()
      // the file ends in the middle of a header line
      const text = partial.toString('utf8')
      const next = filterHeaderLine(text, true)
      callback(null, next.line === text ? partial : Buffer.from(next.line))
    },
  })
}

/**
 * True when a server reporting this server_version_num predates transaction_timeout (PostgreSQL 14
 * to 16). Pure. A missing or unreadable version is not older, so nothing changes.
 */
export function predatesTransactionTimeout(versionNum: string | undefined): boolean {
  if (!versionNum || !/^\d+$/.test(versionNum)) return false
  return Number(versionNum) < TRANSACTION_TIMEOUT_SINCE
}

/** Asks the target server for its version. If that fails, the server counts as 17 or newer. */
async function targetPredatesTransactionTimeout(connectionId: string, database: string): Promise<boolean> {
  try {
    const rows = await query<{ server_version_num: string }>(connectionId, database, 'SHOW server_version_num')
    return predatesTransactionTimeout(rows[0]?.server_version_num)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Streams the request body into the file the tool reads. The first bytes must match the chosen
 * format (checked before anything else is written); a gzip file is decompressed on the way in, and
 * `dropTimeout` removes the transaction_timeout line from a plain dump. Bytes are counted as they
 * arrive, so a missing or wrong Content-Length cannot exceed the limit.
 */
async function receiveUpload(
  request: Request,
  file: string,
  format: RestoreFormat,
  limitMb: number,
  dropTimeout: boolean,
): Promise<void> {
  if (!request.body) throw badRequest('The request has no file.')
  const limit = limitMb * MIB
  let bytes = 0
  let head: Buffer = Buffer.alloc(0)
  let checked = false

  const check = () => {
    checked = true
    if (bytes === 0) throw badRequest('The file is empty.')
    const mismatch = restoreFormatMismatch(head, format)
    if (mismatch) throw badRequest(mismatch)
  }

  const guard = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytes += chunk.byteLength
      if (bytes > limit) throw fileTooLarge(limitMb, 'POWVIEW_MAX_RESTORE_MB')
      if (!checked) {
        const need = RESTORE_SNIFF_BYTES - head.length
        head = Buffer.concat([head, chunk.subarray(0, need)])
        if (head.length >= RESTORE_SNIFF_BYTES) check()
      }
      yield chunk
    }
    if (!checked) check()
  }

  const source = Readable.fromWeb(request.body as unknown as WebReadableStream<Uint8Array>)
  const sink = createWriteStream(file, { flags: 'wx', mode: 0o600 })
  const stages = [...(format === 'sql-gz' ? [createGunzip()] : []), ...(dropTimeout ? [dropTransactionTimeout()] : [])]
  try {
    await pipeline([source, guard, ...stages, sink], { signal: request.signal })
  } catch (err) {
    throw uploadError(err, request.signal)
  }
}

function uploadError(err: unknown, signal: AbortSignal): unknown {
  if (err instanceof HttpError) return err
  if (signal.aborted) return new HttpError(400, 'aborted', 'The upload was cancelled.')
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.startsWith('Z_')) {
    return badRequest('The compressed file is damaged or incomplete.')
  }
  return err
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface RunOutcome {
  exitCode: number
  errors: number
  log: string
}

type Stdin = 'ignore' | ReadableStream<Uint8Array>

/** Starts one tool with stderr piped. A tool that cannot start is a 500 with the reason. */
function spawnTool(plan: RestorePlan, stdin: Stdin, stdout: 'ignore' | 'pipe') {
  try {
    return Bun.spawn(plan.args, { env: plan.env, stdin, stdout, stderr: 'pipe' })
  } catch (err) {
    throw new HttpError(
      500,
      'restore_failed',
      `${plan.args[0]} could not start: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Stops a process. It may have exited already, which is fine. */
function stop(proc: { kill(): void }): void {
  try {
    proc.kill()
  } catch {
    // already exited
  }
}

interface Child {
  proc: Subprocess<Stdin, 'ignore' | 'pipe', 'pipe'>
  stderr: ReadableStreamDefaultReader<Uint8Array>
}

/**
 * Reads the stderr of the started tools into one tally and waits for them. The exit code is the
 * last non-zero one in the list (for a script run that is psql's). A client that goes away stops
 * every tool, so an atomic restore rolls back.
 */
async function collect(children: Child[], signal: AbortSignal): Promise<RunOutcome> {
  const kill = () => {
    for (const child of children) stop(child.proc)
    // a grandchild that inherited stderr must not hold the response open
    for (const child of children) void child.stderr.cancel().catch(() => {})
  }
  signal.addEventListener('abort', kill, { once: true })
  try {
    const tally = new StderrTally()
    await Promise.all(children.map((child) => tally.read(child.stderr)))
    const codes = await Promise.all(children.map((child) => child.proc.exited))
    if (signal.aborted) throw new HttpError(400, 'aborted', 'The restore was cancelled.')
    const exitCode = codes.reduce((code, next) => (next === 0 ? code : next), 0)
    return { exitCode, errors: tally.errors, log: tally.log() }
  } finally {
    signal.removeEventListener('abort', kill)
  }
}

/** Runs one tool. */
async function runTool(plan: RestorePlan, signal: AbortSignal): Promise<RunOutcome> {
  // stdout is ignored: psql prints the result rows of the dump's SELECT statements there
  const proc = spawnTool(plan, 'ignore', 'ignore')
  return collect([{ proc, stderr: proc.stderr.getReader() }], signal)
}

/**
 * Runs a custom file on a server older than 17: pg_restore writes the script, the header filter
 * drops the transaction_timeout line, and psql runs what comes out.
 */
async function runScript(plan: { dump: RestorePlan; psql: RestorePlan }, signal: AbortSignal): Promise<RunOutcome> {
  const dump = spawnTool(plan.dump, 'ignore', 'pipe')
  let psql: ReturnType<typeof spawnTool>
  try {
    const script = Readable.fromWeb(dump.stdout as unknown as WebReadableStream<Uint8Array>).pipe(
      dropTransactionTimeout(),
    )
    psql = spawnTool(plan.psql, Readable.toWeb(script) as unknown as ReadableStream<Uint8Array>, 'ignore')
  } catch (err) {
    stop(dump)
    throw err
  }
  // psql stops reading at its first error (ON_ERROR_STOP), so pg_restore must not keep writing
  void psql.exited.then(() => stop(dump))
  return collect(
    [
      { proc: dump, stderr: dump.stderr.getReader() },
      { proc: psql, stderr: psql.stderr.getReader() },
    ],
    signal,
  )
}

/** 200 when the tool exited 0. Otherwise 422 with the same fields and an error message. */
export function restoreResponse(atomic: boolean, outcome: RunOutcome): Response {
  const body: RestoreResult = {
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    errors: outcome.errors,
    log: outcome.log,
  }
  const headers = { 'Cache-Control': 'no-store' }
  if (outcome.exitCode === 0) return jsonResponse(body, 200, headers)
  const message = atomic
    ? 'The restore stopped with an error. Nothing was changed.'
    : 'The restore finished with errors.'
  return Response.json({ ...body, error: { code: 'restore_failed', message } }, { status: 422, headers })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** POST /api/import/restore: the query string says where, the body is the backup file. */
export async function handleRestore(request: Request): Promise<Response> {
  try {
    await requireUser(request, 'restore a database', 'Restore is for signed-in users only. API tokens cannot restore.')
    checkOrigin(request)
    const req = parseRestoreParams(new URL(request.url).searchParams)
    const conn = await loadConnection(req.connection)
    if (conn.readOnly) throw new HttpError(403, 'read_only', 'This connection is read-only.')
    const limitMb = restoreLimitMb()
    checkDeclaredSize(request, limitMb, 'POWVIEW_MAX_RESTORE_MB')
    const legacy = await targetPredatesTransactionTimeout(conn.id, req.database)
    const binary = requireTool(toolFor(req.format))
    // a custom file on an older server goes through psql, which reads pg_restore's script
    const psql = legacy && req.format === 'custom' ? requireTool('psql') : undefined

    // a fresh directory per restore: the file never has a name the client chose
    const dir = await mkdtemp(join(tmpdir(), 'powview-restore-'))
    try {
      const file = join(dir, req.format === 'custom' ? 'dump.dump' : 'dump.sql')
      await receiveUpload(request, file, req.format, limitMb, legacy && req.format !== 'custom')
      const target = await pgTarget(conn, req.database)
      const outcome = psql
        ? await runScript(buildScriptRestorePlan(binary, psql, target, req, file), request.signal)
        : await runTool(buildRestorePlan(binary, target, req, file), request.signal)
      // psql prefixes errors with its input path (a temp file here): show just the line number
      outcome.log = tidyLog(outcome.log, file)
      return restoreResponse(req.atomic, outcome)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } catch (err) {
    return errorToResponse(err)
  }
}

/**
 * `psql:/tmp/powview-restore-x/dump.sql:26: ERROR: ...` becomes `line 26: ERROR: ...`.
 * Errors from a script on stdin (`psql:<stdin>:26:`) get the same treatment.
 */
export function tidyLog(log: string, file: string): string {
  return log.split(`psql:${file}:`).join('line ').split('psql:<stdin>:').join('line ').split(file).join('the file')
}
