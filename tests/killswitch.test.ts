import { expect, test } from 'claude-code/testing'

const RESET = '2026-11-01T17:00:00.000Z'
const NOW = Date.parse('2026-11-01T10:00:00.000Z')

type Kit = Parameters<Parameters<typeof test>[1]>[1]

// Stands in for the engine beneath the plugin: clock, store, usage, git, files.
function engine(on: Kit, usage: () => object[]) {
  const s = {
    now: NOW,
    store: new Map<string, unknown>(),
    ran: [] as string[][],
    written: {} as Record<string, string>,
    aborted: [] as string[],
    toasts: [] as string[],
    submitted: [] as string[],
    // Wakes the reset timer: jumps the clock past the reset first.
    wake: () => {},
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: s.now }))
  // The 30-second tick never fires; the reset timer waits for wake().
  on('clock.sleep', (_, e) => {
    if (e.ms < 60_000) return new Promise(() => {})
    return new Promise(resolve => {
      s.wake = () => {
        s.now = Date.parse(RESET) + 61_000
        resolve({ value: undefined })
      }
    })
  })
  on('store.get', (_, e) => ({ value: s.store.get(e.key) }))
  on('store.set', (_, e) => (s.store.set(e.key, e.value), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: {}, rateLimits: usage() } }))
  on('process.run', (_, e) => {
    s.ran.push([...e.argv])
    const out =
      e.argv[1] === 'rev-parse' && e.argv[2] === '--show-toplevel' ? '/repo'
      : e.argv[1] === 'rev-parse' && e.argv[2] === '--absolute-git-dir' ? '/repo/.git'
      : e.argv[1] === 'rev-parse' ? 'abc123'
      : e.argv[1] === 'write-tree' ? 'tree1'
      : e.argv[1] === 'commit-tree' ? 'commit1'
      : e.argv[1] === 'diff' ? ' a.ts | 2 +-'
      : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  })
  on('fs.write', (_, e) => ((s.written[e.path] = e.text), { value: undefined }))
  on('turn.abort', (_, e) => (s.aborted.push(e.turnId), { value: undefined }))
  on('turn.start', (_, e) => ({ text: e.text, turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_, e) => {
    if (e.origin?.kind === 'plugin') s.submitted.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (s.toasts.push(e.text), { value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  return s
}

const weekly = (p: number) => ({ kind: 'seven_day', percentUsed: p, resetsAt: RESET })
const done = (turnId: string) =>
  ({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' }) as const

test('trips at 99%, saves, blocks, then resumes the work by itself after the reset', async ($, on) => {
  let pct = 98
  const s = engine(on, () => [weekly(pct)])

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'build the thing', turnId: 't1' })
  expect('deny' in (await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(false)

  pct = 99
  await $.session.measure({ context: {}, rateLimits: [weekly(99)], changed: ['rateLimits'] })

  expect(s.aborted).toEqual(['t1'])
  expect(s.ran.some(a => a[1] === 'update-ref' && a[2]?.startsWith('refs/killswitch/'))).toBe(true)
  const note = Object.entries(s.written).find(([p]) => p.startsWith('/repo/.claude/killswitch/2'))
  expect(note?.[1]).toContain('weekly limit at 99.0%')
  expect(note?.[1]).toContain('build the thing')
  expect(note?.[1]).toContain('resumes by itself')

  const denied = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('deny' in denied && denied.deny).toContain('Killswitch is on')

  // The reset passes: the timer releases the stop and resumes the work.
  s.wake()
  for (let i = 0; i < 100 && s.submitted.length === 0; i++) await new Promise(r => setTimeout(r, 5))
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toContain('Continue the work the killswitch stopped')
  expect('deny' in (await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(false)
})

test('another session reading 99% stops this one too', async ($, on) => {
  const s = engine(on, () => [weekly(97.2)])
  s.store.set('latest', [weekly(99.1)])

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.turn.complete(done('t1'))

  const denied = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('deny' in denied && denied.deny).toContain('weekly limit at 99.1%')
})

test('a reading from a window that has already reset is ignored', async ($, on) => {
  const s = engine(on, () => [weekly(40)])
  s.store.set('latest', [{ kind: 'seven_day', percentUsed: 99.5, resetsAt: '2026-11-01T09:00:00.000Z' }])

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect('deny' in (await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(false)
  expect((s.store.get('latest') as { percentUsed: number }[])[0]?.percentUsed).toBe(40)
})

test('warns once at 90%', async ($, on) => {
  let pct = 89
  const s = engine(on, () => [weekly(pct)])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect(s.toasts.filter(t => t.startsWith('Heads up')).length).toBe(0)

  pct = 90.4
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.turn.complete(done('t1'))
  pct = 91
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.turn.complete(done('t2'))

  const heads = s.toasts.filter(t => t.startsWith('Heads up'))
  expect(heads.length).toBe(1)
  expect(heads[0]).toContain('weekly limit at 90.4%')
})

test('past 97% Claude is told to wrap up, once per turn and on each new prompt', async ($, on) => {
  engine(on, () => [weekly(97.5)])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const sent = await $.prompt.submit({ text: 'next task' })
  expect('context' in sent && sent.context?.join(' ')).toContain('handoff note')

  await $.turn.start({ text: 'next task', turnId: 't1' })
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('context' in first && first.context?.join(' ')).toContain('Finish the step you are on')
  expect('context' in second ? second.context ?? [] : []).toEqual([])
})

test('the settings set the levels', { options: { warnAt: 80 } }, async ($, on) => {
  const s = engine(on, () => [weekly(85)])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // Warned at 85%, under the default 90% but past the 80% set here.
  expect(s.toasts.filter(t => t.startsWith('Heads up')).length).toBe(1)
})

test('the band draws slim rails, the pace and the killswitch state', async ($, on) => {
  let pct = 90
  const s = engine(on, () => [
    { kind: 'five_hour', percentUsed: 8, resetsAt: '2026-11-01T12:10:00.000Z' },
    weekly(pct),
  ])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // An hour later the weekly figure rose 4 points: 5 to go at that pace is ~1h 15m.
  s.now = NOW + 3600_000
  pct = 94
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.turn.complete(done('t1'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'killswitch',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /armed at 99%/ }))?.text).toContain('armed')
    expect((await ui.find({ type: 'Text', text: /94\.0%/ }))?.text).toContain('resets 6h 0m')
    expect((await ui.find({ type: 'Text', text: /99% in ~1h 15m/ }))?.text).toContain('Weekly')
    expect((await ui.find({ type: 'Text', text: /8\.0%/ }))?.text).toContain('resets 1h 10m')
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  }
})

test('the history pane shows each window', async ($, on) => {
  engine(on, () => [weekly(60)])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'killswitch',
      surface,
      component: 'Pane',
      requestId: 'killswitch-history',
      props: {
        title: 'Usage history',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /weekly limit: 60\.0%/ }))?.text).toBeTruthy()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  }
})
