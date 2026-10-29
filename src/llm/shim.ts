/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim applies the WorkBuddy wire quirks (forced streaming, string
 * `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * Inbound hardening: the loopback bind alone is not a trust boundary (any
 * local process or a DNS-rebinding page can reach 127.0.0.1), so every
 * request must carry a loopback Host header, browser-sent Origins must be
 * loopback, chat POSTs must be application/json, and the Authorization
 * header must carry the shim's per-process shared secret. The plugin's
 * own client satisfies all four by construction; local attackers cannot
 * read the secret out of the plugin process's memory.
 *
 * @module dsh-workbuddy-bridge/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { WorkBuddyCredentialStore } from '../credential/store.ts'
import type { WorkBuddyCatalog } from '../catalog/index.ts'
import { hostIsLoopback, originIsLoopback } from '../llm/loopback.ts'
import {
  isChannelGateBody,
  prepareChatBody,
  upstreamDisplayMessage,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
} from '../protocol/client.ts'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
  /**
   * Observe what one upstream response cost, as the upstream reports it.
   *
   * Called at most once per response, at the frame carrying the number, with
   * the stream's own response id (`cmb-…`) — the same id DSH records on the
   * assistant message, which is what lets the Host half attribute a cost to a
   * message instead of guessing.
   */
  observeCredit?: (responseId: string, credit: number) => void
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/**
 * Pull the response id and `credit` out of one SSE `data:` payload.
 *
 * WorkBuddy's OpenAI-compatible stream reports what a message cost as an extra
 * `credit` member beside the standard token buckets on the final usage frame
 * (measured: `glm-5.3` answering 900 tokens reported `credit: 0.51`). The
 * member is not part of the OpenAI schema, so it is read defensively off the
 * parsed object rather than through any typed shape, and every frame without a
 * usable number is skipped.
 *
 * @param payload - the text after `data: ` on one frame.
 * @returns the response id and credit, or undefined when this frame carries none.
 */
export function readCreditFrame(payload: string): { id: string; credit: number } | undefined {
  if (payload === '' || payload.startsWith('[DONE]')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // A partial or non-JSON frame is ordinary mid-stream; nothing to report.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const frame = parsed as Record<string, unknown>
  const id = typeof frame['id'] === 'string' ? frame['id'] : ''
  if (id === '') return undefined
  const usage = frame['usage']
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return undefined
  const credit = (usage as Record<string, unknown>)['credit']
  if (typeof credit !== 'number' || !Number.isFinite(credit) || credit < 0) return undefined
  return { id, credit }
}

/**
 * Split a raw chunk into complete SSE `data:` payloads, carrying the trailing
 * partial line into the next chunk.
 *
 * A TCP read boundary lands wherever it likes — mid-JSON, mid-line — so
 * scanning each chunk on its own would parse a truncated object and drop the
 * very frame that carries the cost. The remainder is returned for the caller to
 * prepend.
 *
 * @param carry - bytes left over from the previous chunk.
 * @param chunk - the bytes just read.
 * @returns the complete payloads, and the new carry.
 */
export function readCreditChunk(
  carry: string,
  chunk: string,
): { payloads: readonly string[]; carry: string } {
  const text = carry + chunk
  const lines = text.split('\n')
  // The last element is either an incomplete line or '' when the chunk ended on
  // a newline; either way it is not a frame yet.
  const carryOver = lines.pop() ?? ''
  const payloads: string[] = []
  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (!trimmed.startsWith('data:')) continue
    payloads.push(trimmed.slice('data:'.length).trim())
  }
  return { payloads, carry: carryOver }
}

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

/**
 * What to do when the gateway refuses a request on content (code `11-128`).
 *
 * Two actions only, and the copy keeps the code spelled `11-128` so that the
 * guidance itself, echoed back into a later request, cannot re-arm the gate.
 * No status digits (see {@link failureMessage}) and no retry advice: retrying
 * the same poisoned conversation reproduces the refusal.
 */
const CHANNEL_GATE_HINT =
  ' — 渠道校验拦截（11-128）。请新开会话重试；若持续出现，先更新插件' +
  ' / blocked by channel verification (11-128): start a new conversation, and update the plugin if it persists'

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function writeOpenAIError(
  res: ServerResponse,
  status: number,
  kind: string,
  message: string,
): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/**
 * The one-line reason a failed upstream request is reported with.
 *
 * The host does not read our HTTP status to classify a failure: `dsh-llm-pi-ai`
 * matches the **message text** (`if (/\b(?:401|403)\b/.test(message)) return
 * "AUTH"`), and the chat UI then replaces whatever we wrote with
 * "API key is invalid". So a status may only appear here when the failure
 * really is an authentication one; every other class keeps its digits out, or
 * a restricted account or a rejected prompt reaches the user as a bad key.
 *
 * The upstream's own `displayMsg` wins over the raw body: it is the sentence
 * written for a human ("账号存在异常行为，已被限制使用"), while the body is a JSON
 * document whose `msg` is often a machine phrase such as `request illegal`.
 *
 * The channel-gate code (`11-128`) appends {@link CHANNEL_GATE_HINT}: its raw
 * body is `{"message":"请求被拦截，请重新发送","type":"client","code":"client"}`,
 * which on its own reads as a transient hiccup the user should simply retry —
 * the two actions that actually help (a new conversation; update the plugin)
 * are not guessable from it.
 */
function failureMessage(result: {
  status: number
  kind: UpstreamErrorKind
  message: string
}): string {
  const reason = upstreamDisplayMessage(result.message) ?? result.message.slice(0, 400)
  const head = `workbuddy upstream ${result.kind}`
  // `session_dead` is the one class where the status *is* the actionable fact
  // (sign in again), and where the host's AUTH reading happens to be right.
  const line =
    result.kind === 'session_dead'
      ? `${head} (http ${result.status}): ${reason}`
      : `${head}: ${reason}`
  return isChannelGateBody(result.message) ? `${line}${CHANNEL_GATE_HINT}` : line
}

/** Read a request body with a size cap; over-limit bodies fail the request. */ function readBody(
  req: IncomingMessage,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, client, catalog, observeCredit } = options
  const logger = options.logger

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  // The shim never forwards it upstream — the real credential comes from the
  // store. A local attacker who can hit the port still cannot forge this.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const expected = SHARED_SECRET
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Inbound hardening: every request must name the loopback host, and
      // browser-sent origins must be loopback too. The plugin's own client
      // always satisfies both; DNS-rebinding pages and cross-origin POSTs
      // do not.
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(
          res,
          403,
          'host_not_allowed',
          'Host header must name the loopback interface',
        )
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map((model) => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'workbuddy',
          })),
        })
        return
      }
      if (
        req.method === 'POST' &&
        (url === '/v1/chat/completions' || url === '/v1/chat/completions/')
      ) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, failureMessage(result))
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    /**
     * Bytes of the frame currently being read.
     *
     * The cost arrives on the last usage frame, and that frame is exactly the
     * one a TCP read boundary is most likely to split: parsing each chunk in
     * isolation would drop it. Complete lines are accumulated into `carry` and
     * only whole `data:` payloads are inspected.
     */
    let carry = ''
    /** The last cost observed for this response; reported once, at the end. */
    let observed: { id: string; credit: number } | undefined
    /**
     * Decodes the byte stream without splitting a multi-byte character across
     * chunks.
     *
     * `chunk.toString('utf8')` would turn a character straddling a read
     * boundary into U+FFFD, and since answers routinely contain Chinese that is
     * not hypothetical. A mangled frame fails `JSON.parse` and is dropped —
     * which for the frame carrying the cost would mean a message silently
     * losing its label.
     */
    const decoder = new StringDecoder('utf8')
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true
      if (observeCredit === undefined) return
      const read = readCreditChunk(carry, decoder.write(chunk))
      carry = read.carry
      for (const payload of read.payloads) {
        const frame = readCreditFrame(payload)
        // Keep the latest rather than the first: a response may report
        // intermediate usage frames, and only the final one is the total.
        if (frame !== undefined) observed = frame
      }
    })
    body.on('error', (error: unknown) => {
      logger?.warn('dsh-workbuddy-bridge: upstream stream failed mid-flight', error)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    // Report after the response is fully written, so the callback never runs
    // while the browser half is still waiting on this same request.
    body.on('end', () => {
      if (observeCredit !== undefined && observed !== undefined) {
        observeCredit(observed.id, observed.credit)
      }
    })
    body.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => resolve())
        server.closeAllConnections()
        server.once('error', reject)
      }),
  }
}
