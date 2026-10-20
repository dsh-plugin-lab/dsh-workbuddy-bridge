import { describe, expect, it } from 'vitest'
import {
  classifyUpstreamError,
  prepareChatBody,
  prepareInternationalChatBody,
  regionOf,
} from '../src/protocol/client.ts'

describe('prepareChatBody', () => {
  it('forces stream true', () => {
    expect(JSON.parse(prepareChatBody('{"model":"auto","messages":[]}'))['stream']).toBe(true)
  })

  it('keeps invalid JSON untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })

  it('flattens object tool_choice auto', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'auto' } })))
    expect(body['tool_choice']).toBe('auto')
  })

  it("drops the picker's own `off` spelling, in both regions (issues #49 and #13)", () => {
    // `off` is what `thinkingLevelMap.off` pins, so pi-ai puts it on the wire
    // both for an explicit Off selection and for every request that carries no
    // level at all. Neither endpoint accepts it as a `reasoning_effort` value:
    // #49 measured the international GPT family, #13 measured CN. Omission is
    // the only form measured good everywhere, so the *shared* preparation drops
    // it and the international layer no longer has to.
    for (const body of [
      { messages: [], reasoning_effort: 'off' },
      // No messages array: the transformation must not be conditional on shape.
      { reasoning_effort: 'off' },
    ]) {
      expect('reasoning_effort' in JSON.parse(prepareChatBody(JSON.stringify(body)))).toBe(false)
    }
    expect(
      'reasoning_effort' in
        JSON.parse(prepareChatBody(JSON.stringify({ reasoning_effort: 'off', model: 'm' }))),
    ).toBe(false)
  })

  it('passes every other effort value through verbatim, `none` included', () => {
    // A user-chosen `none` (or any declared level) is not the adapter's own
    // spelling, so the wire keeps it: the adapter does not decide the user's
    // `none` for them, and a wrong guess there would be a silent behaviour
    // change rather than a rejected request.
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(
        prepareChatBody(JSON.stringify({ messages: [], reasoning_effort: effort })),
      )
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('flattens named function tool_choice to the function name', () => {
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          tool_choice: { type: 'function', function: { name: 'grep' } },
        }),
      ),
    )
    expect(body['tool_choice']).toBe('grep')
  })

  it('drops tool_choice and tools for none', () => {
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          tool_choice: { type: 'none' },
          tools: [{ type: 'function', function: { name: 'grep' } }],
        }),
      ),
    )
    expect('tool_choice' in body).toBe(false)
    expect('tools' in body).toBe(false)
  })

  it('drops an unrecognized object tool_choice', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'weird' } })))
    expect('tool_choice' in body).toBe(false)
  })

  it('preserves the reasoning_effort the model picker selects', () => {
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          model: 'glm-5.3',
          messages: [{ role: 'user', content: 'hi' }],
          reasoning_effort: 'xhigh',
        }),
      ),
    )
    expect(body['reasoning_effort']).toBe('xhigh')
    expect(body['stream']).toBe(true)
  })

  it('rewrites developer messages to system (upstream rejects developer)', () => {
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'developer', content: 'system prompt' },
            { role: 'user', content: 'hi' },
          ],
          reasoning_effort: 'max',
        }),
      ),
    )
    const roles = body['messages'].map((message: { role: string }) => message.role)
    expect(roles).toEqual(['system', 'user'])
    expect(body['reasoning_effort']).toBe('max')
  })
})

describe('classifyUpstreamError', () => {
  it('classifies 402 as hard credit', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
  })

  it('classifies credit wording in a 200-shaped business error', () => {
    expect(classifyUpstreamError(200, 'code=1 msg=积分不足，请充值')).toBe('hard_credit')
  })

  it('classifies the offline session marker as session dead', () => {
    expect(classifyUpstreamError(401, 'Offline user session not found')).toBe('session_dead')
  })

  it('classifies 429 as soft rate', () => {
    expect(classifyUpstreamError(429, 'slow down')).toBe('soft_rate')
  })

  it('classifies 404 as transient not-found', () => {
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })

  it('classifies 5xx as server and other 4xx as client', () => {
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(400, 'bad')).toBe('client')
  })
})

describe('regionOf', () => {
  it('treats workbuddy.ai domains as global and everything else as cn', () => {
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('workbuddy.ai')).toBe('global')
    expect(regionOf('US.WorkBuddy.AI')).toBe('global')
    expect(regionOf('')).toBe('cn')
  })
})

describe('prepareInternationalChatBody effort handling (issues #49 and #13)', () => {
  it("drops the adapter's own `off` spelling on the international wire", () => {
    // pi-ai sends `model.thinkingLevelMap.off` for every request that carries
    // no explicit level; the international endpoint rejects it on the GPT
    // family with 400 / 11133 / `extError.param === 'reasoning.effort'`.
    // Omission is the only form measured good on every such model — including
    // `gpt-6-astra`, which also rejects a literal `'none'`.
    //
    // The strip itself now lives in the shared `prepareChatBody` (#13 showed CN
    // rejects the same spelling); this case stays because the international
    // layer must not reintroduce it, and it is the region the GPT family lives in.
    const body = JSON.parse(
      prepareInternationalChatBody(
        JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
          reasoning_effort: 'off',
        }),
      ),
    )
    expect('reasoning_effort' in body).toBe(false)
  })

  it('keeps declared spellings and an explicit `none` untouched', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(
        prepareInternationalChatBody(
          JSON.stringify({
            messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
            reasoning_effort: effort,
          }),
        ),
      )
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('strips `off` on every early-return path, not only the system-prompt one', () => {
    // A body without a messages array takes an early return; the strip must
    // still apply, or such a request would reach the international endpoint
    // carrying the rejected spelling. It does, because the strip happens in the
    // shared layer *before* the region-specific branching.
    const body = JSON.parse(
      prepareInternationalChatBody(JSON.stringify({ reasoning_effort: 'off' })),
    )
    expect('reasoning_effort' in body).toBe(false)
  })
})
