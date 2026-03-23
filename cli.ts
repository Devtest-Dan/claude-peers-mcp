#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the shared workspace.
 *
 * Usage:
 *   bun cli.ts status              — Broker status overview
 *   bun cli.ts peers               — List all peers
 *   bun cli.ts send <id> <msg>     — Send a message
 *   bun cli.ts tasks [project]     — List tasks
 *   bun cli.ts context [project]   — List shared context
 *   bun cli.ts locks [project]     — List file locks
 *   bun cli.ts delegations         — List delegations
 *   bun cli.ts kill-broker         — Stop the broker
 */

import os from "os";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_HOST = process.env.CLAUDE_PEERS_HOST ?? "127.0.0.1";
const BROKER_URL = `http://${BROKER_HOST}:${BROKER_PORT}`;
const SHARED_SECRET = process.env.CLAUDE_PEERS_SECRET ?? null;

function brokerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SHARED_SECRET) headers["x-claude-peers-secret"] = SHARED_SECRET;
  return headers;
}

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? { method: "POST", headers: brokerHeaders(), body: JSON.stringify(body) }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, { ...opts, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const h = await brokerFetch<any>("/health");
      console.log(`Broker: ${h.status}`);
      console.log(`URL: ${BROKER_URL}`);
      console.log(`Host: ${h.hostname} (${h.lan_ip})`);
      console.log(`Bind: ${h.bind} | Auth: ${h.auth}`);
      console.log(`Peers: ${h.peers} | Active tasks: ${h.tasks} | Locks: ${h.locks} | Pending delegations: ${h.delegations}`);

      if (h.peers > 0) {
        const peers = await brokerFetch<any[]>("/list-peers", { scope: "network", hostname: os.hostname(), cwd: "/", git_root: null });
        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  [${p.hostname}]  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch { console.log(`Broker at ${BROKER_URL} is not running.`); }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<any[]>("/list-peers", { scope: "network", hostname: os.hostname(), cwd: "/", git_root: null });
      if (peers.length === 0) { console.log("No peers."); break; }
      for (const p of peers) {
        console.log(`${p.id}  [${p.hostname}]  PID:${p.pid}  ${p.cwd}`);
        if (p.summary) console.log(`  Summary: ${p.summary}`);
      }
    } catch { console.log(`Broker at ${BROKER_URL} is not running.`); }
    break;
  }

  case "send": {
    const toId = process.argv[3], msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) { console.error("Usage: bun cli.ts send <peer-id> <message>"); process.exit(1); }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", { from_id: "cli", to_id: toId, text: msg });
      console.log(result.ok ? `Sent to ${toId}` : `Failed: ${result.error}`);
    } catch (e) { console.error(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    break;
  }

  case "tasks": {
    const project = process.argv[3];
    try {
      const tasks = await brokerFetch<any[]>("/tasks/list", { project, status: undefined });
      if (tasks.length === 0) { console.log("No tasks."); break; }
      const icons: Record<string, string> = { critical: "!!!", high: "!!", medium: "!", low: "." };
      for (const t of tasks) {
        console.log(`#${t.id} [${t.status}] ${icons[t.priority] || ""} ${t.title}  (${t.project})`);
        if (t.claimed_by) console.log(`   Claimed: ${t.claimed_by_hostname}:${t.claimed_by}`);
        if (t.description) console.log(`   ${t.description}`);
      }
    } catch { console.log(`Broker at ${BROKER_URL} is not running.`); }
    break;
  }

  case "context": {
    const project = process.argv[3];
    try {
      const entries = await brokerFetch<any[]>("/context/get", { project });
      if (entries.length === 0) { console.log("No shared context."); break; }
      for (const e of entries) {
        console.log(`[${e.project}] ${e.key} (id:${e.id}, by ${e.shared_by_hostname})`);
        console.log(`  ${e.value}`);
        console.log();
      }
    } catch { console.log(`Broker at ${BROKER_URL} is not running.`); }
    break;
  }

  case "locks": {
    const project = process.argv[3];
    try {
      const locks = await brokerFetch<any[]>("/locks/list", { project });
      if (locks.length === 0) { console.log("No file locks."); break; }
      for (const l of locks) {
        console.log(`${l.file_path}  locked by ${l.locked_by_hostname}:${l.locked_by}  (${l.reason})`);
      }
    } catch { console.log(`Broker at ${BROKER_URL} is not running.`); }
    break;
  }

  case "delegations": {
    try {
      // Show all delegations (no peer filter from CLI)
      const all = await brokerFetch<any[]>("/delegate/list", { peer_id: "cli", direction: "all" });
      if (all.length === 0) { console.log("No delegations."); break; }
      for (const d of all) {
        console.log(`#${d.id} [${d.status}] ${d.from_hostname}:${d.from_id} → ${d.to_hostname}:${d.to_id}`);
        console.log(`  Task: ${d.task}`);
        if (d.result) console.log(`  Result: ${d.result}`);
      }
    } catch { console.log(`Broker at ${BROKER_URL} is not running.`); }
    break;
  }

  case "kill-broker": {
    if (BROKER_HOST !== "127.0.0.1" && BROKER_HOST !== "localhost") {
      console.error(`Cannot kill remote broker at ${BROKER_URL}.`); process.exit(1);
    }
    try {
      const h = await brokerFetch<any>("/health");
      console.log(`Broker has ${h.peers} peer(s). Shutting down...`);
      const isWindows = process.platform === "win32";
      if (isWindows) {
        const proc = Bun.spawnSync(["cmd", "/c", `netstat -ano | findstr :${BROKER_PORT} | findstr LISTENING`]);
        const output = new TextDecoder().decode(proc.stdout).trim();
        const pids = new Set<string>();
        for (const line of output.split("\n").filter((l) => l)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== "0") pids.add(pid);
        }
        for (const pid of pids) Bun.spawnSync(["taskkill", "/F", "/PID", pid]);
      } else {
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder().decode(proc.stdout).trim().split("\n").filter((p) => p);
        for (const pid of pids) process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch { console.log("Broker is not running."); }
    break;
  }

  default:
    console.log(`claude-peers CLI (shared workspace)

Usage:
  bun cli.ts status              Broker status overview
  bun cli.ts peers               List all peers (across LAN)
  bun cli.ts send <id> <msg>     Send a message to a peer
  bun cli.ts tasks [project]     List shared tasks
  bun cli.ts context [project]   List shared context
  bun cli.ts locks [project]     List file locks
  bun cli.ts delegations         List delegations
  bun cli.ts kill-broker         Stop the local broker

Environment:
  CLAUDE_PEERS_HOST    Broker host (default: 127.0.0.1)
  CLAUDE_PEERS_PORT    Broker port (default: 7899)
  CLAUDE_PEERS_SECRET  Shared secret for auth (optional)`);
}
