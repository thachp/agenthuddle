import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const command = vi.fn();
vi.mock("@/lib/gateway/client", () => ({ clientCommand: (...args: unknown[]) => command(...args) }));

const { PlannedLines } = await import("./planned-lines");

const roles = [{ id: "rol_a", title: "Architect" }, { id: "rol_b", title: "Engineer" }];
const line = { id: "rel_1", from_role: "rol_a", from_title: "Architect", to_role: "rol_b", to_title: "Engineer", label: "Hands designs to", created_by: "per_me", created_at: 1, setBy: "You" };
const show = (lines = [line]) => render(<PlannedLines roomId="ws_1" lines={lines} roles={roles} canManage archived={false} policyVersion={3} />);
const fill = async (from: string, to: string, label: string) => {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole("combobox", { name: "From role" }), from);
  await user.selectOptions(screen.getByRole("combobox", { name: "To role" }), to);
  await user.type(screen.getByRole("textbox", { name: "What flows between them" }), label);
  return user;
};

beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue({ ok: true, data: {} });
});

describe("PlannedLines", () => {
  it("adds a line with the room's version and a trimmed label, then clears and says what it means", async () => {
    show([]);
    const user = await fill("rol_a", "rol_b", "  Hands designs to ");
    await user.click(screen.getByRole("button", { name: "Add planned line" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    const [path, body, options] = command.mock.calls[0];
    expect(path).toBe("/api/v1/workspaces/ws_1/collaboration/planned");
    expect(body).toEqual({ policy_version: 3, from_role_id: "rol_a", to_role_id: "rol_b", label: "Hands designs to" });
    expect(options.method).toBe("POST");
    expect(options.idempotencyKey).toBeTruthy();
    expect(await screen.findByText(/changes nobody's access/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "What flows between them" })).toHaveValue("");
    expect(screen.getByRole("status")).toHaveFocus();
  });

  it("won't send a line from a role to itself, or a label over the limit", async () => {
    show([]);
    const user = await fill("rol_a", "rol_a", "x");
    expect(screen.getByText("Choose two different roles.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add planned line" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "To role" }), "rol_b");
    await user.click(screen.getByRole("textbox", { name: "What flows between them" }));
    await user.paste("é".repeat(100));
    expect(screen.getByText(/Keep this to 200 bytes/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add planned line" }));
    expect(command).not.toHaveBeenCalled();
  });

  it("says what a refusal means, and keeps what was typed", async () => {
    command.mockResolvedValue({ ok: false, status: 409, code: "relationship_exists" });
    show([]);
    const user = await fill("rol_a", "rol_b", "Again");
    await user.click(screen.getByRole("button", { name: "Add planned line" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already planned, in that direction. Nothing changed.");
    expect(screen.getByRole("textbox", { name: "What flows between them" })).toHaveValue("Again");
  });

  it("removes only once confirmed, and sends focus to the result", async () => {
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(command).not.toHaveBeenCalled();
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByText(/changes nobody's access and no task/)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Remove line" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    const [path, body, options] = command.mock.calls[0];
    expect(path).toBe("/api/v1/workspaces/ws_1/collaboration/planned/rel_1");
    expect(body).toEqual({ policy_version: 3 });
    expect(options.method).toBe("DELETE");
    await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("Planned line removed.");
  });

  it("makes a list row a place a map link can land", () => {
    const { container } = show();
    expect(container.querySelector("#planned-rel_1")).toHaveAttribute("tabindex", "-1");
  });
});
