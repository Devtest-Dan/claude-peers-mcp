#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server backed by SQLite.
 * Shared workspace for Claude Code instances across LAN.
 *
 * Features:
 *   - Peer discovery & messaging
 *   - Shared task board
 *   - Shared context store
 *   - File locks
 *   - Task delegation
 *
 * Environment variables:
 *   CLAUDE_PEERS_PORT    — Port to listen on (default: 7899)
 *   CLAUDE_PEERS_DB      — SQLite database path (default: ~/.claude-peers.db)
 *   CLAUDE_PEERS_SECRET  — Shared secret for LAN authentication (optional)
 *   CLAUDE_PEERS_BIND    — Bind address: "lan" (0.0.0.0) or "local" (127.0.0.1, default)
 */

import { Database } from "bun:sqlite";
import os from "os";
import type {
  RegisterRequest, RegisterResponse, HeartbeatRequest,
  SetSummaryRequest, ListPeersRequest, SendMessageRequest,
  PollMessagesRequest, PollMessagesResponse, Peer, Message,
  CreateTaskRequest, ListTasksRequest, ClaimTaskRequest,
  CompleteTaskRequest, UpdateTaskRequest, SharedTask,
  ShareContextRequest, GetContextRequest, DeleteContextRequest, ContextEntry,
  LockFilesRequest, UnlockFilesRequest, ListLocksRequest, FileLock,
  DelegateTaskRequest, RespondDelegationRequest, ListDelegationsRequest, Delegation,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME ?? process.env.USERPROFILE}/.claude-peers.db`;
const SHARED_SECRET = process.env.CLAUDE_PEERS_SECRET ?? null;
const BIND_MODE = process.env.CLAUDE_PEERS_BIND ?? "local";
const BIND_HOST = BIND_MODE === "lan" ? "0.0.0.0" : "127.0.0.1";
const STALE_TIMEOUT_MS = 60_000;

// ===================== DATABASE SETUP =====================

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

// --- Peers ---
db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    hostname TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);
try { db.run("ALTER TABLE peers ADD COLUMN hostname TEXT NOT NULL DEFAULT ''"); } catch {}

// --- Messages ---
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

// --- Shared Tasks ---
db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    created_by TEXT NOT NULL,
    created_by_hostname TEXT NOT NULL DEFAULT '',
    claimed_by TEXT,
    claimed_by_hostname TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )
`);

// --- Shared Context ---
db.run(`
  CREATE TABLE IF NOT EXISTS context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    shared_by TEXT NOT NULL,
    shared_by_hostname TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project, key)
  )
`);

// --- File Locks ---
db.run(`
  CREATE TABLE IF NOT EXISTS file_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    project TEXT NOT NULL,
    locked_by TEXT NOT NULL,
    locked_by_hostname TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    locked_at TEXT NOT NULL,
    UNIQUE(file_path, project)
  )
`);

// --- Delegations ---
db.run(`
  CREATE TABLE IF NOT EXISTS delegations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_hostname TEXT NOT NULL DEFAULT '',
    to_id TEXT NOT NULL,
    to_hostname TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// ===================== STALE CLEANUP =====================

function cleanStalePeers() {
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();
  const stale = db.query("SELECT id FROM peers WHERE last_seen < ?").all(cutoff) as { id: string }[];
  for (const peer of stale) {
    // Release file locks held by stale peer
    db.run("DELETE FROM file_locks WHERE locked_by = ?", [peer.id]);
    // Cancel pending delegations to stale peer
    db.run("UPDATE delegations SET status = 'rejected', updated_at = ? WHERE to_id = ? AND status = 'pending'",
      [new Date().toISOString(), peer.id]);
    db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
  }
  if (stale.length > 0) {
    console.error(`[broker] Cleaned ${stale.length} stale peer(s) + released their locks`);
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// ===================== AUTH =====================

function authenticate(req: Request): boolean {
  if (!SHARED_SECRET) return true;
  return req.headers.get("x-claude-peers-secret") === SHARED_SECRET;
}

// ===================== ID GENERATOR =====================

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ===================== PEER HANDLERS =====================

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const hostname = body.hostname || os.hostname();
  const existing = db.query("SELECT id FROM peers WHERE pid = ? AND hostname = ?").get(body.pid, hostname) as { id: string } | null;
  if (existing) db.run("DELETE FROM peers WHERE id = ?", [existing.id]);
  db.run(
    "INSERT INTO peers (id, pid, hostname, cwd, git_root, tty, summary, registered_at, last_seen) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, body.pid, hostname, body.cwd, body.git_root, body.tty, body.summary, now, now]
  );
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  db.run("UPDATE peers SET last_seen = ? WHERE id = ?", [new Date().toISOString(), body.id]);
}

function handleSetSummary(body: SetSummaryRequest): void {
  db.run("UPDATE peers SET summary = ? WHERE id = ?", [body.summary, body.id]);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];
  switch (body.scope) {
    case "network": peers = db.query("SELECT * FROM peers").all() as Peer[]; break;
    case "machine":
      peers = body.hostname
        ? db.query("SELECT * FROM peers WHERE hostname = ?").all(body.hostname) as Peer[]
        : db.query("SELECT * FROM peers").all() as Peer[];
      break;
    case "directory": peers = db.query("SELECT * FROM peers WHERE cwd = ?").all(body.cwd) as Peer[]; break;
    case "repo":
      peers = body.git_root
        ? db.query("SELECT * FROM peers WHERE git_root = ?").all(body.git_root) as Peer[]
        : db.query("SELECT * FROM peers WHERE cwd = ?").all(body.cwd) as Peer[];
      break;
    default: peers = db.query("SELECT * FROM peers").all() as Peer[];
  }
  if (body.exclude_id) peers = peers.filter((p) => p.id !== body.exclude_id);
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();
  return peers.filter((p) => p.last_seen >= cutoff);
}

// ===================== MESSAGE HANDLERS =====================

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) return { ok: false, error: `Peer ${body.to_id} not found` };
  db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)",
    [body.from_id, body.to_id, body.text, new Date().toISOString()]);
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = db.query("SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC").all(body.id) as Message[];
  for (const msg of messages) db.run("UPDATE messages SET delivered = 1 WHERE id = ?", [msg.id]);
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  db.run("DELETE FROM file_locks WHERE locked_by = ?", [body.id]);
  db.run("DELETE FROM peers WHERE id = ?", [body.id]);
}

// ===================== TASK BOARD HANDLERS =====================

function handleCreateTask(body: CreateTaskRequest): SharedTask {
  const now = new Date().toISOString();
  const result = db.run(
    "INSERT INTO tasks (project, title, description, status, priority, created_by, created_by_hostname, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [body.project, body.title, body.description, "open", body.priority, body.peer_id, body.hostname, now, now]
  );
  return db.query("SELECT * FROM tasks WHERE id = ?").get(result.lastInsertRowid) as SharedTask;
}

function handleListTasks(body: ListTasksRequest): SharedTask[] {
  if (body.project && body.status) {
    return db.query("SELECT * FROM tasks WHERE project = ? AND status = ? ORDER BY priority DESC, created_at DESC")
      .all(body.project, body.status) as SharedTask[];
  } else if (body.project) {
    return db.query("SELECT * FROM tasks WHERE project = ? ORDER BY status ASC, priority DESC, created_at DESC")
      .all(body.project) as SharedTask[];
  } else if (body.status) {
    return db.query("SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC")
      .all(body.status) as SharedTask[];
  }
  return db.query("SELECT * FROM tasks ORDER BY status ASC, priority DESC, created_at DESC").all() as SharedTask[];
}

function handleClaimTask(body: ClaimTaskRequest): { ok: boolean; error?: string; task?: SharedTask } {
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(body.task_id) as SharedTask | null;
  if (!task) return { ok: false, error: "Task not found" };
  if (task.status !== "open") return { ok: false, error: `Task is ${task.status}, not open` };
  const now = new Date().toISOString();
  db.run("UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_by_hostname = ?, updated_at = ? WHERE id = ?",
    [body.peer_id, body.hostname, now, body.task_id]);
  return { ok: true, task: db.query("SELECT * FROM tasks WHERE id = ?").get(body.task_id) as SharedTask };
}

function handleCompleteTask(body: CompleteTaskRequest): { ok: boolean; error?: string } {
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(body.task_id) as SharedTask | null;
  if (!task) return { ok: false, error: "Task not found" };
  if (task.status === "completed") return { ok: false, error: "Task already completed" };
  const now = new Date().toISOString();
  db.run("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [now, now, body.task_id]);
  // Notify the task creator
  if (task.created_by !== body.peer_id) {
    const note = body.result ? ` Result: ${body.result}` : "";
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)",
      [body.peer_id, task.created_by, `Task #${task.id} "${task.title}" completed.${note}`, now]);
  }
  return { ok: true };
}

function handleUpdateTask(body: UpdateTaskRequest): { ok: boolean; error?: string; task?: SharedTask } {
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(body.task_id) as SharedTask | null;
  if (!task) return { ok: false, error: "Task not found" };
  const now = new Date().toISOString();
  if (body.status) db.run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [body.status, now, body.task_id]);
  if (body.title) db.run("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?", [body.title, now, body.task_id]);
  if (body.description) db.run("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?", [body.description, now, body.task_id]);
  if (body.priority) db.run("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?", [body.priority, now, body.task_id]);
  return { ok: true, task: db.query("SELECT * FROM tasks WHERE id = ?").get(body.task_id) as SharedTask };
}

// ===================== CONTEXT STORE HANDLERS =====================

function handleShareContext(body: ShareContextRequest): ContextEntry {
  const now = new Date().toISOString();
  // Upsert: update if same project+key exists
  const existing = db.query("SELECT id FROM context WHERE project = ? AND key = ?").get(body.project, body.key) as { id: number } | null;
  if (existing) {
    db.run("UPDATE context SET value = ?, shared_by = ?, shared_by_hostname = ?, updated_at = ? WHERE id = ?",
      [body.value, body.peer_id, body.hostname, now, existing.id]);
    return db.query("SELECT * FROM context WHERE id = ?").get(existing.id) as ContextEntry;
  }
  const result = db.run(
    "INSERT INTO context (project, key, value, shared_by, shared_by_hostname, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [body.project, body.key, body.value, body.peer_id, body.hostname, now, now]
  );
  return db.query("SELECT * FROM context WHERE id = ?").get(result.lastInsertRowid) as ContextEntry;
}

function handleGetContext(body: GetContextRequest): ContextEntry[] {
  if (body.project && body.key) {
    return db.query("SELECT * FROM context WHERE project = ? AND key = ? ORDER BY updated_at DESC")
      .all(body.project, body.key) as ContextEntry[];
  } else if (body.project) {
    return db.query("SELECT * FROM context WHERE project = ? ORDER BY key ASC, updated_at DESC")
      .all(body.project) as ContextEntry[];
  }
  return db.query("SELECT * FROM context ORDER BY project ASC, key ASC").all() as ContextEntry[];
}

function handleDeleteContext(body: DeleteContextRequest): { ok: boolean } {
  db.run("DELETE FROM context WHERE id = ?", [body.context_id]);
  return { ok: true };
}

// ===================== FILE LOCK HANDLERS =====================

function handleLockFiles(body: LockFilesRequest): { ok: boolean; locked: string[]; conflicts: Array<{ file: string; held_by: string; hostname: string }> } {
  const locked: string[] = [];
  const conflicts: Array<{ file: string; held_by: string; hostname: string }> = [];

  for (const fp of body.file_paths) {
    const existing = db.query("SELECT * FROM file_locks WHERE file_path = ? AND project = ?").get(fp, body.project) as FileLock | null;
    if (existing && existing.locked_by !== body.peer_id) {
      conflicts.push({ file: fp, held_by: existing.locked_by, hostname: existing.locked_by_hostname });
    } else if (existing && existing.locked_by === body.peer_id) {
      // Already locked by same peer, update reason
      db.run("UPDATE file_locks SET reason = ?, locked_at = ? WHERE id = ?", [body.reason, new Date().toISOString(), existing.id]);
      locked.push(fp);
    } else {
      db.run("INSERT INTO file_locks (file_path, project, locked_by, locked_by_hostname, reason, locked_at) VALUES (?,?,?,?,?,?)",
        [fp, body.project, body.peer_id, body.hostname, body.reason, new Date().toISOString()]);
      locked.push(fp);
    }
  }

  // Notify peers working on same project about new locks
  if (locked.length > 0) {
    const peers = db.query("SELECT id FROM peers WHERE id != ?").all(body.peer_id) as { id: string }[];
    const lockMsg = `[file-lock] ${body.hostname}:${body.peer_id} locked: ${locked.join(", ")} — ${body.reason}`;
    const now = new Date().toISOString();
    for (const peer of peers) {
      db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)",
        [body.peer_id, peer.id, lockMsg, now]);
    }
  }

  return { ok: conflicts.length === 0, locked, conflicts };
}

function handleUnlockFiles(body: UnlockFilesRequest): { ok: boolean; unlocked: number } {
  let result;
  if (body.file_paths && body.project) {
    let count = 0;
    for (const fp of body.file_paths) {
      const r = db.run("DELETE FROM file_locks WHERE file_path = ? AND project = ? AND locked_by = ?", [fp, body.project, body.peer_id]);
      count += r.changes;
    }
    return { ok: true, unlocked: count };
  } else if (body.project) {
    result = db.run("DELETE FROM file_locks WHERE project = ? AND locked_by = ?", [body.project, body.peer_id]);
  } else {
    result = db.run("DELETE FROM file_locks WHERE locked_by = ?", [body.peer_id]);
  }
  return { ok: true, unlocked: result.changes };
}

function handleListLocks(body: ListLocksRequest): FileLock[] {
  if (body.project) {
    return db.query("SELECT * FROM file_locks WHERE project = ? ORDER BY locked_at DESC").all(body.project) as FileLock[];
  }
  return db.query("SELECT * FROM file_locks ORDER BY project ASC, locked_at DESC").all() as FileLock[];
}

// ===================== DELEGATION HANDLERS =====================

function handleDelegateTask(body: DelegateTaskRequest): { ok: boolean; delegation?: Delegation; error?: string } {
  // Verify target peer exists
  const target = db.query("SELECT id, hostname FROM peers WHERE id = ?").get(body.to_id) as { id: string; hostname: string } | null;
  if (!target) return { ok: false, error: `Peer ${body.to_id} not found` };

  const now = new Date().toISOString();
  const result = db.run(
    "INSERT INTO delegations (from_id, from_hostname, to_id, to_hostname, task, context, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [body.from_id, body.from_hostname, body.to_id, target.hostname, body.task, body.context, "pending", now, now]
  );

  const delegation = db.query("SELECT * FROM delegations WHERE id = ?").get(result.lastInsertRowid) as Delegation;

  // Push notification to target peer
  db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)",
    [body.from_id, body.to_id,
     `[delegation #${delegation.id}] ${body.from_hostname}:${body.from_id} asks you to: ${body.task}\n\nContext: ${body.context}\n\nRespond with respond_delegation(delegation_id=${delegation.id}, status="accepted"|"rejected"|"completed", result="...")`,
     now]);

  return { ok: true, delegation };
}

function handleRespondDelegation(body: RespondDelegationRequest): { ok: boolean; error?: string } {
  const delegation = db.query("SELECT * FROM delegations WHERE id = ?").get(body.delegation_id) as Delegation | null;
  if (!delegation) return { ok: false, error: "Delegation not found" };
  if (delegation.to_id !== body.peer_id) return { ok: false, error: "You are not the target of this delegation" };

  const now = new Date().toISOString();
  db.run("UPDATE delegations SET status = ?, result = ?, updated_at = ? WHERE id = ?",
    [body.status, body.result ?? null, now, body.delegation_id]);

  // Notify the delegator
  const statusText = body.status === "completed" ? "completed" : body.status === "accepted" ? "accepted" : "rejected";
  const resultText = body.result ? `\nResult: ${body.result}` : "";
  db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)",
    [body.peer_id, delegation.from_id,
     `[delegation #${delegation.id}] ${statusText}: "${delegation.task}"${resultText}`, now]);

  return { ok: true };
}

function handleListDelegations(body: ListDelegationsRequest): Delegation[] {
  switch (body.direction) {
    case "incoming":
      return db.query("SELECT * FROM delegations WHERE to_id = ? ORDER BY created_at DESC").all(body.peer_id) as Delegation[];
    case "outgoing":
      return db.query("SELECT * FROM delegations WHERE from_id = ? ORDER BY created_at DESC").all(body.peer_id) as Delegation[];
    default:
      return db.query("SELECT * FROM delegations WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC")
        .all(body.peer_id, body.peer_id) as Delegation[];
  }
}

// ===================== HTTP SERVER =====================

const localIP = (() => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "unknown";
})();

Bun.serve({
  port: PORT,
  hostname: BIND_HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({
          status: "ok", hostname: os.hostname(), lan_ip: localIP, bind: BIND_HOST,
          auth: SHARED_SECRET ? "enabled" : "disabled",
          peers: (db.query("SELECT COUNT(*) as c FROM peers").get() as { c: number }).c,
          tasks: (db.query("SELECT COUNT(*) as c FROM tasks WHERE status IN ('open','claimed')").get() as { c: number }).c,
          locks: (db.query("SELECT COUNT(*) as c FROM file_locks").get() as { c: number }).c,
          delegations: (db.query("SELECT COUNT(*) as c FROM delegations WHERE status = 'pending'").get() as { c: number }).c,
        });
      }
      return new Response("claude-peers workspace broker", { status: 200 });
    }

    if (!authenticate(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

    try {
      const body = await req.json();
      switch (path) {
        // --- Peers ---
        case "/register": return Response.json(handleRegister(body));
        case "/heartbeat": handleHeartbeat(body); return Response.json({ ok: true });
        case "/set-summary": handleSetSummary(body); return Response.json({ ok: true });
        case "/list-peers": return Response.json(handleListPeers(body));
        case "/unregister": handleUnregister(body); return Response.json({ ok: true });
        // --- Messages ---
        case "/send-message": return Response.json(handleSendMessage(body));
        case "/poll-messages": return Response.json(handlePollMessages(body));
        // --- Task Board ---
        case "/tasks/create": return Response.json(handleCreateTask(body));
        case "/tasks/list": return Response.json(handleListTasks(body));
        case "/tasks/claim": return Response.json(handleClaimTask(body));
        case "/tasks/complete": return Response.json(handleCompleteTask(body));
        case "/tasks/update": return Response.json(handleUpdateTask(body));
        // --- Context Store ---
        case "/context/share": return Response.json(handleShareContext(body));
        case "/context/get": return Response.json(handleGetContext(body));
        case "/context/delete": return Response.json(handleDeleteContext(body));
        // --- File Locks ---
        case "/locks/lock": return Response.json(handleLockFiles(body));
        case "/locks/unlock": return Response.json(handleUnlockFiles(body));
        case "/locks/list": return Response.json(handleListLocks(body));
        // --- Delegation ---
        case "/delegate/create": return Response.json(handleDelegateTask(body));
        case "/delegate/respond": return Response.json(handleRespondDelegation(body));
        case "/delegate/list": return Response.json(handleListDelegations(body));

        default: return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on ${BIND_HOST}:${PORT} (db: ${DB_PATH})`);
console.error(`[claude-peers broker] hostname: ${os.hostname()}, LAN IP: ${localIP}`);
console.error(`[claude-peers broker] auth: ${SHARED_SECRET ? "enabled" : "disabled"}`);
