# killswitch

A usage killswitch and live usage bars for Claude Code.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install killswitch --marketplace adrianstanese/claude-killswitch
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell:

```bash
claude plugin install killswitch --marketplace adrianstanese/claude-killswitch
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `adrianstanese/claude-killswitch`, then Add plugin.

## What it does

A Claude Code mod. It arms itself at 99% in every session, with nothing to run. When the 5-hour or the weekly usage limit reaches 99%, the mod:

1. ends the running turn,
2. snapshots the working tree (tracked and untracked files) to `refs/killswitch/<time>` in the repo. It leaves your files, branch and index unchanged,
3. writes a resume note to `<cwd>/.claude/killswitch/<time>.md` with the limit, the reset time, the last request and the restore command,
4. blocks every tool call and every new prompt until the limit's reset time. After that it lifts the block by itself.

Above the prompt, two slim rails show the 5-hour and weekly limits: green under 70%, amber below the warning level, red above it, with the percent to one decimal, a tick at the killswitch threshold, the reset countdown, and a forecast such as "99% in ~1h 15m" from the last two hours' pace. Readings refresh after each turn and every 30 seconds.

Along the way to the stop:

- **Shared readings.** Every session writes its newest reading to the mod's store and reads the others', so all your sessions show the freshest figure, and when one reaches the threshold they all stop.
- **Warning** (90% by default): a one-time heads-up toast per limit and reset.
- **Wrap-up** (97% by default): Claude is told to finish the step it is on and keep a handoff note at `.claude/killswitch/HANDOFF.md`, so a stop never lands mid-thought.
- **Auto-resume** (on by default): when the limit resets, a session that was stopped mid-work continues by itself from the killswitch and handoff notes.
- **History**: the History button or `/killswitch history` opens a pane with each window's usage over its whole span, with the warning and stop levels marked.

| Command | Effect |
| --- | --- |
| `/killswitch` | re-arm at the configured threshold |
| `/killswitch 95` | arm at another percent for this session |
| `/killswitch status` | readings, forecast, state and settings |
| `/killswitch history` | open the usage history pane |
| `/killswitch off` | disarm for this session, and lift a stop early |
| `/killswitch bar` | show or hide the usage rails |

## Settings

Set in the plugin's settings (`/config` in a terminal session):

| Setting | Default |
| --- | --- |
| Stop at (%) | 99 |
| Warn at (%) | 90 |
| Ask Claude to wrap up at (%) | 97 |
| Resume automatically after the reset | on |

The limit figures come from Claude Code's own rate-limit readings, which update after each API response. The response that crosses the threshold has already been used, so the stop happens right after it.

Requires a Claude subscription (the 5-hour and weekly limits are not reported for API-key use). Snapshots need the session's working directory to be a git repository; without one, only the resume note is written.

## Licence

MIT
