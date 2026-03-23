#!/usr/bin/env bash
# ============================================================
# claude-peers: One-command team setup
#
# Run this ONCE and you're connected forever:
#   curl -sL https://raw.githubusercontent.com/Devtest-Dan/claude-peers-mcp/main/join.sh | bash
# ============================================================

set -e

REPO_URL="https://github.com/Devtest-Dan/claude-peers-mcp.git"
INSTALL_DIR="$HOME/claude-peers-mcp"
BROKER_HOST="100.111.71.83"
BROKER_PORT="7899"

G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m' R='\033[0;31m' N='\033[0m'

echo ""
echo -e "${C}========================================${N}"
echo -e "${C}  claude-peers — team setup${N}"
echo -e "${C}========================================${N}"
echo ""

# 1. Bun
if ! command -v bun &>/dev/null; then
  echo -e "${Y}Installing bun...${N}"
  if command -v npm &>/dev/null; then npm install -g bun
  else curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"
  fi
fi
echo -e "${G}[ok]${N} bun $(bun --version)"

# 2. Clone/update
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR" && git pull --ff-only origin main 2>/dev/null || true
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR" && bun install --silent 2>/dev/null || bun install
echo -e "${G}[ok]${N} repo ready"

# 3. Claude Code check
if ! command -v claude &>/dev/null; then
  echo -e "${R}[error]${N} Claude Code CLI not found."
  echo "  Install: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi
echo -e "${G}[ok]${N} claude found"

# 4. Register MCP server
claude mcp remove --scope user claude-peers 2>/dev/null || true
claude mcp add --scope user --transport stdio claude-peers -- bun "$INSTALL_DIR/server.ts"
echo -e "${G}[ok]${N} MCP server registered"

# 5. Set env vars
SHELL_RC=""
[ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
[ -f "$HOME/.bashrc" ] && SHELL_RC="$HOME/.bashrc"
[ -z "$SHELL_RC" ] && [ -f "$HOME/.bash_profile" ] && SHELL_RC="$HOME/.bash_profile"

if [ -n "$SHELL_RC" ]; then
  # Clean old entries
  sed -i '/# claude-peers/d' "$SHELL_RC" 2>/dev/null || true
  sed -i '/CLAUDE_PEERS_HOST/d' "$SHELL_RC" 2>/dev/null || true
  sed -i '/CLAUDE_PEERS_PORT/d' "$SHELL_RC" 2>/dev/null || true
  sed -i '/CLAUDE_PEERS_SECRET/d' "$SHELL_RC" 2>/dev/null || true
  sed -i '/alias claude-peers=/d' "$SHELL_RC" 2>/dev/null || true

  cat >> "$SHELL_RC" << 'ENVBLOCK'

# claude-peers LAN config
export CLAUDE_PEERS_HOST=100.111.71.83
export CLAUDE_PEERS_PORT=7899
alias claude-peers="claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers"
ENVBLOCK

  echo -e "${G}[ok]${N} env vars + alias added to $SHELL_RC"
fi

# Also export for current session
export CLAUDE_PEERS_HOST="$BROKER_HOST"
export CLAUDE_PEERS_PORT="$BROKER_PORT"

# 6. Test broker
echo ""
echo -e "${C}Testing broker connection...${N}"
if curl -s --connect-timeout 3 "http://$BROKER_HOST:$BROKER_PORT/health" >/dev/null 2>&1; then
  echo -e "${G}[ok]${N} Broker is reachable!"
else
  echo -e "${Y}[warn]${N} Broker not reachable right now. It may be offline."
  echo "  It will connect automatically when the broker is running."
fi

echo ""
echo -e "${G}========================================${N}"
echo -e "${G}  Done! You're all set.${N}"
echo -e "${G}========================================${N}"
echo ""
echo "  Start a new terminal, then run:"
echo ""
echo -e "    ${C}claude-peers${N}"
echo ""
echo "  That's it. You're in the shared workspace."
echo ""
