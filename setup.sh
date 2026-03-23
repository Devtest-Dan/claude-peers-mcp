#!/usr/bin/env bash
# ============================================================
# claude-peers LAN setup script
#
# Run this on any machine to join the claude-peers network.
# Usage:
#   curl -sL https://raw.githubusercontent.com/Devtest-Dan/claude-peers-mcp/main/setup.sh | bash
#   — or —
#   bash setup.sh
#
# For the broker host (Daniel's machine), run with:
#   bash setup.sh --broker
# ============================================================

set -e

# --- Configuration ---
REPO_URL="https://github.com/Devtest-Dan/claude-peers-mcp.git"
INSTALL_DIR="$HOME/claude-peers-mcp"
DEFAULT_BROKER_HOST="100.111.71.83"  # Daniel's Tailscale IP
DEFAULT_PORT="7899"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[info]${NC} $1"; }
ok()    { echo -e "${GREEN}[ok]${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
fail()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

IS_BROKER=false
BROKER_HOST=""
SHARED_SECRET=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --broker)    IS_BROKER=true; shift ;;
    --host)      BROKER_HOST="$2"; shift 2 ;;
    --secret)    SHARED_SECRET="$2"; shift 2 ;;
    --port)      DEFAULT_PORT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bash setup.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --broker         Set up this machine as the broker host"
      echo "  --host <ip>      Broker IP address (default: $DEFAULT_BROKER_HOST)"
      echo "  --secret <key>   Shared secret for authentication"
      echo "  --port <port>    Broker port (default: $DEFAULT_PORT)"
      echo "  --help           Show this help"
      exit 0
      ;;
    *) fail "Unknown option: $1" ;;
  esac
done

echo ""
echo "============================================"
echo "  claude-peers LAN Setup"
echo "============================================"
echo ""

# --- Step 1: Check/install bun ---
info "Checking for bun..."
if command -v bun &>/dev/null; then
  ok "bun $(bun --version) already installed"
else
  info "Installing bun..."
  if command -v npm &>/dev/null; then
    npm install -g bun
    ok "bun installed via npm"
  elif command -v curl &>/dev/null; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    ok "bun installed via official installer"
  else
    fail "Neither npm nor curl found. Install bun manually: https://bun.sh"
  fi
fi

# --- Step 2: Clone or update repo ---
info "Setting up claude-peers-mcp..."
if [ -d "$INSTALL_DIR" ]; then
  info "Repo exists, pulling latest..."
  cd "$INSTALL_DIR"
  git pull --ff-only origin main 2>/dev/null || warn "Could not pull latest (offline or diverged)"
else
  info "Cloning repository..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
ok "Repository ready at $INSTALL_DIR"

# --- Step 3: Install dependencies ---
info "Installing dependencies..."
cd "$INSTALL_DIR"
bun install --silent 2>/dev/null || bun install
ok "Dependencies installed"

# --- Step 4: Check Claude Code ---
info "Checking for Claude Code..."
if command -v claude &>/dev/null; then
  CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
  ok "Claude Code found: $CLAUDE_VERSION"
else
  warn "Claude Code CLI not found. Install it before using claude-peers."
  warn "See: https://docs.anthropic.com/en/docs/claude-code"
fi

# --- Step 5: Register MCP server ---
info "Registering claude-peers MCP server..."
if command -v claude &>/dev/null; then
  # Remove existing registration if any
  claude mcp remove --scope user claude-peers 2>/dev/null || true
  claude mcp add --scope user --transport stdio claude-peers -- bun "$INSTALL_DIR/server.ts"
  ok "MCP server registered"
else
  warn "Skipping MCP registration (Claude Code not installed)"
  echo "  Run this manually later:"
  echo "  claude mcp add --scope user --transport stdio claude-peers -- bun $INSTALL_DIR/server.ts"
fi

# --- Step 6: Configure environment ---
if [ "$IS_BROKER" = true ]; then
  # Broker host setup
  info "Configuring as BROKER HOST..."

  # Detect LAN IP
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig 2>/dev/null | grep -oP 'IPv4.*: \K[\d.]+' | head -1 || echo "unknown")

  echo ""
  ok "Broker host configured!"
  echo ""
  echo "  Start the broker with:"
  echo ""
  if [ -n "$SHARED_SECRET" ]; then
    echo "    CLAUDE_PEERS_BIND=lan CLAUDE_PEERS_SECRET=$SHARED_SECRET bun $INSTALL_DIR/broker.ts"
  else
    echo "    CLAUDE_PEERS_BIND=lan bun $INSTALL_DIR/broker.ts"
  fi
  echo ""
  echo "  Your LAN IP: $LAN_IP"
  echo "  Tell team members to run:"
  echo "    bash setup.sh --host $LAN_IP"
  if [ -n "$SHARED_SECRET" ]; then
    echo "    (with --secret $SHARED_SECRET)"
  fi

else
  # Client setup — configure to point to broker
  if [ -z "$BROKER_HOST" ]; then
    echo ""
    read -p "  Broker host IP [$DEFAULT_BROKER_HOST]: " input_host
    BROKER_HOST="${input_host:-$DEFAULT_BROKER_HOST}"
  fi

  if [ -z "$SHARED_SECRET" ]; then
    echo ""
    read -p "  Shared secret (press Enter to skip): " input_secret
    SHARED_SECRET="${input_secret:-}"
  fi

  # Build the env lines
  ENV_LINES="export CLAUDE_PEERS_HOST=$BROKER_HOST"
  ENV_LINES="$ENV_LINES\nexport CLAUDE_PEERS_PORT=$DEFAULT_PORT"
  if [ -n "$SHARED_SECRET" ]; then
    ENV_LINES="$ENV_LINES\nexport CLAUDE_PEERS_SECRET=$SHARED_SECRET"
  fi

  # Detect shell config file
  SHELL_RC=""
  if [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_RC="$HOME/.bash_profile"
  fi

  if [ -n "$SHELL_RC" ]; then
    echo ""
    read -p "  Add env vars to $SHELL_RC? [Y/n]: " add_to_rc
    if [[ "${add_to_rc:-Y}" =~ ^[Yy] ]]; then
      # Remove old entries
      sed -i '/# claude-peers/d' "$SHELL_RC" 2>/dev/null || true
      sed -i '/CLAUDE_PEERS_HOST/d' "$SHELL_RC" 2>/dev/null || true
      sed -i '/CLAUDE_PEERS_PORT/d' "$SHELL_RC" 2>/dev/null || true
      sed -i '/CLAUDE_PEERS_SECRET/d' "$SHELL_RC" 2>/dev/null || true

      echo "" >> "$SHELL_RC"
      echo "# claude-peers LAN config" >> "$SHELL_RC"
      echo -e "$ENV_LINES" >> "$SHELL_RC"
      ok "Environment variables added to $SHELL_RC"
      warn "Run 'source $SHELL_RC' or open a new terminal for changes to take effect"
    fi
  fi
fi

# --- Step 7: Create launch alias ---
echo ""
info "Creating launch alias..."
ALIAS_CMD='alias claude-peers="claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers"'

if [ -n "$SHELL_RC" ]; then
  # Remove old alias
  sed -i '/alias claude-peers=/d' "$SHELL_RC" 2>/dev/null || true
  echo "$ALIAS_CMD" >> "$SHELL_RC"
  ok "Alias 'claude-peers' added to $SHELL_RC"
fi

# --- Done ---
echo ""
echo "============================================"
echo -e "  ${GREEN}Setup complete!${NC}"
echo "============================================"
echo ""
echo "  Launch Claude Code with peers:"
echo "    claude-peers"
echo "  — or —"
echo "    claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers"
echo ""
echo "  Check broker status:"
echo "    bun $INSTALL_DIR/cli.ts status"
echo ""
echo "  List peers:"
echo "    bun $INSTALL_DIR/cli.ts peers"
echo ""

if [ "$IS_BROKER" = false ]; then
  # Test broker connection
  info "Testing broker connection at $BROKER_HOST:$DEFAULT_PORT..."
  if curl -s --connect-timeout 3 "http://$BROKER_HOST:$DEFAULT_PORT/health" >/dev/null 2>&1; then
    HEALTH=$(curl -s "http://$BROKER_HOST:$DEFAULT_PORT/health")
    ok "Broker is reachable! $HEALTH"
  else
    warn "Broker at $BROKER_HOST:$DEFAULT_PORT is not reachable."
    warn "Make sure the broker is running on the host machine."
  fi
fi
