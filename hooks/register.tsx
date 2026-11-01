import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderSurface, SessionRateLimit } from 'claude-code'

import type { KillswitchConfig, Limit, Sample } from '../types'

type $ = EngineInterface

const WATCHED: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
}
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 24 * 3600_000,
}
const PANE = 'killswitch-history'

// The settings page's values (plugin.json userConfig), defaults filled in.
const settings = { threshold: 99, warnAt: 90, wrapUpAt: 97, autoResume: true }

function readSettings(options: PluginOptions) {
  const num = (v: unknown, d: number) =>
    typeof v === 'number' && v > 0 && v <= 100 ? v : d
  settings.threshold = num(options.threshold, 99)
  settings.warnAt = num(options.warnAt, 90)
  settings.wrapUpAt = num(options.wrapUpAt, 97)
  settings.autoResume = options.autoResume !== false
}

const config = atom(
  { plugin: 'killswitch', key: 'config' } as const,
  // Armed from the start of every session; /killswitch off disarms it.
  { isArmed: true, threshold: 99, isTripped: false },
  { shape: 'config-2' },
)

const limits = atom({ plugin: 'killswitch', key: 'limits' } as const, [])
const isBandHidden = atom({ plugin: 'killswitch', key: 'isBandHidden' } as const, false)
const warned = atom({ plugin: 'killswitch', key: 'warned' } as const, {})

// The running main-loop turn, so a trip can end it. A reload forgets it; tools
// are still denied from the moment of the trip.
let mainTurn: string | undefined
// The turn the wrap-up note was last given in, so it is given once per turn.
let wrapNotedTurn: string | undefined
let cwd = '.'
let lastPrompt = ''
// The account's usage history, shared by every session through the store.
let history: Sample[] = []

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-')
const when = (ms?: number) =>
  ms === undefined ? 'unknown (run /killswitch off once it has reset)' : new Date(ms).toLocaleString()
const handoffPath = () => `${cwd}/.claude/killswitch/HANDOFF.md`

async function git($: $, args: string[], env?: Record<string, string>) {
  const ran = await $.process.run(['git', ...args], { cwd, env, timeoutMs: 120_000 })
  return ran.exitCode === 0 ? ran.stdout.trim() : undefined
}

// Saves the working tree (tracked + untracked, .gitignore respected) as a commit
// under refs/killswitch/<stamp>, through a throwaway index: the branch, the real
// index and the files on disk are left exactly as they were.
async function snapshot($: $, name: string, why: string) {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (top === undefined) return { status: 'not a git repository: nothing snapshotted' }
  const gitDir = await git($, ['rev-parse', '--absolute-git-dir'])
  const env = { GIT_INDEX_FILE: `${gitDir}/killswitch-index` }
  const head = await git($, ['rev-parse', '--verify', '-q', 'HEAD'])
  await git($, head ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], env)
  await git($, ['-C', top, 'add', '-A'], env)
  const tree = await git($, ['write-tree'], env)
  if (tree === undefined) return { top, status: 'git snapshot failed' }
  const commit = await git($, [
    'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `killswitch: ${why}`,
  ])
  if (commit === undefined) return { top, status: 'git snapshot failed' }
  const ref = `refs/killswitch/${name}`
  await git($, ['update-ref', ref, commit])
  const changed = head ? await git($, ['diff', '--stat', head, commit]) : '(first commit)'

  return { top, ref, changed: changed || 'no changes since HEAD', status: 'saved' }
}

async function trip($: $, hit: readonly Limit[], threshold: number) {
  const now = await $.clock.now()
  const resets = hit.map(w => (w.resetsAt ? Date.parse(w.resetsAt) : NaN))
  const resumesAt = resets.some(Number.isNaN) ? undefined : Math.max(...resets)
  const reason = hit.map(w => `${WATCHED[w.kind]} at ${w.percentUsed.toFixed(1)}%`).join(', ')
  const wasWorking = mainTurn !== undefined

  await update($, config, c => ({ ...c, isTripped: true, resumesAt, reason, wasWorking }))
  $.ui.status(`KILLSWITCH: stopped (${reason})`)
  $.ui.toast(`Killswitch tripped: ${reason}. Saving work and stopping.`)

  // End the running turn first, so nothing more is spent while saving.
  if (mainTurn !== undefined) await $.turn.abort({ turnId: mainTurn }).catch(() => {})

  const name = stamp(now)
  const snap: { status: string; top?: string; ref?: string; changed?: string } =
    await snapshot($, name, reason).catch(err => ({ status: `git snapshot failed: ${err}` }))
  const notePath = `${cwd}/.claude/killswitch/${name}.md`
  const note = [
    `# Killswitch stop — ${new Date(now).toLocaleString()}`,
    '',
    `- Reason: ${reason} (threshold ${threshold}%)`,
    `- Work resumes after: ${when(resumesAt)}`,
    `- Working directory: ${cwd}`,
    `- Git snapshot: ${snap.ref ?? snap.status}`,
    `- Claude's handoff note, if it wrote one before the stop: ${handoffPath()}`,
    '',
    '## Last request in progress',
    '',
    lastPrompt ? lastPrompt.slice(0, 4000) : '(none recorded)',
    '',
    ...(snap.ref
      ? [
          '## Changes in the snapshot (vs HEAD)',
          '',
          '```',
          snap.changed ?? '',
          '```',
          '',
          '## Restoring',
          '',
          'Your files on disk were not touched; the snapshot is a safety copy.',
          'To bring the snapshot back over the working tree:',
          '',
          '```bash',
          `git -C "${snap.top ?? cwd}" checkout ${snap.ref} -- .`,
          '```',
          '',
        ]
      : []),
    '## To resume',
    '',
    settings.autoResume && wasWorking
      ? 'The session resumes by itself once the limit resets.'
      : 'After the reset time, send a new message (e.g. "continue from the killswitch note").',
    'Run `/killswitch off` to lift the stop early.',
    '',
  ].join('\n')
  const savedTo = await $.fs.write(notePath, note).then(() => notePath, () => undefined)

  await update($, config, c => ({ ...c, savedTo }))
  $.ui.toast(`Killswitch: work saved${savedTo ? ` to ${savedTo}` : ''}. Blocked until ${when(resumesAt)}.`)
  if (resumesAt !== undefined) void wakeAt($, resumesAt)
}

async function wakeAt($: $, at: number) {
  await $.clock.sleep(Math.max(0, at - (await $.clock.now())) + 60_000)
  await releaseIfDue($, true)
}

// Lifts the stop once the blocking window's reset time has passed. Woken by its
// own timer, it also picks the stopped work up again when the settings allow.
async function releaseIfDue($: $, isTimer = false): Promise<KillswitchConfig> {
  const c = await read($, config)
  if (!c.isTripped || c.resumesAt === undefined) return c
  if ((await $.clock.now()) < c.resumesAt) return c
  const next = await update($, config, x => ({
    ...x, isTripped: false, resumesAt: undefined, reason: undefined, wasWorking: undefined,
  }))
  $.ui.status('killswitch: armed')
  if (isTimer && settings.autoResume && c.wasWorking) {
    $.ui.toast('Killswitch: the usage limit has reset. Resuming the stopped work.')
    await $.prompt.submit({
      text:
        'The usage limit has reset. Continue the work the killswitch stopped: read ' +
        `${c.savedTo ?? 'the latest note in .claude/killswitch/'} and ${handoffPath()} ` +
        '(if it exists), then carry on from where it stopped.',
    })
  } else {
    $.ui.toast('Killswitch: the usage limit has reset. You can continue.')
  }
  return next
}

// Several sessions report on the same account, each from its own last
// response. Within one window usage only grows, so the freshest reading is the
// highest; a later reset time is a newer window. Expired windows are dropped.
function merge(a: readonly Limit[], b: readonly Limit[], now: number): Limit[] {
  const out: Limit[] = []
  for (const kind of Object.keys(WATCHED)) {
    const live = [...a, ...b].filter(
      w => w.kind === kind && !(w.resetsAt && Date.parse(w.resetsAt) <= now),
    )
    const best = live.reduce<Limit | undefined>((acc, w) => {
      if (acc === undefined) return w
      const ra = acc.resetsAt ? Date.parse(acc.resetsAt) : 0
      const rw = w.resetsAt ? Date.parse(w.resetsAt) : 0
      if (rw !== ra) return rw > ra ? w : acc
      return w.percentUsed > acc.percentUsed ? w : acc
    }, undefined)
    if (best) out.push({ kind, percentUsed: best.percentUsed, resetsAt: best.resetsAt })
  }
  return out
}

async function sharedLimits($: $): Promise<Limit[]> {
  const v = await $.store.get('latest').catch(() => undefined)
  return Array.isArray(v) ? (v as Limit[]) : []
}

async function loadHistory($: $) {
  const v = await $.store.get('history').catch(() => undefined)
  history = Array.isArray(v) ? (v as Sample[]) : []
}

// A point per window when its figure moves, or every ten minutes; eight days kept.
async function recordHistory($: $, list: readonly Limit[], now: number) {
  await loadHistory($)
  let isChanged = false
  for (const w of list) {
    const last = [...history].reverse().find(s => s.k === w.kind)
    if (last && last.p === w.percentUsed && last.r === w.resetsAt && now - last.t < 600_000) continue
    history.push({ t: now, k: w.kind, p: w.percentUsed, r: w.resetsAt })
    isChanged = true
  }
  if (!isChanged) return
  history = history.filter(s => now - s.t < 8 * 24 * 3600_000).slice(-3000)
  await $.store.set('history', history)
}

// The pace of a window over the last two hours of its own samples: when, at that
// rate, it reaches the threshold. Undefined when there is no rise to go on.
function forecast(w: Limit, threshold: number, now: number): { eta?: number } | undefined {
  const points = history.filter(s => s.k === w.kind && s.r === w.resetsAt && now - s.t <= 2 * 3600_000)
  const first = points[0]
  if (first === undefined || w.percentUsed >= threshold) return undefined
  const dt = now - first.t
  const dp = w.percentUsed - first.p
  if (dt < 10 * 60_000 || dp <= 0) return {}
  const eta = ((threshold - w.percentUsed) / dp) * dt
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : Infinity
  return now + eta >= reset ? {} : { eta }
}

function duration(ms: number) {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

const countdown = (resetsAt: string | undefined, now: number) =>
  resetsAt ? duration(Date.parse(resetsAt) - now) : ''

function paceText(w: Limit, threshold: number, now: number) {
  const f = forecast(w, threshold, now)
  if (f === undefined) return ''
  return f.eta !== undefined ? `${threshold}% in ~${duration(f.eta)}` : 'safe until reset'
}

async function setLimits($: $, list: readonly Limit[]) {
  await update($, limits, () => list.map(w => ({ ...w })))
}

// One toast per window and reset as it passes the warning level.
async function warn($: $, list: readonly Limit[], now: number) {
  const c = await read($, config)
  if (!c.isArmed || c.isTripped) return
  const seen = await read($, warned)
  for (const w of list) {
    const key = w.resetsAt ?? 'unknown'
    if (w.percentUsed < settings.warnAt || w.percentUsed >= c.threshold || seen[w.kind] === key) continue
    await update($, warned, x => ({ ...x, [w.kind]: key }))
    $.ui.toast(
      `Heads up: ${WATCHED[w.kind]} at ${w.percentUsed.toFixed(1)}%. ` +
        `The killswitch stops work at ${c.threshold}%` +
        (w.resetsAt ? `; it resets in ${countdown(w.resetsAt, now)}.` : '.'),
    )
  }
}

const over = (list: readonly Limit[], threshold: number) =>
  list.filter(w => w.kind in WATCHED && w.percentUsed >= threshold)

// Trips the killswitch when a watched window is at or past the threshold.
async function check($: $, list: readonly Limit[]) {
  const c = await read($, config)
  if (!c.isArmed || c.isTripped) return
  const hit = over(list, c.threshold)
  if (hit.length > 0) await trip($, hit, c.threshold)
}

// The newest figures: this session's own reading merged with every other
// session's, written back for them. Each trips, warns and redraws from it.
async function refresh($: $, own?: readonly SessionRateLimit[]) {
  const now = await $.clock.now()
  const mine = (own ?? (await $.session.usage()).rateLimits).filter(w => w.kind in WATCHED)
  const merged = merge(mine, await sharedLimits($), now)
  await $.store.set('latest', merged)
  await recordHistory($, merged, now)
  await setLimits($, merged)
  await warn($, merged, now)
  await check($, merged)
}

async function tick($: $) {
  for (;;) {
    await $.clock.sleep(30_000)
    await refresh($).catch(() => {})
    $.ui.invalidate('ui.render')
  }
}

// The window nearest its limit, when it is past the wrap-up level.
async function wrapUpWindow($: $) {
  const c = await read($, config)
  if (!c.isArmed || c.isTripped) return undefined
  const list = await read($, limits)
  return list
    .filter(w => w.percentUsed >= settings.wrapUpAt && w.percentUsed < c.threshold)
    .sort((a, b) => b.percentUsed - a.percentUsed)[0]
}

const wrapUpNote = (w: Limit, threshold: number) =>
  `[killswitch] The ${WATCHED[w.kind]} is at ${w.percentUsed.toFixed(1)}%; at ${threshold}% ` +
  'this session is stopped until the limit resets. Finish the step you are on, do not ' +
  `start new large work, and write a short handoff note to ${handoffPath()}: what is ` +
  'done, what is next, and the files involved. Keep it current as you go.'

const blockedText = (c: KillswitchConfig) =>
  `Killswitch is on (${c.reason}). Everything is stopped until ${when(c.resumesAt)}. ` +
  `Work saved${c.savedTo ? ` in ${c.savedTo}` : ''}. Run /killswitch off to override.`

const RAIL_FILL = { success: '#4caf50', warning: '#e0a030', error: '#e5534b' } as const

const tone = (pct: number) =>
  pct >= settings.warnAt ? 'error' : pct >= 70 ? 'warning' : 'success'

const BAND_ROWS: Array<[kind: string, label: string]> = [
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
]

// A window's history as an SVG line over its whole span, with the warning and
// stop levels marked.
function historySvg(w: Limit, threshold: number, now: number) {
  const span = WINDOW_MS[w.kind] ?? 3600_000
  const end = w.resetsAt ? Date.parse(w.resetsAt) : now
  const start = end - span
  const points = history
    .filter(s => s.k === w.kind && s.r === w.resetsAt && s.t >= start)
    .map(s => `${(((s.t - start) / span) * 1000).toFixed(1)},${(100 - s.p).toFixed(1)}`)
  const x = (((now - start) / span) * 1000).toFixed(1)
  const line = (pct: number, color: string) =>
    `<line x1="0" x2="1000" y1="${100 - pct}" y2="${100 - pct}" stroke="${color}" stroke-width="0.6" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 100" width="1000" height="120" preserveAspectRatio="none">` +
    `<rect width="1000" height="100" fill="#8a8a8a" fill-opacity="0.08"/>` +
    line(settings.warnAt, RAIL_FILL.warning) +
    line(threshold, RAIL_FILL.error) +
    `<line x1="${x}" x2="${x}" y1="0" y2="100" stroke="#8a8a8a" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    (points.length > 0
      ? `<polyline points="${points.join(' ')} ${x},${(100 - w.percentUsed).toFixed(1)}" fill="none" stroke="${RAIL_FILL[tone(w.percentUsed)]}" stroke-width="2" vector-effect="non-scaling-stroke"/>`
      : '') +
    `</svg>`
  )
}

// The same history as a row of block glyphs, one per slice of the window.
function sparkline(w: Limit, cells: number, now: number) {
  const span = WINDOW_MS[w.kind] ?? 3600_000
  const end = w.resetsAt ? Date.parse(w.resetsAt) : now
  const start = end - span
  const glyphs = '▁▂▃▄▅▆▇█'
  const samples = history.filter(s => s.k === w.kind && s.r === w.resetsAt)
  let last = 0
  return Array.from({ length: cells }, (_, i) => {
    const t = start + ((i + 1) / cells) * span
    if (t > now) return ' '
    for (const s of samples) if (s.t <= t) last = s.p
    return glyphs[Math.min(7, Math.floor((last / 100) * 8))]
  }).join('')
}

const openHistory = ($: $) => $.ui.open({ id: PANE, title: 'Usage history' })

export const register: Register = (on, options) => {
  readSettings(options)

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'killswitch',
      description: 'Usage killswitch, armed at 99% by default (args: off | status | bar | history | <percent>)',
    })
    await loadHistory($)
    // The settings' threshold applies unless /killswitch <percent> set one.
    await update($, config, c => (c.isCustom ? c : { ...c, threshold: settings.threshold }))
    await refresh($).catch(() => {})
    void tick($)
    const c = await releaseIfDue($)
    if (c.isArmed) $.ui.status(c.isTripped ? `KILLSWITCH: stopped (${c.reason})` : 'killswitch: armed')
    if (c.isTripped && c.resumesAt !== undefined) void wakeAt($, c.resumesAt)
    return next(e)
  })

  on('command.run', { command: 'killswitch' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await update($, config, c => ({ ...c, isArmed: false, isTripped: false, resumesAt: undefined, reason: undefined }))
      $.ui.status(undefined)
      return { text: 'Killswitch disarmed for this session.' }
    }
    if (arg === 'bar' || arg === 'hide') {
      const hidden = await update($, isBandHidden, x => (arg === 'hide' ? true : !x))
      return { text: hidden ? 'Usage bar hidden. /killswitch bar shows it again.' : 'Usage bar shown.' }
    }
    if (arg === 'history') {
      await openHistory($)
      return { text: 'Usage history opened.' }
    }
    if (arg === 'status') {
      await refresh($).catch(() => {})
      const c = await releaseIfDue($)
      const now = await $.clock.now()
      const readings =
        (await read($, limits))
          .map(w => {
            const pace = paceText(w, c.threshold, now)
            return `${WATCHED[w.kind]} ${w.percentUsed.toFixed(1)}% (resets in ${countdown(w.resetsAt, now) || '?'}${pace ? `; ${pace}` : ''})`
          })
          .join('; ') || 'no reading yet'
      const state = !c.isArmed ? 'off' : c.isTripped ? `TRIPPED — ${blockedText(c)}` : `armed at ${c.threshold}%`
      return {
        text:
          `Killswitch: ${state}\nUsage: ${readings}\n` +
          `Settings: warn at ${settings.warnAt}%, wrap up at ${settings.wrapUpAt}%, ` +
          `auto-resume ${settings.autoResume ? 'on' : 'off'}`,
      }
    }
    const asked = arg === '' ? settings.threshold : Number(arg.replace('%', ''))
    if (!Number.isFinite(asked) || asked <= 0 || asked > 100) {
      return { text: 'Usage: /killswitch [percent] | off | status | bar | history' }
    }
    await update($, config, x => ({ ...x, isArmed: true, threshold: asked, isCustom: arg !== '' }))
    $.ui.status('killswitch: armed')
    // A window may already be past it.
    await refresh($).catch(() => {})
    return {
      text: `Killswitch armed: at ${asked}% of the 5-hour or weekly limit, work is snapshotted and everything stops until the limit resets.`,
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await refresh($, e.rateLimits).catch(() => {})
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurn = e.turnId
      if (e.text) lastPrompt = e.text
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) mainTurn = undefined
    await refresh($).catch(() => {})
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const c = await releaseIfDue($)
    if (c.isTripped && e.command?.name !== 'killswitch') {
      $.ui.toast(blockedText(c))
      return { drop: blockedText(c) }
    }
    // Past the wrap-up level, every new request carries the wrap-up note.
    const w = await wrapUpWindow($)
    if (w === undefined || e.command !== undefined) return next(e)
    return next({ ...e, context: [...(e.context ?? []), wrapUpNote(w, c.threshold)] })
  })

  on('tool.call', async ($, e, next) => {
    const c = await read($, config)
    if (c.isTripped) return { deny: blockedText(c) }
    const ran = await next(e)
    // Past the wrap-up level mid-turn, the next tool result carries the note once.
    if (ran.deny !== undefined || mainTurn === undefined || wrapNotedTurn === mainTurn) return ran
    const w = await wrapUpWindow($)
    if (w === undefined) return ran
    wrapNotedTurn = mainTurn
    return { ...ran, context: [...(ran.context ?? []), wrapUpNote(w, c.threshold)] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const list = await read($, limits)
    const c = await read($, config)
    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const width = e.props.bodyColumns
    const isTerminal = e.surface === 'terminal'

    // The terminal's rail: a thin line of box-drawing glyphs, a tick at the threshold.
    const glyphRail = (pct: number, color: string) => {
      const cells = Math.max(10, width)
      const filled = Math.round((pct / 100) * cells)
      const markAt = Math.min(cells - 1, Math.floor((c.threshold / 100) * cells))
      const rest = Array.from({ length: cells - filled }, (_, i) =>
        c.isArmed && filled + i === markAt ? '┃' : '─').join('')
      return (
        <Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{rest}</Text>
        </Text>
      )
    }

    // A graphical surface's rail: a 4px SVG stretched across the row.
    const svgRail = (pct: number, kind: string) => {
      const mark = c.isArmed
        ? `<rect x="${c.threshold * 10 - 2}" y="0" width="4" height="8" fill="#8a8a8a"/>`
        : ''
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 8" width="1000" height="8" preserveAspectRatio="none">` +
        `<rect x="0" y="2" width="1000" height="4" rx="2" fill="#8a8a8a" fill-opacity="0.3"/>` +
        `<rect x="0" y="2" width="${Math.max(4, pct * 10)}" height="4" rx="2" fill="${RAIL_FILL[tone(pct)]}"/>` +
        mark +
        `</svg>`
      if (!('Svg' in ui)) return glyphRail(pct, tone(pct))
      const { Svg } = ui
      return <Svg key={`${kind}-rail`} source={source} alt={`${pct.toFixed(1)}% used`} height={6} />
    }

    const shield = !c.isArmed
      ? <Text dimColor>○ killswitch off</Text>
      : c.isTripped
        ? <Text color="error" bold>■ STOPPED until {when(c.resumesAt)}</Text>
        : <Text color="success">◆ killswitch armed at {c.threshold}%</Text>

    return (
      <Box flexDirection="column">
        {BAND_ROWS.map(([kind, label]) => {
          const w = list.find(x => x.kind === kind)
          const pct = w ? Math.min(100, w.percentUsed) : 0
          const color = tone(pct)
          const resets = w?.resetsAt ? ` · resets ${countdown(w.resetsAt, now)}` : ''
          const pace = w ? paceText(w, c.threshold, now) : ''
          return (
            <Box key={kind} flexDirection="column" marginBottom={isTerminal ? 0 : 1}>
              <Box justifyContent="space-between" flexWrap="nowrap">
                <Text wrap="truncate">
                  <Text dimColor>{label}</Text>
                  {pace && <Text color={pace.startsWith('safe') ? 'subtle' : 'warning'}>{`  ${pace}`}</Text>}
                </Text>
                {w === undefined ? (
                  <Text dimColor>waiting for the first reading</Text>
                ) : (
                  <Text wrap="truncate">
                    <Text color={color}>{`${pct.toFixed(1)}%`}</Text>
                    <Text dimColor>{resets}</Text>
                  </Text>
                )}
              </Box>
              {isTerminal ? glyphRail(pct, color) : svgRail(pct, kind)}
            </Box>
          )
        })}
        <Box justifyContent="space-between">
          {shield}
          <Button key="history" label="History" plain onPress={() => void openHistory($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const ui = $.ui.resolve(e)
    await loadHistory($)
    const list = await read($, limits)
    const c = await read($, config)
    const now = await $.clock.now()
    const cells = Math.max(10, e.props.bodyColumns)
    const surface: RenderSurface = e.surface

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && <Text dimColor>No reading yet: it arrives with the first reply.</Text>}
        {list.map(w => {
          const pace = paceText(w, c.threshold, now)
          return (
            <Box key={w.kind} flexDirection="column">
              <Text bold>
                {`${WATCHED[w.kind]}: `}
                <Text color={tone(w.percentUsed)}>{`${w.percentUsed.toFixed(1)}%`}</Text>
              </Text>
              <Text dimColor wrap="truncate">
                {`resets in ${countdown(w.resetsAt, now) || '?'}${pace ? ` · ${pace}` : ''} · ` +
                  `warn ${settings.warnAt}%, wrap up ${settings.wrapUpAt}%, stop ${c.threshold}%`}
              </Text>
              {surface !== 'terminal' && 'Svg' in ui ? (
                <ui.Svg
                  key={`${w.kind}-chart`}
                  source={historySvg(w, c.threshold, now)}
                  alt={`${WATCHED[w.kind]} over its window, now ${w.percentUsed.toFixed(1)}%`}
                  height={120}
                />
              ) : (
                <Text color={tone(w.percentUsed)}>{sparkline(w, cells, now)}</Text>
              )}
            </Box>
          )
        })}
        <Text dimColor>Shared by all your sessions on this machine. Dashed lines: warning and stop levels.</Text>
      </Box>
    )
  })
}
