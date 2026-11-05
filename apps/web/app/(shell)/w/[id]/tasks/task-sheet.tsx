"use client";

import { AgentContent } from "@/components/agent-content/agent-content";
import { SheetLink, TargetSheet } from "@/components/sheet/target-sheet";
import { clientQuery } from "@/lib/gateway/client";

export type TaskSummary = { id: string; title: string; status: string };
type Task = TaskSummary & { instructions: string; requester: string; version: number };

/**
 * The reference use of the Sheet, until the Review screen replaces this file. It shows the real flow: a deep-linkable
 * target, a load that treats anything but success as gone, and agent-written text through the inert renderer.
 */
export function TaskList({ workroomId, workroomName, tasks }: { workroomId: string; workroomName: string; tasks: TaskSummary[] }) {
  return (
    <>
      <ul className="space-y-1">
        {tasks.map((task) => (
          <li key={task.id}>
            <SheetLink param="task" target={task.id} className="text-primary underline break-words">
              {task.title}
            </SheetLink>
          </li>
        ))}
      </ul>
      <TargetSheet<Task>
        param="task"
        size="lg"
        noun="task"
        load={async (target, { signal }) => {
          const result = await clientQuery<{ task: Task }>(`/api/v1/workspaces/${workroomId}/tasks/${encodeURIComponent(target)}`, { signal });
          if (result.ok) return result.data.task;
          if (result.status >= 500 || result.status === 429) throw new Error(result.code);
          return null;
        }}
        title={(task) => task.title}
        description={() => `Workroom: ${workroomName}`}
        version={(task) => task.version}
      >
        {({ data }) => <AgentContent author={{ name: data.requester, kind: data.requester.startsWith("agt_") ? "agent" : "person" }} body={data.instructions} />}
      </TargetSheet>
    </>
  );
}
