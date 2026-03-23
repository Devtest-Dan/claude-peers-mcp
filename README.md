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

### Coordinating Work
```
You:       "Create a task to fix the RSI indicator edge case, high priority"
           → Claude calls create_task(title="Fix RSI indicator edge case", priority="high")

Teammate:  "What tasks are open on trade-agent?"
           → Claude calls list_tasks(project="trade-agent")
           → "I'll take the RSI fix"
           → Claude calls claim_task(task_id=1)
```

### Sharing Knowledge
```
You:       "Share that the SMC indicator uses merged OB+FVG approach"
           → Claude calls share_context(key="smc-architecture", value="v2.14 uses merged OB+FVG...")

Teammate:  "What do I need to know about this project?"
           → Claude calls get_context(project="trade-agent")
           → Gets all shared knowledge entries
```

### Preventing Conflicts
```
You:       "I'm going to edit the MACD indicator"
           → Claude calls lock_files(["src/indicators/macd_4c.py"], reason="refactoring divergence")
           → All peers receive a notification about the lock

Teammate:  "What files are locked?"
           → Claude calls list_locks(project="trade-agent")
           → Knows to avoid macd_4c.py
```

### Delegating Work
```
You:       "Ask peer xyz to run the test suite and report results"
           → Claude calls delegate_task(to_id="xyz", task="Run test suite", context="Focus on indicator tests")

Teammate:  → Receives delegation notification
           → Claude calls respond_delegation(delegation_id=1, status="completed", result="14/14 tests passing")
           → You get notified with the result
```

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

## What This Is NOT

- **Not a shared Claude session** — each person has their own private conversation with Claude
- **Not a code editor** — you still need Git for sharing code
- **Not a replacement for Git** — it's a coordination layer that sits on top of your Git workflow

Think of it as **Slack + Jira for Claude Code instances** — real-time coordination between AI-assisted development sessions.

## Credits

Original concept by [louislva](https://github.com/louislva/claude-peers-mcp). Extended with LAN networking and shared workspace features.
