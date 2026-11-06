/**
 * Diagnostic capture of the chat requests this plugin actually sends.
 *
 * The channel gate (`11-128`) refuses requests by criteria the upstream never
 * documents, so a field report can only be acted on from the exact request that
 * was refused — and that request exists for one instant. Every report this repo
 * has received (issues #25, #28, #29, #30) was blocked on missing it.
 *
 * Two lessons are baked into the shape:
 *
 * - **Headers matter as much as the body.** Replaying a captured body from this
 *   process answered 200 while the host's own request answered 400 (2026-11-06),
 *   which rules the body out and makes the identity headers the first suspect.
 *   So one record carries both.
 * - **One line per request, written after the outcome is known.** A body file
 *   overwritten per request plus a separate outcome file lets a captured body be
 *   paired with another request's verdict; a later report cannot tell. The line
 *   is appended only once, with the verdict that belongs to it.
 *
 * Off by default: the body carries the user's whole conversation. Two ways to
 * arm it — see [README.md](./README.md).
 *
 * @module dsh-workbuddy-bridge/capture
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Presence of this file under `$DSH_HOME` arms the capture. */
export const CAPTURE_FLAG_FILENAME = '.workbuddy-capture.on'

/** The capture log under `$DSH_HOME`; one JSON object per line. */
export const CAPTURE_LOG_FILENAME = '.workbuddy-captures.jsonl'

/** One chat request, held until its verdict is known. */
interface PendingRequest {
  url: string
  headers: Record<string, string>
  body: string
  at: string
  /** Digest of the bearer token; see {@link tokenFingerprint}. */
  token: string | undefined
}

/**
 * Held across the request/response pair.
 *
 * A single slot is deliberate rather than a map: this is a human-driven
 * diagnostic, the host serialises one turn at a time, and the cost of a
 * collision (one record with another's verdict) is a re-run, not a wrong fix.
 * A map would need per-request ids threaded through the client for no gain here.
 */
let pending: PendingRequest | undefined

/** Where the log goes right now, or `undefined` when disarmed. */
export function captureTarget(): string | undefined {
  const fromEnv = process.env['WORKBUDDY_CAPTURE_BODY']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  try {
    const home = resolveDshHome()
    return existsSync(join(home, CAPTURE_FLAG_FILENAME))
      ? join(home, CAPTURE_LOG_FILENAME)
      : undefined
  } catch {
    // An unresolvable home is not worth failing a message over.
    return undefined
  }
}

/**
 * Strip credential material before anything is written.
 *
 * The log is meant to be pasted into an issue. A bearer token in it would hand
 * the reporter's account to whoever reads the issue, so redaction happens on the
 * way in rather than being left to whoever copies the file.
 */
function redacted(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase()
    out[name] =
      lowered === 'authorization' || lowered === 'cookie' || lowered.includes('token')
        ? '[redacted]'
        : value
  }
  return out
}

/**
 * A non-reversible fingerprint of the bearer token, for comparing two runs.
 *
 * The token itself stays out of the log, but "was this the same token?" is a real
 * question when the same body and headers answer 200 on a replay and 400 from the
 * host: a token refresh between the two makes them different requests. A digest
 * answers it without storing the secret.
 */
function tokenFingerprint(headers: Record<string, string>): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')
  if (entry === undefined) return undefined
  const token = entry[1].replace(/^Bearer\s+/i, '')
  if (token === '') return undefined
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

/**
 * Remember the request that is about to leave.
 *
 * Called from the client's `onChatRequest` hook, i.e. after every header and the
 * body are final and before the fetch — so what is recorded is what the upstream
 * receives, not what the caller intended.
 */
export function rememberChatRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
): void {
  if (captureTarget() === undefined) return
  pending = {
    url,
    headers: redacted(headers),
    body,
    at: new Date().toISOString(),
    token: tokenFingerprint(headers),
  }
}

/**
 * The most recent request this process captured, with its verdict.
 *
 * Exists so a maintainer can re-send the exact refused request from **inside**
 * the host process: the same body, headers and token answered 200 from a separate
 * process and 400 from the host, which leaves the sending process as the only
 * remaining variable.
 *
 * Falls back to the capture log's last line, because the in-memory slot does not
 * survive a plugin reload — and a reload is exactly when the experiment is
 * needed.
 */
export function lastCapturedRequest():
  { body: string; at: string; status: number; headers: Record<string, string> } | undefined {
  if (lastRequest !== undefined) return lastRequest
  const target = captureTarget()
  if (target === undefined || !existsSync(target)) return undefined
  try {
    const last = readFileSync(target, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .at(-1)
    if (last === undefined) return undefined
    const record = JSON.parse(last) as {
      body?: string
      at?: string
      status?: number
      headers?: Record<string, string>
    }
    if (typeof record.body !== 'string') return undefined
    return {
      body: record.body,
      at: record.at ?? '',
      status: record.status ?? 0,
      headers: record.headers ?? {},
    }
  } catch {
    return undefined
  }
}

/** Set by {@link rememberChatRequest} and refreshed by {@link recordChatOutcome}. */
let lastRequest:
  { body: string; at: string; status: number; headers: Record<string, string> } | undefined

/**
 * Append the pending request with its verdict.
 *
 * `status` 0 means a transport failure. A missing pending request (a caller that
 * skips the hook) writes nothing rather than inventing a record.
 */
export function recordChatOutcome(status: number, message?: string): void {
  const target = captureTarget()
  const entry = pending
  pending = undefined
  if (entry !== undefined) {
    lastRequest = { body: entry.body, at: entry.at, status, headers: entry.headers }
  }
  if (target === undefined || entry === undefined) return
  const line = JSON.stringify({
    at: entry.at,
    url: entry.url,
    status,
    ...(message === undefined ? {} : { message: message.slice(0, 400) }),
    // "Was this the same token?" decides whether a replay is comparable at all:
    // the same body and headers answered 200 on a replay and 400 from the host,
    // and a token refresh in between would make them different requests.
    tokenFingerprint: entry.token,
    headers: entry.headers,
    bodyLength: entry.body.length,
    body: entry.body,
  })
  try {
    appendFileSync(target, `${line}\n`, { mode: 0o600 })
  } catch {
    // A diagnostic must never become a failure mode.
  }
}
