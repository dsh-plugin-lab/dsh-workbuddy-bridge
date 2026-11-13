/**
 * Per-model reasoning-effort entry beside the Composer's model selector.
 *
 * It is **only an icon** — no inline text. The composer row is shared with the
 * host's own model picker, and a word here competes with the model name for the
 * same glance while adding nothing: the verified levels already appear in the
 * model dropdown (the adapter exposes them as selectable efforts). What the
 * control offers is an *action*, so it is drawn like the other icon-only
 * buttons in this chrome, and its meaning lives in the tooltip and the
 * accessible name.
 *
 * Styling follows `dsh-ds-balance`'s popover button, which copies the host's own
 * sidebar `.iconButton` (28px circle, `--dsw-alias-label-secondary` icon on a
 * transparent background, `--dsw-alias-interactive-bg-hover` on hover). The
 * artwork strokes `currentColor`, so light and dark themes are handled by the
 * token rather than by two sets of colours — no `[data-ds-dark-theme]` selector
 * and no hard-coded colour anywhere.
 *
 * - a **hover/focus tooltip** carries the state and the click's purpose, and is
 *   also the button's `aria-label`.
 * - the **confirmation** is a popover anchored to the control, not a
 *   `window.confirm`. Probing spends real credit, so a confirmation stays — but
 *   it belongs next to the thing it acts on.
 *
 * The popover surface follows `dsh-ds-balance`'s balance popover, which itself
 * copies the host's own stat dialog: a portal to `document.body`, dismissed by
 * the host's `useDismissOnOutsidePointer`, skinned with `--dsw-specific-menu`
 * plus `--dsw-menu-backdrop-filter` (the pair the host requires together — fill
 * alone is "translucent but not frosted").
 *
 * Its **placement is CSS, not JavaScript**: the trigger carries a unique
 * `anchor-name`, the panel names it in `position-anchor`, and the insets in
 * `probe-control.module.css` put the panel 8px above the trigger while keeping
 * 12px viewport margins. That replaced the host's old anchored-position hook,
 * which the 0.2.2 rc line **removed** (its migration guide prescribes exactly
 * this). The dead import kept compiling here because this repo's devDependencies
 * sit one rc behind the running host, and only threw in the browser — and only
 * once a WorkBuddy model was actually selected, which is why it stayed latent.
 * The removed symbol's name is deliberately **not written here**: the bundle
 * keeps comments, and `tests/redlines.spec.ts` greps the built artifact for it,
 * so a reintroduced import cannot come back quietly. That is the same trade the
 * bundle's inline-runtime guard already makes — it too fires on prose, so the
 * wording of comments in this half is part of the contract.
 *
 * **The filter must not sit on the panel itself**: a non-`none`
 * `backdrop-filter` makes the element the containing block for its fixed
 * descendants, and this panel contains non-portal `Tooltip` bubbles. The fill
 * and the filter therefore live on an isolated `::before`, exactly as the host
 * does it.
 *
 * @module dsh-workbuddy-bridge/client/probe-control
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Button, Tooltip, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { cardVariantFor } from './variants.ts'
import type { WorkBuddyCardVariant } from './variants.ts'
import { isWorkBuddyWebStatus } from './status-document.ts'
import type { WorkBuddyTranslate } from './locales.ts'
import type { WorkBuddyWebEffortModel, WorkBuddyWebStatus } from '../shared/paths.ts'
import css from './probe-control.module.css'

/** Injected props; `directory` resolves the session's current model selection. */
export interface WorkBuddyProbeControlProps {
  directory: ModelDirectory['store']
  t: WorkBuddyTranslate
}

/** How often the control re-checks state when the window regains focus. */
const RECONCILE_MS = 60_000

/**
 * The custom property that carries this control's anchor name.
 *
 * The name itself has to be **unique per instance** — two composers, or a
 * remount, would otherwise point two panels at one trigger — so it is derived
 * from `useId` and handed to CSS through this variable. Both the trigger
 * (`anchor-name`) and the portalled panel (`position-anchor`) read it, which is
 * how the host's own model picker wires its menu.
 *
 * Geometry lives entirely in `probe-control.module.css`: the 8px gap, the 12px
 * viewport margins, the size caps and the right-edge fallback are all CSS, so
 * nothing here measures an element or reacts to scroll.
 */
const ANCHOR_PROPERTY = '--dsh-workbuddy-probe-anchor'

/** One model's row out of the probe section's single list. */
function effortModelFor(
  status: WorkBuddyWebStatus,
  model: string,
): WorkBuddyWebEffortModel | undefined {
  if (status.status !== 'signed-in') return undefined
  return status.probe?.models.find((entry) => entry.id === model)
}

/**
 * What hovering the icon says.
 *
 * The bulb answers one question — *can I pick a thinking level on this model?* —
 * so the tooltip leads with that answer and only then explains it. Three states,
 * and the distinction between the last two is the whole point:
 *
 * - levels are offered: name them, and where they came from;
 * - nothing is offered but a detection could still find some: say so, and that
 *   pressing is what asks;
 * - nothing is offered and a detection already proved there is nothing to find:
 *   say *that*, rather than implying the question is still open. Reporting a
 *   completed answer as "not checked yet" was the old copy's defect.
 *
 * A remembered failure is the last resort: it describes this control's own run,
 * while `entry` describes the model, and the model is what the user asked about.
 */
function tooltipText(
  t: WorkBuddyTranslate,
  state: {
    busy: boolean
    failed: boolean
    entry?: WorkBuddyWebEffortModel | undefined
  },
): string {
  if (state.busy) return t('probeTooltipRunning')
  const entry = state.entry
  if (entry !== undefined) {
    if (entry.efforts.length > 0) {
      return t(entry.source === 'declared' ? 'probeTooltipDeclared' : 'probeTooltipLevels', {
        levels: entry.efforts.join(' / '),
      })
    }
    if (entry.validation === 'non-validating') return t('probeTooltipNotValidating')
    if (entry.detectable) return t('probeTooltipIdle')
    // No levels, nothing left to probe, and no verdict recorded: the only
    // honest reading is that the answer did not arrive.
    return t('probeTooltipFailed')
  }
  return state.failed ? t('probeTooltipFailed') : t('probeTooltipIdle')
}

/** The levels this model offers as one line; undefined when there are none. */
function levelsLine(entry: WorkBuddyWebEffortModel | undefined): string | undefined {
  if (entry === undefined || entry.efforts.length === 0) return undefined
  return entry.efforts.join(' / ')
}

/** Model-independent shell: resolves the selection, then delegates per variant. */
export function WorkBuddyProbeControl({ directory, t }: WorkBuddyProbeControlProps): ReactNode {
  const subscribe = useCallback(
    (listener: () => void) => directory.subscribe(listener),
    [directory],
  )
  const snapshot = useCallback(() => directory.getSnapshot(), [directory])
  const selection = useSyncExternalStore(subscribe, snapshot, snapshot).current
  // `current` is `null` — not `undefined` — until a selection is projected, so
  // this must be a truthy test. Testing `=== undefined` let the first frame
  // dereference `null.provider`, which threw inside the host's slot boundary;
  // that boundary latches on failure, so the control stayed gone for the life of
  // the mount — the "bulb sometimes just disappears" report.
  const card = selection == null ? undefined : cardVariantFor(selection.provider)
  if (card === undefined || selection == null) return null
  /*
   * Keyed by the **variant**, never by the model — and that distinction is the
   * whole reason this level exists.
   *
   * The status document describes an *account*: one `probe.models` list holding
   * every model the variant serves. It does not describe the selected model, so
   * switching models cannot change it and must not re-read it. Keying the
   * component that owns it by model was what made the bulb arrive late: React
   * unmounted the old instance, the new one started with `status === undefined`,
   * and the bulb could not render until a fresh `GET /status` came back — a
   * visible half-second gap on every switch, plus one real upstream billing
   * request per switch, because the status route fetches credit.
   */
  return <VariantProbe key={card.id} card={card} model={selection.model} t={t} />
}

/**
 * One variant's status document, held above the model-keyed layer.
 *
 * Living here means a model switch is a prop update rather than a remount, so
 * the document read for the previous model is already in hand and the new
 * model's row is rendered from it on the first frame — no gap, and no request.
 *
 * The reads that *do* belong here are the ones keyed to the account: the
 * mount-time load, the reconcile poll (a detection run in another conversation
 * or in the settings card has to reach this control), and the focus refresh.
 */
function VariantProbe({
  card,
  model,
  t,
}: {
  card: WorkBuddyCardVariant
  model: string
  t: WorkBuddyTranslate
}): ReactNode {
  const [status, setStatus] = useState<WorkBuddyWebStatus>()
  const mounted = useRef(false)
  /** Number of the newest read that may write; assigned when a read starts. */
  const readSeq = useRef(0)

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const seq = ++readSeq.current
      const response = await fetch(card.statusPath, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      /*
       * A 200 does not promise a status document: the body may be empty, literal
       * `null`, or a non-JSON page. Storing that unchecked would put a value in
       * state that the next render dereferences, so it is validated here with the
       * same predicate the settings card uses. A rejection is left to the callers
       * below, which already degrade quietly.
       */
      const value: unknown = await response.json().catch(() => undefined)
      if (!isWorkBuddyWebStatus(value)) throw new Error(t('statusResponseInvalid'))
      // The newest read wins: a slow poll begun before a manual action must not
      // settle after it and restore the older document.
      if (mounted.current && signal?.aborted !== true && seq === readSeq.current) setStatus(value)
    },
    [card.statusPath, t],
  )

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    const load = (): void => {
      void refresh(controller.signal).catch(() => {
        /* the icon still works without state */
      })
    }
    load()
    // Reconcile detections performed in another conversation or in the card.
    const timer = window.setInterval(load, RECONCILE_MS)
    window.addEventListener('focus', load)
    return () => {
      mounted.current = false
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [refresh])

  return (
    <ModelProbe
      // Per-model state (the open panel, a remembered failure, this control's own
      // fresh answer) must not survive a switch, so the layer below is keyed by
      // model. The document itself is not per-model and deliberately stays above.
      key={model}
      model={model}
      status={status}
      probePath={card.probePath}
      refresh={refresh}
      t={t}
    />
  )
}

function ModelProbe({
  model,
  status,
  probePath,
  refresh,
  t,
}: {
  model: string
  /** The variant's document, read above this layer so a switch does not wait. */
  status: WorkBuddyWebStatus | undefined
  /** This variant's write route, for the one action the panel offers. */
  probePath: string
  refresh: (signal?: AbortSignal) => Promise<void>
  t: WorkBuddyTranslate
}): ReactNode {
  const [busy, setBusy] = useState(false)
  /**
   * Whether the panel is open.
   *
   * One flag, not a confirmation-plus-result pair: the panel shows the same
   * thing before and after a run (the levels, and the one button that gets
   * them), so there is no second state to model. Opening it is not a commitment
   * either — the button inside is.
   */
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  /**
   * The outcome of the run this control just performed.
   *
   * Kept so a fresh answer is shown immediately, without waiting for the next
   * status read; the document's own row is what stands when there is none.
   */
  const [fresh, setFresh] = useState<WorkBuddyWebEffortModel>()
  const inFlight = useRef(false)
  const mounted = useRef(false)
  /**
   * This control's anchor name, unique per instance.
   *
   * Generated here rather than in the panel because the **trigger** is what CSS
   * anchors onto, and the control exists before the panel does. The panel is
   * portalled to `document.body`, so it inherits nothing: both elements get the
   * property inline, and the stylesheet reads it on each side
   * (`anchor-name` on the trigger, `position-anchor` on the panel).
   */
  const anchorStyle: CSSProperties & Record<typeof ANCHOR_PROPERTY, string> = {
    [ANCHOR_PROPERTY]: `--dsh-workbuddy-probe-${useId().replaceAll(':', '')}`,
  }
  /** The control itself: the popover's anchor and the "inside" test for dismissal. */
  const rootRef = useRef<HTMLSpanElement>(null)
  /**
   * The panel, portalled to `document.body` so it is not clipped by the composer
   * row. Passed to the outside-pointer test, which would otherwise read a click
   * on the panel as a click outside it. Its *placement* needs no ref: CSS anchors
   * resolve it against the trigger.
   */
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const probe = status?.status === 'signed-in' ? status.probe : undefined
  const key = status?.status === 'signed-in' ? status.probeKey : undefined
  const entry = status === undefined ? undefined : effortModelFor(status, model)
  /**
   * The bulb is shown for every reasoning model the host reports, and hidden
   * only where the host says there is nothing to say.
   *
   * The old gate was `candidates.includes(model) || hasRecord`, i.e. "this model
   * could be probed, or has been". That is a statement about *detection*, and it
   * left the bulb off exactly the models whose switch already worked — a
   * declared set made a model ineligible, so the best-configured models were the
   * ones with no control beside them, and the user read that as a bug.
   */
  const visible = entry !== undefined

  // A recorded answer answers the question a remembered failure was about, so
  // the flag is dropped with it rather than lingering into the next render.
  useEffect(() => {
    if (entry?.validation !== undefined) setFailed(false)
  }, [entry?.validation])

  // A selection change must not strand an open bubble.
  useEffect(() => {
    setOpen(false)
    setFresh(undefined)
  }, [model])

  const detect = async (): Promise<void> => {
    if (key === undefined || inFlight.current || probe?.running === true) return
    inFlight.current = true
    setFresh(undefined)
    setBusy(true)
    setFailed(false)
    try {
      const response = await fetch(probePath, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
        body: JSON.stringify({ action: 'probe', model }),
      })
      const body = (await response.json()) as {
        state?: string
        validation?: string
        efforts?: unknown
      }
      const validation = body.validation
      if (
        !response.ok ||
        body.state !== 'ok' ||
        (validation !== 'validating' && validation !== 'non-validating') ||
        !Array.isArray(body.efforts) ||
        !body.efforts.every((effort) => typeof effort === 'string')
      ) {
        throw new Error('probe failed')
      }
      // This response belongs to the explicit click, even when the host reused
      // an older cached result. Do not wait for /status (which fetches credit),
      // or infer completion from wall-clock timestamps and background polls.
      if (mounted.current) {
        // Only a validating sweep produces a switchable set. A `non-validating`
        // verdict is recorded *without* levels, exactly as the host stores it,
        // so the fresh row cannot claim a control the picker does not offer.
        const validating = validation === 'validating'
        setFresh({
          id: model,
          name: model,
          efforts: validating ? (body.efforts as string[]) : [],
          source: validating ? 'observed' : 'none',
          detectable: true,
          validation,
          probedAt: Date.now(),
        })
      }
      void refresh().catch(() => {
        /* Credit/status failure does not undo a completed probe. */
      })
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  // The one hook that is still the host's, and it lives above the `visible`
  // early return: hooks may not be skipped, and a control that comes and goes
  // with the selection must keep a stable hook order across renders.
  //
  // The panel is portalled, so it is no longer a DOM descendant of the anchor:
  // without `panelRef` a click inside the panel would count as "outside" and
  // close it.
  useDismissOnOutsidePointer(
    rootRef,
    open,
    () => {
      setOpen(false)
    },
    panelRef,
  )

  if (!visible) return null

  const text = tooltipText(t, { busy, entry, failed })
  // The freshly-answered row wins over the document's, so the panel the user
  // just acted in shows what the action produced rather than the older snapshot.
  const shown = fresh ?? entry
  const levels = levelsLine(shown)
  const notValidating = shown?.validation === 'non-validating'
  /*
   * Whether the bulb is lit: **this model can switch thinking levels.**
   *
   * Keyed on whether levels are offered, never on whether a detection ran. The
   * two disagree in both directions and the levels are what the user cares
   * about: a declared set has levels and no detection, while a `non-validating`
   * sweep has a detection and no levels. Lighting the bulb for the second case
   * was the old behaviour, and it made "detected" look like "works".
   */
  const lit = levels !== undefined
  /*
   * A declared set is already the answer, so there is nothing left to detect.
   * The bulb stays — it is how the user learns the model *has* levels — but the
   * action inside says so instead of offering to spend credit on a settled
   * question.
   */
  const detectable = shown?.detectable === true
  // Opening the panel is always allowed: for a declared model that is the only
  // way to read which levels it offers, and a bulb that refuses to open is a
  // worse answer than one that opens and explains. Only the action is gated.
  const triggerDisabled = busy || probe?.running === true || key === undefined
  const actionDisabled = !detectable || triggerDisabled
  // The open panel already says everything the tooltip would, so it steps aside
  // rather than hovering over the thing it describes.
  return (
    <span className={css.wrapper} ref={rootRef}>
      <Tooltip label={text} side="top" portal disabled={open}>
        <button
          type="button"
          className={css.trigger}
          style={anchorStyle}
          aria-label={text}
          aria-busy={busy}
          aria-expanded={open}
          disabled={triggerDisabled}
          onClick={() => {
            setOpen(!open)
          }}
        >
          <ProbeIcon lit={lit} />
        </button>
      </Tooltip>

      {/* Closed means unmounted: a panel left in the DOM is a `position: fixed`
          hit-testing box that would sit over the composer after it closed.

          There is no close button and no cancel: the panel explains one action and
          holds the one button that takes it, so the ways out are the popover's own
          — a pointer anywhere outside (the host's `useDismissOnOutsidePointer`;
          that hook is pointer-only, Escape was never one of its exits) or the icon
          again. */}
      {open
        ? createPortal(
            <ProbePanel
              panelRef={panelRef}
              style={anchorStyle}
              model={model}
              lit={lit}
              levels={levels}
              notValidating={notValidating}
              detectable={detectable}
              failed={failed}
              shown={shown}
              busy={busy}
              actionDisabled={actionDisabled}
              onDetect={() => {
                void detect()
              }}
              t={t}
            />,
            document.body,
          )
        : null}
    </span>
  )
}

/**
 * The open popover's contents.
 *
 * Split out of {@link ModelProbe} because the panel is a self-contained reading
 * of one model — a title, the levels, why there are none, and the one action —
 * while the parent is a state machine (reads, races, an anchored portal). The
 * boundary is *what the panel needs to know*, not a slice of the parent's state:
 * every prop here is already computed by the time the panel renders, and the
 * panel holds none of its own. That is what keeps the split from moving the
 * implicit constraints the parent carries.
 */
function ProbePanel({
  panelRef,
  style,
  model,
  lit,
  levels,
  notValidating,
  detectable,
  failed,
  shown,
  busy,
  actionDisabled,
  onDetect,
  t,
}: {
  /** The portalled surface, used by the dismissal test. */
  panelRef: React.RefObject<HTMLElement>
  /**
   * The anchor property only — placement is CSS. The panel is portalled to
   * `document.body`, so it inherits nothing from the control; this carries the
   * anchor name the stylesheet's `position-anchor` reads.
   */
  style: CSSProperties
  model: string
  lit: boolean
  levels: string | undefined
  notValidating: boolean
  detectable: boolean
  failed: boolean
  shown: WorkBuddyWebEffortModel | undefined
  busy: boolean
  actionDisabled: boolean
  onDetect: () => void
  t: WorkBuddyTranslate
}): ReactNode {
  return (
    <section
      ref={panelRef}
      className={css.panel}
      style={style}
      role="dialog"
      aria-label={t('probeLabel')}
    >
      <div className={css.panelTitle}>
        <span className={css.panelTitleIcon}>
          <ProbeIcon lit={lit} />
        </span>
        <span className={css.panelTitleText}>{model}</span>
      </div>

      <div className={css.titleRule} aria-hidden />

      <p className={css.levelsLabel}>{t('probePanelLevels')}</p>
      <p className={css.levels} role="status" aria-live="polite">
        {levels ?? t('probePanelNoLevels')}
      </p>
      {/*
       * Why there are no levels, when that is the answer. Three distinct
       * facts, and the panel must not collapse them: a declared model
       * whose set is empty does not exist (it would have levels), a
       * completed sweep that found no validation is a *result*, and
       * silence means nobody has asked yet.
       *
       * The old copy rendered `probePanelNone` ("not detected yet")
       * whenever `levels` was undefined, so a `non-validating` result
       * printed "not detected yet" directly above its own verdict —
       * telling the user a question they had just paid to ask was still
       * open.
       */}
      <PanelReason
        notValidating={notValidating}
        levels={levels}
        detectable={detectable}
        shown={shown}
        failed={failed}
        t={t}
      />

      {/* The cost note belongs to the action, so it steps aside once
        there is nothing left to ask — a declared set, or a model with
        no detection to offer. */}
      {detectable && levels === undefined && !notValidating ? (
        <p className={css.note}>{t('probePanelNote')}</p>
      ) : null}

      <div className={css.panelActions}>
        <Button size="sm" variant="primary" disabled={actionDisabled} onClick={onDetect}>
          {busy
            ? t('probePanelDetecting')
            : /*
               * A settled model's button explains why it is inert rather
               * than saying "Detect" and going grey: an action label that
               * names something the button will not do is what makes a
               * disabled control read as broken.
               */
              !detectable
              ? t('probePanelNotNeeded')
              : levels === undefined
                ? t('probePanelDetect')
                : t('probePanelRedetect')}
        </Button>
      </div>
    </section>
  )
}

/**
 * The one line explaining *why* there are no levels, when that is the answer.
 *
 * Three facts, kept apart on purpose — see the call site. Extracted so the three
 * mutually exclusive branches read as one decision rather than three adjacent
 * conditionals interleaved with unrelated markup.
 */
function PanelReason({
  notValidating,
  levels,
  detectable,
  shown,
  failed,
  t,
}: {
  notValidating: boolean
  levels: string | undefined
  detectable: boolean
  shown: WorkBuddyWebEffortModel | undefined
  failed: boolean
  t: WorkBuddyTranslate
}): ReactNode {
  if (notValidating) return <p className={css.dim}>{t('probePanelNotValidating')}</p>
  if (levels === undefined && !detectable && shown !== undefined) {
    return <p className={css.dim}>{t('probePanelDeclaredNone')}</p>
  }
  if (failed && shown === undefined) return <p className={css.dim}>{t('probePanelFailed')}</p>
  return null
}

/** The bulb's body — the maintainer's artwork, one filled path with the base cut out. */
const BULB_BODY =
  'M496 64C681.6 64 832 208.896 832 387.648c0 124.544-73.152 232.704-180.352 286.784v24.256c0 6.912-0.64 13.76-1.856 20.288a56.32 56.32 0 0 1 20.672 20.416 54.848 54.848 0 0 1 7.552 27.712v37.312c0 29.312-23.04 53.312-52.288 55.808l-2.816 0.192h-23.04c0 54.976-46.336 99.584-103.424 99.584-57.024 0-103.296-44.544-103.296-99.584h-19.776l-2.24-0.128h-3.84a58.24 58.24 0 0 1-36.48-18.432 55.808 55.808 0 0 1-14.72-37.44v-37.312c0-20.16 11.008-37.888 27.328-47.744a104.064 104.064 0 0 1-1.984-20.672v-23.744C233.6 621.056 160 512.576 160 387.584 160.064 208.96 310.4 64 496 64z m-45.632 796.288c0 24.064 20.48 43.712 46.08 43.712 25.728 0 46.144-19.712 46.208-43.52v-0.192H450.368z m-76.992-56h247.296l0.064-37.056-0.512-0.32H373.632l-0.256 37.376zM496 120.064c-154.112 0-278.656 120-278.656 267.52 0 100.8 58.624 191.68 150.208 237.44l31.104 15.68 0.064 50.56c0 3.968 0.384 7.552 0.896 10.816l0.576 1.984H467.84V704h70.4v-0.128l55.488-0.32 0.512-1.472c0.64-3.776 0.96-7.552 0.96-11.328l-0.96-50.56 31.04-15.616c91.2-45.952 149.312-136.576 149.312-236.992 0-147.584-124.544-267.648-278.656-267.648v0.128z'

/** The bolt drawn inside the bulb once a detection has landed. */
const BULB_BOLT =
  'M465.536 443.264H396.8c-8.96 0-15.168-8.192-11.968-15.872l68.288-163.84a11.904 11.904 0 0 1 4.672-5.504A13.632 13.632 0 0 1 465.024 256h115.2c9.088 0 15.36 8.448 11.904 16.128L552.32 361.344H627.2c11.008 0 16.832 11.84 9.6 19.456L453.376 571.968c-8.96 9.28-25.472 1.28-22.016-10.752l34.176-117.952z'

/**
 * The control's icon: a light bulb, and the same bulb lit once a detection landed.
 *
 * Two states carry the whole story without a word:
 * - **bulb** — nothing verified yet; this is the model whose levels are still unknown.
 * - **bulb with the bolt** — a recorded result says which levels this model accepts.
 *
 * That is why the bolt is a second path rather than decoration: the trigger has to answer
 * "is this model checked?" at a glance, in 28px, next to the host's model picker — and the
 * panel that opens from it repeats the same glyph, so trigger, panel and result read as one
 * object. The artwork is the maintainer's bulb, redrawn on the host's 16-unit grid: ink spans
 * 2..14 vertically and 3.5..12.5 horizontally (the host's own icons keep a 6–9 inset), filled
 * with `currentColor` so both themes come from the button's colour alone — no literal colour,
 * no `[data-ds-dark-theme]` selector.
 *
 * The bolt appears only for a **successful** detection (`lit`), never while a run is in
 * flight and never for a failure: a spinner-shaped claim would be answered by the tooltip,
 * which already says exactly what happened.
 */
function ProbeIcon({ lit }: { lit: boolean }): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g transform="translate(1.35714 1.14286) scale(0.01339286)">
        <path d={BULB_BODY} fill="currentColor" fillRule="evenodd" />
        {/* The bolt is cut out of the bulb with the same even-odd rule: one filled path, so
            the hole is real glass rather than a second colour that would need a token. */}
        {lit ? <path d={BULB_BOLT} fill="currentColor" fillRule="evenodd" /> : null}
      </g>
    </svg>
  )
}
