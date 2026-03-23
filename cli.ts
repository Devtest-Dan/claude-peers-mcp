#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 * Supports LAN networking via CLAUDE_PEERS_HOST.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers (across LAN)
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

import os from "os";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_HOST = process.env.CLAUDE_PEERS_HOST ?? "127.0.0.1";
const BROKER_URL = `http://${BROKER_HOST}:${BROKER_PORT}`;
const SHARED_SECRET = process.env.CLAUDE_PEERS_SECRET ?? null;

function brokerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SHARED_SECRET) {
    headers["x-claude-peers-secret"] = SHARED_SECRET;
  }
  return headers;
}

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: brokerHeaders(),
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{
        status: string;
        hostname: string;
        lan_ip: string;
        bind: string;
        auth: string;
        peers: number;
      }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);
      console.log(`Broker host: ${health.hostname} (${health.lan_ip})`);
      console.log(`Bind: ${health.bind}`);
      console.log(`Auth: ${health.auth}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            hostname: string;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "network",
          hostname: os.hostname(),
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  [${p.hostname}]  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log(`Broker at ${BROKER_URL} is not running.`);
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          hostname: string;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "network",
        hostname: os.hostname(),
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const parts = [`${p.id}  [${p.hostname}]  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log(`Broker at ${BROKER_URL} is not running.`);
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    // Only works if broker is local
    if (BROKER_HOST !== "127.0.0.1" && BROKER_HOST !== "localhost") {
      console.error(`Cannot kill remote broker at ${BROKER_URL}. Stop it on the host machine.`);
      process.exit(1);
    }
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);

      // Cross-platform: find and kill process on the port
      const isWindows = process.platform === "win32";
      if (isWindows) {
        // Windows: use netstat to find PID
        const proc = Bun.spawnSync(["cmd", "/c", `netstat -ano | findstr :${BROKER_PORT} | findstr LISTENING`]);
        const output = new TextDecoder().decode(proc.stdout).trim();
        const lines = output.split("\n").filter((l) => l);
        const pids = new Set<string>();
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== "0") pids.add(pid);
        }
        for (const pid of pids) {
          Bun.spawnSync(["taskkill", "/F", "/PID", pid]);
        }
      } else {
        // Unix: use lsof
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder()
          .decode(proc.stdout)
          .trim()
          .split("\n")
          .filter((p) => p);
        for (const pid of pids) {
          process.kill(parseInt(pid), "SIGTERM");
        }
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI (LAN-enabled)

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers (across LAN)
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts kill-broker     Stop the local broker daemon

Environment:
  CLAUDE_PEERS_HOST    Broker host (default: 127.0.0.1)
  CLAUDE_PEERS_PORT    Broker port (default: 7899)
  CLAUDE_PEERS_SECRET  Shared secret for auth (optional)`);
}
