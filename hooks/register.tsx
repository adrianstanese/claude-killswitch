import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { KillswitchConfig, Limit } from '../types'

type $ = EngineInterface

const WATCHED: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
}
const DEFAULT_THRESHOLD = 99

const config = atom(
  { plugin: 'killswitch', key: 'config' } as const,
  // Armed from the start of every session; /killswitch off disarms it.
  { isArmed: true, threshold: DEFAULT_THRESHOLD, isTripped: false },
  { shape: 'config-2' },
)

const limits = atom({ plugin: 'killswitch', key: 'limits' } as const, [])
const isBandHidden = atom({ plugin: 'killswitch', key: 'isBandHidden' } as const, false)

// The running main-loop turn, so a trip can end it. A reload forgets it; tools
// are still denied from the moment of the trip.
let mainTurn: string | undefined
let cwd = '.'
let lastPrompt = ''

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-')
const when = (ms?: number) =>
  ms === undefined ? 'unknown (run /killswitch off once it has reset)' : new Date(ms).toLocaleString()

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

async function trip($: $, hit: SessionRateLimit[], threshold: number) {
  const now = await $.clock.now()
  const resets = hit.map(w => (w.resetsAt ? Date.parse(w.resetsAt) : NaN))
  const resumesAt = resets.some(Number.isNaN) ? undefined : Math.max(...resets)
  const reason = hit.map(w => `${WATCHED[w.kind]} at ${w.percentUsed}%`).join(', ')

  await update($, config, c => ({ ...c, isTripped: true, resumesAt, reason }))
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
    'After the reset time, send a new message (e.g. "continue from the killswitch note").',
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
  await releaseIfDue($)
}

// Lifts the stop once the blocking window's reset time has passed.
async function releaseIfDue($: $): Promise<KillswitchConfig> {
  const c = await read($, config)
  if (!c.isTripped || c.resumesAt === undefined) return c
  if ((await $.clock.now()) < c.resumesAt) return c
  const next = await update($, config, x => ({ ...x, isTripped: false, resumesAt: undefined, reason: undefined }))
  $.ui.status('killswitch: armed')
  $.ui.toast('Killswitch: the usage limit has reset. You can continue.')
  return next
}

const BAND_ROWS: Array<[kind: string, label: string]> = [
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
]

const tone = (pct: number) =>
  pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success'

function countdown(resetsAt: string | undefined, now: number) {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Keeps the band's figures current: every measurement, plus a minute tick so the
// reset countdowns move between turns.
async function setLimits($: $, list: readonly SessionRateLimit[]) {
  await update($, limits, () => list.filter(w => w.kind in WATCHED).map(w => ({ ...w })))
}

// Trips the killswitch when a watched window is at or past the threshold.
async function check($: $, list: readonly SessionRateLimit[]) {
  const c = await read($, config)
  if (!c.isArmed || c.isTripped) return
  const hit = over(list, c.threshold)
  if (hit.length > 0) await trip($, hit, c.threshold)
}

// The engine pushes a measurement only when a window moves a whole point, so
// the latest reading is also pulled after each turn and every 30 seconds.
async function refresh($: $) {
  const { rateLimits } = await $.session.usage()
  await setLimits($, rateLimits)
  await check($, rateLimits)
}

async function tick($: $) {
  for (;;) {
    await $.clock.sleep(30_000)
    await refresh($).catch(() => {})
    $.ui.invalidate('ui.render')
  }
}

const blockedText = (c: KillswitchConfig) =>
  `Killswitch is on (${c.reason}). Everything is stopped until ${when(c.resumesAt)}. ` +
  `Work saved${c.savedTo ? ` in ${c.savedTo}` : ''}. Run /killswitch off to override.`

const over = (limits: readonly SessionRateLimit[], threshold: number) =>
  limits.filter(w => w.kind in WATCHED && w.percentUsed >= threshold)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'killswitch',
      description: 'Usage killswitch, armed at 99% by default (args: off | status | bar | <percent>)',
    })
    await setLimits($, (await $.session.usage()).rateLimits).catch(() => {})
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
    if (arg === 'status') {
      const c = await releaseIfDue($)
      const { rateLimits } = await $.session.usage()
      const readings =
        rateLimits
          .filter(w => w.kind in WATCHED)
          .map(w => `${WATCHED[w.kind]} ${w.percentUsed}% (resets ${w.resetsAt ? new Date(w.resetsAt).toLocaleString() : '?'})`)
          .join('; ') || 'no reading yet'
      const state = !c.isArmed ? 'off' : c.isTripped ? `TRIPPED — ${blockedText(c)}` : `armed at ${c.threshold}%`
      return { text: `Killswitch: ${state}\nUsage: ${readings}` }
    }
    const asked = arg === '' ? DEFAULT_THRESHOLD : Number(arg.replace('%', ''))
    if (!Number.isFinite(asked) || asked <= 0 || asked > 100) {
      return { text: 'Usage: /killswitch [percent] | off | status | bar' }
    }
    const c = await update($, config, x => ({ ...x, isArmed: true, threshold: asked }))
    $.ui.status('killswitch: armed')
    // A window may already be past the threshold.
    const hit = over((await $.session.usage()).rateLimits, c.threshold)
    if (hit.length > 0 && !c.isTripped) await trip($, hit, c.threshold)
    return {
      text: `Killswitch armed: at ${asked}% of the 5-hour or weekly limit, work is snapshotted and everything stops until the limit resets.`,
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await setLimits($, e.rateLimits)
      await check($, e.rateLimits)
    }
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
    if (!c.isTripped || e.command?.name === 'killswitch') return next(e)
    $.ui.toast(blockedText(c))
    return { drop: blockedText(c) }
  })

  on('tool.call', async ($, e, next) => {
    const c = await read($, config)
    return c.isTripped ? { deny: blockedText(c) } : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const list = await read($, limits)
    const c = await read($, config)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const isTerminal = e.surface === 'terminal'
    // Label (7) + percent (6) + countdown (17) + gaps around the bar.
    const barWidth = Math.max(8, Math.min(40, e.props.bodyColumns - 34))
    const markAt = Math.min(barWidth - 1, Math.floor((c.threshold / 100) * barWidth))
    // The terminal draws the bar in block glyphs, with a tick where the killswitch fires.
    const glyphBar = (pct: number, color: string) => {
      const filled = Math.round((pct / 100) * barWidth)
      const empty = Array.from({ length: barWidth - filled }, (_, i) =>
        c.isArmed && filled + i === markAt ? '│' : '░').join('')
      return (
        <Text>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{empty}</Text>
        </Text>
      )
    }

    const shield = !c.isArmed
      ? <Text dimColor>○ killswitch off</Text>
      : c.isTripped
        ? <Text color="error" bold>■ STOPPED until {when(c.resumesAt)}</Text>
        : <Text color="success">● killswitch armed at {c.threshold}%</Text>

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold color="claude">⏻ Usage</Text>
          {shield}
        </Box>
        {BAND_ROWS.map(([kind, label]) => {
          const w = list.find(x => x.kind === kind)
          if (w === undefined) {
            return (
              <Box key={kind} gap={1}>
                <Text dimColor>{label.padEnd(7)}</Text>
                <Text dimColor>waiting for the first reading</Text>
              </Box>
            )
          }
          const pct = Math.min(100, w.percentUsed)
          const color = tone(pct)
          const shown = `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`
          const resets = w.resetsAt ? `resets in ${countdown(w.resetsAt, now)}` : ''
          return (
            <Box key={kind} gap={1} alignItems="center" flexWrap="nowrap">
              <Box width={7} flexShrink={0}><Text>{label}</Text></Box>
              {isTerminal ? glyphBar(pct, color) : (
                // A graphical surface draws a solid track and fill, as wide as the row allows.
                <Box flexGrow={1} height={1} backgroundColor="subtle" overflow="hidden">
                  <Box width={`${pct}%`} backgroundColor={color}><Text> </Text></Box>
                </Box>
              )}
              <Box width={6} flexShrink={0} justifyContent="flex-end">
                <Text color={color} bold>{shown}</Text>
              </Box>
              <Box width={17} flexShrink={0}>
                <Text dimColor wrap="truncate">{resets}</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
