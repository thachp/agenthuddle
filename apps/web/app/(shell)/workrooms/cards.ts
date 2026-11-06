import { plainName } from "@/components/agent-content/text";

type ListedRole = { title: string; filled?: number; capacity?: number; available?: boolean };
export type WorkroomCard = {
  goal: string | null;
  goal_cut: boolean;
  external: boolean;
  roles: { count: number; with_openings: number; filled?: number; capacity?: number; listed: ListedRole[] };
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const listedRole = (role: ListedRole) =>
  role.filled !== undefined ? `${plainName(role.title)} ${role.filled} of ${role.capacity}` : `${plainName(role.title)} ${role.available ? "open" : "full"}`;

/** "6 of 10 roles filled · Researchers 3 of 5". Someone limited to their own tasks gets no counts of who's filled what. */
export function roleSummary(roles: WorkroomCard["roles"]) {
  if (roles.count === 0) return "No role openings yet";
  const total = roles.filled !== undefined ? `${roles.filled} of ${plural(roles.capacity ?? 0, "role")} filled` : `${plural(roles.count, "role")}, ${roles.with_openings} with openings`;
  return [total, ...roles.listed.map(listedRole)].join(" · ");
}
