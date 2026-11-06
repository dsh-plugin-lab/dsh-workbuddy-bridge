/**
 * The diagnostic capture, tested where it lives (src/llm/capture.ts).
 *
 * Its three contracts are the ones a field report depends on:
 *
 * - disarmed writes nothing (the body is the user's whole conversation);
 * - one request produces exactly one record, carrying headers *and* the body
 *   after preparation — replaying a body alone answered 200 while the host's own
 *   request answered 400, so headers are half the evidence;
 * - credential material never lands in a file meant to be pasted into an issue.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPTURE_FLAG_FILENAME,
  CAPTURE_LOG_FILENAME,
  captureTarget,
  recordChatOutcome,
  rememberChatRequest,
} from '../src/llm/capture.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  delete process.env['WORKBUDDY_CAPTURE_BODY']
  const previous = process.env['DSH_HOME']
  delete process.env['DSH_HOME']
  if (previous !== undefined) process.env['DSH_HOME'] = previous
  await Promise.all(CLEANUP.splice(0).map((clean) => clean()))
})

/** A fresh home directory, with DSH_HOME pointed at it. */
async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'wb-capture-'))
  CLEANUP.push(() => rm(home, { recursive: true, force: true }))
  process.env['DSH_HOME'] = home
  return home
}

interface CaptureRecord {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  message?: string
  tokenFingerprint?: string
}

/** The records written so far. */
function records(path: string): CaptureRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CaptureRecord)
}

describe('capture', () => {
  it('writes nothing while disarmed', async () => {
    const home = await freshHome()
    expect(captureTarget()).toBeUndefined()
    rememberChatRequest('https://example.invalid/v2/chat/completions', {}, '{"a":1}')
    recordChatOutcome(400, 'blocked')
    expect(() => readFileSync(join(home, CAPTURE_LOG_FILENAME), 'utf8')).toThrow()
  })

  it('records one line per request, with headers, body and verdict together', async () => {
    const home = await freshHome()
    await writeFile(join(home, CAPTURE_FLAG_FILENAME), '')
    const log = join(home, CAPTURE_LOG_FILENAME)

    rememberChatRequest(
      'https://copilot.tencent.com/v2/chat/completions',
      { 'User-Agent': 'WorkBuddy/5.8.6', 'X-User-Id': 'uid-1' },
      '{"model":"deepseek-v4.1-flash"}',
    )
    recordChatOutcome(400, '{"code":11-128}')

    const [record] = records(log)
    expect(record!.url).toContain('/v2/chat/completions')
    expect(record!.status).toBe(400)
    expect(record!.headers['User-Agent']).toBe('WorkBuddy/5.8.6')
    expect(record!.headers['X-User-Id']).toBe('uid-1')
    expect(record!.body).toContain('deepseek-v4.1-flash')
    expect(record!.message).toContain('11-128')
  })

  it('never writes credential material', async () => {
    const home = await freshHome()
    process.env['WORKBUDDY_CAPTURE_BODY'] = join(home, 'custom.jsonl')

    rememberChatRequest(
      'https://copilot.tencent.com/v2/chat/completions',
      {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
        Cookie: 'session=secret',
        'X-Access-Token': 'also-secret',
        'Content-Type': 'application/json',
      },
      '{}',
    )
    recordChatOutcome(200)

    const [record] = records(join(home, 'custom.jsonl'))
    // The log is meant to be pasted into an issue, so redaction happens on the
    // way in rather than being left to whoever copies the file.
    expect(record!.headers['Authorization']).toBe('[redacted]')
    expect(record!.headers['Cookie']).toBe('[redacted]')
    expect(record!.headers['X-Access-Token']).toBe('[redacted]')
    expect(record!.headers['Content-Type']).toBe('application/json')
    expect(JSON.stringify(record)).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('records a token fingerprint so two runs are comparable', async () => {
    // The same body and headers answered 200 on a replay and 400 from the host,
    // so "was this the same token?" is a real question. The digest answers it
    // without putting the secret in a file meant to be pasted into an issue.
    const home = await freshHome()
    process.env['WORKBUDDY_CAPTURE_BODY'] = join(home, 'custom.jsonl')

    rememberChatRequest('https://example.invalid/v2/chat/completions', {}, '{}')
    recordChatOutcome(200)
    rememberChatRequest(
      'https://example.invalid/v2/chat/completions',
      { Authorization: 'Bearer token-one' },
      '{}',
    )
    recordChatOutcome(400)
    rememberChatRequest(
      'https://example.invalid/v2/chat/completions',
      { Authorization: 'Bearer token-one' },
      '{}',
    )
    recordChatOutcome(200)

    const [anonymous, first, again] = records(join(home, 'custom.jsonl'))
    expect(anonymous!.tokenFingerprint).toBeUndefined()
    expect(first!.tokenFingerprint).toMatch(/^[0-9a-f]{12}$/)
    // Same token → same digest; the comparison a bisect relies on.
    expect(again!.tokenFingerprint).toBe(first!.tokenFingerprint)
    // And the token itself is nowhere in the file.
    expect(JSON.stringify([anonymous, first, again])).not.toContain('token-one')
  })

  it('appends rather than overwrites, so a bisect can compare runs', async () => {
    const home = await freshHome()
    process.env['WORKBUDDY_CAPTURE_BODY'] = join(home, 'custom.jsonl')
    for (const status of [400, 200]) {
      rememberChatRequest('https://example.invalid/v2/chat/completions', {}, '{}')
      recordChatOutcome(status)
    }
    expect(records(join(home, 'custom.jsonl')).map((record) => record.status)).toEqual([400, 200])
  })

  it('writes nothing when the outcome arrives without a remembered request', async () => {
    // A caller that skips the request hook must not produce a record with an
    // invented body: a wrong capture is worse than none.
    const home = await freshHome()
    process.env['WORKBUDDY_CAPTURE_BODY'] = join(home, 'custom.jsonl')
    recordChatOutcome(400, 'blocked')
    expect(() => readFileSync(join(home, 'custom.jsonl'), 'utf8')).toThrow()
  })
})
