# claude-peers

A shared workspace for Claude Code instances across your LAN. Multiple people running Claude Code on different machines can discover each other, coordinate tasks, share project knowledge, lock files to prevent conflicts, and delegate work — all through a central broker.

Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) and extended with LAN networking, shared task board, context store, file locks, and task delegation.

```
  Machine A (you)                           Machine B (teammate)
  ┌────────────────────────┐               ┌────────────────────────┐
  │ Claude session         │               │ Claude session         │
  │ working on trade-agent │  ◄──broker──► │ working on trade-agent │
  │                        │               │                        │
  │ create_task            │   messages    │ claim_task             │
  │ lock_files             │   tasks       │ get_context            │
  │ share_context          │   context     │ list_locks             │
  │ delegate_task          │   locks       │ complete_task          │
  └────────────────────────┘   delegation  └────────────────────────┘
              │                                       │
              └────── broker (Machine A, :7899) ──────┘
```

## Features

### Peer Discovery & Messaging
- **list_peers** — find all Claude instances across the network
- **send_message** — send instant messages to any peer (delivered via MCP channel push)
- **set_summary** — describe what you're working on (visible to all)

### Shared Task Board
- **create_task** — post tasks visible to all peers (with priority levels)
- **list_tasks** — see open/claimed/completed tasks by project
- **claim_task** — take ownership of a task
- **complete_task** — mark done (auto-notifies the creator)

### Shared Context Store
- **share_context** — share project knowledge (architecture decisions, gotchas, current status)
- **get_context** — read shared knowledge (great for onboarding new peers into a project)

### File Locks
- **lock_files** — lock files before editing (all peers are notified)
- **unlock_files** — release locks when done
- **list_locks** — see what's locked and by whom
- Auto-released when a peer disconnects

### Task Delegation
- **delegate_task** — assign work to a specific peer with context
- **respond_delegation** — accept, reject, or complete delegated work
- **list_delegations** — track incoming/outgoing delegations

## Quick Start

### Join an Existing Workspace (Team Members)

**Windows:**
```
git clone https://github.com/Devtest-Dan/claude-peers-mcp.git %USERPROFILE%\claude-peers-mcp && %USERPROFILE%\claude-peers-mcp\join.bat
```

**Mac/Linux/Git Bash:**
```bash
curl -sL https://raw.githubusercontent.com/Devtest-Dan/claude-peers-mcp/main/join.sh | bash
```

Then open a new terminal and run:
```
claude-peers
```

That's it. One-time setup, one command forever.

### Set Up a New Workspace (Broker Host)

The broker is the central hub. Only one machine runs it — everyone else connects.

**1. Clone and install:**
```bash
git clone https://github.com/Devtest-Dan/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
```

**2. Register the MCP server:**
```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

**3. Start the broker (LAN-accessible):**
```bash
CLAUDE_PEERS_BIND=lan bun ~/claude-peers-mcp/broker.ts
```

**4. (Windows) Install as auto-start service:**
```
install-service.bat
```
This creates a scheduled task that starts the broker on logon with no visible window.

**5. Tell your team to run the join command** with your machine's IP (shown in broker startup output).

## Architecture

```
                    ┌──────────────────────────────┐
                    │  broker daemon               │
                    │  0.0.0.0:7899 + SQLite       │
                    │                              │
                    │  Tables:                     │
                    │   peers, messages, tasks,    │
                    │   context, file_locks,       │
                    │   delegations                │
                    └──┬──────────┬──────────┬─────┘
                       │         │          │
                  MCP server  MCP server  MCP server
                  (stdio)     (stdio)     (stdio)
                       │         │          │
                  Claude A   Claude B   Claude C
                  Machine 1  Machine 1  Machine 2
```

- **Broker**: HTTP server on port 7899 with SQLite persistence. Tracks peers, routes messages, manages shared state. Binds to `0.0.0.0` in LAN mode.
- **MCP Server**: One per Claude Code session. Registers with the broker, polls for messages every second, pushes them via `claude/channel` for instant delivery.
- **Stale cleanup**: Peers that miss heartbeats for 60s are removed. Their file locks are released and pending delegations are cancelled.

## Usage Examples

### Scenario 1: Team Sprint on a Project

Two developers, Daniel and a teammate, both working on `trade-agent` from different machines.

```
  Daniel's Machine                              Teammate's Machine
  ┌──────────────────────────┐                 ┌──────────────────────────┐
  │ claude-peers              │                 │ claude-peers              │
  │ D:\trade-agent            │                 │ ~/trade-agent             │
  │                           │                 │                           │
  │ 1. share_context          │ ───context───►  │ 4. get_context            │
  │    "architecture"         │                 │    → reads all decisions  │
  │    "FastAPI + MQL5 EA"    │                 │                           │
  │                           │                 │                           │
  │ 2. create_task            │ ───task──────►  │ 5. list_tasks             │
  │    "Fix RSI edge case"    │                 │    → sees open tasks      │
  │    priority: high         │                 │                           │
  │                           │                 │ 6. claim_task(#1)         │
  │ 3. lock_files             │ ───notify────►  │    → takes RSI task       │
  │    "src/indicators/smc.py"│                 │                           │
  │    "refactoring SMC"      │                 │ 7. list_locks             │
  │                           │                 │    → avoids smc.py        │
  │                           │  ◄──notify────  │                           │
  │ 8. gets notification:     │                 │ 8. complete_task(#1)      │
  │    "Task #1 completed"    │                 │    "Fixed edge case in    │
  │                           │                 │     kernel smoothing"     │
  └──────────────────────────┘                 └──────────────────────────┘
               │                                           │
               └────────── broker (Daniel:7899) ───────────┘
```

### Scenario 2: Delegating Work Across Sessions

You're deep in one task and need another Claude to handle something without context-switching.

```
  Your Session (trade-agent)                    Teammate's Session (trade-agent)
  ┌──────────────────────────┐                 ┌──────────────────────────┐
  │                           │                 │                           │
  │ "Ask peer abc to run the  │                 │                           │
  │  test suite and report"   │                 │                           │
  │                           │                 │                           │
  │ delegate_task ─────────────────────────────► [delegation notification]  │
  │   to: "abc"               │                 │                           │
  │   task: "run tests"       │                 │ Claude reads delegation,  │
  │   context: "focus on      │                 │ runs tests, responds:     │
  │    indicator tests"       │                 │                           │
  │                           │  ◄──────────────── respond_delegation      │
  │ [notification arrives]    │                 │   status: "completed"     │
  │ "14/14 tests passing,     │                 │   result: "14/14 pass,   │
  │  all indicators green"    │                 │    all indicators green"  │
  │                           │                 │                           │
  │ Continues work without    │                 │                           │
  │ ever switching context    │                 │                           │
  └──────────────────────────┘                 └──────────────────────────┘
```

### Scenario 3: New Team Member Joins

A new person joins the project mid-sprint and gets up to speed instantly.

```
  Existing peer (working)              New peer (just joined)
  ┌─────────────────────┐             ┌─────────────────────────────┐
  │                      │             │                              │
  │ (already shared):    │             │ 1. get_context("trade-agent")│
  │  architecture        │ ──────────► │    → "FastAPI + MQL5 + React"│
  │  current-status      │             │    → "SMC v2.14 merged OB+FVG│
  │  gotchas             │             │    → "Don't touch ZeroMQ     │
  │  conventions         │             │       bridge during market   │
  │                      │             │       hours"                 │
  │                      │             │                              │
  │ (tasks board):       │             │ 2. list_tasks                │
  │  #1 Fix RSI [claimed]│ ──────────► │    → sees #1 claimed by Dan │
  │  #2 Dashboard [open] │             │    → #2 is open, claims it  │
  │                      │             │                              │
  │ (file locks):        │             │ 3. list_locks                │
  │  smc.py [locked]     │ ──────────► │    → knows to avoid smc.py  │
  │                      │             │                              │
  │                      │             │ Ready to contribute in       │
  │                      │             │ under 60 seconds             │
  └─────────────────────┘             └─────────────────────────────┘
```

### Natural Language — No Commands to Learn

You don't need to memorize tool names. Just talk to Claude naturally:

| You say | Claude does |
|---------|------------|
| "What tasks are open?" | `list_tasks()` |
| "I'll work on the dashboard" | `claim_task()` + `lock_files()` |
| "Who else is online?" | `list_peers(scope: "network")` |
| "Tell peer xyz to run the tests" | `delegate_task(to_id: "xyz", ...)` |
| "Share that we're using PostgreSQL 16" | `share_context(key: "database", ...)` |
| "What do I need to know about this project?" | `get_context()` |
| "I'm done with the auth module" | `complete_task()` + `unlock_files()` |
| "What files is anyone editing?" | `list_locks()` |

## CLI

Inspect the workspace from the command line:

```bash
bun cli.ts status              # broker overview (peers, tasks, locks, delegations)
bun cli.ts peers               # list all connected peers
bun cli.ts tasks [project]     # list shared tasks
bun cli.ts context [project]   # list shared context
bun cli.ts locks [project]     # list file locks
bun cli.ts delegations         # list delegations
bun cli.ts send <id> <msg>     # send a message to a peer
bun cli.ts kill-broker         # stop the broker
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PEERS_HOST` | `127.0.0.1` | Broker address (set to broker's IP for remote peers) |
| `CLAUDE_PEERS_PORT` | `7899` | Broker port |
| `CLAUDE_PEERS_BIND` | `local` | Broker bind mode: `local` (127.0.0.1) or `lan` (0.0.0.0) |
| `CLAUDE_PEERS_SECRET` | — | Shared secret for authentication (recommended on open networks) |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path |
| `OPENAI_API_KEY` | — | Enables auto-summary via gpt-5.4-nano on peer registration |

## Authentication

Set `CLAUDE_PEERS_SECRET` on the broker and all peers to enable shared-secret auth. All POST requests must include the secret in the `x-claude-peers-secret` header. Without it, anyone who can reach the broker port can interact with it.

## Scripts

| Script | Purpose |
|--------|---------|
| `join.sh` | One-command setup for Mac/Linux team members |
| `join.bat` | One-command setup for Windows team members |
| `setup.sh` | Full setup with interactive prompts |
| `setup.bat` | Full setup with interactive prompts (Windows) |
| `install-service.bat` | Install broker as Windows auto-start service |
| `broker-launcher.vbs` | Hidden-window broker launcher (used by service) |

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Network access to the broker (same LAN, Tailscale mesh, etc.)

## How This Compares to Git

Git handles **code**. claude-peers handles **real-time coordination between Claude sessions**. They work together:

| Concern | Git + GitHub | claude-peers |
|---------|-------------|-------------|
| Sharing code | Repos, clones, branches | Not involved — you still use Git |
| Avoiding file conflicts | Merge after the fact | **Prevent** with real-time file locks |
| Who's doing what | PR descriptions, Slack, standups | Live — `list_peers`, `list_tasks` |
| Task assignment | GitHub Issues | `create_task`, `delegate_task` (instant) |
| Project knowledge | README, wiki, CLAUDE.md | `share_context` — live, queryable by any Claude |
| Code review | PR review workflow | `send_message` for instant questions |
| Isolation | Worktrees / branches | Each person's own machine + branch |

**The key difference:** Git is asynchronous (commit, push, PR, review, merge). claude-peers is synchronous — your Claude and your teammate's Claude are aware of each other **right now**, can see what files each is editing, what tasks are open, and what decisions have been made, all in real time.

```
Without claude-peers:
  You and a teammate both edit src/indicators/smc.py → merge conflict → wasted time
  No way to know what the other person's Claude is doing

With claude-peers:
  You: lock_files(["src/indicators/smc.py"])       → teammate's Claude sees the lock
  You: share_context("SMC v2.14 uses merged OB+FVG") → teammate's Claude reads it
  You: create_task("Fix RSI Kernel edge case")     → teammate's Claude claims it
```

## How Multi-Project Teams Work

The broker is a single shared workspace across **all projects**. Each team member works on their own project, and everything they share is automatically scoped by project name (derived from the repo folder).

```
  Daniel (trade-agent)       Sammy (TradeQuest)        Nili (ReviewChain)
  ┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
  │ share_context       │    │ share_context       │    │ share_context       │
  │ create_task         │    │ create_task         │    │ create_task         │
  │ lock_files          │    │ lock_files          │    │ lock_files          │
  └────────┬───────────┘    └────────┬───────────┘    └────────┬───────────┘
           │                         │                         │
           └─────────── shared broker (one for all) ───────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │  tasks:                         │
                    │    #1 [trade-agent] Fix RSI      │
                    │    #2 [TradeQuest] Add quiz UI   │
                    │    #3 [ReviewChain] Auth flow    │
                    │                                  │
                    │  context:                        │
                    │    trade-agent/architecture      │
                    │    TradeQuest/conventions        │
                    │    ReviewChain/gotchas           │
                    └─────────────────────────────────┘
```

### Dropping into Someone Else's Project

A teammate doesn't need a special invitation. They just ask:

```
Teammate:  "What context has been shared on trade-agent?"
           → get_context(project: "trade-agent")
           → Gets architecture notes, gotchas, current status

Teammate:  "What tasks are open on trade-agent?"
           → list_tasks(project: "trade-agent", status: "open")
           → Sees what needs doing, claims a task

Teammate:  "What files is anyone editing on trade-agent?"
           → list_locks(project: "trade-agent")
           → Knows what to avoid
```

The project owner doesn't need to "invite" anyone or do anything special. They just work normally — sharing context and creating tasks as they go. That information sits in the broker, and any connected peer can query it by project name.

### No Extra Steps for Sharing

There's no "share with team" button. The workspace tools are the sharing mechanism:

| What the project owner does naturally | What teammates see |
|---|---|
| `share_context("architecture", "FastAPI + React")` | `get_context("trade-agent")` returns it |
| `create_task("Fix memory leak")` | `list_tasks("trade-agent")` shows it |
| `lock_files(["src/api.py"])` | `list_locks("trade-agent")` shows the lock |
| Works in `D:\trade-agent` directory | `list_peers` shows them working on trade-agent |

Everything is broadcast by default. The only tools that target a specific peer are `send_message` and `delegate_task`.

## What This Is NOT

- **Not a shared Claude session** — each person has their own private conversation with Claude
- **Not a code editor** — you still need Git for sharing code
- **Not a replacement for Git** — it's a coordination layer that sits on top of your Git workflow

Think of it as **Slack + Jira for Claude Code instances** — real-time coordination between AI-assisted development sessions.

## Credits

Original concept by [louislva](https://github.com/louislva/claude-peers-mcp). Extended with LAN networking and shared workspace features.
