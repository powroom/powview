import { describe, expect, test } from 'bun:test'
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { scramSha256Verifier, scramVerifierWithSalt } from './scram.server'

const parse = (verifier: string) => {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier)
  if (!m) throw new Error(`not a verifier: ${verifier}`)
  return { iterations: Number(m[1]), salt: m[2], storedKey: m[3], serverKey: m[4] }
}

describe('SCRAM-SHA-256 verifier', () => {
  test('known vector: RFC 7677 example (password pencil, salt W22ZaJ0SNY7soEsUEjb6gQ==)', () => {
    // Only the StoredKey is pinned, because it is the published value. No published ServerKey was
    // confirmed, so the ServerKey is checked for its format only (see the tests below).
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')
    expect(parse(scramVerifierWithSalt('pencil', salt, 4096)).storedKey).toBe(
      'WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=',
    )
  })

  test('format: 4096 iterations, 16-byte salt, 32-byte keys', () => {
    const parsed = parse(scramSha256Verifier('s3cret'))
    expect(parsed.iterations).toBe(4096)
    expect(Buffer.from(parsed.salt, 'base64').length).toBe(16)
    expect(Buffer.from(parsed.storedKey, 'base64').length).toBe(32)
    expect(Buffer.from(parsed.serverKey, 'base64').length).toBe(32)
  })

  test('a new random salt on every call', () => {
    expect(scramSha256Verifier('same')).not.toBe(scramSha256Verifier('same'))
  })

  test('a client proof derived with plain crypto checks out against StoredKey', () => {
    // The client side of SCRAM, written independently: derive ClientKey from the password and the
    // salt, build the ClientProof for a sample AuthMessage, then let the server side recover
    // ClientKey from the proof and hash it. The hash must equal the StoredKey in the verifier.
    const password = 'correct horse'
    const parsed = parse(scramSha256Verifier(password))
    const salted = pbkdf2Sync(password, Buffer.from(parsed.salt, 'base64'), parsed.iterations, 32, 'sha256')
    const clientKey = createHmac('sha256', salted).update('Client Key').digest()
    const storedKey = createHash('sha256').update(clientKey).digest()
    const authMessage = 'n=user,r=clientnonce,r=clientnonceservernonce,s=salt,i=4096,c=biws,r=clientnonceservernonce'
    const signature = createHmac('sha256', storedKey).update(authMessage).digest()
    const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i]))

    const recovered = Buffer.from(proof.map((b, i) => b ^ signature[i]))
    expect(createHash('sha256').update(recovered).digest('base64')).toBe(parsed.storedKey)
  })
})
