// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  hostname: string; // machine hostname for LAN identification
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Shared Task Board ---

export type TaskStatus = "open" | "claimed" | "completed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export interface SharedTask {
  id: number;
  project: string; // project/repo name for scoping
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  created_by: PeerId;
  created_by_hostname: string;
  claimed_by: PeerId | null;
  claimed_by_hostname: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateTaskRequest {
  peer_id: PeerId;
  hostname: string;
  project: string;
  title: string;
  description: string;
  priority: TaskPriority;
}

export interface ListTasksRequest {
  project?: string;
  status?: TaskStatus;
}

export interface ClaimTaskRequest {
  task_id: number;
  peer_id: PeerId;
  hostname: string;
}

export interface CompleteTaskRequest {
  task_id: number;
  peer_id: PeerId;
  result?: string; // optional completion notes
}

export interface UpdateTaskRequest {
  task_id: number;
  peer_id: PeerId;
  status?: TaskStatus;
  title?: string;
  description?: string;
  priority?: TaskPriority;
}

// --- Shared Context Store ---

export interface ContextEntry {
  id: number;
  project: string;
  key: string; // topic/category
  value: string; // the knowledge
  shared_by: PeerId;
  shared_by_hostname: string;
  created_at: string;
  updated_at: string;
}

export interface ShareContextRequest {
  peer_id: PeerId;
  hostname: string;
  project: string;
  key: string;
  value: string;
}

export interface GetContextRequest {
  project?: string;
  key?: string;
}

export interface DeleteContextRequest {
  context_id: number;
  peer_id: PeerId;
}

// --- File Locks ---

export interface FileLock {
  id: number;
  file_path: string;
  project: string;
  locked_by: PeerId;
  locked_by_hostname: string;
  reason: string;
  locked_at: string;
}

export interface LockFilesRequest {
  peer_id: PeerId;
  hostname: string;
  project: string;
  file_paths: string[];
  reason: string;
}

export interface UnlockFilesRequest {
  peer_id: PeerId;
  file_paths?: string[]; // omit to unlock all by this peer
  project?: string;
}

export interface ListLocksRequest {
  project?: string;
}

// --- Task Delegation ---

export type DelegationStatus = "pending" | "accepted" | "rejected" | "completed";

export interface Delegation {
  id: number;
  from_id: PeerId;
  from_hostname: string;
  to_id: PeerId;
  to_hostname: string;
  task: string; // what to do
  context: string; // additional context
  status: DelegationStatus;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface DelegateTaskRequest {
  from_id: PeerId;
  from_hostname: string;
  to_id: PeerId;
  task: string;
  context: string;
}

export interface RespondDelegationRequest {
  delegation_id: number;
  peer_id: PeerId;
  status: "accepted" | "rejected" | "completed";
  result?: string;
}

export interface ListDelegationsRequest {
  peer_id: PeerId;
  direction: "incoming" | "outgoing" | "all";
}

// --- Broker API types (messaging) ---

export interface RegisterRequest {
  pid: number;
  hostname: string;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "network" | "directory" | "repo";
  hostname?: string;
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
