import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const command = vi.fn();
vi.mock("@/lib/gateway/client", () => ({ clientCommand: (...args: unknown[]) => command(...args) }));

const { PlannedLines } = await import("./planned-lines");

const roles = [{ id: "rol_a", title: "Architect" }, { id: "rol_b", title: "Engineer" }];
const line = { id: "rel_1", from_role: "rol_a", from_title: "Architect", to_role: "rol_b", to_title: "Engineer", label: "Hands designs to", created_by: "per_me", created_at: 1, setBy: "You" };
const show = (lines: (Omit<typeof line, "setBy"> & { setBy: string | null })[] = [line], external = false) => render(<PlannedLines roomId="ws_1" lines={lines} external={external} roles={roles} canManage archived={false} policyVersion={3} />);
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
    const same = screen.getByText("Choose two different roles.");
    expect(same.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "To role" })).toHaveAccessibleDescription("Choose two different roles.");
    await user.click(screen.getByRole("button", { name: "Add planned line" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "To role" }), "rol_b");
    await user.click(screen.getByRole("textbox", { name: "What flows between them" }));
    await user.paste("é".repeat(100));
    expect(screen.getByText(/Keep this to 200 bytes/).closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "What flows between them" })).toHaveAccessibleDescription("Keep this to 200 bytes.");
    await user.click(screen.getByRole("button", { name: "Add planned line" }));
    expect(command).not.toHaveBeenCalled();
  });

  it("says so when a label is only spaces, announces it and goes back to the field", async () => {
    show([]);
    const user = await fill("rol_a", "rol_b", "   ");
    await user.click(screen.getByRole("button", { name: "Add planned line" }));
    expect(command).not.toHaveBeenCalled();
    const field = screen.getByRole("textbox", { name: "What flows between them" });
    expect(screen.getByText(/Spaces alone don't count/).closest('[role="alert"]')).not.toBeNull();
    expect(field).toHaveAccessibleDescription(/Spaces alone don't count/);
    expect(field).toHaveFocus();
    await user.type(field, "Hands over");
    expect(screen.queryByText(/Spaces alone/)).toBeNull();
  });

  it("marks a label as someone's words, says who set it even when it can't name them, and marks another organization's", () => {
    const { setBy: _unknown, ...rest } = line;
    const first = show([{ ...rest, setBy: null }], true);
    expect(screen.getByText("Label: “Hands designs to”")).toBeInTheDocument();
    expect(screen.getByText("Set by the workroom's owner or an admin. Planned, not recorded.")).toBeInTheDocument();
    expect(screen.getByText("External")).toBeInTheDocument();
    first.unmount();
    show();
    expect(screen.getByText("Set by You. Planned, not recorded.")).toBeInTheDocument();
    expect(screen.queryByText("External")).toBeNull();
  });

  it("says what a refusal means, and keeps what was typed", async () => {
    command.mockResolvedValue({ ok: false, status: 409, code: "relationship_exists" });
    show([]);
    const user = await fill("rol_a", "rol_b", "Again");
    await user.click(screen.getByRole("button", { name: "Add planned line" }));
    expect((await screen.findByText(/already planned, in that direction\. Nothing changed\./)).closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "What flows between them" })).toHaveValue("Again");
  });

  it("removes only once confirmed, and sends focus to the result", async () => {
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(command).not.toHaveBeenCalled();
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByRole("heading", { name: "Remove “Architect to Engineer”?" })).toBeInTheDocument();
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
