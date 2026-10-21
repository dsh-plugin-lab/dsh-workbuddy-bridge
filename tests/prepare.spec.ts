import { describe, expect, it } from 'vitest'
import {
  classifyUpstreamError,
  prepareChatBody,
  prepareInternationalChatBody,
  regionOf,
  upstreamDisplayMessage,
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

describe('prepareChatBody channel signature (measured 2026-10-21)', () => {
  const OPENER = 'You are an AI agent powered by DeepSeek Harness.'
  const system = (content: unknown): Record<string, unknown> =>
    JSON.parse(prepareChatBody(JSON.stringify({ messages: [{ role: 'system', content }] })))
  const textOf = (body: Record<string, unknown>): string =>
    (body['messages'] as { content: unknown }[])[0]!.content as string

  it('rewrites the DSH opener a system message starts with', () => {
    const body = system(`${OPENER}\n\nYou are a coding agent.`)
    expect(textOf(body)).toBe('You are an AI agent.\n\nYou are a coding agent.')
  })

  it('rewrites the opener on a developer message too, which is what pi-ai sends', () => {
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          messages: [
            { role: 'developer', content: OPENER },
            { role: 'user', content: 'hi' },
          ],
        }),
      ),
    ) as { messages: { role: string; content: string }[] }
    expect(body.messages[0]!.role).toBe('system')
    expect(body.messages[0]!.content).toBe('You are an AI agent.')
  })

  it('tolerates leading whitespace, a BOM, and any case or spacing in the phrase', () => {
    // The prefix is carried through untouched: only the sentence is rewritten,
    // so a prompt's own indentation or BOM survives verbatim.
    for (const [content, expected] of [
      [`\n\n  ${OPENER}`, '\n\n  You are an AI agent.'],
      [`\uFEFF${OPENER}`, `\uFEFFYou are an AI agent.`],
      ['You are an AI agent powered by DeepSeek\u00A0Harness.', 'You are an AI agent.'],
      ['you are an ai agent powered by deepseek harness.', 'You are an AI agent.'],
      ['You are an AI agent powered by  DeepSeek   Harness.', 'You are an AI agent.'],
    ] as const) {
      expect(textOf(system(content))).toBe(expected)
    }
  })

  it('rewrites the phrase in every array-shaped text part, and leaves other parts alone', () => {
    const parts = [
      { type: 'text', text: OPENER },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      { type: 'text', text: 'mentions DeepSeek Harness mid-sentence.' },
    ]
    const body = system(parts)
    const rewritten = (body['messages'] as { content: Record<string, string>[] }[])[0]!.content
    expect(rewritten[0]!['text']).toBe('You are an AI agent.')
    expect(rewritten[2]!['text']).not.toContain('DeepSeek Harness')
    // The non-text part is byte-identical: the gateway inspects text only, and
    // rewriting an image part would corrupt the attachment.
    expect(rewritten[1]).toEqual(parts[1])
  })

  it('breaks a mid-sentence occurrence losslessly, keeping the whitespace it used', () => {
    expect(textOf(system('Powered by DeepSeek Harness, an agent runtime.'))).toBe(
      'Powered by DeepSeek\u200B Harness, an agent runtime.',
    )
  })

  it('never rewrites the phrase inside a path, where it is a real directory name', () => {
    // A zero-width space in a path would make every tool call that quotes it
    // fail with a path the model cannot see is wrong.
    for (const content of [
      'The checkout is at D:\\10_COD\\DeepSeek Harness\\resources\\app.asar.',
      'The checkout is at /opt/DeepSeek Harness/resources/app.asar.',
      'See DeepSeek Harness/resources for details.',
    ]) {
      expect(textOf(system(content))).toBe(content)
    }
  })

  it('leaves user and tool messages untouched', () => {
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          messages: [
            { role: 'user', content: OPENER },
            { role: 'tool', content: OPENER },
          ],
        }),
      ),
    ) as { messages: { content: string }[] }
    expect(body.messages[0]!.content).toBe(OPENER)
    expect(body.messages[1]!.content).toBe(OPENER)
  })

  it('is idempotent, so the international layer may run the body twice', () => {
    const once = prepareChatBody(
      JSON.stringify({
        messages: [{ role: 'system', content: `${OPENER}\n\nPowered by DeepSeek Harness.` }],
      }),
    )
    expect(prepareChatBody(once)).toBe(once)
    expect(JSON.parse(prepareInternationalChatBody(once))['messages']).toEqual(
      JSON.parse(once)['messages'],
    )
  })

  it('survives a body with no messages array', () => {
    expect(prepareChatBody(JSON.stringify({ model: 'm' }))).toBe(
      JSON.stringify({ model: 'm', stream: true }),
    )
  })
})

describe('upstreamDisplayMessage', () => {
  it('prefers the Chinese display message the gateway writes for a human', () => {
    expect(
      upstreamDisplayMessage(
        JSON.stringify({
          code: 11140,
          msg: 'request illegal',
          displayMsg: {
            en: 'Your account has been restricted',
            zh: '账号存在异常行为，已被限制使用',
          },
        }),
      ),
    ).toBe('账号存在异常行为，已被限制使用')
  })

  it('falls back through zh-hant, en, msg and extError.message', () => {
    expect(upstreamDisplayMessage(JSON.stringify({ displayMsg: { 'zh-hant': '帳號異常' } }))).toBe(
      '帳號異常',
    )
    expect(upstreamDisplayMessage(JSON.stringify({ displayMsg: { en: 'restricted' } }))).toBe(
      'restricted',
    )
    expect(upstreamDisplayMessage(JSON.stringify({ msg: 'request illegal' }))).toBe(
      'request illegal',
    )
    expect(
      upstreamDisplayMessage(JSON.stringify({ extError: { code: 'x', message: 'boom' } })),
    ).toBe('boom')
  })

  it('returns undefined for bodies with nothing to show', () => {
    for (const body of ['not json', '{}', '', '{"displayMsg":{}}', '[]']) {
      expect(upstreamDisplayMessage(body)).toBeUndefined()
    }
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
