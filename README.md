# Software Factory

A local web app that takes messy work, such as Jira keys, pasted text, or screenshots, and turns it into a
batch of coding agents. You approve the batch on one screen before anything runs. Each agent works in
its own git worktree. Its work must pass the repo's own build and tests before it can be shipped as a
merge request or pull request.

The rule behind the design: **the model that schedules work never grades it.** A classifier sorts and
routes items. Whether code is done is decided by an objective gate (build and tests), and by you at
review time.

## How it works

1. **Intake.** Paste one or more items: Jira keys, free text, or images. Images get a vision pass that
   turns them into text. Jira issues are fetched read-only.
2. **Classify.** One structured-output call per item proposes a type, a target repo, an agent role, a
   model, a complexity score and dependencies. An item that is too vague becomes a question for you;
   it is not refused.
3. **Plan board.** The proposal appears as editable cards. Fix any field, split or drop a card, or
   leave a plain-text comment and have it re-planned. Nothing runs until you approve.
4. **Run.** Approved cards run in parallel, up to `maxParallel`. Each card gets an isolated worktree,
   limits on turns and cost, and a tool policy (no edits outside the worktree, no force-push). Cards
   that depend on another card wait their turn.
5. **Gate.** The gate passes when there are **no new failures against a baseline** measured on the
   base commit. A target whose suite is already red can still pass. Agents cannot report done while
   the gate is red.
6. **Ship and merge.** Shipping opens a merge request (`glab`) or pull request (`gh`). On `local`
   targets the branch stays local and nothing is pushed. Merging is always your action.

A collapsible **My Jira** panel lists open issues assigned to you. From there you can add an issue
to the board, dismiss it, or post a comment. The factory never transitions a Jira issue.

## Architecture

Ports and adapters, enforced by `test/architecture.test.ts`:

```
src/
  domain/        pure rules: board state, scheduling, path claims, routing, gate verdicts, tool policy
  application/   use cases (plan, run, publish, merge, triage) and the ports they depend on
  adapters/      Copilot SDK runtime + vision, Atlassian MCP/REST, git worktrees, glab/gh, shell gate, SQLite
  ui/web/        Node HTTP server + SSE, and a vanilla JS/HTML board
  main.ts        composition root and `npm start`
```

All state for batches, cards, turns and spend lives in a single SQLite file, `runs/factory.db`. It
survives crashes and restarts. Worktrees live under `runs/worktrees/`.

## Requirements

- Node.js **24+**. The app uses `node:sqlite` and runs TypeScript through `tsx`.
- A GitHub Copilot subscription, with the Copilot CLI logged in. Agents, classification and vision
  run on the [Copilot SDK](https://github.com/github/copilot-sdk).
- `git`, plus `glab` and/or `gh` authenticated for the targets you ship to.
- Optional: Jira. Issue reads and comments go through the Atlassian remote MCP, which uses a browser
  OAuth login on first use. Reading image attachments also needs `ATLASSIAN_EMAIL` and
  `ATLASSIAN_API_TOKEN` in the environment.

## Setup

```sh
npm ci
cp factory.config.example.json factory.config.json   # then edit targets, budgets and Jira site
npm start                                            # → http://localhost:4600
```

Targets can also be added from the UI, which inspects a local checkout and suggests a host, a base
branch and gate commands.

### Configuration

`factory.config.json` is gitignored. See `factory.config.example.json` for an example.

| Key | Meaning |
| --- | --- |
| `budget.perTurnUsd` / `perAgentUsd` / `perBatchUsd` | Spend ceilings. Hitting one stops that agent; the rest of the batch continues. |
| `budget.usdPerAiu` | Conversion rate for Copilot usage units. |
| `maxParallel`, `maxTurnsPerAgent` | Concurrency cap and per-agent turn cap. |
| `jira.site`, `jira.mcpUrl` | Your Atlassian site and the remote MCP endpoint. |
| `targets.<name>.repo` | Path to the main checkout (`~` is expanded). |
| `targets.<name>.host` | `github`, `gitlab` or `local`. |
| `targets.<name>.baseBranch` | Branch that work is cut from and shipped to. |
| `targets.<name>.setup` | Commands run once in a fresh worktree (installs, symlinks). |
| `targets.<name>.gate.quick` / `full` | Gate commands. `{repo}`, `{changedTests}` and `{changedSpecs}` are substituted. |

Environment overrides: `FACTORY_CONFIG`, `FACTORY_DB`, `FACTORY_PORT`.

## Development

```sh
npm test            # node:test suite
npm run typecheck   # tsc
```

The `smoke/` scripts (`npm run smoke`, `smoke:classify`, `smoke:intake`, `smoke:runner`,
`smoke:parallel`) exercise the real backends. They need working credentials and spend real usage.

## Status

An early, single-user tool that runs on localhost. It has no authentication and is not meant to be
exposed to a network.
