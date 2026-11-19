/**
 * WorkBuddy 5.6.x at-rest credential protection: classification, key
 * resolution, and field decryption for the desktop app's encrypted auth file.
 *
 * Since WorkBuddy 5.6 the desktop app encrypts `auth.accessToken` and
 * `auth.refreshToken` at rest (`buildPolicy: "fields"`, on by default), so the
 * plugin reads `{$wbEncrypted:1, envelope}` wrappers instead of token strings
 * (issues #39/#40). Everything needed to open them lives on the same machine:
 *
 * - the sealed payload (`{version:1, atRestSecretKey}`) comes from the
 *   WorkBuddy-modified Electron's private `workbuddyStorage` binding, reached
 *   by running *its own* binary once with `ELECTRON_RUN_AS_NODE=1`;
 * - `protectorKey = sha256(atRestSecretKey, utf8)` opens the envelopes with
 *   AES-256-GCM; the AAD builder below is transcribed from the app's own
 *   `buildAuthenticatedContextAad` (verified live against 5.6.2, see
 *   `docs/r3-final.js` in the working copy — not committed).
 *
 * The plugin process itself can never call `_linkedBinding` (it runs in DSH's
 * Node, not the forked Electron), so the helper is spawned. The key is cached
 * in memory only, single-flight, and re-resolved when an envelope names a
 * different key id. Neither the payload, the key, nor any token is ever
 * logged; error messages carry sizes, ids, and exit codes only.
 *
 * @module dsh-workbuddy-bridge/desktop-credential-protection
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { WorkBuddySignedOutReasonCode } from '../shared/paths.ts'

/** The four states a desktop auth document can be read as. */
export type DesktopAuthFormat = 'absent' | 'plaintext' | 'encrypted' | 'unrecognized'

/** Env variable that overrides the WorkBuddy Electron binary used as the key helper. */
export const WORKBUDDY_ELECTRON_BIN_ENV = 'WORKBUDDY_ELECTRON_BIN'

/** Platform-default Electron binary, confirmed only on macOS (5.6.2). */
const MACOS_ELECTRON_PATH = '/Applications/WorkBuddy.app/Contents/MacOS/Electron'

/**
 * The Windows install locations probed in order, confirmed on WorkBuddy 5.6.2.
 *
 * The app ships the Electron runtime as `WorkBuddy.exe` beside its `resources/`
 * and `locales/` directories — there is no `Electron.exe`, and the launcher is
 * the runtime itself (it honours `ELECTRON_RUN_AS_NODE`, which is what the key
 * helper relies on).
 *
 * The default location is `%LOCALAPPDATA%\Programs\WorkBuddy`, but the 5.6.2
 * installer here put it at the drive root (`E:\WorkBuddy`), so the registry's
 * `DisplayIcon` is consulted as well — see {@link windowsElectronCandidates}.
 */
/**
 * Which WorkBuddy product a Windows discovery pass is looking for.
 *
 * The two products are separate installs with separate directory names and
 * separate executable names, so "the WorkBuddy app" is ambiguous on a machine
 * that has both. Discovery therefore runs *per product*: it never falls back
 * from one to the other, because a CN binary can only answer for CN envelopes.
 */
export type WorkBuddyElectronProduct = 'cn' | 'ai'

/**
 * The Electron runtime each Windows installer ships, keyed by product.
 *
 * Both are the runtime itself — there is no `Electron.exe`, and the launcher is
 * the runtime (it honours `ELECTRON_RUN_AS_NODE`, which is what the key helper
 * relies on).
 *
 * The Global app is `WorkBuddyAI.exe` inside `Programs\\WorkBuddyAI` — no space,
 * and *not* `Programs\\WorkBuddy`, which is the CN layout. Verified against
 * WorkBuddy AI 5.11.4; the CN name is the 5.6.2 one.
 */
const WINDOWS_ELECTRON_FILENAME: Readonly<Record<WorkBuddyElectronProduct, string>> = {
  cn: 'WorkBuddy.exe',
  ai: 'WorkBuddyAI.exe',
}

/** Where each Windows installer puts the app unless the user picks another drive. */
const WINDOWS_LOCAL_PROGRAM_SUFFIX: Readonly<Record<WorkBuddyElectronProduct, readonly string[]>> =
  {
    cn: ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
    ai: ['Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'],
  }

/**
 * The Electron binary one discovery strategy expects at its default location, or
 * `undefined` where that strategy has no verified layout on this platform.
 *
 * Keyed by **strategy** rather than by platform: a strategy names both the
 * product and the layout it expects, so a macOS-strategy provider on Windows
 * must report no default rather than this platform's — `discoverMacosApp` would
 * contradict it a moment later, and a caller reading `helperPath()` for
 * diagnostics would be pointed at a binary that can never run.
 *
 * A platform without a verified layout must set
 * {@link WORKBUDDY_ELECTRON_BIN_ENV} explicitly — guessing would spawn the wrong
 * app's binary.
 */
export function defaultWorkBuddyElectronPath(
  discovery: WorkBuddyElectronDiscovery = 'none',
  product: WorkBuddyElectronProduct = 'cn',
): string | undefined {
  if (discovery === 'macos-workbuddy' && process.platform === 'darwin') return MACOS_ELECTRON_PATH
  if (discovery === 'windows-workbuddy' && process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA']?.trim()
    if (localAppData !== undefined && localAppData !== '') {
      return join(localAppData, ...WINDOWS_LOCAL_PROGRAM_SUFFIX[product])
    }
  }
  return undefined
}

/** One decrypted-openable envelope's decoded parts. */
export interface WorkBuddyEnvelope {
  suite: number
  keyId: string
  nonce: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

/** One auth field found in its encrypted wrapper, with its envelope decoded. */
export interface WrappedAuthField {
  field: 'accessToken' | 'refreshToken'
  envelope: WorkBuddyEnvelope
}

/**
 * A read desktop auth document, as a discriminated union on `format`. The
 * `encrypted` variant carries the parsed document plus the fields still in
 * wrappers; the caller decrypts those fields and hands the rebuilt text to
 * the regular parser, so identity and expiry fields need no second code path.
 */
export type DesktopAuthClassification =
  | { format: 'absent' }
  | { format: 'plaintext' }
  | {
      format: 'encrypted'
      wrapped: { document: Record<string, unknown>; fields: readonly WrappedAuthField[] }
    }
  | { format: 'unrecognized' }

/** Distinct key ids across the wrapped fields, in field order. */
export function keyIdsOf(fields: readonly WrappedAuthField[]): string[] {
  return [...new Set(fields.map((wrapped) => wrapped.envelope.keyId))]
}

/**
 * Whether a raw value is the 5.6 field wrapper, with its inner envelope
 * decodable. The wrapper is `{$wbEncrypted:1, envelope:<base64 of a JSON
 * {suite,keyId,nonce,authTag,ciphertext>}}`; anything claiming the flag whose
 * envelope cannot be decoded makes the whole document unrecognized rather
 * than encrypted, because no key could ever open it.
 */
function parseWrappedField(
  field: 'accessToken' | 'refreshToken',
  value: unknown,
): WrappedAuthField | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = value as Record<string, unknown>
  if (wrapped['$wbEncrypted'] !== 1 || typeof wrapped['envelope'] !== 'string') return undefined
  let inner: unknown
  try {
    inner = JSON.parse(Buffer.from(wrapped['envelope'], 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined
  const parts = inner as Record<string, unknown>
  const nonce = parseBase64(parts['nonce'], 12)
  const authTag = parseBase64(parts['authTag'], 16)
  const ciphertext = parseBase64(parts['ciphertext'])
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (typeof parts['suite'] !== 'number' || !Number.isInteger(parts['suite'])) return undefined
  // Suite 1 is the only scheme WorkBuddy 5.6.x defines for credential fields.
  // Anything else is a format this plugin has not seen, so the wrapper is not
  // claimed as encrypted — the document then reads as unrecognized and the
  // store reports a diagnosis instead of attempting a blind open.
  if (parts['suite'] !== 1) return undefined
  if (typeof parts['keyId'] !== 'string' || !/^[0-9a-f]{16}$/u.test(parts['keyId']))
    return undefined
  return {
    field,
    envelope: {
      suite: parts['suite'],
      keyId: parts['keyId'],
      nonce,
      authTag,
      ciphertext,
    },
  }
}

/** Decode a base64 value and check its exact byte length when given. */
function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
  // Buffer.from is lenient about stray characters; require the round-trip so a
  // tampered envelope is rejected before any key material is involved.
  if (
    decoded.length === 0 ||
    decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')
  )
    return undefined
  return length === undefined || decoded.length === length ? decoded : undefined
}

const AUTH_FIELDS = ['accessToken', 'refreshToken'] as const

/**
 * Read a desktop auth document's format. `absent` is an empty file; `plaintext`
 * is any document the regular parser could read (even one without a token);
 * `encrypted` has at least one field in a decodable wrapper; everything else —
 * unparsable JSON, non-objects, wrappers whose envelope will not decode — is
 * `unrecognized`.
 */
export function classifyDesktopAuthDocument(text: string): DesktopAuthClassification {
  if (text.trim() === '') return { format: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { format: 'unrecognized' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { format: 'unrecognized' }
  const document = parsed as Record<string, unknown>
  const auth =
    typeof document['auth'] === 'object' && document['auth'] !== null
      ? (document['auth'] as Record<string, unknown>)
      : document
  const fields: WrappedAuthField[] = []
  for (const field of AUTH_FIELDS) {
    const value = auth[field]
    if (typeof value === 'string') continue
    const wrapped = parseWrappedField(field, value)
    // A field in *some* object that is not a decodable wrapper: not plaintext,
    // not usable. Treated as unrecognized below unless another field wrapped.
    if (wrapped === undefined && value !== undefined) return { format: 'unrecognized' }
    if (wrapped !== undefined) fields.push(wrapped)
  }
  if (fields.length === 0) return { format: 'plaintext' }
  return { format: 'encrypted', wrapped: { document, fields } }
}

/**
 * Decrypt a wrapped document into the plaintext text the regular parser reads.
 * Throws a diagnosable error naming the field and key ids — never envelope or
 * token content — when any wrapped field cannot be opened.
 */
export function unwrapDesktopAuthDocument(
  classification: Extract<DesktopAuthClassification, { format: 'encrypted' }>,
  openField: (wrapped: WrappedAuthField) => string,
): string {
  const wrapped = classification.wrapped
  const rebuilt = structuredClone(wrapped.document) as Record<string, unknown>
  const auth =
    typeof rebuilt['auth'] === 'object' && rebuilt['auth'] !== null
      ? (rebuilt['auth'] as Record<string, unknown>)
      : rebuilt
  for (const field of wrapped.fields) {
    auth[field.field] = openField(field)
  }
  return JSON.stringify(rebuilt)
}

/**
 * The authenticated-context AAD for one field envelope, transcribed from the
 * app bundle's `buildAuthenticatedContextAad` and verified live against 5.6.2
 * (`docs/r3-final.js` in the working copy holds the original reference).
 * Credential fields are always suite 1 under the `field` framing (WBEV1);
 * the framing family's other members (WBEF1/WBER1/WBES1) belong to other
 * document kinds and are deliberately not implemented — opening a field is
 * not a place to guess at future formats.
 */
export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  // No sequence numbers on credential fields; the final byte 0 mirrors the
  // reference script's default context.
  return Buffer.concat([
    prefix,
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/**
 * Open one envelope with a protector key; `undefined` when it will not open.
 * The accepted format is exactly what WorkBuddy 5.6.2 writes — suite 1 under
 * the `field` framing — so a failure means "not this format / wrong key",
 * and is reported as such rather than retried against other framings.
 */
export function openAuthField(key: Buffer, envelope: WorkBuddyEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** Seal one field with the exact format `openAuthField` reads. Test helper. */
export function sealAuthFieldForTest(
  key: Buffer,
  plaintext: string,
  suite = 1,
): { $wbEncrypted: 1; envelope: string } {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAuthenticatedContextAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64'),
  }
}

/** The validated `loggerGet()` payload: the sealed at-rest secret. */
export interface WorkBuddyAtRestPayload {
  atRestSecretKey: string
}

/**
 * Validate the helper's payload against the app's own rules: `version:1` and
 * a canonical-base64 32-byte, non-all-zero secret. `undefined` otherwise.
 */
export function parseAtRestPayload(text: string): WorkBuddyAtRestPayload | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const payload = parsed as Record<string, unknown>
  if (payload['version'] !== 1) return undefined
  const secret = payload['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(secret, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length !== 32) return undefined
  if (decoded.toString('base64') !== secret) return undefined
  if (decoded.every((byte) => byte === 0)) return undefined
  return { atRestSecretKey: secret }
}

/** Derive the protector key from the payload's secret (sha256 over its UTF-8 string). */
export function deriveProtectorKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** A resolved protector key and the id envelopes name for it. */
interface ResolvedKey {
  key: Buffer
  keyId: string
}

/** The spawned helper. Separated from the provider so tests can stand it in. */
export type WorkBuddyKeyPayloadSource = () => Promise<string>

/**
 * Which automatic discovery, if any, this provider may run when no explicit
 * binary is configured.
 *
 * `none` is the safe default: a provider that has not been told which product
 * it serves must not reach for another product's app.
 *
 * The two `*-workbuddy` kinds name a **platform strategy** — both verified live
 * against WorkBuddy 5.6.2, both only ever looking for the CN app — and each
 * refuses when the running platform is not its own:
 * `macos-workbuddy` resolves the platform default and then Spotlight;
 * `windows-workbuddy` resolves the platform default and then the Uninstall
 * registry key.
 */
export type WorkBuddyElectronDiscovery = 'none' | 'macos-workbuddy' | 'windows-workbuddy'

/**
 * The strategy the CN app may use on this platform.
 *
 * Both macOS and Windows have a verified WorkBuddy 5.6.2 layout; anything else
 * gets `none`, which reads as "not configured" rather than "we searched and
 * failed". Lives here — beside the strategies it chooses between — so the plugin
 * host and the CLI cannot drift apart on it, which they did once already.
 */
export function cnAppDiscovery(): WorkBuddyElectronDiscovery {
  if (process.platform === 'darwin') return 'macos-workbuddy'
  if (process.platform === 'win32') return 'windows-workbuddy'
  return 'none'
}

/**
 * The strategy the Global (WorkBuddy AI) app may use on this platform.
 *
 * Windows only, and deliberately narrower than {@link cnAppDiscovery}: the
 * Uninstall registration names the product, so a Global search can prove it is
 * looking at the Global install instead of borrowing the CN one. The macOS
 * lookup is a Spotlight search for the *CN* bundle id, which has no verified
 * Global counterpart — a Global provider keeps `'none'` there rather than
 * executing the other product's binary. An explicit `WORKBUDDY_ELECTRON_BIN`
 * still works on every platform.
 */
export function aiAppDiscovery(): WorkBuddyElectronDiscovery {
  if (process.platform === 'win32') return 'windows-workbuddy'
  return 'none'
}

/** The CN app's bundle id; the only one this round resolves by discovery. */
export const WORKBUDDY_CN_BUNDLE_ID = 'com.tencent.workbuddy.mac'

/** Absolute tool paths: never resolved through PATH, which a user can change. */
const MDFIND_BIN = '/usr/bin/mdfind'
const PLUTIL_BIN = '/usr/bin/plutil'

/** One discovery subprocess's own limits; see {@link WorkBuddyAtRestKeyProviderOptions}. */
export const WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS = 3_000
/** Whole-discovery budget, independent of the helper's own timeout. */
export const WORKBUDDY_DISCOVERY_BUDGET_MS = 10_000
const MDFIND_MAX_OUTPUT_BYTES = 1024 * 1024
const PLUTIL_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Why a discovery step could not produce an answer. Every one of these means
 * "we do not know", explicitly *not* "the candidate does not exist" — the
 * distinction is what keeps a half-finished check from being mistaken for a
 * unique candidate.
 */
class DiscoveryIncompleteError extends Error {}

/** A discovered app: its `.app` bundle and the Electron binary inside it. */
interface DiscoveredApp {
  bundlePath: string
  electronPath: string
  /** Display version, best effort; absent when unreadable. */
  version?: string
}

/** Seams the discovery flow runs through, so tests never spawn a process. */
export interface WorkBuddyDiscoveryTools {
  /** Candidate `.app` bundles for the CN bundle id, or a throw for an unusable tool. */
  findApps: (signal: AbortSignal) => Promise<readonly string[]>
  /**
   * `CFBundleIdentifier` of a bundle, or `undefined` when the tool could not
   * read it — which is "we could not check this candidate", never "it does not
   * match". A successful read of a *different* id returns that id, and the
   * caller excludes the candidate.
   */
  bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
  /** Display version, best effort; `undefined` when unavailable. */
  bundleVersion: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
}

/** Provider options. */
export interface WorkBuddyAtRestKeyProviderOptions {
  /** Explicit Electron binary; overrides the platform default and env. */
  electronPath?: string
  /** Helper timeout in milliseconds; default 10s. */
  timeoutMs?: number
  /**
   * Where the payload comes from. Defaults to spawning WorkBuddy's own
   * Electron with `ELECTRON_RUN_AS_NODE=1`; tests supply a stand-in so no
   * test ever touches the real binary or a real key. Supplying this replaces
   * path *resolution* too, so tests about resolution use
   * {@link spawnHelper} instead.
   */
  source?: WorkBuddyKeyPayloadSource
  /**
   * Runs the helper at the resolved path. Distinct from {@link source}, which
   * replaces the whole payload path: this seam keeps resolution — explicit
   * config, platform default, discovery — real, so tests can exercise it
   * without spawning anything.
   */
  spawnHelper?: (electronPath: string) => Promise<string>
  /**
   * Automatic discovery budget; defaults to `'none'` (see
   * {@link WorkBuddyElectronDiscovery}). Passed explicitly per variant at the
   * composition root, never inferred from the environment.
   */
  discovery?: WorkBuddyElectronDiscovery
  /**
   * Which product this provider serves, for the Windows layout and registry
   * identity. Defaults to `'cn'` — the product every earlier release served —
   * so an existing caller that says nothing keeps its behaviour. A Global
   * (WorkBuddy AI) provider must pass `'ai'`: the two installs have different
   * directory and executable names, and the CN executable cannot stand in.
   */
  product?: WorkBuddyElectronProduct
  /**
   * Platform default binary, consulted only when `discovery` is enabled and no
   * explicit path is configured. Injectable so tests can force the fallback
   * branch without moving the real app; `null` means "no default here".
   */
  defaultElectronPath?: string | undefined
  /** Discovery subprocesses; injectable so tests never spawn. */
  tools?: WorkBuddyDiscoveryTools
  /** Windows registry subprocess; injectable so tests never spawn `reg.exe`. */
  windowsTools?: WorkBuddyWindowsDiscoveryTools
  /**
   * Total budget for one discovery run, covering the search and every
   * candidate check. Injectable so tests can exercise exhaustion without
   * waiting out the production 10s.
   */
  discoveryBudgetMs?: number
}

/** `reg.exe` by absolute path: never resolved through `PATH`, which a user can change. */
const REG_BIN = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\reg.exe`

/** Registry paths searched for a registered WorkBuddy, in order. */
const WINDOWS_UNINSTALL_HIVES = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const

/** Three hives' worth of matching entries is far smaller than this. */
const WINDOWS_REGISTRY_MAX_OUTPUT_BYTES = 256 * 1024

/** Seams the Windows discovery flow runs through, so tests never spawn a process. */
export interface WorkBuddyWindowsDiscoveryTools {
  /**
   * Registered WorkBuddy install directories. An empty array means "the query ran
   * and matched nothing" — a decidable absence. A query that could not run at all
   * must throw {@link DiscoveryIncompleteError}, so a broken tool is never read
   * as "not installed".
   */
  findInstallRoots: (signal: AbortSignal) => Promise<readonly string[]>
}

/**
 * Whether a registration's `DisplayName` belongs to the product being searched.
 *
 * The two products register as `WorkBuddy <version>` and `WorkBuddy AI <version>`
 * on the same machine, so the CN prefix match would also accept the Global entry
 * — and then `join(root, 'WorkBuddy.exe')` would simply miss, turning a
 * *decidable* "wrong product" into a misleading "not installed". Matching the
 * product exactly keeps each variant's answer about its own app.
 *
 * A name that carries a trailing qualifier is not the app: "WorkBuddy AI Helper"
 * and "WorkBuddyUninstall" both fail the version/end boundary, so a component of
 * the product can never be read as the product itself.
 */
function matchesProduct(displayName: string, product: WorkBuddyElectronProduct): boolean {
  const appName = product === 'ai' ? 'WorkBuddy AI' : 'WorkBuddy'
  if (!displayName.startsWith(appName)) return false
  // What follows the product name must be a version or nothing at all. A plain
  // prefix test is not enough: `WorkBuddy AI 5.11.4` starts with `WorkBuddy`,
  // so a CN search would claim the Global installation, and `WorkBuddyUninstall`
  // would pose as the app itself.
  const rest = displayName.slice(appName.length)
  return rest === '' || /^\s+\d/u.test(rest)
}

/**
 * Install directories named by one `reg query` dump, in listing order.
 *
 * `reg query <hive> /s /f WorkBuddy` prints one block per matching key: a
 * `HKEY_…` header, then indented `Name    REG_SZ    value` lines. The identity
 * proof is `DisplayName` starting with `WorkBuddy` — the search also matches the
 * product name inside *other* values, so a block that merely mentions it must not
 * count. The location comes from `DisplayIcon`, because that is the field that
 * carries the path: the 5.6.2 installer here wrote the app to a drive root and
 * left `InstallLocation` empty.
 *
 * Only the fields read here are mentioned: the same `/f` filter that finds these
 * blocks also drops every value that does not contain "WorkBuddy", so the dump
 * is a partial view of the key by construction and must not be read as one.
 *
 * Exported for tests: the flow's whole decision surface is here, so it can be
 * exercised without running `reg.exe`.
 */
export function windowsInstallsFromRegistry(
  output: string,
  product: WorkBuddyElectronProduct = 'cn',
): string[] {
  const roots: string[] = []
  let name: string | undefined
  let icon: string | undefined
  let location: string | undefined
  const flush = (): void => {
    if (name !== undefined && matchesProduct(name, product)) {
      const root = iconRootOf(icon) ?? locationRootOf(location)
      if (root !== undefined && !roots.includes(root)) roots.push(root)
    }
    name = undefined
    icon = undefined
    location = undefined
  }
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('HKEY_')) {
      flush()
      continue
    }
    const field = /^\s+(\S+)\s+REG_[A-Z_]+\s+(.*)$/u.exec(line)
    if (field === null) continue
    const key = field[1] ?? ''
    const value = (field[2] ?? '').trim()
    if (key === 'DisplayName') name = value
    else if (key === 'DisplayIcon') icon = value
    else if (key === 'InstallLocation') location = value
  }
  flush()
  return roots
}

/**
 * Strip what the registry wraps a path value in: a surrounding pair of quotes and
 * a trailing `,<icon index>`. Neither is part of the path.
 */
function unwrapRegistryPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const path = value
    .trim()
    .replace(/^"(.*)"(?:,-?\d+)?$/u, '$1')
    .replace(/,-?\d+$/u, '')
  return path === '' ? undefined : path
}

/**
 * The install directory `DisplayIcon` points at, or `undefined` when it names
 * something other than the app's executable.
 *
 * It is rejected unless it names a `.exe`: installers often point this value at an
 * icon file, and a `.ico` is not a directory that could hold the runtime. Rejecting
 * it is what lets {@link locationRootOf} answer instead.
 *
 * The split is done on Windows separators explicitly: the value comes out of the
 * Windows registry, so its shape must not depend on the host that happens to parse
 * it — a Linux CI runner reads the same dump and must reach the same directory.
 */
function iconRootOf(value: string | undefined): string | undefined {
  const path = unwrapRegistryPath(value)
  if (path === undefined || !/\.exe$/iu.test(path)) return undefined
  return path.replace(/[\\/][^\\/]*$/u, '')
}

/**
 * The directory `InstallLocation` names, or `undefined` when it names nothing.
 *
 * It is a directory by definition, so it is taken as-is — this installer leaves it
 * empty, which is exactly the "no answer here" case.
 */
function locationRootOf(value: string | undefined): string | undefined {
  const path = unwrapRegistryPath(value)
  if (path === undefined) return undefined
  return /\.exe$/iu.test(path) ? path.replace(/[\\/][^\\/]*$/u, '') : path
}

/**
 * The default Windows discovery tools: `reg.exe` from its absolute path, so a
 * user's `PATH` cannot redirect what the plugin executes.
 *
 * A hive that cannot be read at all — a missing `reg.exe`, a denied key — raises
 * {@link DiscoveryIncompleteError}, because "we could not check" must never be
 * read as "not installed". A hive that simply holds no WorkBuddy entry is a
 * normal empty result: `reg` reports that with exit code 1 and empty stdout.
 */
export function workBuddyWindowsDiscoveryTools(
  product: WorkBuddyElectronProduct = 'cn',
): WorkBuddyWindowsDiscoveryTools {
  return {
    findInstallRoots: async (signal) => {
      const found: string[] = []
      for (const hive of WINDOWS_UNINSTALL_HIVES) {
        if (signal.aborted) {
          throw new DiscoveryIncompleteError(
            'the Windows registry search was not started: the discovery budget was already spent',
          )
        }
        const output = await new Promise<string>((resolve, reject) => {
          execFile(
            REG_BIN,
            ['query', hive, '/s', '/f', 'WorkBuddy'],
            {
              maxBuffer: WINDOWS_REGISTRY_MAX_OUTPUT_BYTES,
              timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS,
              windowsHide: true,
            },
            (error, stdout) => {
              if (error === null || error === undefined) {
                resolve(stdout)
                return
              }
              // `reg` reports "nothing matched" as exit code 1, in two shapes the
              // plugin must treat alike: a key that holds no WorkBuddy entry prints a
              // localised "0 matches" on stdout, while an absent key prints its message
              // on stderr instead. Both are answers about this hive, so only a killed
              // process (a timeout) or one that never started (ENOENT/EACCES — a string
              // code, not a number) means "we could not check".
              if (error.killed !== true && typeof error.code !== 'string') {
                resolve(stdout)
                return
              }
              reject(
                new DiscoveryIncompleteError(
                  `the Windows registry query for ${hive} could not complete (${error.killed === true ? 'timed out' : String(error.code)})`,
                ),
              )
            },
          )
        })
        found.push(...windowsInstallsFromRegistry(output, product))
      }
      return found
    },
  }
}
/**
 * The default discovery tools: Spotlight for the bundle, `/usr/bin/plutil` for
 * identity. Every failure that means "we could not tell" — a missing tool, a
 * timeout, an oversized answer — is raised as {@link DiscoveryIncompleteError}
 * so it can never be silently read as "no such app".
 */
export function workBuddyDiscoveryTools(): WorkBuddyDiscoveryTools {
  const runTool = (
    bin: string,
    args: readonly string[],
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(
          new DiscoveryIncompleteError(
            `${bin} was not started: the discovery budget was already spent`,
          ),
        )
        return
      }
      let settled = false
      const child = execFile(
        bin,
        [...args],
        { maxBuffer: maxBytes, timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS },
        (error, stdout) => {
          if (settled) return
          settled = true
          if (error !== null && error !== undefined) {
            reject(
              new DiscoveryIncompleteError(
                `${bin} could not complete (${error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')})`,
              ),
            )
            return
          }
          resolve(stdout)
        },
      )
      const abort = (): void => {
        if (settled) return
        settled = true
        child.kill()
        reject(new DiscoveryIncompleteError(`${bin} was abandoned: the discovery budget was spent`))
      }
      signal.addEventListener('abort', abort, { once: true })
      child.on('close', () => {
        signal.removeEventListener('abort', abort)
      })
    })

  return {
    findApps: async (signal) => {
      const out = await runTool(
        MDFIND_BIN,
        [`kMDItemCFBundleIdentifier == '${WORKBUDDY_CN_BUNDLE_ID}'`],
        MDFIND_MAX_OUTPUT_BYTES,
        signal,
      )
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.app'))
    },
    bundleIdentifier: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          [
            '-extract',
            'CFBundleIdentifier',
            'raw',
            '-o',
            '-',
            join(bundlePath, 'Contents', 'Info.plist'),
          ],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        return out.trim()
      } catch {
        // An unreadable plist is "we could not check this one", not "this one
        // does not match" — the candidate stays unresolved and the whole
        // discovery reports incomplete rather than quietly dropping it.
        return undefined
      }
    },
    bundleVersion: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          [
            '-extract',
            'CFBundleShortVersionString',
            'raw',
            '-o',
            '-',
            join(bundlePath, 'Contents', 'Info.plist'),
          ],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        const version = out.trim()
        return version === '' ? undefined : version
      } catch {
        return undefined
      }
    },
  }
}

/**
 * In-memory protector-key resolver: one spawn per key id, single-flight, never
 * persisted. The cache is keyed by the id envelopes ask for, so an envelope
 * sealed under a rotated key triggers exactly one fresh resolution.
 */ export class WorkBuddyAtRestKeyProvider {
  /**
   * The explicit binary, when one was configured. `undefined` here means "the
   * caller did not name one", which is what lets discovery run — an explicit
   * path that turns out to be unusable is an error, never a reason to look for
   * a different app.
   */
  private readonly explicitPath: string | undefined
  private readonly defaultPath: string | undefined
  private readonly discovery: WorkBuddyElectronDiscovery
  private readonly product: WorkBuddyElectronProduct
  private readonly tools: WorkBuddyDiscoveryTools
  /** Explicit `tools` means the caller owns the platform question (tests, custom hosts). */
  private readonly toolsAreInjected: boolean
  private readonly windowsTools: WorkBuddyWindowsDiscoveryTools
  /** Explicit `windowsTools` means the caller owns the platform question. */
  private readonly windowsToolsAreInjected: boolean
  private readonly discoveryBudgetMs: number
  private readonly timeoutMs: number
  private readonly source: WorkBuddyKeyPayloadSource
  private readonly spawnHelper: (electronPath: string) => Promise<string>
  /**
   * The path discovery settled on, cached only on success. A failure leaves
   * this unset so the next attempt tries again — the user may install or move
   * the app without restarting DSH.
   */
  private discoveredPath: string | undefined
  private cache: ResolvedKey | undefined
  private inflight: Promise<ResolvedKey> | undefined

  constructor(options: WorkBuddyAtRestKeyProviderOptions = {}) {
    const fromEnv = process.env[WORKBUDDY_ELECTRON_BIN_ENV]?.trim()
    const envPath = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
    // Explicit sources are authoritative and mutually exclusive with
    // discovery: naming a binary means "use this one", so an unusable one is
    // an error, not an invitation to go looking for another app.
    this.explicitPath = options.electronPath ?? envPath
    this.discovery = options.discovery ?? 'none'
    this.product = options.product ?? 'cn'
    this.defaultPath =
      options.defaultElectronPath === undefined
        ? defaultWorkBuddyElectronPath(this.discovery, this.product)
        : (options.defaultElectronPath ?? undefined)
    this.tools = options.tools ?? workBuddyDiscoveryTools()
    this.toolsAreInjected = options.tools !== undefined
    this.windowsTools = options.windowsTools ?? workBuddyWindowsDiscoveryTools(this.product)
    this.windowsToolsAreInjected = options.windowsTools !== undefined
    this.discoveryBudgetMs = options.discoveryBudgetMs ?? WORKBUDDY_DISCOVERY_BUDGET_MS
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.spawnHelper = options.spawnHelper ?? ((path) => this.spawnAt(path))
    this.source = options.source ?? (() => this.spawnPayload())
  }

  /**
   * The binary the default helper would use, for diagnostics.
   *
   * Reports a *discovery result* once one exists, so diagnostics describe what
   * would actually run rather than the default that was bypassed. Discovery
   * itself stays in {@link resolveElectronPath}: this accessor never triggers a
   * search (the constructor must remain I/O-free, and callers may ask before
   * any resolution has happened).
   */
  helperPath(): string | undefined {
    if (this.explicitPath !== undefined) return this.explicitPath
    if (this.discovery === 'none') return undefined
    return this.discoveredPath ?? this.defaultPath
  }

  /**
   * A protector key matching one of the requested envelope key ids. The first
   * id the cache answers wins; otherwise one spawn resolves the current key,
   * which must match a request — a mismatch means the envelopes were sealed by
   * a different install than the one this machine now runs, and no key we can
   * reach will open them.
   */
  async protectorKeyFor(requested: readonly string[]): Promise<Buffer> {
    if (requested.length === 0) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'encrypted desktop credential carries no key ids',
      )
    }
    const cached = this.cache
    if (cached !== undefined && requested.includes(cached.keyId)) return cached.key
    this.inflight ??= this.source()
      .then((text) => this.ingest(text))
      .finally(() => {
        this.inflight = undefined
      })
    const resolved = await this.inflight
    if (!requested.includes(resolved.keyId)) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        `WorkBuddy's current at-rest key (id ${resolved.keyId}) does not match the credential's envelope (id ${requested.join(' or ')});` +
          ' the desktop credential was sealed by a different WorkBuddy installation',
      )
    }
    return resolved.key
  }

  private ingest(text: string): ResolvedKey {
    const payload = parseAtRestPayload(text)
    if (payload === undefined) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'WorkBuddy key helper returned an unusable at-rest payload (expected {version:1, atRestSecretKey})',
      )
    }
    const key = deriveProtectorKey(payload.atRestSecretKey)
    const resolved: ResolvedKey = {
      key,
      keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
    }
    this.cache = resolved
    return resolved
  }

  /**
   * The binary to spawn, or a diagnosable error saying why there is none.
   *
   * Order is the contract: an explicit path is used as-is and never falls back;
   * discovery runs only for a provider that was configured for it, and only
   * after the platform default has been tried and found unusable.
   */
  private async resolveElectronPath(): Promise<string> {
    if (this.explicitPath !== undefined) {
      if (!isExecutable(this.explicitPath)) {
        throw new WorkBuddyElectronPathError(
          'electron-path-invalid',
          `the configured WorkBuddy Electron binary is not available at ${this.explicitPath};` +
            ` check ${WORKBUDDY_ELECTRON_BIN_ENV} or unset it to let the plugin look for the app itself`,
        )
      }
      return this.explicitPath
    }
    if (this.discovery === 'none') {
      // Either the other product, or a platform with no verified layout. Both
      // are "not configured", never "we searched and failed".
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no WorkBuddy Electron binary is configured for this platform;` +
          ` set ${WORKBUDDY_ELECTRON_BIN_ENV} to the app's Electron binary`,
      )
    }
    // The default path is the ordinary case and costs one stat; discovery is
    // reserved for the installations the default misses.
    if (this.defaultPath !== undefined && isExecutable(this.defaultPath)) return this.defaultPath
    // A previously discovered path is re-checked rather than trusted: the app
    // may have been moved or removed since, and a stale path must not win.
    if (this.discoveredPath !== undefined) {
      if (isExecutable(this.discoveredPath)) return this.discoveredPath
      this.discoveredPath = undefined
    }
    const found =
      this.discovery === 'windows-workbuddy'
        ? await this.discoverWindowsApp()
        : await this.discoverMacosApp()
    this.discoveredPath = found
    return found
  }

  /**
   * Resolve the CN app through Spotlight, then prove each candidate's identity
   * before it can be executed.
   *
   * The whole flow shares one budget: a hang in one candidate must not extend
   * the wait for the others, and running out of budget is reported as an
   * unfinished check rather than an absent app.
   */
  private async discoverMacosApp(): Promise<string> {
    // Spotlight and plutil exist only on macOS, so with the platform tool set
    // a non-macOS host has nothing to search with. An explicitly injected tool
    // set bypasses this: its caller has answered for the platform themselves.
    if (process.platform !== 'darwin' && !this.toolsAreInjected) {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no WorkBuddy Electron binary is configured for this platform;` +
          ` set ${WORKBUDDY_ELECTRON_BIN_ENV} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      let candidates: readonly string[]
      try {
        candidates = await this.tools.findApps(controller.signal)
      } catch {
        throw discoveryIncomplete('the app search did not complete')
      }
      // Several Spotlight rows can name one bundle (path aliases, the
      // /System/Volumes/Data view). Identity + realpath collapse those into
      // one candidate; only genuinely distinct apps may count as "more than
      // one", or a single app would look ambiguous.
      const seen = new Map<string, DiscoveredApp>()
      let unresolved = false
      for (const candidate of candidates) {
        // A Spotlight index keeps rows for apps deleted since the last sweep,
        // and a stale row is a *decidable* exclusion: the candidate is gone,
        // which is not the same as "we could not check it". Skipping it here
        // is what stops one dead row from sinking a live app beside it — the
        // plan's "明确不可用 → 排除该候选" case (issue #48 §3.7).
        //
        // Only ENOENT qualifies. `existsSync` is not usable here: it answers
        // `false` for *any* error, so an EACCES/EPERM parent (or an
        // ENAMETOOLONG path) would be read as "this app was deleted" and a
        // live sibling would be chosen over a candidate we merely could not
        // inspect. `statSync` distinguishes them, and anything other than a
        // confirmed absence stays unresolved.
        try {
          statSync(candidate)
        } catch (error: unknown) {
          if (isENOENT(error)) continue
          unresolved = true
          continue
        }
        let bundleIdentifier: string | undefined
        try {
          bundleIdentifier = await this.tools.bundleIdentifier(candidate, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        if (bundleIdentifier === undefined) {
          unresolved = true
          continue
        }
        if (bundleIdentifier !== WORKBUDDY_CN_BUNDLE_ID) continue
        const electronPath = join(candidate, 'Contents', 'MacOS', 'Electron')
        if (!isExecutable(electronPath)) continue
        let identity: string
        try {
          identity = realpathSync(candidate)
        } catch {
          identity = candidate
        }
        if (seen.has(identity)) continue
        let version: string | undefined
        try {
          version = await this.tools.bundleVersion(candidate, controller.signal)
        } catch {
          // Version is display-only; an unreadable one must not sink an
          // otherwise identified candidate.
          version = undefined
        }
        seen.set(identity, {
          bundlePath: candidate,
          electronPath,
          ...(version === undefined ? {} : { version }),
        })
      }
      if (seen.size > 1) {
        const listed = [...seen.values()]
          .map(
            (app) => `  - ${app.bundlePath}${app.version === undefined ? '' : ` (${app.version})`}`,
          )
          .join('\n')
        throw new WorkBuddyElectronPathError(
          'electron-binary-ambiguous',
          `more than one WorkBuddy application was found, so none was chosen:\n${listed}\n` +
            ` set ${WORKBUDDY_ELECTRON_BIN_ENV} to the one to use`,
        )
      }
      // A candidate nobody could check might have been a second copy, so its
      // existence forbids claiming the rest are unique. This is the difference
      // between "we know there is exactly one" and "we only found one of the
      // ones we could read" (§3.4).
      if (unresolved) throw discoveryIncomplete('some candidates could not be checked')
      if (seen.size === 0) {
        throw new WorkBuddyElectronPathError(
          'electron-binary-not-found',
          'no WorkBuddy application was found in the default location or the system index;' +
            ' if WorkBuddy is installed elsewhere, it may not be indexed yet',
        )
      }
      return [...seen.values()][0]!.electronPath
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  /**
   * Resolve this provider's product from its Windows registration.
   *
   * There is no second identity check as on macOS: the registration *is* the
   * identity — {@link windowsInstallsFromRegistry} only accepts blocks whose
   * `DisplayName` names this product — and the executable is a fixed name
   * inside the registered directory. A registered directory that no longer holds
   * an executable is a decidable exclusion, the same way a Spotlight row for a
   * deleted app is.
   *
   * Both products may be installed side by side and register under the same
   * `WorkBuddy` stem, so the registry query results are filtered by product
   * before the executable is looked for: otherwise the Global app's directory
   * would be probed for a CN executable and read as "not installed".
   */
  private async discoverWindowsApp(): Promise<string> {
    if (process.platform !== 'win32' && !this.windowsToolsAreInjected) {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no WorkBuddy Electron binary is configured for this platform;` +
          ` set ${WORKBUDDY_ELECTRON_BIN_ENV} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      let roots: readonly string[]
      try {
        roots = await this.windowsTools.findInstallRoots(controller.signal)
      } catch {
        throw discoveryIncomplete('the Windows registry search did not complete')
      }
      const seen = new Map<string, string>()
      for (const root of roots) {
        const electronPath = join(root, WINDOWS_ELECTRON_FILENAME[this.product])
        if (!isExecutable(electronPath)) continue
        let identity: string
        try {
          identity = realpathSync(electronPath)
        } catch {
          identity = electronPath
        }
        seen.set(identity, electronPath)
      }
      if (seen.size > 1) {
        const listed = [...seen.values()].map((path) => `  - ${path}`).join('\n')
        throw new WorkBuddyElectronPathError(
          'electron-binary-ambiguous',
          `more than one WorkBuddy application was found, so none was chosen:\n${listed}\n` +
            ` set ${WORKBUDDY_ELECTRON_BIN_ENV} to the one to use`,
        )
      }
      if (seen.size === 0) {
        throw new WorkBuddyElectronPathError(
          'electron-binary-not-found',
          `no WorkBuddy application was found in the default location or its Windows registration;` +
            ` if WorkBuddy is installed elsewhere, set ${WORKBUDDY_ELECTRON_BIN_ENV} to the app's Electron binary`,
        )
      }
      return [...seen.values()][0]!
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  private async spawnPayload(): Promise<string> {
    return await this.spawnHelper(await this.resolveElectronPath())
  }

  private async spawnAt(electronPath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        electronPath,
        [HELPER_SCRIPT_ARGUMENT_FLAG, HELPER_SCRIPT],
        {
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
        (error, stdout) => {
          if (error !== null && error !== undefined) {
            // Code and reason only: stdout/stderr can carry paths or crash dumps,
            // and the payload must never appear in a message.
            const reason =
              error.killed === true
                ? `timed out or was killed after ${String(this.timeoutMs)}ms`
                : error.code !== undefined
                  ? `exited with code ${String(error.code)}`
                  : 'could not be started'
            reject(
              new WorkBuddyElectronPathError(
                'encrypted-credential-unreadable',
                `the WorkBuddy key helper (${electronPath}) ${reason}`,
              ),
            )
            return
          }
          const output = stdout.trim()
          if (output === '') {
            reject(
              new WorkBuddyElectronPathError(
                'encrypted-credential-unreadable',
                `the WorkBuddy key helper (${electronPath}) produced no payload`,
              ),
            )
            return
          }
          resolve(output)
        },
      )
    })
  }
}

/** Whether a path exists and is executable; never throws. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A failure the card must be able to classify. The code travels with the error
 * so the store can promote it to `reasonCode` without re-deriving the cause
 * from prose.
 */
export class WorkBuddyElectronPathError extends Error {
  readonly reasonCode: WorkBuddySignedOutReasonCode

  constructor(reasonCode: WorkBuddySignedOutReasonCode, message: string) {
    super(message)
    this.name = 'WorkBuddyElectronPathError'
    this.reasonCode = reasonCode
  }
}

/** Read the reason code off an arbitrary thrown value, when it carries one. */
export function reasonCodeOf(error: unknown): WorkBuddySignedOutReasonCode | undefined {
  return error instanceof WorkBuddyElectronPathError ? error.reasonCode : undefined
}

/** Whether a filesystem error reports an absent path (`existsSync` cannot tell). */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function discoveryIncomplete(detail: string): WorkBuddyElectronPathError {
  return new WorkBuddyElectronPathError(
    'electron-discovery-incomplete',
    `the WorkBuddy application search did not finish (${detail});` +
      ' this is not proof that the app is missing',
  )
}

/**
 * The helper: run inside WorkBuddy's Electron as plain Node, where the
 * private `workbuddyStorage` binding exists, and print only the payload. It
 * writes nothing else, so whatever reaches stdout is the payload.
 */
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'
const HELPER_SCRIPT_ARGUMENT_FLAG = '-e'