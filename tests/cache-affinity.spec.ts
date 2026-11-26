import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog/index.ts'
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from '../src/credential/store.ts'
import { createWorkBuddyAdapter } from '../src/llm/adapter.ts'
import { createWorkBuddyShim } from '../src/llm/shim.ts'
import { cacheConversationId, WorkBuddyUpstreamClient } from '../src/protocol/client.ts'

const cn: WorkBuddyCredential = {
  uid: 'account-a',
  domain: 'www.codebuddy.cn',
  source: 'desktop',
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
}
const globalAccount = { ...cn, domain: 'www.workbuddy.ai' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('HY4 conversation affinity (#47)', () => {
  it('isolates the tested models by region, account, enterprise and DSH session', () => {
    vi.stubEnv('WORKBUDDY_HY4_CACHE_AFFINITY', '1')
    const id = cacheConversationId(cn, 'hy4flash-free', 'one')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const scopes = [
      id,
      cacheConversationId(cn, 'hy4flash-free', 'two'),
      cacheConversationId({ ...cn, uid: 'account-b' }, 'hy4flash-free', 'one'),
      cacheConversationId({ ...cn, enterpriseId: 'org' }, 'hy4flash-free', 'one'),
      cacheConversationId(cn, 'hy4std', 'one'),
      cacheConversationId(cn, 'hy4flash', 'one'),
      cacheConversationId(globalAccount, 'hy4flash-free', 'one'),
      cacheConversationId(globalAccount, 'hy4std', 'one'),
      cacheConversationId(globalAccount, 'hy4flash', 'one'),
    ]
    expect(scopes).not.toContain(undefined)
    expect(new Set(scopes).size).toBe(scopes.length)
    expect(cacheConversationId(globalAccount, 'hy4free', 'one')).toBeUndefined()
    expect(cacheConversationId(cn, 'hy4free', 'one')).toBeUndefined()
    expect(cacheConversationId(cn, 'hy4std', undefined)).toBeUndefined()
    expect(cacheConversationId({ ...cn, uid: '' }, 'hy4std', 'one')).toBeUndefined()
    vi.stubEnv('WORKBUDDY_HY4_CACHE_AFFINITY', '0')
    expect(cacheConversationId(cn, 'hy4std', 'one')).toBeUndefined()
    expect(cacheConversationId(globalAccount, 'hy4flash-free', 'one')).toBeUndefined()
  })

  it.each([
    { provider: 'workbuddy', model: 'hy4std', account: cn },
    { provider: 'workbuddy', model: 'hy4flash', account: cn },
    { provider: 'workbuddy', model: 'hy4flash-free', account: cn },
    { provider: 'workbuddy-ai', model: 'hy4std', account: globalAccount },
    { provider: 'workbuddy-ai', model: 'hy4flash', account: globalAccount },
    { provider: 'workbuddy-ai', model: 'hy4flash-free', account: globalAccount },
  ])(
    'carries a session through the adapter and shim for $provider/$model',
    async ({ provider, model, account }) => {
      vi.stubEnv('WORKBUDDY_HY4_CACHE_AFFINITY', '1')
      vi.stubEnv('PI_CACHE_RETENTION', 'short')
      const store = { resolve: async () => account } as WorkBuddyCredentialStore
      const catalog = new WorkBuddyCatalog([
        { id: model, name: model, contextWindow: 8192, maxTokens: 256, supportsImages: false },
      ])
      const wire: { headers: Headers; body: string }[] = []
      const localFetch = globalThis.fetch
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.hostname === '127.0.0.1') return localFetch(input, init)
        wire.push({ headers: new Headers(init?.headers), body: String(init?.body) })
        return new Response(
          'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      })
      const client = new WorkBuddyUpstreamClient({
        resolveChatIdentity: async () => ({ clientVersion: '1', cliVersion: '1' }),
      })
      const shim = createWorkBuddyShim({ store, catalog, client })
      try {
        await shim.ready
        const { adapter } = createWorkBuddyAdapter({ store, catalog, shim, providerId: provider })
        const call = await adapter.prepareCall(provider, model)
        const sessionId = SessionId('local-session-示例')
        for (const [text, session] of [
          ['first', sessionId],
          ['second', sessionId],
          ['first', SessionId('another-session')],
        ] as const) {
          for await (const _chunk of call.stream({
            provider,
            model,
            sessionId: session,
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          })) {
            /* drain the stream */
          }
        }
        expect(wire).toHaveLength(3)
        const first = wire[0]!.headers
        const second = wire[1]!.headers
        const id = first.get('x-conversation-id')
        expect(id).toBeTruthy()
        expect(second.get('x-conversation-id')).toBe(id)
        expect(wire[2]!.headers.get('x-conversation-id')).not.toBe(id)
        for (const { headers, body } of wire) {
          expect(headers.has('x-workbuddy-cache-session')).toBe(false)
          expect([...headers.values()]).not.toContain(sessionId)
          expect(JSON.parse(body)).not.toHaveProperty('conversation_id')
          expect(body).not.toContain(sessionId)
        }
        if (account === globalAccount) {
          for (const name of [
            'x-trace-id',
            'x-request-id',
            'x-conversation-request-id',
            'x-conversation-message-id',
          ]) {
            expect(first.get(name)).toBeTruthy()
            expect(second.get(name)).not.toBe(first.get(name))
          }
        }
      } finally {
        await shim.close()
      }
    },
  )
})
