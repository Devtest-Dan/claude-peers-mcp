# claude-peers — Shared Workspace for Claude Code Instances

## What This Is

A shared workspace that lets multiple Claude Code instances coordinate across machines via a central broker. Provides 17 MCP tools: peer discovery, messaging, shared task board, context store, file locks, and task delegation.

## Installation Instructions for Claude

When a user asks you to "install claude-peers", "set up claude-peers", or gives you this repo link, follow these steps exactly on their machine.

### Prerequisites Check

Run these first to verify what's available:
```bash
which bun 2>/dev/null && bun --version || echo "NEED_BUN"
which claude 2>/dev/null && claude --version || echo "NEED_CLAUDE"
which git 2>/dev/null || echo "NEED_GIT"
```

### Automated Setup (Preferred)

**On Windows (cmd or PowerShell):**
```cmd
git clone https://github.com/Devtest-Dan/claude-peers-mcp.git %USERPROFILE%\claude-peers-mcp && %USERPROFILE%\claude-peers-mcp\join.bat
```

**On Mac/Linux/Git Bash:**
```bash
bash <(curl -sL https://raw.githubusercontent.com/Devtest-Dan/claude-peers-mcp/main/join.sh)
```

The script handles everything: installs bun, clones repo, installs deps, registers MCP server, sets env vars, creates the `claude-peers` launch command, and tests the broker connection.

### Manual Setup (If Scripts Fail)

If the automated scripts don't work on the user's system, do these steps manually:

**Step 1 — Install Bun:**
```bash
npm install -g bun
```

**Step 2 — Clone and install:**
```bash
git clone https://github.com/Devtest-Dan/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp && bun install
```
Windows path: `%USERPROFILE%\claude-peers-mcp`

**Step 3 — Register MCP server with Claude Code:**
```bash
claude mcp remove --scope user claude-peers 2>/dev/null || true
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```
Windows: use full path `bun %USERPROFILE%\claude-peers-mcp\server.ts`

**Step 4 — Set environment variables:**

The user needs to know the broker host IP. Ask them: "What's the broker host IP address?"

Mac/Linux — add to `~/.bashrc` or `~/.zshrc`:
```bash
export CLAUDE_PEERS_HOST=<BROKER_IP>
export CLAUDE_PEERS_PORT=7899
alias claude-peers="claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers"
```

Windows — set permanently and create launcher:
```cmd
setx CLAUDE_PEERS_HOST "<BROKER_IP>"
setx CLAUDE_PEERS_PORT "7899"
```
Then create `%USERPROFILE%\AppData\Local\Microsoft\WindowsApps\claude-peers.cmd`:
```cmd
@echo off
set "CLAUDE_PEERS_HOST=<BROKER_IP>"
set "CLAUDE_PEERS_PORT=<BROKER_PORT>"
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers %*
```

**Step 5 — Verify:**
```bash
curl -s http://<BROKER_IP>:7899/health
```
Should return JSON with `"status":"ok"`.

**Step 6 — Tell the user:** "Open a new terminal and type `claude-peers` to connect."

### Broker Host Setup

If the user wants to HOST the broker (not just join):

```bash
# Start broker in LAN mode (accessible from other machines)
CLAUDE_PEERS_BIND=lan bun ~/claude-peers-mcp/broker.ts

# Windows auto-start service (runs on logon, hidden window):
# Run install-service.bat from the repo directory
```

The broker's LAN IP is shown in the startup output. Share this IP with team members.

## Project Structure

```
broker.ts              Central broker daemon (HTTP + SQLite, one per network)
server.ts              MCP server (one per Claude Code session, connects to broker)
cli.ts                 CLI for inspecting workspace state
shared/types.ts        TypeScript interfaces for all API types
shared/summarize.ts    Auto-summary generation for peer context
join.sh / join.bat     One-command team setup scripts
setup.sh / setup.bat   Interactive setup with prompts
install-service.bat    Windows auto-start service installer
broker-launcher.vbs    Hidden-window launcher for the broker
```

## Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_PEERS_HOST` | `127.0.0.1` | Broker IP (set to broker machine's IP for remote) |
| `CLAUDE_PEERS_PORT` | `7899` | Broker port |
| `CLAUDE_PEERS_BIND` | `local` | Broker bind: `local` (127.0.0.1) or `lan` (0.0.0.0) |
| `CLAUDE_PEERS_SECRET` | — | Shared secret for authentication (optional) |
| `OPENAI_API_KEY` | — | Auto-summary via gpt-5.4-nano (optional) |

## Runtime: Bun (Not Node.js)

This project uses Bun exclusively. Key differences:

- `bun <file>` instead of `node <file>`
- `bun install` instead of `npm install`
- `bun test` instead of `jest`
- `bun:sqlite` for SQLite (not `better-sqlite3`)
- `Bun.serve()` for HTTP (not `express`)
- Bun auto-loads `.env` files (no dotenv needed)

## MCP Tools (17 Total)

**Peers:** list_peers, send_message, set_summary, check_messages
**Tasks:** create_task, list_tasks, claim_task, complete_task, update_task
**Context:** share_context, get_context, delete_context
**Locks:** lock_files, unlock_files, list_locks
**Delegation:** delegate_task, respond_delegation, list_delegations

## CLI Commands

```bash
bun cli.ts status              # broker overview
bun cli.ts peers               # list connected peers
bun cli.ts tasks [project]     # shared tasks
bun cli.ts context [project]   # shared context
bun cli.ts locks [project]     # file locks
bun cli.ts delegations         # delegations
bun cli.ts send <id> <msg>     # message a peer
bun cli.ts kill-broker         # stop broker
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `bun: command not found` | `npm install -g bun` |
| `claude: command not found` | Install Claude Code CLI |
| Broker not reachable | Check broker is running, check IP/port, check firewall |
| MCP server not connecting | Re-run `claude mcp add` step, restart Claude Code |
| Stale peers showing | They auto-clean after 60s, or restart broker |
| File locks stuck | They auto-release when the peer disconnects |
