// SCRAM-SHA-256 password verifiers, computed here so a plain-text password never reaches
// PostgreSQL. PostgreSQL 10 and newer store a verifier as is when it is given as a password.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

/** The iteration count PostgreSQL uses by default (scram_iterations is 4096 in the server). */
const ITERATIONS = 4096

function hmac(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest()
}

/**
 * The verifier for `password` with a given salt, in PostgreSQL's format:
 * SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>, all parts base64.
 * The password is NFKC-normalized, which is what PostgreSQL's SASLprep does for most text.
 */
export function scramVerifierWithSalt(password: string, salt: Buffer, iterations = ITERATIONS): string {
  const saltedPassword = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
  const clientKey = hmac(saltedPassword, 'Client Key')
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = hmac(saltedPassword, 'Server Key')
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/** A new verifier for `password` with a random 16-byte salt. */
export function scramSha256Verifier(password: string): string {
  return scramVerifierWithSalt(password, randomBytes(16))
}
