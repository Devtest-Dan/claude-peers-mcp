#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for:
 *   - Peer discovery & messaging
 *   - Shared task board
 *   - Shared context store
 *   - File locks
 *   - Task delegation
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import os from "os";
import type {
  PeerId, Peer, RegisterResponse, PollMessagesResponse,
  SharedTask, ContextEntry, FileLock, Delegation,
} from "./shared/types.ts";
import { generateSummary, getGitBranch, getRecentFiles } from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_HOST = process.env.CLAUDE_PEERS_HOST ?? "127.0.0.1";
const BROKER_URL = `http://${BROKER_HOST}:${BROKER_PORT}`;
const SHARED_SECRET = process.env.CLAUDE_PEERS_SECRET ?? null;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const MY_HOSTNAME = os.hostname();

// --- Broker communication ---

function brokerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SHARED_SECRET) headers["x-claude-peers-secret"] = SHARED_SECRET;
  return headers;
}

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST", headers: brokerHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Broker error (${path}): ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) { log("Broker already running"); return; }
  if (BROKER_HOST !== "127.0.0.1" && BROKER_HOST !== "localhost") {
    throw new Error(`Remote broker at ${BROKER_URL} is not reachable. Start the broker on the remote machine with: CLAUDE_PEERS_BIND=lan bun broker.ts`);
  }
  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, CLAUDE_PEERS_BIND: process.env.CLAUDE_PEERS_BIND ?? "local" },
  });
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) { log("Broker started"); return; }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

function log(msg: string) { console.error(`[claude-peers] ${msg}`); }

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text.trim() : null;
  } catch { return null; }
}

function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") return tty;
    }
  } catch {}
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myProject = ""; // derived from cwd basename or git root basename

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.3.0" },
  {
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
    instructions: `You are connected to the claude-peers shared workspace. Other Claude Code instances on this machine AND across the LAN can collaborate with you.

## Responding to Messages
When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Pause your current task, reply using send_message, then resume.

## Available Tools

### Peer Discovery & Messaging
- list_peers: Find other Claude instances (scope: network/machine/directory/repo)
- send_message: Send a message to any peer by ID
- set_summary: Describe what you're working on
- check_messages: Manually poll for messages

### Shared Task Board (coordinate work across peers)
- create_task: Create a task for anyone to claim (visible to all peers)
- list_tasks: See all tasks, filter by project/status
- claim_task: Claim an open task (you're now responsible)
- complete_task: Mark a task done (notifies the creator)
- update_task: Change task details, status, or priority

### Shared Context (team knowledge base)
- share_context: Share knowledge with all peers (e.g., decisions, architecture notes, gotchas)
- get_context: Read shared knowledge for a project
- delete_context: Remove outdated context

### File Locks (prevent conflicts)
- lock_files: Lock files you're editing (other peers are notified)
- unlock_files: Release your locks when done
- list_locks: See what files are locked and by whom

### Task Delegation (ask another peer to do something)
- delegate_task: Assign work to a specific peer (they get a notification)
- respond_delegation: Accept, reject, or complete a delegation
- list_delegations: View incoming/outgoing delegations

## Workflow
1. On start: call set_summary, then get_context for your project
2. Before editing files: call list_locks, then lock_files
3. When done with files: call unlock_files
4. For coordination: create_task or delegate_task
5. Share discoveries: share_context with key decisions/findings`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  // --- Peer Discovery ---
  {
    name: "list_peers",
    description: "List other Claude Code instances on this machine or across the LAN.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: { type: "string" as const, enum: ["network", "machine", "directory", "repo"],
          description: '"network"=all LAN, "machine"=same host, "directory"=same cwd, "repo"=same git repo' },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to another Claude Code instance by peer ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "Target peer ID" },
        message: { type: "string" as const, description: "Message text" },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description: "Set a brief summary of your current work (visible to all peers).",
    inputSchema: {
      type: "object" as const,
      properties: { summary: { type: "string" as const, description: "1-2 sentence summary" } },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description: "Manually check for new messages (normally auto-pushed).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  // --- Task Board ---
  {
    name: "create_task",
    description: "Create a task on the shared board. Any peer can claim it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Task title" },
        description: { type: "string" as const, description: "What needs to be done" },
        priority: { type: "string" as const, enum: ["low", "medium", "high", "critical"], description: "Task priority (default: medium)" },
        project: { type: "string" as const, description: "Project name (default: current project)" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks on the shared board. Filter by project or status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string" as const, description: "Filter by project (default: all)" },
        status: { type: "string" as const, enum: ["open", "claimed", "completed", "cancelled"], description: "Filter by status" },
      },
    },
  },
  {
    name: "claim_task",
    description: "Claim an open task. You become responsible for completing it.",
    inputSchema: {
      type: "object" as const,
      properties: { task_id: { type: "number" as const, description: "Task ID to claim" } },
      required: ["task_id"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed. The creator is notified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "number" as const, description: "Task ID" },
        result: { type: "string" as const, description: "Completion notes (optional)" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "update_task",
    description: "Update a task's title, description, priority, or status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "number" as const, description: "Task ID" },
        title: { type: "string" as const }, description: { type: "string" as const },
        priority: { type: "string" as const, enum: ["low", "medium", "high", "critical"] },
        status: { type: "string" as const, enum: ["open", "claimed", "completed", "cancelled"] },
      },
      required: ["task_id"],
    },
  },
  // --- Context Store ---
  {
    name: "share_context",
    description: "Share knowledge with all peers. Upserts by project+key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string" as const, description: "Topic/category (e.g., 'architecture', 'current-status', 'gotchas')" },
        value: { type: "string" as const, description: "The knowledge to share" },
        project: { type: "string" as const, description: "Project name (default: current)" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "get_context",
    description: "Read shared knowledge. Returns all context for a project or specific key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string" as const, description: "Project name (default: all)" },
        key: { type: "string" as const, description: "Specific topic (optional)" },
      },
    },
  },
  {
    name: "delete_context",
    description: "Remove outdated context by ID.",
    inputSchema: {
      type: "object" as const,
      properties: { context_id: { type: "number" as const, description: "Context entry ID" } },
      required: ["context_id"],
    },
  },
  // --- File Locks ---
  {
    name: "lock_files",
    description: "Lock files you're about to edit. Other peers are notified. Prevents conflicts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_paths: { type: "array" as const, items: { type: "string" as const }, description: "Files to lock (relative paths)" },
        reason: { type: "string" as const, description: "Why you're locking these files" },
        project: { type: "string" as const, description: "Project name (default: current)" },
      },
      required: ["file_paths", "reason"],
    },
  },
  {
    name: "unlock_files",
    description: "Release file locks. Omit file_paths to unlock all your locks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_paths: { type: "array" as const, items: { type: "string" as const }, description: "Files to unlock (omit for all)" },
        project: { type: "string" as const, description: "Project name (default: current)" },
      },
    },
  },
  {
    name: "list_locks",
    description: "See all locked files and who holds them.",
    inputSchema: {
      type: "object" as const,
      properties: { project: { type: "string" as const, description: "Project name (default: all)" } },
    },
  },
  // --- Delegation ---
  {
    name: "delegate_task",
    description: "Ask a specific peer to do something. They get an immediate notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "Target peer ID" },
        task: { type: "string" as const, description: "What you want them to do" },
        context: { type: "string" as const, description: "Additional context to help them" },
      },
      required: ["to_id", "task"],
    },
  },
  {
    name: "respond_delegation",
    description: "Accept, reject, or complete a delegation assigned to you.",
    inputSchema: {
      type: "object" as const,
      properties: {
        delegation_id: { type: "number" as const, description: "Delegation ID" },
        status: { type: "string" as const, enum: ["accepted", "rejected", "completed"], description: "Your response" },
        result: { type: "string" as const, description: "Result or reason (optional)" },
      },
      required: ["delegation_id", "status"],
    },
  },
  {
    name: "list_delegations",
    description: "View delegations assigned to you or created by you.",
    inputSchema: {
      type: "object" as const,
      properties: {
        direction: { type: "string" as const, enum: ["incoming", "outgoing", "all"], description: "Filter direction (default: all)" },
      },
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args as Record<string, any>;

  const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
  const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

  if (!myId && name !== "check_messages") {
    // Allow most tools even before full registration (shouldn't happen, but safe)
  }

  try {
    switch (name) {
      // --- Peers ---
      case "list_peers": {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: a.scope, hostname: MY_HOSTNAME, cwd: myCwd, git_root: myGitRoot, exclude_id: myId,
        });
        if (peers.length === 0) return ok(`No other peers found (scope: ${a.scope}).`);
        const lines = peers.map((p) => {
          const parts = [`ID: ${p.id}`, `Host: ${p.hostname}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });
        return ok(`Found ${peers.length} peer(s) (scope: ${a.scope}):\n\n${lines.join("\n\n")}`);
      }

      case "send_message": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", { from_id: myId, to_id: a.to_id, text: a.message });
        return result.ok ? ok(`Message sent to ${a.to_id}`) : err(`Failed: ${result.error}`);
      }

      case "set_summary": {
        if (!myId) return err("Not registered yet");
        await brokerFetch("/set-summary", { id: myId, summary: a.summary });
        return ok(`Summary updated: "${a.summary}"`);
      }

      case "check_messages": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) return ok("No new messages.");
        const lines = result.messages.map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`);
        return ok(`${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`);
      }

      // --- Task Board ---
      case "create_task": {
        if (!myId) return err("Not registered yet");
        const task = await brokerFetch<SharedTask>("/tasks/create", {
          peer_id: myId, hostname: MY_HOSTNAME, project: a.project || myProject,
          title: a.title, description: a.description || "", priority: a.priority || "medium",
        });
        return ok(`Task #${task.id} created: "${task.title}" [${task.priority}] in project "${task.project}"`);
      }

      case "list_tasks": {
        const tasks = await brokerFetch<SharedTask[]>("/tasks/list", { project: a.project, status: a.status });
        if (tasks.length === 0) return ok("No tasks found.");
        const priorityIcon: Record<string, string> = { critical: "!!!", high: "!!", medium: "!", low: "." };
        const lines = tasks.map((t) =>
          `#${t.id} [${t.status}] ${priorityIcon[t.priority] || ""} ${t.title}\n  Project: ${t.project} | Created by: ${t.created_by_hostname}:${t.created_by}` +
          (t.claimed_by ? `\n  Claimed by: ${t.claimed_by_hostname}:${t.claimed_by}` : "") +
          (t.description ? `\n  ${t.description}` : "")
        );
        return ok(`${tasks.length} task(s):\n\n${lines.join("\n\n")}`);
      }

      case "claim_task": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<{ ok: boolean; error?: string; task?: SharedTask }>("/tasks/claim", {
          task_id: a.task_id, peer_id: myId, hostname: MY_HOSTNAME,
        });
        return result.ok ? ok(`Claimed task #${a.task_id}: "${result.task?.title}"`) : err(`Failed: ${result.error}`);
      }

      case "complete_task": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/tasks/complete", {
          task_id: a.task_id, peer_id: myId, result: a.result,
        });
        return result.ok ? ok(`Task #${a.task_id} marked complete.`) : err(`Failed: ${result.error}`);
      }

      case "update_task": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<{ ok: boolean; error?: string; task?: SharedTask }>("/tasks/update", {
          task_id: a.task_id, peer_id: myId, status: a.status, title: a.title,
          description: a.description, priority: a.priority,
        });
        return result.ok ? ok(`Task #${a.task_id} updated.`) : err(`Failed: ${result.error}`);
      }

      // --- Context Store ---
      case "share_context": {
        if (!myId) return err("Not registered yet");
        const entry = await brokerFetch<ContextEntry>("/context/share", {
          peer_id: myId, hostname: MY_HOSTNAME, project: a.project || myProject,
          key: a.key, value: a.value,
        });
        return ok(`Context shared: [${entry.project}] ${entry.key} (id: ${entry.id})`);
      }

      case "get_context": {
        const entries = await brokerFetch<ContextEntry[]>("/context/get", { project: a.project, key: a.key });
        if (entries.length === 0) return ok("No shared context found.");
        const lines = entries.map((e) =>
          `[${e.project}] ${e.key} (id:${e.id}, by ${e.shared_by_hostname}:${e.shared_by}, ${e.updated_at}):\n${e.value}`
        );
        return ok(`${entries.length} context entries:\n\n${lines.join("\n\n---\n\n")}`);
      }

      case "delete_context": {
        if (!myId) return err("Not registered yet");
        await brokerFetch("/context/delete", { context_id: a.context_id, peer_id: myId });
        return ok(`Context #${a.context_id} deleted.`);
      }

      // --- File Locks ---
      case "lock_files": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<{ ok: boolean; locked: string[]; conflicts: Array<{ file: string; held_by: string; hostname: string }> }>(
          "/locks/lock", { peer_id: myId, hostname: MY_HOSTNAME, project: a.project || myProject, file_paths: a.file_paths, reason: a.reason }
        );
        let text = `Locked ${result.locked.length} file(s): ${result.locked.join(", ")}`;
        if (result.conflicts.length > 0) {
          text += `\n\nCONFLICTS (${result.conflicts.length}):\n` +
            result.conflicts.map((c) => `  ${c.file} — held by ${c.hostname}:${c.held_by}`).join("\n");
        }
        return result.ok ? ok(text) : err(text);
      }

      case "unlock_files": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<{ ok: boolean; unlocked: number }>(
          "/locks/unlock", { peer_id: myId, file_paths: a.file_paths, project: a.project || myProject }
        );
        return ok(`Unlocked ${result.unlocked} file(s).`);
      }

      case "list_locks": {
        const locks = await brokerFetch<FileLock[]>("/locks/list", { project: a.project });
        if (locks.length === 0) return ok("No file locks active.");
        const lines = locks.map((l) =>
          `${l.file_path} — locked by ${l.locked_by_hostname}:${l.locked_by} (${l.reason}) since ${l.locked_at}`
        );
        return ok(`${locks.length} lock(s):\n${lines.join("\n")}`);
      }

      // --- Delegation ---
      case "delegate_task": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<{ ok: boolean; delegation?: Delegation; error?: string }>(
          "/delegate/create", { from_id: myId, from_hostname: MY_HOSTNAME, to_id: a.to_id, task: a.task, context: a.context || "" }
        );
        return result.ok ? ok(`Delegation #${result.delegation?.id} sent to ${a.to_id}: "${a.task}"`) : err(`Failed: ${result.error}`);
      }

      case "respond_delegation": {
        if (!myId) return err("Not registered yet");
        const result = await brokerFetch<{ ok: boolean; error?: string }>(
          "/delegate/respond", { delegation_id: a.delegation_id, peer_id: myId, status: a.status, result: a.result }
        );
        return result.ok ? ok(`Delegation #${a.delegation_id} ${a.status}.`) : err(`Failed: ${result.error}`);
      }

      case "list_delegations": {
        if (!myId) return err("Not registered yet");
        const delegations = await brokerFetch<Delegation[]>(
          "/delegate/list", { peer_id: myId, direction: a.direction || "all" }
        );
        if (delegations.length === 0) return ok("No delegations.");
        const lines = delegations.map((d) => {
          const dir = d.from_id === myId ? `→ ${d.to_hostname}:${d.to_id}` : `← ${d.from_hostname}:${d.from_id}`;
          return `#${d.id} [${d.status}] ${dir}\n  Task: ${d.task}` +
            (d.result ? `\n  Result: ${d.result}` : "");
        });
        return ok(`${delegations.length} delegation(s):\n\n${lines.join("\n\n")}`);
      }

      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// --- Polling loop ---

async function pollAndPushMessages() {
  if (!myId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    for (const msg of result.messages) {
      let fromSummary = "", fromCwd = "", fromHostname = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "network", hostname: MY_HOSTNAME, cwd: myCwd, git_root: myGitRoot });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) { fromSummary = sender.summary; fromCwd = sender.cwd; fromHostname = sender.hostname; }
      } catch {}
      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content: msg.text, meta: { from_id: msg.from_id, from_summary: fromSummary, from_cwd: fromCwd, from_hostname: fromHostname, sent_at: msg.sent_at } },
      });
      log(`Pushed message from ${msg.from_id}@${fromHostname}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) { log(`Poll error: ${e instanceof Error ? e.message : String(e)}`); }
}

// --- Startup ---

async function main() {
  await ensureBroker();
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  // Derive project name from git root or cwd
  const projectSource = myGitRoot || myCwd;
  myProject = projectSource.split(/[/\\]/).pop() || "unknown";

  log(`Hostname: ${MY_HOSTNAME}, Broker: ${BROKER_URL}`);
  log(`Project: ${myProject}, CWD: ${myCwd}, Git: ${myGitRoot ?? "(none)"}`);

  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({ cwd: myCwd, git_root: myGitRoot, git_branch: branch, recent_files: recentFiles });
      if (summary) { initialSummary = summary; log(`Auto-summary: ${summary}`); }
    } catch (e) { log(`Auto-summary failed: ${e instanceof Error ? e.message : String(e)}`); }
  })();
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid, hostname: MY_HOSTNAME, cwd: myCwd, git_root: myGitRoot, tty, summary: initialSummary,
  });
  myId = reg.id;
  log(`Registered as peer ${myId} on ${MY_HOSTNAME}`);

  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try { await brokerFetch("/set-summary", { id: myId, summary: initialSummary }); } catch {}
      }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(async () => {
    if (myId) { try { await brokerFetch("/heartbeat", { id: myId }); } catch {} }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) { try { await brokerFetch("/unregister", { id: myId }); log("Unregistered"); } catch {} }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => { log(`Fatal: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
