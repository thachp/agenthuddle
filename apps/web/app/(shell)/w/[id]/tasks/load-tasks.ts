import type { GatewayResult } from "@/lib/gateway/result";
import type { Names, Task } from "./task-model";

type Query = <T>(path: string) => Promise<GatewayResult<T>>;

/** Pages are 50 tasks. Past this many a person's rate limit matters more, and the screen says it stopped. */
const MAX_PAGES = 4;

/** Every task the viewer may see, as far as `MAX_PAGES`. A failure on any page fails the read, rather than looking like a shorter list. */
export async function loadTasks(query: Query, workspace: string, filter = ""): Promise<GatewayResult<{ tasks: Task[]; more: boolean }>> {
  const tasks: Task[] = [];
  let cursor: number | null = 0;
  for (let page = 0; page < MAX_PAGES && cursor !== null; page += 1) {
    const result: GatewayResult<{ tasks: Task[]; next_cursor: number | null }> = await query(`/api/v1/workspaces/${encodeURIComponent(workspace)}/tasks?cursor=${cursor}${filter}`);
    if (!result.ok) return result;
    tasks.push(...result.data.tasks);
    cursor = result.data.next_cursor;
  }
  return { ok: true, data: { tasks, more: cursor !== null } };
}

/** The names we can show: agents in the viewer's own organizations. Nothing yet names anyone else, so a failure here just leaves IDs. */
export async function loadNames(query: Query): Promise<Names> {
  const result = await query<{ agents: { id: string; name: string }[] }>("/api/agents");
  return result.ok ? Object.fromEntries(result.data.agents.map((agent) => [agent.id, agent.name])) : {};
}
