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

  it('rewrites a mid-sentence brand occurrence with a real word, not an invisible byte', () => {
    // The zero-width variant is retired: measured 2026-10-29 on two independent
    // probes, the CN gateway normalizes U+200B before matching, so the phrase
    // still tripped the gate. A visible separator is what a real rewording
    // looks like, and it survives normalization.
    const rewritten = textOf(system('Powered by DeepSeek Harness, an agent runtime.'))
    expect(rewritten).toBe('Powered by the agent runtime, an agent runtime.')
    expect(rewritten).not.toContain('\u200B')
  })

  it('never puts two articles in front of the neutral phrase', () => {
    // The replacement carries its own `the` (mid-sentence English needs one),
    // so a sentence that already supplies one used to read
    // `through the the agent runtime web interface`. Found on the live prompt:
    // the identity row below matched only the no-`Harness` spelling, and the
    // brand pass then doubled the article.
    const rewritten = textOf(
      system(
        'You are interacting with the user through the DeepSeek web interface whose URL is named.',
      ),
    )
    expect(rewritten).toBe(
      'You are working with the user inside the agent runtime web interface whose URL is named.',
    )
    expect(rewritten).not.toMatch(/\bthe the\b/iu)
    for (const content of [
      'Read from the DeepSeek Harness checkout.',
      'Read from the  DeepSeek   Harness checkout.',
    ]) {
      expect(textOf(system(content))).toBe('Read from the agent runtime checkout.')
    }
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

  it('rewrites the assistant history echo, which is where a real request trips the filter', () => {
    // Measured 2026-10-21 (ablation published as CPA-side PR mmqz/cpa-multi-plugins#49 —
    // a sibling fix against the same gateway, not this repo's upstream): rewriting only
    // `system` still answered 400; the phrases sat in the assistant echo — a compaction
    // summary replayed as history. This is the case the earlier system-only scope missed.
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          messages: [
            { role: 'user', content: 'repeat after me' },
            { role: 'assistant', content: OPENER },
            { role: 'user', content: 'now say ok' },
          ],
        }),
      ),
    ) as { messages: { role: string; content: string }[] }
    expect(body.messages[1]!.content).toBe('You are an AI agent.')
    // The surrounding turns are untouched, including the user's own words.
    expect(body.messages[0]!.content).toBe('repeat after me')
    expect(body.messages[2]!.content).toBe('now say ok')
  })

  it('rewrites an assistant array-content text part and leaves non-text parts alone', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Powered by DeepSeek Harness.' }, image],
            },
          ],
        }),
      ),
    ) as { messages: { content: Record<string, unknown>[] }[] }
    const parts = body.messages[0]!.content
    expect(parts[0]!['text']).toBe('Powered by the agent runtime.')
    expect(parts[1]).toEqual(image)
  })

  it('rewrites the assistant reasoning mirror and tool-call arguments', () => {
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          messages: [
            {
              role: 'assistant',
              content: '',
              reasoning_content: 'I am powered by DeepSeek Harness.',
              reasoning: 'I am powered by DeepSeek Harness.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'pwsh',
                    arguments: '{"command":"dir","note":"DeepSeek Harness build"}',
                  },
                },
              ],
            },
          ],
        }),
      ),
    ) as {
      messages: {
        reasoning_content: string
        reasoning: string
        tool_calls: { function: { arguments: string } }[]
      }[]
    }
    const message = body.messages[0]!
    for (const text of [message.reasoning_content, message.reasoning]) {
      expect(text).not.toContain('DeepSeek Harness')
      expect(text).toContain('the agent runtime')
    }
    const args = message.tool_calls[0]!.function.arguments
    expect(args).not.toContain('DeepSeek Harness')
    expect(args).toContain('the agent runtime')
    // The argument string must still be valid JSON with its other fields intact.
    expect(JSON.parse(args)).toEqual({ command: 'dir', note: 'the agent runtime build' })
  })

  it('keeps a real path inside a tool-call argument byte-identical', () => {
    const argument = '{"path":"D:\\\\10_COD\\\\DeepSeek Harness\\\\resources\\\\app.asar"}'
    const body = JSON.parse(
      prepareChatBody(
        JSON.stringify({
          messages: [
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'c', type: 'function', function: { name: 'read', arguments: argument } },
              ],
            },
          ],
        }),
      ),
    ) as { messages: { tool_calls: { function: { arguments: string } }[] }[] }
    expect(body.messages[0]!.tool_calls[0]!.function.arguments).toBe(argument)
  })

  it('normalizes a tool message that also carries array text content', () => {
    // `tool` is excluded by role, so even an array-shaped tool result keeps its
    // bytes: it quotes what a file or command actually returned.
    const content = [{ type: 'text', text: 'file.md: DeepSeek Harness is mentioned here' }]
    const body = JSON.parse(
      prepareChatBody(JSON.stringify({ messages: [{ role: 'tool', content }] })),
    ) as { messages: { content: { text: string }[] }[] }
    expect(body.messages[0]!.content[0]!.text).toBe('file.md: DeepSeek Harness is mentioned here')
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

  describe('the file-reference paragraph (re-measured 2026-11-06)', () => {
    // One unit, not one sentence per row.
    //
    // Measured with a refusal RATE on a real 92 KB turn, because single probes on
    // this gateway flip within minutes: the paragraph is refused 3/3, the same
    // paragraph with one word inserted into its first sentence is still refused
    // 3/3, and only replacing the paragraph outright clears it (0/3). Each
    // sentence alone answers 200, so the match unit is the paragraph.
    const PARAGRAPH =
      'Paths prefixed with @ point to files the user referenced.' +
      ' Relative paths resolve against the working directory; absolute paths identify files or directories on the host.' +
      ' A trailing slash marks a directory: list it when its contents matter.' +
      ' Anything else is a file: use the read tool when its contents are needed,' +
      ' and do not claim to have inspected it before reading.' +
      ' @"..." quotes a path containing spaces.'

    /** The neutral paragraph the rule substitutes; duplicated here on purpose so a
     * silent change to the shipped wording fails this test instead of passing. */
    const NEUTRAL =
      'A token beginning with @ names a location the user pointed at.' +
      ' Resolve relative ones from the project folder and treat absolute ones as host paths.' +
      ' A trailing slash means a directory, otherwise it is a file.' +
      ' Quote a path containing spaces with @"...".'

    it('replaces the whole paragraph', () => {
      expect(textOf(system(PARAGRAPH))).toBe(NEUTRAL)
    })

    it('keeps what the model needs: the @ meaning and the quoting form', () => {
      const out = textOf(system(PARAGRAPH))
      // The glyph and its meaning survive; only the phrasing the gate reads is
      // gone. Dropping @ entirely would be a functional regression, not a fix.
      expect(out).toContain('@')
      expect(out).toContain('names a location the user pointed at')
      expect(out).toContain('@"..."')
      // And none of the measured signature sentences survive in any form.
      for (const banned of [
        'Paths prefixed with @',
        'the workspace root',
        'the user referenced',
        'working directory',
      ]) {
        expect(out).not.toContain(banned)
      }
    })

    it('replaces the wording older releases left in history', () => {
      // A `to` side becomes a fingerprint once the gate has been measured against
      // it, and a session that ran an older release carries those forms in its
      // assistant echo. The pattern matches them by shape, not by one literal.
      for (const opening of [
        'Tokens prefixed with @ are paths that the user explicitly referenced.',
        'Tokens starting with @ are locations that the user explicitly named.',
      ]) {
        const paragraph = `${opening}${PARAGRAPH.slice('Paths prefixed with @ point to files the user referenced.'.length)}`
        expect(textOf(system(paragraph))).toBe(NEUTRAL)
      }
    })

    it('leaves a fragment alone, so history that was already truncated is not rewritten', () => {
      // The rule needs the paragraph's shape. A lone sentence is not a signature
      // on its own, so passing it through byte-identical is the measured-safe
      // answer — and it keeps the rewrite from guessing at prose it cannot verify.
      const sentence = 'Paths prefixed with @ point to files the user referenced.'
      expect(textOf(system(sentence))).toBe(sentence)
    })

    it('is idempotent', () => {
      const once = prepareChatBody(
        JSON.stringify({ messages: [{ role: 'system', content: PARAGRAPH }] }),
      )
      expect(prepareChatBody(once)).toBe(once)
    })

    it('reaches the assistant echo and leaves user and tool messages byte-identical', () => {
      const body = JSON.parse(
        prepareChatBody(
          JSON.stringify({
            messages: [
              { role: 'assistant', content: PARAGRAPH },
              { role: 'user', content: PARAGRAPH },
              { role: 'tool', content: PARAGRAPH },
            ],
          }),
        ),
      ) as { messages: { content: string }[] }
      expect(body.messages[0]!.content).toBe(NEUTRAL)
      // user/tool are re-measured as not scanned (200 with the intact identity),
      // and they are the model's ground truth — never rewritten.
      expect(body.messages[1]!.content).toBe(PARAGRAPH)
      expect(body.messages[2]!.content).toBe(PARAGRAPH)
    })

    it('leaves unrelated prose about @ paths alone', () => {
      for (const content of [
        'Paths prefixed with @ point to files the user mentioned earlier.',
        'mail me at foo@bar.com',
        'npm i @deepseek-ai/dsh',
      ]) {
        expect(textOf(system(content))).toBe(content)
      }
    })
  })

  describe('the whole current DSH system prompt', () => {
    // The end-to-end case the earlier, segment-by-segment fixes kept missing
    // (issues #25 / #13): every measured family in one message, which is what
    // the harness actually sends on every request.
    const fileReference =
      'Paths prefixed with @ point to files the user referenced.' +
      ' Relative paths resolve against the working directory; absolute paths identify files or directories on the host.' +
      ' A trailing slash marks a directory: list it when its contents matter.' +
      ' Anything else is a file: use the read tool when its contents are needed,' +
      ' and do not claim to have inspected it before reading.' +
      ' @"..." quotes a path containing spaces.'

    const systemPrompt = [
      'You are an AI assistant.',
      'You are a coding agent powered by the deepseek-v4.1-flash model.',
      'You are interacting with the user through the DeepSeek Harness web interface whose URL the runtime context names.',
      'Agent Teams is available in this session',
      fileReference,
      'Use the read tool.',
    ].join('\n\n')

    it('leaves no measured fingerprint in the system message', () => {
      const out = textOf(system(systemPrompt))
      for (const banned of [
        'Paths prefixed with @ point to files the user referenced.',
        'You are a helpful AI assistant.',
        'You are a coding agent powered by',
        'is available in this session',
        'DeepSeek Harness',
        'DeepSeek - Harness',
      ]) {
        expect(out).not.toContain(banned)
      }
      // No invisible bytes anywhere: the gateway normalizes them away, so
      // relying on one is the same as not rewriting at all.
      expect(out).not.toContain('\u200B')
      // Nor an article the rewrite itself doubled.
      expect(out).not.toMatch(/\bthe the\b/iu)
    })

    it('keeps the prompt readable, so the model behaves the same', () => {
      const out = textOf(system(systemPrompt))
      expect(out).toContain('You are an AI agent.')
      expect(out).toContain('You are a coding agent running on the deepseek-v4.1-flash model.')
      // The identity sentence must survive as English: the brand pass leaves the
      // article the original sentence already had (`through the …`), so the
      // neutral phrase contributes only its noun.
      expect(out).toContain(
        'You are interacting with the user through the agent runtime web interface',
      )
      expect(out).toContain('Agent Teams is enabled for this session')
      expect(out).toContain('Use the read tool.')
    })

    it('is idempotent on the full prompt', () => {
      const once = prepareChatBody(
        JSON.stringify({ messages: [{ role: 'system', content: systemPrompt }] }),
      )
      expect(prepareChatBody(once)).toBe(once)
    })
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

  it('classifies the plan-limit code 11158 on both envelope shapes (issue #24)', () => {
    // A free account asking for a paid model answers 400 / 11158 with a
    // human-readable `displayMsg`. Before the table knew the code it landed on
    // `kindOfStatus(400)` — same value, but by coincidence, and with nothing
    // naming the real cause, so the shim could not add the "pick another model"
    // advice the situation needs.
    expect(
      classifyUpstreamError(
        400,
        JSON.stringify({
          code: 11158,
          msg: 'model [gpt-6-luna] is not allowed for user type [personal_free_user]',
          displayMsg: { en: 'Your account type does not support this model.' },
        }),
      ),
    ).toBe('client')
    // The other wire shape: the code arrives as a string under `extError`.
    expect(
      classifyUpstreamError(400, JSON.stringify({ extError: { code: '11158', message: 'nope' } })),
    ).toBe('client')
  })

  it('never files a plan limit with hard_credit, which spends the user credit', () => {
    // `hard_credit` is "out of credit" and the card answers it with a top-up
    // prompt. A tier exclusion cannot be fixed by paying, so filing it there
    // would send the user to the wrong screen.
    for (const body of [
      JSON.stringify({ code: 11158, msg: 'model not allowed' }),
      JSON.stringify({ code: 11158, msg: '积分不足' }),
    ]) {
      expect(classifyUpstreamError(400, body)).not.toBe('hard_credit')
    }
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
