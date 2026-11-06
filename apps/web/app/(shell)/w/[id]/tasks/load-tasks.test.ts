import { describe, expect, it, vi } from "vitest";
import type { GatewayResult } from "@/lib/gateway/result";
import { isOutage, loadNames, MAX_NAMED_ORGS, orgNamesOf } from "./load-tasks";

const org = (id: string, personal = 0) => ({ id, name: id.toUpperCase(), personal });

function query(replies: Record<string, unknown>) {
  return vi.fn(async (path: string): Promise<GatewayResult<never>> => (path in replies ? { ok: true, data: replies[path] as never } : { ok: false, status: 503, code: "error" }));
}

describe("loadNames", () => {
  it("names agents and people, with one read per shared organization and none for a personal one", async () => {
    const q = query({ "/api/agents": { agents: [{ id: "agt_1", name: "Builder" }] }, "/api/orgs/org_a/members": { members: [{ person_id: "per_1", name: "Sam" }, { person_id: "per_2", name: null }] } });
    expect(await loadNames(q as never, [org("org_a"), org("org_p", 1)])).toEqual({ agt_1: "Builder", per_1: "Sam" });
    expect(q.mock.calls.map(([path]) => path).sort()).toEqual(["/api/agents", "/api/orgs/org_a/members"]);
  });

  it("stops at the limit, however many organizations someone is in", async () => {
    const q = query({});
    await loadNames(q as never, Array.from({ length: MAX_NAMED_ORGS + 4 }, (_, i) => org(`org_${i}`)));
    expect(q).toHaveBeenCalledTimes(MAX_NAMED_ORGS + 1);
  });

  it("leaves IDs when a read fails, rather than failing the screen", async () => {
    expect(await loadNames(query({}) as never, [org("org_a")])).toEqual({});
  });

  it("names only the viewer's organizations", () => expect(orgNamesOf([org("org_a")])).toEqual({ org_a: "ORG_A" }));
});

describe("isOutage", () => {
  it("is what says nothing about access: a success, a server failure or a rate limit", () => {
    expect(isOutage({ ok: true, data: null })).toBe(true);
    expect(isOutage({ ok: false, status: 503, code: "x" })).toBe(true);
    expect(isOutage({ ok: false, status: 429, code: "x" })).toBe(true);
  });

  it.each([401, 403, 404])("a %i may mean access is gone", (status) => {
    expect(isOutage({ ok: false, status, code: "x" })).toBe(false);
  });
});
