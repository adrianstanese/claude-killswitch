import { expect, test } from 'claude-code/testing'

const RESET = '2026-11-01T17:00:00.000Z'
const NOW = Date.parse('2026-11-01T10:00:00.000Z')

test('trips at 99% of the weekly limit, saves, and blocks until reset', async ($, on) => {
  let now = NOW
  const ran: string[][] = []
  const written: Record<string, string> = {}
  const aborted: string[] = []

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: now }))
  // The release timer never fires here; the prompt check lifts the stop.
  on('clock.sleep', () => new Promise(() => {}))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: {}, rateLimits: [] },
  }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
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
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ text: e.text, turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'killswitch', args: '' })
  await $.turn.start({ text: 'build the thing', turnId: 't1' })

  // 98%: nothing happens.
  await $.session.measure({
    context: {},
    rateLimits: [{ kind: 'seven_day', percentUsed: 98, resetsAt: RESET }],
    changed: ['rateLimits'],
  })
  expect('deny' in (await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(false)

  // 99%: trips.
  await $.session.measure({
    context: {},
    rateLimits: [
      { kind: 'five_hour', percentUsed: 8, resetsAt: RESET },
      { kind: 'seven_day', percentUsed: 99, resetsAt: RESET },
    ],
    changed: ['rateLimits'],
  })

  expect(aborted).toEqual(['t1'])
  expect(ran.some(a => a[1] === 'update-ref' && a[2]?.startsWith('refs/killswitch/'))).toBe(true)
  const note = Object.entries(written).find(([p]) => p.startsWith('/repo/.claude/killswitch/'))
  expect(note?.[1]).toContain('weekly limit at 99%')
  expect(note?.[1]).toContain('build the thing')

  const denied = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('deny' in denied && denied.deny).toContain('Killswitch is on')
  const dropped = await $.prompt.submit({ text: 'keep going' })
  expect('drop' in dropped && dropped.drop).toContain('Killswitch is on')

  // After the reset time the stop lifts on its own.
  now = Date.parse(RESET) + 1000
  const passed = await $.prompt.submit({ text: 'continue' })
  expect('drop' in passed && passed.drop).toBeFalsy()
  expect('deny' in (await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(false)
})

test('the band draws a bar per limit with the killswitch state', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.sleep', () => new Promise(() => {}))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: {}, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'killswitch', args: '' })
  await $.session.measure({
    context: {},
    rateLimits: [
      { kind: 'five_hour', percentUsed: 8, resetsAt: '2026-11-01T12:10:00.000Z' },
      { kind: 'seven_day', percentUsed: 98, resetsAt: '2026-11-01T17:00:00.000Z' },
    ],
    changed: ['rateLimits'],
  })

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
    expect((await ui.find({ type: 'Text', text: /98%/ }))?.text).toContain('98%')
    expect((await ui.find({ type: 'Text', text: /resets in 7h 0m/ }))?.text).toBe('resets in 7h 0m')
    expect((await ui.find({ type: 'Text', text: /resets in 2h 10m/ }))?.text).toBe('resets in 2h 10m')
    await ui.unmount()
  }
})

test('a reading pulled after a turn trips it, even without a whole-point measurement', async ($, on) => {
  let weekly = 98.4
  const aborted: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.sleep', () => new Promise(() => {}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: {},
      rateLimits: [{ kind: 'seven_day', percentUsed: weekly, resetsAt: RESET }],
    },
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('fs.write', () => ({ value: undefined }))
  on('turn.abort', (_, e) => (aborted.push(e.turnId), { value: undefined }))
  on('turn.start', (_, e) => ({ text: e.text, turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  expect('deny' in (await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(false)

  weekly = 99.1
  await $.turn.start({ text: 'more work', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  expect('deny' in (await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(true)
})
