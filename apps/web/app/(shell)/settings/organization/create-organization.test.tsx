import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { CreateOrganization } from "./create-organization";

describe("creating an organization", () => {
  beforeEach(() => setUrl("/settings/organization"));

  it("shows the server's result and refreshes the list", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "org_2", name: "Acme", role: "admin" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateOrganization />);
    await userEvent.type(screen.getByLabelText("Name"), "  Acme ");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Created Acme");
    expect(routerCalls.refresh).toBe(1);
    expect(fetchMock.mock.calls[0]).toEqual(["/api/orgs", expect.objectContaining({ method: "POST", body: '{"name":"Acme"}' })]);
  });

  it("keeps the name when it fails, and doesn't send an empty one", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "invalid_argument" } }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateOrganization />);
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Name"), "Too long");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't allowed");
    expect(screen.getByLabelText("Name")).toHaveValue("Too long");
    expect(routerCalls.refresh).toBe(0);
  });
});
