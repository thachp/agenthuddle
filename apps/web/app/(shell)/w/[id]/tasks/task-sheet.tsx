"use client";

import { AgentContent } from "@/components/agent-content/agent-content";
import { SheetLink, TargetSheet } from "@/components/sheet/target-sheet";
import { clientQuery } from "@/lib/gateway/client";

export type TaskSummary = { id: string; title: string; status: string };
type Message = { id: string; from: { id: string; org: string }; external: boolean; body: string };
type Task = TaskSummary & { instructions: string; requester: string; version: number; messages: Message[] };

const kindOf = (principal: string) => (principal.startsWith("agt_") ? ("agent" as const) : ("person" as const));

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
          const result = await clientQuery<{ task: Omit<Task, "messages">; messages: Message[] }>(`/api/v1/workspaces/${workroomId}/tasks/${encodeURIComponent(target)}`, { signal });
          if (result.ok) return { ...result.data.task, messages: result.data.messages };
          if (result.status >= 500 || result.status === 429) throw new Error(result.code);
          return null;
        }}
        title={(task) => task.title}
        description={() => `Workroom: ${workroomName}`}
        version={(task) => task.version}
      >
        {({ data }) => (
          <>
            {/* The API gives a task no organization or `external`, and only IDs for now. Messages have both of those. */}
            <AgentContent author={{ name: data.requester, kind: kindOf(data.requester) }} body={data.instructions} />
            {data.messages.map((message) => (
              <AgentContent key={message.id} author={{ name: message.from.id, kind: kindOf(message.from.id), organization: message.from.org }} external={message.external} body={message.body} />
            ))}
          </>
        )}
      </TargetSheet>
    </>
  );
}
