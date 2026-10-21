/**
 * 上游失败的结构化分类。
 *
 * 判定顺序是刻意的：**结构化信号优先，HTTP 状态次之，文案匹配只做兜底**。
 * 上游一旦改动提示文案，靠子串匹配的错误分类就会静默失效；而 `extError.code`
 * 这类机器码与 HTTP 状态是协议的一部分，稳定得多。文案匹配保留下来只是因为
 * 部分失败既不带码也不带明确状态，此时它是唯一线索 —— 命中兜底时调用方应当
 * 记日志，让新出现的文案能被发现并补进码表。
 *
 * @module dsh-workbuddy-bridge/protocol/errors
 */

import z from '@deepseek-ai/schemastery'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client'

/** 一次已分类的上游失败。 */
export interface UpstreamFailure {
  /** HTTP 状态；传输层失败为 0。 */
  status: number
  kind: UpstreamErrorKind
  /** 上游机器码（`extError.code`），没有则缺省。 */
  code?: string
  /** 业务码（`{code,msg}` 信封的 code），非 0 时才有意义。 */
  envelopeCode?: number
  /** 给日志与诊断用的一行说明，不含凭据。 */
  message: string
  /** 该结论来自文案兜底而非结构化信号：不可靠，值得记日志。 */
  fromTextFallback: boolean
}

/**
 * 观测到的上游机器码 → 失败类别。
 *
 * 这张表的每一条都来自真实响应（见 docs/），不是推测。遇到表里没有的码时
 * 按 HTTP 状态兜底，并把码打进日志，方便补表 —— 宁可分类粗一点，也不要猜。
 */
const UPSTREAM_CODE_KINDS: Readonly<Record<string, UpstreamErrorKind>> = {
  // 会话已失效：App 里重新登录才能恢复。
  '12153': 'session_dead',
  // 非法渠道调用（例如 developer 角色、system 以固定句开头）：请求本身不被接受。
  '11128': 'client',
  // 参数越界（例如 max_tokens 低于模型下限）。
  '11133': 'client',
  // 账号被上游风控限制（2026-10-21 实测：`displayMsg.zh` 为「账号存在异常行为，
  // 已被限制使用」，附 `SUBMIT_FEEDBACK` 申诉动作）。归 `client` 是刻意的：
  // 它不是本机凭据失效，重登录与换 key 都无效，而 `session_dead` 会让宿主把
  // 整轮失败显示成鉴权问题。
  '11140': 'client',
}

/** 业务码 → 失败类别：信封 code 非 0 时的第一落点。 */
const ENVELOPE_CODE_KINDS: Readonly<Record<number, UpstreamErrorKind>> = {
  12153: 'session_dead',
  11128: 'client',
  11133: 'client',
  11140: 'client',
}

/**
 * 文案兜底标记。**只在既无机器码也无业务码可依时使用**，且命中后必须记日志：
 * 它是唯一的线索，同时也是最容易失效的一环。中英两种拼写都在，因为上游两种都返回过。
 */
const TEXT_MARKERS: readonly (readonly [marker: string, kind: UpstreamErrorKind])[] = [
  ['insufficient credit', 'hard_credit'],
  ['no credit', 'hard_credit'],
  ['credit exhausted', 'hard_credit'],
  ['credits exhausted', 'hard_credit'],
  ['out of credit', 'hard_credit'],
  ['quota exceeded', 'hard_credit'],
  ['payment required', 'hard_credit'],
  ['credit not enough', 'hard_credit'],
  ['积分不足', 'hard_credit'],
  ['额度不足', 'hard_credit'],
  ['余额不足', 'hard_credit'],
  ['积分用完', 'hard_credit'],
  ['额度用尽', 'hard_credit'],
  ['没有积分', 'hard_credit'],
  ['offline user session not found', 'session_dead'],
  // 上游有时把机器码直接写进 msg 文本而不是 JSON 的 code 字段，此时它是唯一线索。
  ['12153', 'session_dead'],
  ['11128', 'client'],
  ['11133', 'client'],
  ['11140', 'client'],
]

/**
 * 上游自己的、面向用户的文案：`displayMsg` 优先，其次是 `msg`。
 *
 * 上游把「真正该给人看的那句话」放在 `displayMsg` 里（分别给出 `zh` / `zh-hant` /
 * `en` 三种拼写），而 `msg` 常常是一句机器可读的英文短语（`request illegal`）。
 * 把 `displayMsg` 丢掉的代价不是"少一句说明"：`msg` 本身看不出是封号、限流还是
 * 参数错，使用者只能看到一句无从下手的英文。
 *
 * 读取顺序固定在 `zh` → `zh-hant` → `en`：国内网关的 zh 文案是原始表述，en 是
 * 它的译文；先中文，只有上游没给中文时才退回英文。
 *
 * @param body - 响应体原文。
 * @returns 干净的、可直接展示的一行文案；读不出来返回 undefined。
 */
export function upstreamDisplayMessage(body: string): string | undefined {
  const parsed = parseJson(body)
  if (!isRecord(parsed)) return undefined
  const display = parsed['displayMsg']
  if (isRecord(display)) {
    for (const key of ['zh', 'zh-hant', 'en']) {
      const value = display[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  const msg = parsed['msg']
  if (typeof msg === 'string' && msg.trim() !== '') return msg.trim()
  const extError = parsed['extError']
  if (isRecord(extError)) {
    const message = extError['message']
    if (typeof message === 'string' && message.trim() !== '') return message.trim()
  }
  return undefined
}

/** 上游错误体：只取结构化字段，其余一概不看。 */
const ErrorBody = z.object({
  extError: z.object({ code: z.string(), message: z.string() }),
  code: z.number(),
  msg: z.string(),
})

/** 信封里的业务码与文案。 */
const EnvelopeBody = z.object({ code: z.number(), msg: z.string() })

/** 从响应体里读出结构化错误码；读不出来返回 undefined。 */
export function upstreamErrorCode(body: string): string | undefined {
  const parsed = parseJson(body)
  if (parsed === undefined) return undefined
  try {
    return ErrorBody(parsed).extError?.code
  } catch {
    return undefined
  }
}

/** 读出信封业务码；非 JSON 或无 code 字段时返回 undefined。 */
export function envelopeCodeOf(body: string): number | undefined {
  const parsed = parseJson(body)
  if (parsed === undefined) return undefined
  try {
    return EnvelopeBody(parsed).code
  } catch {
    return undefined
  }
}

/**
 * 分类一次上游失败。
 *
 * @param status - HTTP 状态；传输层失败传 0。
 * @param body - 响应体原文（已截断亦可）。
 */
export function classifyUpstreamFailure(status: number, body: string): UpstreamFailure {
  const code = upstreamErrorCode(body)
  if (code !== undefined) {
    const kind = UPSTREAM_CODE_KINDS[code] ?? kindOfStatus(status)
    return { status, kind, code, message: body.slice(0, 160), fromTextFallback: false }
  }
  const envelopeCode = envelopeCodeOf(body)
  if (envelopeCode !== undefined && envelopeCode !== 0) {
    const kind = ENVELOPE_CODE_KINDS[envelopeCode] ?? kindOfStatus(status)
    return { status, kind, envelopeCode, message: body.slice(0, 160), fromTextFallback: false }
  }
  const text = textKindOf(body)
  if (text !== undefined) {
    return { status, kind: text, message: body.slice(0, 160), fromTextFallback: true }
  }
  return {
    status,
    kind: kindOfStatus(status),
    message: body.slice(0, 160),
    fromTextFallback: false,
  }
}

/** 兼容旧调用点：只要类别，不要证据。 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  return classifyUpstreamFailure(status, body).kind
}

/** HTTP 状态到类别的兜底映射；传输层失败（0）算服务端。 */
function kindOfStatus(status: number): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500 || status === 0) return 'server'
  return 'client'
}

/** 文案兜底：命中返回类别，否则 undefined。 */
function textKindOf(body: string): UpstreamErrorKind | undefined {
  const lower = body.toLowerCase()
  for (const [marker, kind] of TEXT_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return kind
  }
  return undefined
}

/** 解析 JSON；非 JSON 返回 undefined（上游时不时返回 HTML 或空体）。 */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/** 是否是一个可按键读取的对象（数组与 null 都不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
