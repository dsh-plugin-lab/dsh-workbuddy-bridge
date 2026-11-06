/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop apps'
 * sign-in. Registers one provider per product variant — `workbuddy` for the CN
 * app and `workbuddy-ai` for the international one — while streaming, tool
 * calls, compaction, and permissions stay Harness-owned.
 *
 * The two variants are assembled by the same factory and differ only in their
 * {@link WorkBuddyVariant} descriptor: each gets its own credential store,
 * catalog, upstream client, shim, adapter, probe state, and routes. Neither
 * variant's startup, catalog fetch, or credential state can stop the other from
 * registering — a user with only one app installed sees only that group.
 *
 * @module dsh-workbuddy-bridge
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
// Type-only, and load-bearing: this is the merge that declares `sessions` on
// the Context and `session/event` on Events. Without it the attribution
// subscriber below cannot typecheck (and a value import would pull a host
// service into the module graph for no runtime reason).
import type {} from '@deepseek-ai/dsh-session'
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from './credential/store.ts'
import {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
} from './catalog/index.ts'
import { workbuddyCatalogPath, WorkBuddyCatalogStore } from './catalog/store.ts'
import { WorkBuddyVisibilityStore, workbuddyVisibilityPath } from './catalog/visibility.ts'
import { createWorkBuddyAdapter } from './llm/adapter.ts'
import { lastCapturedRequest, recordChatOutcome, rememberChatRequest } from './llm/capture.ts'
import { createWorkBuddyShim } from './llm/shim.ts'
import {
  attributeCredit,
  WorkBuddyCreditLog,
  WorkBuddySessionCreditIndex,
  type AssistantMessageEventData,
} from './llm/credit-log.ts'
import { WorkBuddyProbeService } from './probe/service.ts'
import { resolveEfforts } from './probe/efforts.ts'
import { WorkBuddyProbeStore, workbuddyProbePath } from './probe/store.ts'
import { WorkBuddyUpstreamClient } from './protocol/client.ts'
import { registerWorkBuddyStatusRoute } from './web/status.ts'
import { registerWorkBuddyCreditRoute } from './web/credit.ts'
import { createProbeKey, registerWorkBuddyProbeRoute } from './web/probe-route.ts'
import type { WorkBuddyModelInfo } from './catalog/index.ts'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './shared/paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './web/heartbeat.ts'
import { WORKBUDDY_BRIDGE_VERSION } from './version.ts'
import { CN_VARIANT, WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './variants.ts'

export {
  WORKBUDDY_PROVIDER,
  WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
  createWorkBuddyAdapter,
  type WorkBuddyAdapter,
} from './llm/adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './llm/shim.ts'
export { WorkBuddyCreditLog, WorkBuddySessionCreditIndex } from './llm/credit-log.ts'
export {
  WORKBUDDY_CREDIT_PATH,
  registerWorkBuddyCreditRoute,
  workBuddyCreditHandler,
  workBuddySessionCredits,
  type WorkBuddyCreditRouteOptions,
  type WorkBuddyWebSessionCredits,
} from './web/credit.ts'
export {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog/index.ts'
export {
  WORKBUDDY_CATALOG_FILENAME,
  workbuddyCatalogPath,
  WorkBuddyCatalogStore,
} from './catalog/store.ts'
export {
  WORKBUDDY_VISIBILITY_FILENAME,
  WorkBuddyVisibilityStore,
  workbuddyVisibilityPath,
} from './catalog/visibility.ts'
export {
  fingerprintModel,
  WorkBuddyProbeStore,
  workbuddyProbePath,
  WORKBUDDY_PROBE_FILENAME,
  type WorkBuddyProbeRecord,
  type WorkBuddyProbeValidation,
} from './probe/store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe/probe.ts'
export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe/service.ts'
export {
  AI_VARIANT,
  CN_VARIANT,
  variantFor,
  WORKBUDDY_VARIANTS,
  type WorkBuddyVariant,
} from './variants.ts'
export {
  appUserAgent,
  installedAppVersion,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
  WORKBUDDY_APP_VERSION_FILENAME,
  type AppVersionInfo,
  type WorkBuddyAppVersionSource,
} from './protocol/app-version.ts'
export {
  CN_APP_VERSION_FILENAME,
  FALLBACK_CN_APP_VERSION,
  chatUserAgent,
  fallbackChatIdentity,
  readCliVersion,
  resolveChatIdentity,
  validCliVersion,
  type ChatIdentity,
  type ResolveChatIdentityOptions,
} from './protocol/client-identity.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  desktopAuthCandidatesFor,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './credential/store.ts'
export {
  classifyUpstreamError,
  modelWithCurrentPromotion,
  normalizeCredits,
  parseModelCatalog,
  prepareChatBody,
  prepareInternationalChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyCatalogFetch,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyPromotion,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './protocol/client.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './web/heartbeat.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * A startup-only catalog fetch cannot notice a sign-in that happens while DSH
 * is already running, so the model group would not appear until a restart. This
 * poll is a cheap existence/parse read of at most a few local files: it never
 * contacts the network and never runs a reasoning probe.
 *
 * `DSH_WORKBUDDY_POLL_MS` overrides it. That exists so the sweep can be
 * exercised end to end in tests and shortened while diagnosing a slow sign-in
 * on a real machine; it is not a product setting and no UI exposes it. The
 * value is clamped to a sane range so a mistaken override cannot turn the poll
 * into a busy loop.
 */
const CREDENTIAL_POLL_MS = 30_000

/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs(): number {
  const override = Number(process.env['DSH_WORKBUDDY_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * How long to wait before retrying a catalog fetch that failed.
 *
 * The credential sweep deliberately does not re-fetch a catalog it already has
 * (a same-identity token rotation carries no new model information). But a
 * *failed* fetch must not be treated the same way: without a retry, one
 * transient network blip at startup would leave the group on the built-in
 * fallback roster until the user noticed and pressed refresh. This bound keeps
 * that recovery automatic while still honoring the "not every round" rule — at
 * most one attempt per interval, and none at all once a live catalog lands.
 *
 * Expressed as a multiple of the sweep rather than a fixed duration so the two
 * stay in proportion under the `DSH_WORKBUDDY_POLL_MS` override.
 */
const CATALOG_RETRY_SWEEPS = 10

/**
 * Plugin configuration.
 *
 * No field is optional: an empty string means "not set", which is also what
 * the form shows. That is forced by `.volatile()` — a volatile field always
 * carries a value, so an optional marker here would describe a different type
 * than the schema produces (and `exactOptionalPropertyTypes` rejects the
 * mismatch rather than letting it slide).
 */
export interface Config {
  /** Explicit WorkBuddy (CN) desktop auth-file path, overriding env and platform defaults; empty means "use the app's own". */
  authFile: string
  /** Explicit WorkBuddy AI (international) desktop auth-file path; empty means "use the app's own". */
  authFileAI: string
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent: boolean
  /** Use the largest context window the international catalog explicitly offers. */
  useMaximumContextWindow: boolean
}

/** Explicit CN desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_FIELD = z
  .string()
  .default('')
  .volatile()
  .description("WorkBuddy desktop auth file (defaults to the app's own location)")
/** Explicit international desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_AI_FIELD = z
  .string()
  .default('')
  .volatile()
  .description("WorkBuddy AI desktop auth file (defaults to the app's own location)")
/** Probe authorization (shared by the plugin schema and the CN section). */
const PROBE_CONSENT_FIELD = z
  .boolean()
  .default(false)
  .volatile()
  .description(
    'Authorize reasoning-effort probes (each probe sends real requests that may consume credit)',
  )
const MAXIMUM_CONTEXT_WINDOW_FIELD = z
  .boolean()
  .default(true)
  .volatile()
  .description(
    'Use the largest context window declared by WorkBuddy AI when alternatives are available (on by default)',
  )

/**
 * Every field is `.volatile()`, and both reasons matter:
 *
 * 1. **Only volatile fields reach the form.** The host's `volatileForm()` returns
 *    `undefined` when a schema has no volatile field, which drops the whole entry
 *    out of `describe()` — so `ctx.configForms.get(ENTRY_ID)` never becomes ready
 *    and the plugin's configuration area stays **empty**, with no error anywhere.
 *    A single field missing `.volatile()` does not fail loudly either; it just
 *    silently vanishes from the form.
 * 2. **The write path is allow-listed per volatile path.** A non-volatile path is
 *    rejected outright (`Config field "..." is not volatile`), so a form that did
 *    show the field could never save it.
 *
 * `.default()` must come **before** `.volatile()`: the former fixes the mode, the
 * latter then yields `Volatile<T>` rather than `Volatile<T | undefined>`.
 *
 * The side effect is welcome: with every field volatile the Loader always
 * concludes "only volatile fields changed", so editing configuration never
 * remounts the plugin and `apply` runs exactly once.
 *
 * Host sources: `packages/settings/settings/src/schema.ts` (`volatileForm`) and
 * `settings/src/index.ts` (`write`).
 */
/**
 * The reference face `apply` receives: every field is a cell whose `get()`
 * returns the current value.
 *
 * An all-volatile schema is what makes that so — the Loader commits new values
 * into the running references and remounts only the volatile parts, so this
 * plugin never remounts and `apply` runs exactly once. It also means a value
 * must never be captured into a field: read it through {@link configOf} at the
 * point of use, because the reference always holds the newest value.
 *
 * Host sources: `vendor/cosmokit/src/volatile.ts` (`Volatile<T>` exposes only
 * `get()`) and `vendor/loader/src/config/entry.ts` (`_commitVolatile`).
 */
export type ConfigRefs = { readonly [K in keyof Config]: Volatile<Config[K]> }

export const Config = z.object({
  authFile: AUTH_FILE_FIELD,
  authFileAI: AUTH_FILE_AI_FIELD,
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
})

/**
 * Read the current plain configuration.
 *
 * Called at the point of use rather than cached: see {@link ConfigRefs}. Several
 * callers are lazy accessors evaluated long after `apply` returned, and those
 * must observe an edit made in between.
 * @param refs - the reference face handed to `apply`.
 * @returns the values in effect right now.
 */
function configOf(refs: ConfigRefs): Config {
  // The `?? ` fallbacks repeat the schema's own defaults. A volatile reference
  // is typed `Volatile<T | undefined>` for a `.default()` field, and the schema
  // is the only place the default is applied — so repeating it here is what
  // keeps the value face honest rather than casting the difference away.
  return {
    authFile: refs.authFile.get() ?? '',
    authFileAI: refs.authFileAI.get() ?? '',
    probeConsent: refs.probeConsent?.get() ?? false,
    useMaximumContextWindow: refs.useMaximumContextWindow?.get() ?? true,
  }
}

/** One variant's live runtime, assembled by {@link createVariantRuntime}. */
interface VariantRuntime {
  variant: WorkBuddyVariant
  store: WorkBuddyCredentialStore
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  probeStore: WorkBuddyProbeStore
  probeService: WorkBuddyProbeService
  /**
   * Response id → what that response cost, as the upstream reported it.
   *
   * Written by the shim when a stream's final usage frame arrives; read by the
   * Session-event handler below, which is the other half of the key. Per
   * variant, because each variant's shim serves only its own provider's
   * traffic, and one variant's response ids can never appear in the other's
   * sessions.
   */
  creditLog: WorkBuddyCreditLog
  /**
   * `sessionId → messageId → credit`, the shape the browser half reads.
   *
   * Shared by both variants on purpose, unlike {@link creditLog}: the value is
   * already attributed to a message id by the time it lands here, and a session
   * can switch providers mid-conversation (the user changing models), so
   * keying the browser-visible index per variant would lose every message sent
   * under the other provider.
   */
  creditIndex: WorkBuddySessionCreditIndex
  /**
   * The last catalogs that loaded, keyed by account.
   *
   * Sits between the live fetch and the built-in roster in the degradation
   * order: a restart, or a fetch that fails while offline, serves what this
   * account was last actually shown instead of the one-off snapshot compiled
   * into the plugin.
   */
  savedCatalogs: WorkBuddyCatalogStore
  /**
   * This variant's per-account hidden-model preferences (issue #36). One file
   * per variant, keyed by account: a model id one account hid never hides for
   * another, and switching accounts switches the whole list in one read.
   */
  visibilityStore: WorkBuddyVisibilityStore
  /**
   * The visibility account key currently in effect (`uid:enterpriseId`), or
   * undefined when signed out or the credential carries no uid. Read per call,
   * so an account switch changes the answer without rebuilding anything.
   */
  account: () => string | undefined
  /** The static roster this variant falls back to. */
  fallback: readonly WorkBuddyModelInfo[]
  /**
   * Where the served models came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch) →
   * `fallback` (the roster compiled into the plugin).
   */
  catalogSource: 'live' | 'saved' | 'fallback'
  /** When the served catalog was fetched, for `live` and `saved`. */
  catalogFetchedAtMs: number | undefined
  /** Why the last catalog attempt failed, when it did. */
  catalogError: string | undefined
  /** When the last catalog attempt started, for the retry backoff. */
  lastFetchAtMs: number
  /**
   * Bumped whenever this variant's catalog generation changes — an account
   * switch, a sign-out, or a new fetch superseding an older one. A request
   * carries the generation it started under and refuses to write back if the
   * generation has moved on, so a slow answer can never resurrect data the
   * plugin has since decided to drop (spec §5: late responses are discarded).
   */
  catalogGeneration: number
  /**
   * The in-flight catalog fetch, scoped to the identity and generation it began
   * under. A caller may only join the same scope; an account change cancels the
   * old request and immediately starts one for the newly adopted account.
   */
  inflightFetch: CatalogFetch | undefined
  /** Notify the model directory that this variant's answers changed. */
  invalidate: () => void
  /** Whether the provider registered successfully. */
  registered: boolean
}

/** One catalog request plus the identity state it is allowed to update. */
interface CatalogFetch {
  identity: string
  generation: number
  controller: AbortController
  promise: Promise<void>
}

/** Stable identity key used by credentials, probe records, and catalog entries. */
function credentialIdentity(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string {
  return `${credential.uid}:${credential.enterpriseId ?? ''}`
}

/**
 * The account key model-visibility preferences are stored under: the stable
 * identity, but only when it carries a uid.
 *
 * A credential whose desktop document carried no `account.uid` normalizes to
 * an empty string; keying preferences on the resulting `":enterpriseId"` would
 * silently share one bucket between every such account. Those accounts get no
 * per-account preferences at all — everything stays visible and the control
 * route explains the refusal — which is the only honest degradation: it never
 * applies one account's hidden list to another.
 */
export function visibilityAccountOf(
  credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>,
): string | undefined {
  return credential.uid === '' ? undefined : credentialIdentity(credential)
}

/**
 * Read the configured explicit auth-file path for one variant.
 *
 * An empty string means "not set" — that is what the schema's default and the
 * form's empty field both produce — and it must be reported as `undefined`
 * rather than passed along. The consumers below treat a *present* path as
 * authoritative and stop falling back to the env var and the platform default,
 * so forwarding `''` would silently disable both.
 * @param config - the plain configuration in effect.
 * @param variant - which of the two desktop apps this is for.
 * @returns the configured path, or `undefined` when the field is empty.
 */
function configuredAuthFile(config: Config, variant: WorkBuddyVariant): string | undefined {
  const path = variant.id === CN_VARIANT.id ? config.authFile : config.authFileAI
  return path === '' ? undefined : path
}

/**
 * The static catalog a variant serves before its first successful fetch.
 *
 * Each variant has its own roster: the two endpoints share several model ids
 * but not their billing, context windows, or reasoning sets, so one shared
 * fallback would misdescribe whichever variant it was not captured from.
 */
function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS
}

/** Build one variant's stores and probe state. */
function createVariantRuntime(
  config: Config,
  variant: WorkBuddyVariant,
  identityOf: (variantId: string) => string | undefined,
  accountOf: (variantId: string) => string | undefined,
  creditIndex: WorkBuddySessionCreditIndex,
): VariantRuntime {
  const client = new WorkBuddyUpstreamClient({
    // Diagnostic only, and cheap when disarmed (`rememberChatRequest` returns
    // immediately). Wired here because the client is one per variant and the
    // hook sees the final headers — the half a refused request can differ in
    // even when its body replays cleanly.
    onChatRequest: ({ url, headers, body }) => {
      rememberChatRequest(url, headers, body)
    },
    onChatOutcome: (outcome) => {
      recordChatOutcome(outcome.status, outcome.message)
    },
  })
  const configured = configuredAuthFile(config, variant)
  const store = new WorkBuddyCredentialStore({
    variant,
    ...(configured === undefined ? {} : { desktopPath: configured }),
    refresh: (credential) => client.refreshToken(credential),
  })
  const fallback = fallbackFor(variant)
  const catalog = new WorkBuddyCatalog(fallback)
  if (variant.id !== CN_VARIANT.id)
    catalog.setUseMaximumContextWindow(config.useMaximumContextWindow === true)
  // Start hidden: a variant must serve no models until an account has actually
  // been adopted, so a signed-out variant is empty rather than showing a roster
  // whose models could only fail. `adoptIdentity` is what reveals it, and it
  // treats "never seen, still signed out" as no change — which is only correct
  // if the pre-adoption state is already hidden.
  catalog.setVisible(false)
  const probeStore = new WorkBuddyProbeStore({
    pluginVersion: WORKBUDDY_BRIDGE_VERSION,
    path: workbuddyProbePath(variant.probeFilename),
  })
  // One file per variant, for the same reason the probe records are split: the
  // two endpoints disagree about rates and windows for shared model ids, so a
  // saved CN roster must never be served as an international one.
  const savedCatalogs = new WorkBuddyCatalogStore(workbuddyCatalogPath(variant.catalogFilename))
  const visibilityStore = new WorkBuddyVisibilityStore(
    workbuddyVisibilityPath(variant.visibilityFilename),
  )
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => config.probeConsent,
    // Observations are per account: the service reads and writes its records
    // against this identity, so one account's detected levels never answer for
    // another's, and an in-flight sweep cannot store under a new account.
    account: () => identityOf(variant.id),
  })
  return {
    variant,
    store,
    client,
    catalog,
    probeStore,
    probeService,
    creditLog: new WorkBuddyCreditLog(),
    creditIndex,
    savedCatalogs,
    visibilityStore,
    account: () => accountOf(variant.id),
    fallback,
    catalogSource: 'fallback',
    catalogFetchedAtMs: undefined,
    catalogError: undefined,
    lastFetchAtMs: 0,
    catalogGeneration: 0,
    inflightFetch: undefined,
    invalidate: () => {},
    registered: false,
  }
}

/** The catalog provenance the card displays. */
function catalogSection(runtime: VariantRuntime): WorkBuddyWebCatalog {
  const fetch = runtime.client.lastCatalog
  return {
    // The source is what the models on screen actually came from, so the card
    // can distinguish a fresh fetch from a saved one from the built-in roster —
    // "stale" and "offline" are different problems for the user.
    source: runtime.catalogSource,
    // The served catalog's own fetch time, which for a saved list is when it
    // was fetched, not when the process started.
    ...(runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs }),
    ...(fetch?.appVersion === undefined ? {} : { appVersion: fetch.appVersion.version }),
    ...(runtime.catalogError === undefined ? {} : { error: runtime.catalogError }),
  }
}

/**
 * One row per reasoning model, describing its thinking-level switch.
 *
 * The judgement comes from {@link resolveEfforts} — the *same* function the
 * adapter builds the model picker from — so the composer's bulb and the picker
 * cannot describe different models. That sharing is the fix for what used to be
 * two independent answers: a candidate list ("who could be probed") beside a
 * result list ("who has been probed"), which between them told the user nothing
 * about the only question they had, namely which models let them pick a level.
 *
 * Read through `recordFor` rather than straight from the store, so a record the
 * adapter already discounts — its catalog row changed, it aged past the TTL, or
 * the upstream has since declared a set — is discounted here too. A model the
 * upstream dropped leaves the catalog entirely and drops out of this list.
 */
function probeSection(runtime: VariantRuntime, consent: boolean): WorkBuddyWebProbeSection {
  const models = runtime.catalog.current().flatMap((info) => {
    // A model that does not reason has no switch to describe.
    if (info.reasoning?.supports !== true) return []
    const record = runtime.probeService.recordFor(info.id)
    const resolved = resolveEfforts(info, record)
    return [
      {
        id: info.id,
        name: info.name,
        efforts: resolved.efforts,
        source: resolved.source,
        detectable: resolved.detectable,
        ...(record === undefined
          ? {}
          : { validation: record.validation, probedAt: record.probedAtMs }),
      },
    ]
  })
  return {
    consent,
    running: runtime.probeService.isRunning(),
    models: detectedFirst(models),
  }
}

/**
 * Order the effort rows for display: most recently detected first, then the
 * catalog's own order.
 *
 * The list is no longer "the models you could probe" but "every model and what
 * its switch does", so it must stay stable as detections land — a row that
 * moves when its own result arrives is a row the user has to find again. Only
 * the detected rows are promoted, and ties keep catalog order (a stable sort),
 * which is what makes the movement predictable.
 */
function detectedFirst<T extends { probedAt?: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (b.probedAt ?? -1) - (a.probedAt ?? -1))
}

/**
 * Start one variant: its loopback endpoint, provider registration, and
 * configuration-card wiring.
 *
 * Registration waits for the shim to hold a port, because the provider's
 * models read the shim origin at construction time. A failure here is
 * contained to this variant: the caller logs it and the other keeps working.
 *
 * @returns whether the provider registered.
 */
async function startVariant(ctx: Context, runtime: VariantRuntime): Promise<boolean> {
  const { variant, store, client, catalog, probeService, creditLog } = runtime
  const shim = createWorkBuddyShim({
    store,
    client,
    catalog,
    logger: ctx.logger,
    // Every response this variant streams past the shim reports what it cost;
    // remembering it here is what lets the assistant-message event below
    // attribute a number to a message id.
    observeCredit: (responseId, credit) => {
      creditLog.record(responseId, credit)
    },
  })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(
      `dsh-workbuddy-bridge: ${variant.displayName} loopback endpoint failed to start`,
      error,
    )
    return false
  }

  try {
    // Constructed only once the listener holds a port: the provider's models
    // read the shim origin at construction time.
    const workbuddy = createWorkBuddyAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      observe: (modelId) => probeService.recordFor(modelId),
      // Hidden ids resolve per read from the store by the *current* account:
      // an account switch or a toggle changes the answer after the next
      // invalidate, and a signed-out or uid-less variant hides nothing.
      hidden: () => {
        const account = runtime.account()
        return account === undefined ? [] : runtime.visibilityStore.hidden(account)
      },
    })
    runtime.invalidate = () => {
      workbuddy.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    // Only the adapter registers. The plugin deliberately contributes NO
    // `registerConfigurableProviders` directory entry: the Models settings page
    // builds its rows from that registration, so
    // omitting it keeps the WorkBuddy providers off that page (its editor has
    // no fields to offer them) while the adapter keeps serving models and the
    // sections keep serving `settings.yaml` and the TUI. A live route with no
    // directory entry joins with an empty `settingsNs`, which every page reads
    // as unconfigured and does not render. Nothing else consumes the
    // directory: the model picker's group headings come from the adapter's own
    // provider metadata and catalog, and `/model` resolves through the
    // adapter, so both are unaffected.
    const releaseAdapter = ctx.llm.registerAdapter([variant.id], workbuddy.adapter)
    try {
      ctx.effect(() => () => {
        releaseAdapter()
        void shim.close()
      })
    } catch {
      // `ctx.effect` throws when the context is already disposed, so the
      // disposer it would have registered never runs: release this variant's
      // own registration (and its shim) here instead.
      releaseAdapter()
      void shim.close()
    }
    runtime.registered = true
    return true
  } catch (error: unknown) {
    ctx.logger.error(
      `dsh-workbuddy-bridge: ${variant.displayName} provider registration failed`,
      error,
    )
    void shim.close()
    return false
  }
}

/**
 * Start both variants: their loopback endpoints, the `workbuddy` and
 * `workbuddy-ai` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a sign-in that happens after startup
 * working without re-registering the provider.
 */
export function apply(ctx: Context, refs: ConfigRefs): void {
  /**
   * The configuration in effect *now*.
   *
   * A function rather than a captured object because the references are live:
   * the lazy accessors registered below outlive `apply`, and an edit made in
   * between must be visible to them.
   */
  const config = (): Config => configOf(refs)
  /** Timers and in-flight work belonging to this plugin instance. */
  let stopped = false
  const timers: NodeJS.Timeout[] = []
  /**
   * The account identity each variant last published a catalog for. Keeps a
   * same-identity token rotation from re-fetching, and lets a late response
   * from a previous identity be discarded instead of overwriting a newer one.
   */
  const lastIdentities = new Map<string, string>()
  /**
   * The visibility account key each variant last adopted, parallel to
   * {@link lastIdentities}: same credential, second key — undefined both when
   * signed out and when the credential carried no uid, which is exactly the
   * case that must not fall back to a shared preference bucket.
   */
  const lastAccounts = new Map<string, string>()

  // The at-rest key provider per variant is the store's own default now: the
  // store knows its variant, so the per-product discovery rule lives with it
  // (`atRestDiscoveryFor` in src/credential/store.ts) instead of being spelled
  // out here and in the CLI.
  // One accounting index for the whole plugin, not one per variant: by the time
  // a cost is written here it is already keyed by a message id, and a session
  // may switch providers mid-conversation, so a per-variant index would lose
  // every message sent under the other provider.
  const creditIndex = new WorkBuddySessionCreditIndex()
  const runtimes = WORKBUDDY_VARIANTS.map((variant) =>
    createVariantRuntime(
      config(),
      variant,
      (id) => lastIdentities.get(id),
      (id) => lastAccounts.get(id),
      creditIndex,
    ),
  )

  // Same-origin routes backing each Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  const probeKey = createProbeKey()
  /**
   * Point a variant at an account identity, invalidating whatever the previous
   * one left behind.
   *
   * One helper for all four transitions (sweep sign-in, sweep sign-out, manual
   * refresh, manual refresh sign-out) because each of them used to do its own
   * partial version, and the manual path forgot pieces the sweep did. Every
   * transition bumps {@link VariantRuntime.catalogGeneration}, which is what
   * makes an in-flight request from before the change refuse to write back.
   *
   * Probe observations are kept across an account change: the store nests them
   * per account, so the departing account's records simply stop being served
   * (every read is account-scoped) and are found intact if that account
   * returns. The "signed out, then in as someone else" sequence that used to
   * look like a first sighting is still safe — a record only ever answers for
   * the account stamped on it, so the new account inherits nothing. Visibility
   * preferences are kept for the same reason, and read through the new
   * account's key immediately: the picker re-lists after the invalidate below
   * and a returning account finds its own hidden list back in force.
   *
   * @param identity - the account now in effect, or `undefined` when signed out.
   * @param account - the visibility key for that same credential (`undefined`
   * also when the credential carries no uid); stored alongside the identity so
   * preference reads never guess it from the identity string.
   */
  const adoptIdentity = (
    runtime: VariantRuntime,
    identity: string | undefined,
    account: string | undefined,
  ): void => {
    const id = runtime.variant.id
    const known = lastIdentities.get(id)
    if (known === identity) return
    const hadCredential = known !== undefined
    if (identity === undefined) lastIdentities.delete(id)
    else lastIdentities.set(id, identity)
    if (account === undefined) lastAccounts.delete(id)
    else lastAccounts.set(id, account)
    // Any change of identity invalidates in-flight work and the catalog it was
    // serving; recorded probe answers stay on disk, keyed by account and
    // re-judged on every read.
    runtime.catalogGeneration += 1
    runtime.inflightFetch?.controller.abort()
    runtime.inflightFetch = undefined
    if (hadCredential && known !== identity) {
      runtime.invalidate()
    }
    if (identity === undefined) {
      // Signed out: hide the group, and drop the models so they are not left
      // registered-but-invisible if visibility ever flips back. The signed-out
      // account's saved catalog is forgotten as well — it is that account's
      // data, and it is keyed by identity so nothing else can serve it, but
      // keeping it would only be useful if that same account returned, and the
      // file is not a place to accumulate departed accounts' catalogs.
      if (known !== undefined) runtime.savedCatalogs.delete(known)
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
      runtime.catalogError = undefined
      if (runtime.catalog.setVisible(false)) runtime.invalidate()
      return
    }
    // Serve this account's best-known catalog until a fetch lands. The saved
    // catalog is preferred over the built-in roster: the roster is a snapshot
    // taken once, while the saved one is what this account (from this source)
    // was actually served. This covers both a switch and a restart — on a
    // restart `hadCredential` is false, and the saved catalog is exactly what
    // stops the group from falling back to the compiled-in list.
    const saved = runtime.savedCatalogs.get(identity)
    if (saved !== undefined) {
      runtime.catalog.set([...saved.models])
      runtime.catalogSource = 'saved'
      runtime.catalogFetchedAtMs = saved.fetchedAtMs
    } else {
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
    }
    runtime.catalogError = undefined
    runtime.catalog.setVisible(true)
    runtime.invalidate()
  }

  ctx.inject(['webServer'], (webCtx) => {
    // Mounted once, not per variant: the accounting is already keyed by DSH
    // message id, and a conversation can switch between the two products — or
    // away from both — mid-thread, so a per-variant route would strand every
    // message whose turn ran under the other one.
    registerWorkBuddyCreditRoute(webCtx, { credits: creditIndex })
    for (const runtime of runtimes) {
      registerWorkBuddyStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        client: runtime.client,
        models: () => runtime.catalog.current(),
        catalog: () => catalogSection(runtime),
        probe: () => probeSection(runtime, config().probeConsent),
        probeKey,
        // Diagnostic: re-send the last captured request from inside this process.
        // See `web/status.ts` for the experiment it answers.
        replayCaptured: async () => {
          const captured = lastCapturedRequest()
          if (captured === undefined) return { error: 'nothing captured' }
          const credential = await runtime.store.resolve()
          const result = await runtime.client.chatStream(credential, captured.body)
          return {
            ok: result.ok,
            replayedStatus: result.ok ? result.response.status : result.status,
            capturedAt: captured.at,
            capturedStatus: captured.status,
            bodyLength: captured.body.length,
          }
        },
        // The full per-account hidden list — stale ids included — so the card's
        // checkboxes answer exactly what the picker filter reads. Absent (and
        // the card renders no controls) when no uid-keyed account is in effect.
        visibility: () => {
          const account = runtime.account()
          return account === undefined
            ? undefined
            : { account, hidden: runtime.visibilityStore.hidden(account) }
        },
        // Reported as a fact, not edited from here: the preference is a
        // configuration field now, and the card points at the settings page
        // rather than writing a second, competing copy of it.
        ...(runtime.variant.id === CN_VARIANT.id
          ? {}
          : {
              useMaximumContextWindow: () => config().useMaximumContextWindow,
            }),
      })
      registerWorkBuddyProbeRoute(
        webCtx,
        {
          path: runtime.variant.probePath,
          probe: async (modelId) => {
            // The authenticated manual endpoint is called only after per-model confirmation.
            const result = await runtime.probeService.probe(modelId, true)
            if (result.state === 'ok') runtime.invalidate()
            return result
          },
          clear: () => {
            runtime.probeStore.clear()
            runtime.invalidate()
          },
          refresh: async () => {
            if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
            // Re-read the credential first: the user pressed this because the list
            // looks wrong, and a sign-in that happened since the last sweep is the
            // common cause. Re-registering is unnecessary — visibility is what
            // changes, and the sweep owns that.
            let credential
            try {
              credential = await runtime.store.current()
            } catch (error: unknown) {
              // A refused credential (wrong region, unreadable file) is a report,
              // not a crash out of the route.
              return {
                state: 'failed',
                reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
              }
            }
            if (credential === undefined) {
              adoptIdentity(runtime, undefined, undefined)
              return { state: 'signed-out' }
            }
            const identity = credentialIdentity(credential)
            // Same transition the sweep performs: a switch reached through the
            // manual path must drop the previous account's data *now*, not when
            // the fetch lands, or a failed fetch leaves those models pickable.
            adoptIdentity(runtime, identity, visibilityAccountOf(credential))
            await fetchCatalog(runtime, identity)
            return runtime.catalogError === undefined
              ? { state: 'refreshed', reason: `${runtime.catalog.current().length} models` }
              : { state: 'failed', reason: runtime.catalogError }
          },
          setModelVisibility: async (modelId, visible, expectedAccount) => {
            // Refused rather than bucketed: a signed-out variant, or a
            // credential with no uid, has no account to key the preference by,
            // and writing it anywhere else would let one account's hidden list
            // answer for another.
            const account = runtime.account()
            if (account === undefined) {
              return {
                state: 'failed',
                reason: 'model visibility needs a signed-in account with a stable user id',
              }
            }
            // Expected-account guard: the card names the account its checkboxes
            // were rendered from. A card still showing account A while the
            // desktop has already switched to B must not land A's toggle in B's
            // bucket — refuse, and the card refreshes into B's own section.
            if (expectedAccount !== account) {
              return { state: 'stale-account', reason: 'the signed-in account changed' }
            }
            try {
              runtime.visibilityStore.setVisible(account, modelId, visible)
            } catch (error: unknown) {
              // A toggle that did not persist must not be reported as saved.
              return {
                state: 'failed',
                reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
              }
            }
            runtime.invalidate()
            return { state: 'updated' }
          },
        },
        probeKey,
      )
    }
  })

  /**
   * Attribute an observed response cost to the message that caused it.
   *
   * The two halves of the key are produced by different layers and in either
   * order, so this is deliberately a join rather than a straight read:
   *
   * - the **shim** sees `usage.credit` on the stream and knows the upstream
   *   response id (`cmb-…`), but nothing about DSH's message ids;
   * - the **session log** records the assistant message with its DSH
   *   `messageId` and, inside `source.replayState.response.responseId`, that
   *   same upstream id.
   *
   * The session event normally lands *after* the stream's final frame (the
   * message is appended once the stream settles), so `creditLog.lookup` usually
   * hits. `creditLog.await` covers the opposite interleaving — a response whose
   * final frame arrives after its message was appended — instead of leaving
   * that message permanently unlabelled.
   *
   * Only variants' own provider routes are considered: the response id is
   * matched against each variant's own log, so a DeepSeek-account message can
   * never be charged a WorkBuddy cost.
   */
  ctx.inject(['sessions'], (sessionCtx) => {
    sessionCtx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const data = event.data as AssistantMessageEventData
      // Only a variant's own provider route is considered: the response id is
      // matched against that variant's own log, so a DeepSeek-account message
      // can never be charged a WorkBuddy cost.
      const provider = data.message?.source?.provider
      const runtime =
        typeof provider === 'string'
          ? runtimes.find((candidate) => candidate.variant.id === provider)
          : undefined
      if (runtime === undefined) return
      const sessionId = session.id
      attributeCredit(runtime.creditLog, runtime.creditIndex, sessionId, data)
    })
  })

  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    void clearHostHeartbeat()
  })

  /**
   * Fetch one variant's catalog for the current credential.
   *
   * Shared by the credential sweep and the card's manual refresh, and written
   * so that concurrent callers cost one request and cannot interleave badly:
   *
   * - **One request at a time.** A second caller joins the in-flight fetch
   *   instead of starting its own (spec §5: one catalog request per variant at
   *   a time).
   * - **Generation-checked write-back.** The request records the generation it
   *   started under and writes nothing if the generation moved on — which is
   *   what a slow answer from a superseded account must not do. Checking only
   *   the *identity* was not enough: two refreshes for the same account can
   *   still finish out of order, and the older one would win.
   * - **`resolve()`, not `config`.** Only `resolve()` performs the locked,
   *   single-flight token renewal. Reading `config` meant an expired token
   *   made every catalog request fail until something else happened to refresh
   *   it, leaving the group on the fallback roster.
   */
  const fetchCatalog = async (runtime: VariantRuntime, identity: string): Promise<void> => {
    const inflight = runtime.inflightFetch
    const generation = runtime.catalogGeneration
    if (
      inflight !== undefined &&
      inflight.identity === identity &&
      inflight.generation === generation
    ) {
      return inflight.promise
    }
    // A caller should normally reach this only after `adoptIdentity()` has
    // already cancelled a previous generation. Keep this guard local as well:
    // no stale request may prevent the current account from fetching now.
    inflight?.controller.abort()
    const controller = new AbortController()
    const run: Promise<void> = (async (): Promise<void> => {
      let models: readonly WorkBuddyModelInfo[]
      try {
        const credential = await runtime.store.resolve()
        const resolvedIdentity = credentialIdentity(credential)
        // `config` established the identity that owns this fetch, but
        // `resolve()` reads the desktop file again. The App can switch accounts
        // between those reads; never send or persist B's directory as A's.
        if (resolvedIdentity !== identity) {
          adoptIdentity(runtime, resolvedIdentity, visibilityAccountOf(credential))
          await fetchCatalog(runtime, resolvedIdentity)
          return
        }
        models = await runtime.client.fetchModels(credential, controller.signal)
        // The account can also change while the upstream request is in flight.
        // Re-read before publishing so the just-finished document still belongs
        // to the account that is currently selected in the desktop App.
        const latest = await runtime.store.current()
        const latestIdentity = latest === undefined ? undefined : credentialIdentity(latest)
        if (latestIdentity !== identity) {
          adoptIdentity(
            runtime,
            latestIdentity,
            latest === undefined ? undefined : visibilityAccountOf(latest),
          )
          if (latestIdentity !== undefined) await fetchCatalog(runtime, latestIdentity)
          return
        }
      } catch (error: unknown) {
        // Report only if this attempt is still the current one; a failure from
        // a superseded attempt must not overwrite the newer state's error.
        if (stopped || runtime.catalogGeneration !== generation) return
        runtime.lastFetchAtMs = Date.now()
        runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error)
        ctx.logger.warn(
          `dsh-workbuddy-bridge: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`,
          error,
        )
        runtime.invalidate()
        return
      }
      if (stopped || runtime.catalogGeneration !== generation) return
      runtime.lastFetchAtMs = Date.now()
      runtime.catalog.set([...models])
      runtime.catalogSource = 'live'
      runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now()
      runtime.catalogError = undefined
      // Remember it for this account, so a restart — or a later fetch that
      // fails — can serve what this account was actually shown rather than the
      // snapshot compiled into the plugin.
      if (lastIdentities.get(runtime.variant.id) === identity) {
        runtime.savedCatalogs.set(identity, {
          source: runtime.client.lastCatalog?.source ?? 'unknown',
          fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
          models: [...models],
          ...(runtime.client.lastCatalog?.appVersion === undefined
            ? {}
            : { appVersion: runtime.client.lastCatalog.appVersion.version }),
        })
      }
      runtime.invalidate()
    })().finally(() => {
      if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = undefined
    })
    runtime.inflightFetch = { identity, generation, controller, promise: run }
    return run
  }

  /**
   * Reconcile one variant with its credentials.
   *
   * Four transitions matter, and each is a different action:
   *
   * - **none → some** (first sighting): reveal the group and fetch a catalog.
   * - **none → some, identity changed**: additionally drop the previous
   *   account's observations, so another user's probe answers cannot be read as
   *   the new account's.
   * - **some → none**: hide the group and stop serving its models.
   * - **same identity**: nothing to do — the store refreshes tokens on demand,
   *   and re-fetching on every rotation would hit the catalog endpoint for no
   *   new information.
   */
  const syncVariant = async (runtime: VariantRuntime): Promise<void> => {
    if (stopped || !runtime.registered) return
    const credential = await readCredential(runtime)
    if (stopped) return

    if (credential === undefined) {
      adoptIdentity(runtime, undefined, undefined)
      return
    }

    const identity = credentialIdentity(credential)
    const known = lastIdentities.get(runtime.variant.id)
    if (known === identity && runtime.catalog.isVisible()) {
      // Same account, already showing something. One case still needs a fetch:
      // an earlier attempt failed, so the group is on the fallback roster and
      // nothing else will ever replace it. Retry on a slow backoff rather than
      // every sweep, so a persistent outage does not become a request loop.
      // Any non-live source is stale: both the saved catalog and the built-in
      // roster are worth replacing with a fresh fetch on the same backoff.
      const stale = runtime.catalogSource !== 'live'
      const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS
      if (stale && due) await fetchCatalog(runtime, identity)
      return
    }

    adoptIdentity(runtime, identity, visibilityAccountOf(credential))
    await fetchCatalog(runtime, identity)
  }

  /**
   * Read a variant's credential, reporting a refusal instead of swallowing it.
   *
   * A region mismatch or an unreadable file is *reported*, not treated as
   * "signed out": the user needs to know which file to fix, and the difference
   * between "no credential" and "a credential I refused" is exactly what the
   * card's reason codes are for.
   *
   * @returns the credential, or `undefined` when there is none to use.
   */
  const readCredential = async (
    runtime: VariantRuntime,
  ): Promise<WorkBuddyCredential | undefined> => {
    try {
      return await runtime.store.current()
    } catch (error: unknown) {
      ctx.logger.warn(
        `dsh-workbuddy-bridge: ${runtime.variant.displayName} credential read failed`,
        error,
      )
      return undefined
    }
  }

  /**
   * Adopt a variant's account **before its provider registers**.
   *
   * Registration and revelation used to happen in the other order: the adapter
   * registered first (reading a catalog that was still hidden, so it built
   * *zero* models), and the first credential sweep revealed the group afterwards
   * in a fire-and-forget `syncAll()`. Between those two moments
   * `ctx.llm.listProviders()` named the provider while `resolveModelInfo`
   * answered `UNKNOWN_MODEL` for every one of its models — invisible in the
   * picker, but a session that already had one of those models selected (a
   * restored conversation, or `agent-default-model`) failed on its first
   * message. The window is tens of milliseconds here and much longer on a real
   * machine: macOS unlocks the credential through Spotlight and the app's
   * Electron, Windows goes through `reg query` and at-rest decryption, and
   * either can sit on a slow or networked drive.
   *
   * Adopting first closes it: when the provider appears, its catalog is already
   * visible, so the models exist from the first read. Nothing is lost when the
   * read fails or nobody is signed in — the variant registers hidden exactly as
   * it does today, and the poll reveals it later.
   *
   * @see .agents/notes/2026-10-02-startup-window-fix-direction.md
   */
  const adoptBeforeRegistering = async (runtime: VariantRuntime): Promise<void> => {
    const credential = await readCredential(runtime)
    if (stopped) return
    adoptIdentity(
      runtime,
      credential === undefined ? undefined : credentialIdentity(credential),
      credential === undefined ? undefined : visibilityAccountOf(credential),
    )
  }

  /** Run one reconcile sweep across both variants. */
  const syncAll = async (): Promise<void> => {
    for (const runtime of runtimes) await syncVariant(runtime)
  }

  /**
   * Bring both variants up, then start the credential sweep.
   *
   * The phases are ordered and deliberate: adopting an identity must finish
   * before the matching provider registers (see
   * {@link adoptBeforeRegistering}), and the catalogs are fetched after
   * registration so a fetch failure lands on an already-usable group rather than
   * on nothing. The two variants never wait on each other within a phase — one
   * slow credential read must not hold the other product's models back.
   */
  const startAll = async (): Promise<void> => {
    await Promise.all(runtimes.map((runtime) => adoptBeforeRegistering(runtime)))
    if (stopped) return
    await Promise.all(runtimes.map(async (runtime) => startVariant(ctx, runtime)))
    if (stopped) return
    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal; a stale heartbeat
    // after a crash is detected by PID in the reader. Written when at least one
    // variant registered, since that is what "the host bundle serves models"
    // means for this plugin.
    if (runtimes.some((runtime) => runtime.registered)) void writeHostHeartbeat()

    void syncAll()
    const timer = setInterval(() => {
      void syncAll()
    }, credentialPollMs())
    timer.unref?.()
    timers.push(timer)
  }

  void startAll()
}
