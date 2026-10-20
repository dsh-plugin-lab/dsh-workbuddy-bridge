import { describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter } from '../src/llm/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog/index.ts'
import { WORKBUDDY_PROVIDER } from '../src/llm/adapter.ts'
import type { WorkBuddyCredentialStore } from '../src/credential/store.ts'
import type { WorkBuddyShim } from '../src/llm/shim.ts'

/** The pi-ai collection built by an adapter exposes the exact model descriptor it consumes. */
interface AdapterSnapshot {
  models: {
    getModel(
      provider: string,
      model: string,
    ):
      | {
          compat?: { maxTokensField?: string }
          thinkingLevelMap?: Partial<Record<string, string | null>>
        }
      | undefined
  }
}

describe('WorkBuddy adapter model descriptors', () => {
  it("uses WorkBuddy's max_tokens output-cap field", () => {
    const catalog = new WorkBuddyCatalog([
      {
        id: 'model',
        name: 'Model',
        contextWindow: 1_000,
        maxTokens: 128_000,
        supportsImages: false,
        billing: { free: false },
      },
    ])
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
    })

    // `current()` is private in the adapter's public API, but this is the
    // descriptor seam pi-ai reads before it serializes a request.
    const snapshot = (adapter as unknown as { current(): AdapterSnapshot }).current()
    expect(snapshot.models.getModel(WORKBUDDY_PROVIDER, 'model')?.compat?.maxTokensField).toBe(
      'max_tokens',
    )
  })

  it('keeps the `off` thinking level selectable when thinking can be disabled', () => {
    // `off` must stay pinned to a string: pi-ai exposes a level only when its
    // `thinkingLevelMap` entry is a string, and `null` would drop it from the
    // picker. The wire spelling is never sent: the shared `prepareChatBody`
    // strips that exact value in *both* regions (issues #49 and #13), so
    // selecting Off means "no `reasoning_effort` on the wire".
    // Known limitation that stays: Off therefore does not guarantee thinking is
    // disabled — the field is omitted and the upstream decides.
    const catalog = new WorkBuddyCatalog([
      {
        id: 'model',
        name: 'Model',
        contextWindow: 1_000,
        maxTokens: 128_000,
        supportsImages: false,
        billing: { free: false },
        reasoning: {
          supports: true,
          onlyReasoning: false,
          canDisableThinking: true,
          supportedEfforts: ['low', 'high', 'max'],
        },
      },
    ])
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
    })

    const snapshot = (adapter as unknown as { current(): AdapterSnapshot }).current()
    const model = snapshot.models.getModel(WORKBUDDY_PROVIDER, 'model')
    expect(model?.thinkingLevelMap?.off).toBe('off')
    // A model without the declaration still offers no `off` at all.
    const bare = new WorkBuddyCatalog([
      {
        id: 'bare',
        name: 'Bare',
        contextWindow: 1_000,
        maxTokens: 8_000,
        supportsImages: false,
        billing: { free: false },
        reasoning: {
          supports: true,
          onlyReasoning: true,
          canDisableThinking: false,
          supportedEfforts: ['high'],
        },
      },
    ])
    const second = createWorkBuddyAdapter({
      catalog: bare,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
    })
    const bareSnapshot = (second.adapter as unknown as { current(): AdapterSnapshot }).current()
    expect(
      bareSnapshot.models.getModel(WORKBUDDY_PROVIDER, 'bare')?.thinkingLevelMap?.off,
    ).toBeNull()
  })
})

describe('request-image contract (0.1.7 host)', () => {
  /**
   * The host's `readImageRequest(ref, target)` takes a per-image target
   * `{ width, height, maxBytes }` — the shape pi-ai sends. The adapter hands
   * the store through unchanged, so this pins the boundary: an image-bearing
   * request reaches the store with that target and nothing else bolted on.
   */
  const IMAGE_MESSAGE = {
    id: 'test-message' as never,
    role: 'user' as const,
    source: { kind: 'user' as const },
    content: [
      { type: 'text' as const, text: 'describe' },
      {
        type: 'image' as const,
        attachment: {
          attachmentId: 'sha256:test',
          mediaType: 'image/png',
          width: 1,
          height: 1,
          bytes: 70,
        },
      },
    ],
  }

  function imageAdapter(store: Record<string, unknown>) {
    const catalog = new WorkBuddyCatalog([
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        contextWindow: 1_000,
        maxTokens: 128_000,
        supportsImages: true,
        billing: { free: false },
      },
    ])
    return createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
      resolveAttachments: () => store as never,
    }).adapter
  }

  it('hands the host store through unchanged', async () => {
    let observed: unknown
    const store = {
      readImageRequest(_ref: unknown, target: Record<string, unknown>) {
        observed = target
        // Sentinel past the boundary: proves the request survived the contract.
        throw new Error('PAST_VALIDATION')
      },
    }
    const adapter = imageAdapter(store)
    const call = await adapter.prepareCall(WORKBUDDY_PROVIDER, 'glm-5.3')
    // The message rides dsh-llm's branded ids/media types; the test's interest
    // is the target at the attachment boundary, not Message branding.
    const messages = [IMAGE_MESSAGE as never]
    await expect(async () => {
      for await (const _chunk of call.stream({
        provider: WORKBUDDY_PROVIDER,
        model: 'glm-5.3',
        messages,
      })) {
        // drain; the store's sentinel is expected to end the iteration
      }
    }).rejects.toThrow('PAST_VALIDATION')
    // The host's own target shape, with nothing added.
    expect(observed).toMatchObject({ width: 1, height: 1, maxBytes: 1_048_576 })
    expect(observed).not.toHaveProperty('maxPixels')
  })
})
