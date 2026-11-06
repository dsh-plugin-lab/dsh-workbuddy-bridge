/**
 * The gate retry, pinned to the measurement it exists for.
 *
 * 2026-11-06, CN gateway, same 784-byte body and same token: the first attempt of
 * a fresh conversation answered `400 / 11-128`, and the identical request answered
 * `200` at +0.74 s from the same process. Every later attempt also 200. So the
 * refusal is per attempt, not per request — which makes "send it again" the fix,
 * and makes "rewrite the prompt again" a dead end (that dead end is issues
 * #25/#28/#29/#30).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/credential/store.ts'
import { WorkBuddyUpstreamClient } from '../src/protocol/client.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

const GATE_BODY = JSON.stringify({
  code: '11-128',
  msg: 'Illegal API invocation from an unapproved channel',
  displayMsg: { en: 'Request blocked. Please send it again', zh: '请求被拦截，请重新发送' },
})

function fakeResponse(body: string, ok: boolean, status: number): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub fetch with a scripted sequence of responses; returns the call count. */
function stubSequence(responses: (() => Response)[]): () => number {
  const calls = { count: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const next = responses[Math.min(calls.count, responses.length - 1)]!
      calls.count++
      return next()
    }),
  )
  return () => calls.count
}

describe('channel-gate retry', () => {
  it('sends the same request again when the gate refuses the first attempt', async () => {
    const calls = stubSequence([
      () => fakeResponse(GATE_BODY, false, 400),
      () => fakeResponse('data: [DONE]\n\n', true, 200),
    ])

    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{"messages":[]}')

    expect(result.ok).toBe(true)
    expect(calls()).toBe(2)
  })

  it('gives up after the retry budget and reports the refusal', async () => {
    const calls = stubSequence([() => fakeResponse(GATE_BODY, false, 400)])

    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{"messages":[]}')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.kind).toBe('client')
    // One attempt plus the two retries the budget allows.
    expect(calls()).toBe(3)
  })

  it('does not retry a verdict about the account', async () => {
    // An auth, quota or rate answer is a real verdict: retrying it wastes the
    // user's time and hides the actual cause behind a delay.
    for (const [body, status] of [
      ['{"code":11140,"msg":"request illegal"}', 403],
      ['{"code":11158,"msg":"model not allowed for user type"}', 400],
      ['积分不足', 402],
      ['slow down', 429],
    ] as const) {
      const calls = stubSequence([() => fakeResponse(body, false, status)])
      const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{"messages":[]}')
      expect(result.ok).toBe(false)
      expect(calls()).toBe(1)
    }
  })

  it('stops retrying when the turn is cancelled', async () => {
    const calls = stubSequence([() => fakeResponse(GATE_BODY, false, 400)])
    const controller = new AbortController()
    controller.abort()

    const result = await new WorkBuddyUpstreamClient().chatStream(
      CREDENTIAL,
      '{"messages":[]}',
      controller.signal,
    )

    expect(result.ok).toBe(false)
    // The delay is abortable, so a cancelled turn does not sit out the backoff.
    expect(calls()).toBe(1)
  })

  it('leaves a healthy attempt alone', async () => {
    const calls = stubSequence([() => fakeResponse('data: [DONE]\n\n', true, 200)])
    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{"messages":[]}')
    expect(result.ok).toBe(true)
    expect(calls()).toBe(1)
  })
})
