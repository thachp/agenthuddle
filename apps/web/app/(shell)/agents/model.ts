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

/** The event an agent's inbox keeps when it leaves a room. Everything else from that room has been cleared by then. */
const REMOVAL_NOTICE = "member.revoked";

export type AgentRoom = {
  id: string;
  /** Absent when the viewer can't read this room, which an agent's owner needn't be able to. */
  name: string | null;
  /** Absent unless the room itself said. Managed by the room, so it's never editable here. */
  role: string | null;
  /** `listed`: the room's own member list has it. `inbox`: known only from inbox events, so it may have gone since. */
  source: "listed" | "inbox";
};

export type ReadableRoom = { id: string; name: string; role: string | null; lists_agent: boolean };

/**
 * No route lists an agent's workrooms, so this joins the two things a person can read: the rooms they belong to, and the
 * rooms in the agent's inbox. Only a room's member list counts as proof of membership.
 */
export function roomsOf(readable: ReadableRoom[], events: InboxEvent[]): AgentRoom[] {
  const rooms: AgentRoom[] = readable.filter((room) => room.lists_agent).map(({ id, name, role }) => ({ id, name, role, source: "listed" as const }));
  const latest = new Map<string, InboxEvent>();
  for (const event of events) if ((latest.get(event.workspace_id)?.seq ?? -1) < event.seq) latest.set(event.workspace_id, event);
  for (const [id, event] of latest) {
    if (event.type === REMOVAL_NOTICE || rooms.some((room) => room.id === id)) continue;
    rooms.push({ id, name: readable.find((room) => room.id === id)?.name ?? null, role: null, source: "inbox" });
  }
  return rooms;
}

const STATUS_EVENT = "podster:agent-status";

/** The Sheet just read this from the server, so the row behind it can show the same thing without asking again. */
export const announceStatus = (id: string, status: ConnectionStatus) => window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: { id, status } }));

export function onStatusAnnounced(listener: (id: string, status: ConnectionStatus) => void) {
  const handle = (event: Event) => {
    const { id, status } = (event as CustomEvent<{ id: string; status: ConnectionStatus }>).detail;
    listener(id, status);
  };
  window.addEventListener(STATUS_EVENT, handle);
  return () => window.removeEventListener(STATUS_EVENT, handle);
}
