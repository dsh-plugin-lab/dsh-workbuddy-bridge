/**
 * The composer's reasoning-level bulb, in a real React tree.
 *
 * This control had **no render test at all** before this suite, which is how
 * both defects it now pins reached users:
 *
 * - the bulb's visibility was computed from "could this model be detected, or
 *   has it been", so it was absent on exactly the models whose thinking switch
 *   already worked — every declared model — and the user read that as broken;
 * - the `selection` guard tested `=== undefined` while the host's store
 *   initialises `current` to `null`, so the first frame dereferenced `null`,
 *   threw inside the host's slot boundary, and left the control gone for the
 *   life of the mount.
 *
 * The cases below therefore lead with **when the bulb exists** and **when it is
 * lit**, because those two answers are the whole contract: the bulb reports
 * "this model can switch thinking levels", not "someone ran a detection".
 */

import { createElement, type ReactNode } from 'react'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { WorkBuddyProbeControl } from '../../src/client/probe-control.tsx'
import { t, signedIn, useBrowserStubs, useTree } from './harness.ts'
import type { WorkBuddyWebEffortModel } from '../../src/shared/paths.ts'

/**
 * Render the panel inline instead of into `document.body`.
 *
 * The portal is correct in production — a `position: fixed` panel inside the
 * composer row would be clipped by it — but it needs a real DOM element to mount
 * into, and this lane deliberately has no DOM (the other browser specs render
 * through react-test-renderer under a stubbed `window`). Rendering the children
 * where they were declared keeps the panel's *content* in the tree, which is
 * what the assertions below read; only its placement is lost, and nothing here
 * asserts on placement.
 */
vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>()
  return { ...actual, createPortal: (children: ReactNode) => children }
})

const stub = useBrowserStubs()
const box = useTree()

/**
 * `document`, stubbed for the tests that open the panel.
 *
 * The panel's dismissal hook (`useDismissOnOutsidePointer`, from the host's own
 * primitives) attaches a `pointerdown` listener to the document, and this lane
 * has no DOM — the other browser specs render through react-test-renderer under a
 * stubbed `window` alone. Only the two listener methods are reached while the
 * panel is mounted and no assertion here depends on them, so an object that
 * records nothing is enough. Without it, opening the panel throws
 * `document is not defined` and the *content* — the thing under test — is never
 * rendered at all.
 */
function stubDocument(): void {
  vi.stubGlobal('document', {
    addEventListener: () => {},
    removeEventListener: () => {},
    // `createPortal` is mocked out below, so nothing appends to the body.
    body: {},
  })
}

/** A `ModelDirectory['store']` stub. `null` is what the host really starts at. */
function directoryFor(selection: { provider: string; model: string } | null) {
  return createSnapshotStore({
    current: selection,
    routable: null,
    groups: [],
    failures: [],
    status: 'idle' as const,
    pending: null,
    error: null,
  })
}

/** One effort row, defaulting to the "not detected yet" shape. */
function row(overrides: Partial<WorkBuddyWebEffortModel> = {}): WorkBuddyWebEffortModel {
  return {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    efforts: [],
    source: 'none',
    detectable: true,
    ...overrides,
  }
}

/** Mount a component and let its mount-time status read settle. */
async function render(element: ReturnType<typeof createElement>): Promise<ReactTestRenderer> {
  let view: ReactTestRenderer | undefined
  await act(async () => {
    view = (await import('react-test-renderer')).create(element)
  })
  // The control fetches on mount; a second flush lets that land before assertions.
  await act(async () => {
    await Promise.resolve()
  })
  box.view = view
  return view!
}

/**
 * Mount the control over one status document.
 *
 * The component fetches on mount and only then has a `probe` section, so a test
 * that asserted before settling would see the pre-read tree — where the control
 * correctly renders nothing.
 */
async function mount(model = 'glm-5.3', probe: Record<string, unknown> | undefined = undefined) {
  stub.body = signedIn(probe === undefined ? {} : { probe })
  return render(
    createElement(WorkBuddyProbeControl, {
      directory: directoryFor({ provider: 'workbuddy', model }),
      t,
    }),
  )
}

/** The bulb trigger, found by its accessible name rather than by class name. */
function bulb(view: ReactTestRenderer) {
  return view.root.findAllByType('button').find((node) => node.props['aria-expanded'] !== undefined)
}

/** How many paths the bulb's SVG draws: 1 idle, 2 lit. */
function bulbPaths(view: ReactTestRenderer): number {
  const button = bulb(view)
  if (button === undefined) return 0
  return button.findAllByType('path' as never).length
}

/** How many times the status route has been read. */
function statusReads(): number {
  return stub.call.mock.calls.filter(([url]) => String(url).includes('/status')).length
}

describe('WorkBuddyProbeControl', () => {
  it('keeps the bulb up across a model switch, and does not re-read status', async () => {
    /*
     * The reported defect: switching models made the bulb vanish for about half a
     * second and then reappear, while the credit readout never flickered.
     *
     * The cause was where the document was held. The component that fetched it was
     * keyed **by model**, so every switch unmounted it; the replacement started at
     * `status === undefined`, could not resolve `entry`, and rendered nothing until
     * its own `GET /status` returned. That also meant one extra upstream billing
     * request per switch, because the status route fetches credit.
     *
     * Both halves are asserted here, because either alone could be satisfied by a
     * wrong fix: the bulb must be present **and lit** immediately after the switch
     * (no gap), and the read count must not move (no request).
     */
    const directory = directoryFor({ provider: 'workbuddy', model: 'glm-5.3-flash' })
    stub.body = signedIn({
      probe: {
        consent: true,
        running: false,
        models: [
          row({
            id: 'glm-5.3-flash',
            efforts: ['low', 'high', 'max'],
            source: 'declared',
            detectable: false,
          }),
          row({ id: 'glm-5.3', name: 'GLM-5.3' }),
        ],
      },
    })
    const view = await render(createElement(WorkBuddyProbeControl, { directory, t }))
    expect(bulbPaths(view)).toBe(2)
    const readsBefore = statusReads()

    // Switch to the other model, exactly as the picker would.
    await act(async () => {
      directory.set({
        ...directory.getSnapshot(),
        current: { provider: 'workbuddy', model: 'glm-5.3' },
      })
    })

    // The very next frame — before any promise settles — must already show it.
    expect(bulb(view), 'the bulb disappeared during a model switch').toBeDefined()
    expect(statusReads(), 'switching models re-read the status route').toBe(readsBefore)
    // The new model has no levels, so the bolt is gone: correct state, no gap.
    expect(bulbPaths(view)).toBe(1)
  })

  it('survives the host store’s null selection without throwing', async () => {
    // The host initialises `current` to `null`, not `undefined`. Guarding on
    // `undefined` dereferenced it and killed the control for the whole mount.
    stub.body = signedIn()
    const view = await render(
      createElement(WorkBuddyProbeControl, { directory: directoryFor(null), t }),
    )
    expect(() => JSON.stringify(view.toJSON())).not.toThrow()
    expect(view.toJSON()).toBeNull()
  })

  it('shows no bulb for a session on another provider', async () => {
    stub.body = signedIn({
      probe: { consent: true, running: false, models: [row()] },
    })
    const view = await render(
      createElement(WorkBuddyProbeControl, {
        directory: directoryFor({ provider: 'deepseek', model: 'glm-5.3' }),
        t,
      }),
    )
    expect(view.toJSON()).toBeNull()
  })

  it('shows an unlit bulb for a model with no levels yet, and offers to detect', async () => {
    const view = await mount('glm-5.3', {
      consent: true,
      running: false,
      models: [row()],
    })
    const button = bulb(view)
    expect(button).toBeDefined()
    // Unlit: one path (the bulb body), no bolt.
    expect(bulbPaths(view)).toBe(1)
    // The action is offered, and says so.
    expect(String(button!.props['aria-label'])).toContain(t('probeTooltipIdle'))
    expect(button!.props['disabled']).toBe(false)
  })

  it('shows a LIT bulb for a model whose levels the provider declared, with no detection', async () => {
    // The regression this suite exists for: a declared set means the switch
    // already works, so the bulb must be present AND lit even though nothing was
    // ever probed. The old gate hid it here, which made the best-configured
    // models look like the broken ones.
    const view = await mount('glm-5.3-flash', {
      consent: true,
      running: false,
      models: [
        row({
          id: 'glm-5.3-flash',
          name: 'GLM-5.3 Flash',
          efforts: ['low', 'high', 'max'],
          source: 'declared',
          detectable: false,
        }),
      ],
    })
    expect(bulb(view)).toBeDefined()
    // Lit: two paths, the bolt is drawn.
    expect(bulbPaths(view)).toBe(2)
    const label = String(bulb(view)!.props['aria-label'])
    // The label names the levels and attributes them to the provider, so
    // "declared" and "detected" are not the same message.
    expect(label).toContain('low / high / max')
    expect(label).toBe(t('probeTooltipDeclared', { levels: 'low / high / max' }))
  })

  it('shows a LIT bulb for a model whose levels a detection established', async () => {
    const view = await mount('hy3', {
      consent: true,
      running: false,
      models: [
        row({
          id: 'hy3',
          name: 'Hy3',
          efforts: ['low', 'medium'],
          source: 'observed',
          detectable: true,
          validation: 'validating',
          probedAt: 1,
        }),
      ],
    })
    expect(bulbPaths(view)).toBe(2)
    expect(String(bulb(view)!.props['aria-label'])).toBe(
      t('probeTooltipLevels', { levels: 'low / medium' }),
    )
  })

  it('keeps the bulb unlit and explains itself when a detection found no levels', async () => {
    // A completed `non-validating` sweep is a *result*, not an open question.
    // Both halves of that used to be reported wrongly: the bulb lit up (so
    // "detected" looked like "works"), and the panel said "not detected yet".
    const view = await mount('glm-5.3', {
      consent: true,
      running: false,
      models: [row({ validation: 'non-validating', probedAt: 1 })],
    })
    expect(bulbPaths(view)).toBe(1)
    expect(String(bulb(view)!.props['aria-label'])).toBe(t('probeTooltipNotValidating'))
  })

  it('does not offer to detect a declared set, and says why', async () => {
    stubDocument()
    const view = await mount('glm-5.3-flash', {
      consent: true,
      running: false,
      models: [
        row({
          id: 'glm-5.3-flash',
          efforts: ['low', 'high'],
          source: 'declared',
          detectable: false,
        }),
      ],
    })
    // Opening the panel is still allowed — that is how the levels are read —
    // so the trigger itself stays enabled.
    expect(bulb(view)!.props['disabled']).toBe(false)

    await act(async () => {
      bulb(view)!.props['onClick']()
    })
    const action = view.root
      .findAllByType('button')
      .find((node) => node.children.join('').includes(t('probePanelNotNeeded')))
    expect(action).toBeDefined()
    // The action is inert: the declaration is already the answer.
    expect(action!.props['disabled']).toBe(true)
  })

  it('renders no panel contradiction for a completed non-validating sweep', async () => {
    stubDocument()
    const view = await mount('glm-5.3', {
      consent: true,
      running: false,
      models: [row({ validation: 'non-validating', probedAt: 1 })],
    })
    await act(async () => {
      bulb(view)!.props['onClick']()
    })
    const text = JSON.stringify(view.toJSON())
    // The verdict is stated...
    expect(text).toContain(t('probePanelNotValidating'))
    // ...and the panel does NOT claim the question is still open. That pair was
    // the visible contradiction: "not detected yet" above "does not check it".
    expect(text).not.toContain(t('probeResultUnknown'))
  })

  it('renders nothing for a model the host did not report', async () => {
    const view = await mount('not-in-the-list', {
      consent: true,
      running: false,
      models: [row()],
    })
    expect(view.toJSON()).toBeNull()
  })

  /**
   * The panel's placement is CSS Anchor Positioning, not JavaScript.
   *
   * The control used to call the host's anchored-position hook; the 0.2.2 rc line
   * removed that export, and because this repo's devDependencies sit one rc
   * behind the running host the import kept compiling — the failure only appeared
   * in a browser, and only once a WorkBuddy model was selected. Placement now
   * comes from two declarations in the stylesheet (`anchor-name` on the trigger,
   * `position-anchor` on the panel), and the only thing JavaScript supplies is the
   * anchor *name*, inline, on both elements.
   *
   * Asserted here rather than in the DOM because that is where the contract lives:
   * the panel is portalled, so a missing property on it is not a layout detail —
   * it is the panel landing in the viewport's top-left corner.
   */
  it('wires the panel to the trigger through one inline anchor name, and measures nothing', async () => {
    stubDocument()
    const view = await mount('glm-5.3', {
      consent: true,
      running: false,
      models: [row()],
    })
    const trigger = bulb(view)!
    const anchorName = (trigger.props['style'] ?? {})['--dsh-workbuddy-probe-anchor']
    expect(String(anchorName), '触发器没拿到 anchor-name 属性').toMatch(/^--dsh-workbuddy-probe-/)

    await act(async () => {
      trigger.props['onClick']()
    })
    const panel = view.root.findAllByType('section')[0]
    expect(panel, '面板没渲染出来').toBeDefined()

    // Same name on both sides: CSS anchors are document-wide, so the panel finds
    // its trigger by that name alone.
    expect(panel!.props['style']).toEqual({ '--dsh-workbuddy-probe-anchor': anchorName })

    // No measured coordinates and no "hide until measured" hack: any of these
    // would mean JS positioning came back (and the bundle would carry the hook).
    for (const gone of ['left', 'top', 'visibility']) {
      expect(panel!.props['style'], `面板的 style 里出现了 ${gone}`).not.toHaveProperty(gone)
    }
  })

  it('gives two controls two anchor names', async () => {
    // A shared name would make both panels follow whichever trigger registered
    // last — the two controls live in the same document.
    stub.body = signedIn({ probe: { consent: true, running: false, models: [row()] } })
    const directory = directoryFor({ provider: 'workbuddy', model: 'glm-5.3' })
    const view = await render(
      createElement(
        'div',
        null,
        createElement(WorkBuddyProbeControl, { directory, t }),
        createElement(WorkBuddyProbeControl, { directory, t }),
      ),
    )
    const names = view.root
      .findAllByType('button')
      .filter((node) => node.props['aria-expanded'] !== undefined)
      .map((node) => (node.props['style'] ?? {})['--dsh-workbuddy-probe-anchor'])
    expect(names.length, '两个控件都应该有触发器').toBe(2)
    expect(new Set(names).size, '两个控件用了同一个 anchor-name').toBe(2)
  })
})
