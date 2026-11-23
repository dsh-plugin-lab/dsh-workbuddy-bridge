import { describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyAtRestKeyProvider,
  aiAppDiscovery,
  cnAppDiscovery,
  defaultWorkBuddyElectronPath,
  windowsInstallsFromRegistry,
} from '../src/credential/at-rest.ts'
import { atRestDiscoveryFor, atRestProductFor } from '../src/credential/store.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'

/**
 * Issue #44: the Global (WorkBuddy AI) variant could never open its credential.
 *
 * It ran at `discovery: 'none'`, so it never looked for an app at all, and the
 * Windows layout it would have looked for belongs to the *CN* product
 * (`Programs\\WorkBuddy\\WorkBuddy.exe`) while the Global installer writes
 * `Programs\\WorkBuddyAI\\WorkBuddyAI.exe`.
 *
 * These tests pin the two halves of the fix: each product resolves its own
 * binary, and the registry filter keeps them apart on a machine that has both.
 * Nothing here spawns a real binary or reads a real key.
 */

/** A registry dump with both products installed side by side. */
const BOTH_INSTALLED = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BFD312E9',
  '    DisplayName    REG_SZ    WorkBuddy 5.11.3',
  '    DisplayIcon    REG_SZ    C:\\Users\\u\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe,0',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\C02C88CB',
  '    DisplayName    REG_SZ    WorkBuddy AI 5.11.4',
  '    DisplayIcon    REG_SZ    C:\\Users\\u\\AppData\\Local\\Programs\\WorkBuddyAI\\WorkBuddyAI.exe,0',
].join('\n')

describe('Windows layout: each product has its own directory and executable', () => {
  // The literal layouts below only exist on Windows: off win32 the platform
  // guard inside `defaultWorkBuddyElectronPath()` answers `undefined`, so the
  // assertions would red on the ubuntu/macos CI legs. Same gating as the
  // win32-only cases in electron-discovery.spec.ts.
  it.skipIf(process.platform !== 'win32')(
    'resolves the CN default at Programs\\WorkBuddy\\WorkBuddy.exe',
    () => {
      vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local')
      expect(defaultWorkBuddyElectronPath('windows-workbuddy', 'cn')).toBe(
        'C:\\Users\\u\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe',
      )
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'resolves the Global default at Programs\\WorkBuddyAI\\WorkBuddyAI.exe',
    () => {
      vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local')
      expect(defaultWorkBuddyElectronPath('windows-workbuddy', 'ai')).toBe(
        'C:\\Users\\u\\AppData\\Local\\Programs\\WorkBuddyAI\\WorkBuddyAI.exe',
      )
    },
  )

  it('defaults to the CN layout when no product is named', () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local')
    expect(defaultWorkBuddyElectronPath('windows-workbuddy')).toBe(
      defaultWorkBuddyElectronPath('windows-workbuddy', 'cn'),
    )
  })

  it('reports no default for a platform with no verified layout', () => {
    expect(defaultWorkBuddyElectronPath('none', 'ai')).toBeUndefined()
  })
})

describe('Windows registry: the two products stay apart', () => {
  it('returns only the CN install for a CN search', () => {
    expect(windowsInstallsFromRegistry(BOTH_INSTALLED, 'cn')).toEqual([
      'C:\\Users\\u\\AppData\\Local\\Programs\\WorkBuddy',
    ])
  })

  it('returns only the Global install for a Global search', () => {
    expect(windowsInstallsFromRegistry(BOTH_INSTALLED, 'ai')).toEqual([
      'C:\\Users\\u\\AppData\\Local\\Programs\\WorkBuddyAI',
    ])
  })

  it('keeps the historical CN answer when no product is named', () => {
    expect(windowsInstallsFromRegistry(BOTH_INSTALLED)).toEqual(
      windowsInstallsFromRegistry(BOTH_INSTALLED, 'cn'),
    )
  })

  it('does not let a plain prefix claim the other product', () => {
    // `WorkBuddy AI 5.11.4` starts with `WorkBuddy`, so a naive prefix test would
    // hand the Global directory to a CN search — and then looking for
    // `WorkBuddy.exe` inside it would read as "not installed".
    const globalOnly = [
      'HKEY_CURRENT_USER\\X\\1',
      '    DisplayName    REG_SZ    WorkBuddy AI 5.11.4',
      '    DisplayIcon    REG_SZ    C:\\A\\WorkBuddyAI.exe,0',
    ].join('\n')
    expect(windowsInstallsFromRegistry(globalOnly, 'cn')).toEqual([])
  })

  it('rejects names that only look like the product', () => {
    // Neither a qualifier nor a missing separator may pose as the app itself.
    const lookalikes = [
      'HKEY_CURRENT_USER\\X\\1',
      '    DisplayName    REG_SZ    WorkBuddyUninstall',
      '    DisplayIcon    REG_SZ    C:\\A\\WorkBuddy.exe,0',
      'HKEY_CURRENT_USER\\X\\2',
      '    DisplayName    REG_SZ    WorkBuddy AI Helper',
      '    DisplayIcon    REG_SZ    C:\\B\\WorkBuddyAI.exe,0',
    ].join('\n')
    expect(windowsInstallsFromRegistry(lookalikes, 'cn')).toEqual([])
    expect(windowsInstallsFromRegistry(lookalikes, 'ai')).toEqual([])
  })
})

describe('discovery selection: Global is answerable on Windows only', () => {
  it('gives the CN variant a product-aware search', () => {
    expect(atRestProductFor(CN_VARIANT)).toBe('cn')
    expect(atRestDiscoveryFor(CN_VARIANT)).toBe(cnAppDiscovery())
  })

  it('gives the Global variant its own product and a Windows search', () => {
    expect(atRestProductFor(AI_VARIANT)).toBe('ai')
    expect(atRestDiscoveryFor(AI_VARIANT)).toBe(aiAppDiscovery())
  })

  it('treats a variant-less store as the CN product it already reads', () => {
    // `defaultDesktopAuthCandidates()` names the CN auth file when no variant is
    // given, so the layout must agree or one half would search for the other app.
    expect(atRestProductFor(undefined)).toBe('cn')
    expect(atRestDiscoveryFor(undefined)).toBe(cnAppDiscovery())
  })

  it.skipIf(process.platform !== 'win32')('enables the Windows strategy for Global', () => {
    expect(aiAppDiscovery()).toBe('windows-workbuddy')
  })

  it.skipIf(process.platform === 'win32')('keeps Global at none off Windows', () => {
    // The macOS lookup is a CN bundle-id search; a Global unlock there must not
    // execute the other product's binary.
    expect(aiAppDiscovery()).toBe('none')
  })
})

describe('provider: the resolved binary follows the product', () => {
  /** A provider whose resolved path is read without spawning anything. */
  function providerFor(product: 'cn' | 'ai'): WorkBuddyAtRestKeyProvider {
    return new WorkBuddyAtRestKeyProvider({
      discovery: 'windows-workbuddy',
      product,
      defaultElectronPath: defaultWorkBuddyElectronPath('windows-workbuddy', product),
      windowsTools: { findInstallRoots: async () => [] },
      spawnHelper: async () => '',
    })
  }

  it.skipIf(process.platform !== 'win32')(
    'reports the product-specific default for diagnostics',
    () => {
      vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local')
      vi.stubEnv('WORKBUDDY_ELECTRON_BIN', '')
      expect(providerFor('cn').helperPath()).toBe(
        'C:\\Users\\u\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe',
      )
      expect(providerFor('ai').helperPath()).toBe(
        'C:\\Users\\u\\AppData\\Local\\Programs\\WorkBuddyAI\\WorkBuddyAI.exe',
      )
    },
  )

  it('still lets an explicit path override the product default', () => {
    vi.stubEnv('WORKBUDDY_ELECTRON_BIN', 'C:\\Custom\\WorkBuddyAI.exe')
    const provider = providerFor('ai')
    expect(provider.helperPath()).toBe('C:\\Custom\\WorkBuddyAI.exe')
  })
})
