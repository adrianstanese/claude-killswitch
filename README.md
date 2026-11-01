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

Above the prompt, a live band shows one bar each for the 5-hour and weekly limits: green under 70%, amber under 90%, red above. Each bar has a tick at the killswitch threshold, the percent, and a countdown to the reset.

| Command | Effect |
| --- | --- |
| `/killswitch` | re-arm at 99% |
| `/killswitch 95` | arm at another percent |
| `/killswitch status` | current readings and state |
| `/killswitch off` | disarm for this session, and lift a stop early |
| `/killswitch bar` | show or hide the usage bar |

The limit figures come from Claude Code's own rate-limit readings, which update after each API response. The response that crosses the threshold has already been used, so the stop happens right after it.

Requires a Claude subscription (the 5-hour and weekly limits are not reported for API-key use). Snapshots need the session's working directory to be a git repository; without one, only the resume note is written.

## Licence

MIT
