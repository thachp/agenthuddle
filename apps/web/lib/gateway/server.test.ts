import { beforeEach, describe, expect, it, vi } from "vitest";

const fetch = vi.fn<(url: string, init: { headers: Headers }) => Promise<Response>>();
vi.mock("./env", () => ({ webEnv: () => ({ GATEWAY: { fetch }, APP_URL: "https://app.test" }) }));
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));

const { gatewayQuery, getSession } = await import("./server");

describe("server reads", () => {
  beforeEach(() => fetch.mockReset());

  it("calls the gateway as the application host, with no origin", async () => {
    fetch.mockResolvedValue(Response.json({ id: "per_1" }));
    await expect(gatewayQuery("/api/v1/me")).resolves.toEqual({ ok: true, data: { id: "per_1" } });
    expect(fetch.mock.calls[0][0]).toBe("https://app.test/api/v1/me");
    expect(fetch.mock.calls[0][1].headers.get("origin")).toBeNull();
  });

  it("keeps a refusal's stable code", async () => {
    fetch.mockResolvedValue(Response.json({ error: { code: "not_allowed" } }, { status: 403 }));
    await expect(gatewayQuery("/api/v1/me")).resolves.toEqual({ ok: false, status: 403, code: "not_allowed" });
  });

  it("no session is null", async () => {
    fetch.mockResolvedValue(Response.json(null));
    await expect(getSession()).resolves.toBeNull();
  });

  it("an outage isn't a signed-out person", async () => {
    fetch.mockResolvedValue(new Response("down", { status: 503 }));
    await expect(getSession()).rejects.toThrow("gateway_unavailable");
  });
});
