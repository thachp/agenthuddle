"use client";

import { Tabs } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { AgentContent, AuthorLine } from "@/components/agent-content/agent-content";
import { destinationHost, plainName, safeLinkUrl } from "@/components/agent-content/text";
import { TargetSheet, type SheetApi } from "@/components/sheet/target-sheet";
import { clientQuery } from "@/lib/gateway/client";
import { TaskActions } from "./task-actions";
import { PrincipalName, TaskStatusBadge, Timestamp } from "./task-bits";
import { briefAuthor, kindOf, nameOf, roleOf, verbFor, type Artifact, type From, type Names, type Room, type TaskDetail } from "./task-model";

export type LoadedTask = TaskDetail & { workspace: string; room: Room };

/** How a Sheet's target maps to a task. A workroom's own page passes the room, and anywhere else names it in the target. */
export type TaskSheetProps = {
  me: string;
  names: Names;
  resolve: (target: string) => { workspace: string; task: string } | null;
  room?: Room;
};

async function read<T>(path: string, signal: AbortSignal) {
  const result = await clientQuery<T>(path, { signal });
  if (result.ok) return result.data;
  // An outage isn't "gone". Anything else is one message, whether it's missing or hidden.
  if (result.status >= 500 || result.status === 429) throw new Error(result.code);
  return null;
}

export function TaskSheet({ me, names, resolve, room }: TaskSheetProps) {
  return (
    <TargetSheet<LoadedTask>
      param="task"
      size="lg"
      noun="task"
      load={async (target, { signal }) => {
        const where = resolve(target);
        if (!where) return null;
        const base = `/api/v1/workspaces/${encodeURIComponent(where.workspace)}`;
        const [detail, loadedRoom] = await Promise.all([read<TaskDetail>(`${base}/tasks/${encodeURIComponent(where.task)}`, signal), room ? room : read<Room>(base, signal)]);
        return detail && loadedRoom ? { ...detail, workspace: where.workspace, room: loadedRoom } : null;
      }}
      title={(data) => plainName(data.task.title)}
      description={(data) => `Workroom: ${plainName(data.room.name)}`}
      version={(data) => data.task.version}
    >
      {(api) => <TaskBody api={api} me={me} names={names} />}
    </TargetSheet>
  );
}

const TAB_CLASS = "min-h-11 flex-1 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-muted sm:min-h-8 sm:flex-none";

function TaskBody({ api, me, names }: { api: SheetApi<LoadedTask>; me: string; names: Names }) {
  const { data } = api;
  const { task } = data;
  // Outlives the action controls, which start fresh for each version, so the result stays on screen.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const label = (id: string) => nameOf(id, me, names);
  // A decision removes the button that made it, and focus shouldn't vanish with it. This also lands on the result.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          <TaskStatusBadge status={task.status} />
        </dd>
        <dt className="text-muted-foreground">Requester</dt>
        <dd>
          <PrincipalName id={task.requester} label={label(task.requester)} />
        </dd>
        <dt className="text-muted-foreground">Assignee</dt>
        <dd>{task.assignee ? <PrincipalName id={task.assignee} label={label(task.assignee)} /> : "Nobody yet"}</dd>
        <dt className="text-muted-foreground">Reviewer</dt>
        <dd>
          <PrincipalName id={task.reviewer} label={label(task.reviewer)} />
        </dd>
        <dt className="text-muted-foreground">Task</dt>
        <dd className="truncate" title={task.id}>
          {task.id}
        </dd>
        <dt className="text-muted-foreground">Submission</dt>
        <dd>{task.submission_no > 0 ? task.submission_no : "None yet"}</dd>
      </dl>
      {task.needs_attention ? <p className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">Someone left this workroom, so this task needs a new reviewer or requester.</p> : null}
      <p ref={noticeRef} tabIndex={-1} role="status" className="rounded-sm text-sm outline-none empty:hidden focus-visible:ring-2 focus-visible:ring-ring">
        {notice}
      </p>

      <Tabs.Root defaultValue="details">
        <Tabs.List aria-label="Task details" className="flex gap-1 border-b pb-1">
          <Tabs.Trigger value="details" className={TAB_CLASS}>
            Details
          </Tabs.Trigger>
          <Tabs.Trigger value="discussion" className={TAB_CLASS}>
            Discussion ({data.messages.length})
          </Tabs.Trigger>
          <Tabs.Trigger value="activity" className={TAB_CLASS}>
            Activity
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="details" className="mt-4 space-y-4 outline-none">
          <Details data={data} me={me} names={names} />
        </Tabs.Content>
        <Tabs.Content value="discussion" className="mt-4 space-y-3 outline-none">
          <Discussion data={data} me={me} names={names} />
        </Tabs.Content>
        <Tabs.Content value="activity" className="mt-4 outline-none">
          <Activity data={data} me={me} names={names} />
        </Tabs.Content>
      </Tabs.Root>

      {/* Fresh for each version, so a draft or key from before a change can't go out against what's on screen now. */}
      <TaskActions key={`${task.version}:${task.submission_no}`} api={api} me={me} names={names} role={roleOf(data.room, me)} onNotice={setNotice} />
    </div>
  );
}

type SectionProps = { data: LoadedTask; me: string; names: Names };

const author = (from: From, me: string, names: Names) => ({ name: nameOf(from.id, me, names), kind: kindOf(from.id), organization: from.org });

function Details({ data, me, names }: SectionProps) {
  const { task } = data;
  const brief = briefAuthor(data);
  const briefBy = { name: nameOf(brief.id, me, names), kind: kindOf(brief.id), organization: brief.org };
  return (
    <>
      <section className="space-y-2">
        <h3 className="font-medium">Instructions</h3>
        <AgentContent author={briefBy} external={brief.external} body={task.instructions} />
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Acceptance criteria</h3>
        {/* Read-only. Nothing here says anyone has checked them. */}
        {task.acceptance_criteria ? <AgentContent author={briefBy} external={brief.external} body={task.acceptance_criteria} /> : <p className="text-sm text-muted-foreground">None given.</p>}
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Submissions</h3>
        {data.submissions.length === 0 ? <p className="text-sm text-muted-foreground">Nothing submitted yet.</p> : null}
        <ol className="space-y-3">
          {data.submissions.toReversed().map((submission) => (
            <li key={submission.submission_no} className="space-y-2 rounded-lg border p-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                Submission {submission.submission_no}
                {submission.submission_no === task.submission_no ? <span className="text-xs font-normal text-muted-foreground">Latest</span> : null}
                <span className="text-xs font-normal">
                  <Timestamp at={submission.created_at} />
                </span>
              </p>
              {submission.note ? (
                <AgentContent author={author(submission.from, me, names)} external={submission.external} body={submission.note} />
              ) : (
                <AuthorLine author={author(submission.from, me, names)} external={submission.external} />
              )}
              {submission.commit_sha ? (
                <p className="text-xs break-all text-muted-foreground">
                  Commit <code className="font-mono">{submission.commit_sha}</code>
                </p>
              ) : null}
              <ArtifactList artifacts={data.artifacts.filter((artifact) => artifact.submission_no === submission.submission_no)} me={me} names={names} />
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function ArtifactList({ artifacts, me, names }: { artifacts: Artifact[]; me: string; names: Names }) {
  if (artifacts.length === 0) return null;
  return (
    <ul aria-label="Artifacts" className="space-y-2">
      {artifacts.map((artifact) => {
        const url = safeLinkUrl(artifact.uri);
        return (
          <li key={artifact.id} className="space-y-1 rounded-md bg-muted/50 p-2 text-sm">
            <AuthorLine author={author(artifact.from, me, names)} external={artifact.external} />
            {/* The label is the agent's, and only the host shown beside it says where this goes. Never previewed or fetched. */}
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer nofollow ugc" className="break-words text-primary underline">
                {plainName(artifact.label)} <span className="break-all text-muted-foreground">({destinationHost(url)})</span>
              </a>
            ) : (
              <p className="break-words">
                {plainName(artifact.label)} <span className="break-all text-muted-foreground">({artifact.uri})</span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What a task read returns, and there's no reason to imply a thread stops here. */
const RECENT_MESSAGES = 20;

function Discussion({ data, me, names }: SectionProps) {
  if (data.messages.length === 0) return <p className="text-sm text-muted-foreground">No messages yet. Agents post their progress here.</p>;
  return (
    <>
      {data.messages.length >= RECENT_MESSAGES ? <p className="text-xs text-muted-foreground">Showing the latest {RECENT_MESSAGES} messages.</p> : null}
      <ol className="space-y-3">
        {data.messages.map((message) => (
          <li key={message.id} className="space-y-1">
            <AgentContent author={author(message.from, me, names)} external={message.external} body={message.body} />
            <p className="text-xs">
              <Timestamp at={message.created_at} />
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}

function Activity({ data, me, names }: SectionProps) {
  if (data.history.length === 0) return <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>;
  return (
    <ol className="space-y-3">
      {data.history.toReversed().map((event) => (
        <li key={event.id} className="space-y-1 border-b pb-3 text-sm last:border-b-0">
          <AuthorLine author={author(event.from, me, names)} external={event.external} />
          <p>
            {verbFor(event.type)}{" "}
            <span className="text-xs">
              <Timestamp at={event.created_at} />
            </span>
          </p>
          {event.reason ? <AgentContent author={author(event.from, me, names)} external={event.external} body={event.reason} /> : null}
        </li>
      ))}
    </ol>
  );
}

