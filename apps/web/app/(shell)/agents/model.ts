/** What the gateway's directory says about an agent. `revoked_at` is set as soon as a disconnect starts, so it never means finished. */
export type DirectoryAgent = { id: string; org_id: string; name: string; description: string | null; created_at: number; revoked_at: number | null };

export type ConnectionStatus = "active" | "disconnecting" | "disconnected";
export type Wake = { url: string; debounce: number; enabled: boolean; last_sent_at: number | null; consecutive_failures: number } | null;
export type AgentConnection = { id: string; org_id: string; name: string; generation: number; status: ConnectionStatus; inbox_unread: number; wake: Wake };

export type InboxEvent = { seq: number; event_id: string; workspace_id: string; type: string; task_id: string | null; actor_id: string; created_at: number };
export type InboxPage = { events: InboxEvent[]; acked_seq: number; unread: number; dropped: number };

export const CONNECTION_LABEL: Record<ConnectionStatus, string> = { active: "Connected", disconnecting: "Disconnecting", disconnected: "Disconnected" };

/** Text, so color is never the only signal. */
export function wakeLabel(wake: Wake) {
  if (wake === null) return "Off";
  if (wake.enabled) return "On";
  return wake.consecutive_failures > 0 ? "Off after repeated failures" : "Off";
}

/** Only the host: a wake URL's path and query can carry the agent's own secrets, and nobody here needs them. */
export function wakeHost(wake: Wake) {
  if (!wake) return null;
  try {
    return new URL(wake.url).host;
  } catch {
    return null;
  }
}

/** A row of `GET /v1/agents/{agent}/rooms`, from the listing read model. It shows rooms, and decides nothing. */
export type AgentRoom = {
  workspace_id: string;
  /** For a room it has left, the name it had then. */
  workspace_name: string;
  role: string;
  /** Null for a room it has left, which says nothing about that room since. */
  status: "active" | "archived" | null;
  left: boolean;
};

/** A row of `GET /v1/oversight/rooms`. One per agent, and it can include a room whose task reads refuse. */
export type OversightRoom = { workspace_id: string; workspace_name: string; status: string | null; agent_id: string; org_id: string };

export const oversightPath = (workspace: string, agent: string) => `/oversight/${encodeURIComponent(workspace)}/${encodeURIComponent(agent)}`;

const STATUS_EVENT = "podster:agent-status";

/** The Sheet just read this from the server, so the row behind it can show the same thing without asking again. */
export const announceStatus = (id: string, status: ConnectionStatus) => window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: { id, status } }));

const WITHDRAWN_EVENT = "podster:agent-withdrawn";

/** The listing catches up a moment later, so a confirmed withdrawal tells the rows behind the Sheet now. */
export const announceWithdrawn = (agent: string, workspace: string) => window.dispatchEvent(new CustomEvent(WITHDRAWN_EVENT, { detail: { agent, workspace } }));

export function onWithdrawn(listener: (agent: string, workspace: string) => void) {
  const handle = (event: Event) => {
    const { agent, workspace } = (event as CustomEvent<{ agent: string; workspace: string }>).detail;
    listener(agent, workspace);
  };
  window.addEventListener(WITHDRAWN_EVENT, handle);
  return () => window.removeEventListener(WITHDRAWN_EVENT, handle);
}

export function onStatusAnnounced(listener: (id: string, status: ConnectionStatus) => void) {
  const handle = (event: Event) => {
    const { id, status } = (event as CustomEvent<{ id: string; status: ConnectionStatus }>).detail;
    listener(id, status);
  };
  window.addEventListener(STATUS_EVENT, handle);
  return () => window.removeEventListener(STATUS_EVENT, handle);
}
