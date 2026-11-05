import { CircleCheck, CircleMinus, Loader } from "lucide-react";
import { cn } from "cn";
import { CONNECTION_LABEL, type ConnectionStatus } from "./model";

const LOOK = {
  active: { icon: CircleCheck, tone: "bg-status-green-surface text-status-green" },
  disconnecting: { icon: Loader, tone: "bg-status-amber-surface text-status-amber" },
  disconnected: { icon: CircleMinus, tone: "bg-status-neutral-surface text-status-neutral" },
} satisfies Record<ConnectionStatus, unknown>;

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const { icon: Icon, tone } = LOOK[status];
  return (
    <span className={cn("inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", tone)}>
      <Icon className="size-3" aria-hidden />
      {CONNECTION_LABEL[status]}
    </span>
  );
}
