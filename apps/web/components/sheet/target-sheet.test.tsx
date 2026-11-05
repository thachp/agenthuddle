import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import type { GatewayResult } from "@/lib/gateway/result";
import { back, currentUrl, navigate, routerCalls, setUrl } from "@/test/next-navigation";
import { SheetLink, TargetSheet, type SheetBinding } from "./target-sheet";

type Item = { id: string; title: string; version: number };

const ITEMS: Record<string, Item> = {
  a: { id: "a", title: "Agent A", version: 3 },
  b: { id: "b", title: "Agent B", version: 7 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const resolved = (id: string) => Promise.resolve(ITEMS[id] ?? null);

function Editor({ data, setDirty }: { data: Item; setDirty: (dirty: boolean) => void }) {
  const [value, setValue] = useState("");
  return (
    <label>
      Notes for {data.id}
      <input
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setDirty(true);
        }}
      />
    </label>
  );
}

function Screen({
  load = resolved,
  command = async () => ({ ok: true, data: {} }),
}: {
  load?: (id: string, init: { signal: AbortSignal }) => Promise<Item | null>;
  command?: (binding: SheetBinding) => Promise<GatewayResult<unknown>>;
}) {
  return (
    <>
      <main id="main-content" tabIndex={-1}>
        <SheetLink param="agent" target="a">
          Open A
        </SheetLink>
        <SheetLink param="agent" target="b">
          Open B
        </SheetLink>
      </main>
      <TargetSheet<Item> param="agent" noun="agent" load={load} title={(item) => item.title} description={() => "Workroom: Developer Platform"} version={(item) => item.version}>
        {({ data, setDirty, run, saving }) => (
          <>
            <Editor key={data.id} data={data} setDirty={setDirty} />
            <Button disabled={saving} onClick={() => void run(command)}>
              Save changes
            </Button>
          </>
        )}
      </TargetSheet>
    </>
  );
}

const title = (name: string) => screen.findByRole("heading", { name });

describe("TargetSheet", () => {
  beforeEach(() => setUrl("/agents"));

  describe("URL state", () => {
    it("stays closed without a target", () => {
      render(<Screen />);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("opens from a deep link, as on reload (UI-05)", async () => {
      setUrl("/agents?agent=a&view=all");
      render(<Screen />);
      expect(await title("Agent A")).toBeInTheDocument();
      expect(screen.getByText("Workroom: Developer Platform")).toBeInTheDocument();
    });

    it("opens from a link that keeps other parameters, and Back closes it", async () => {
      setUrl("/agents?view=all");
      render(<Screen />);
      await userEvent.click(screen.getByRole("link", { name: "Open A" }));
      expect(currentUrl()).toBe("/agents?view=all&agent=a");
      await title("Agent A");
      act(() => back());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("closing clears only its own parameter", async () => {
      setUrl("/agents?view=all&agent=a");
      render(<Screen />);
      await title("Agent A");
      await userEvent.keyboard("{Escape}");
      expect(currentUrl()).toBe("/agents?view=all");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("shows one message for a missing or hidden target, and leaks no title (UI-05)", async () => {
      setUrl("/agents?agent=hidden");
      render(<Screen load={async () => null} />);
      const notice = await screen.findByRole("alert");
      expect(notice).toHaveTextContent("We can't find that. It may not exist, or you may not have access to it.");
      expect(notice).not.toHaveTextContent("hidden");
      expect(currentUrl()).toBe("/agents");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("closes the same way when access ends while it's open", async () => {
      setUrl("/agents?agent=a");
      let allowed = true;
      render(<Screen load={async (id) => (allowed ? ITEMS[id] : null)} command={async () => ((allowed = false), { ok: true, data: {} })} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("We can't find that");
      expect(screen.queryByText("Agent A")).toBeNull();
    });
  });

  describe("focus", () => {
    it("moves to the title on open", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      expect(await title("Agent A")).toHaveFocus();
    });

    it("stays inside while open", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      const dialog = await screen.findByRole("dialog");
      await title("Agent A");
      for (let i = 0; i < 6; i += 1) {
        await userEvent.tab();
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
      }
    });

    it("returns to the launching control on Escape", async () => {
      render(<Screen />);
      await userEvent.click(screen.getByRole("link", { name: "Open B" }));
      await title("Agent B");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.getByRole("link", { name: "Open B" })).toHaveFocus());
    });

    it("returns to the launching control from the close button", async () => {
      render(<Screen />);
      await userEvent.click(screen.getByRole("link", { name: "Open A" }));
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.getByRole("link", { name: "Open A" })).toHaveFocus());
    });

    it("after a reload, still finds the row that opens it", async () => {
      setUrl("/agents?agent=b");
      render(<Screen />);
      await title("Agent B");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.getByRole("link", { name: "Open B" })).toHaveFocus());
    });

    it("falls back to the main content when the launcher has gone", async () => {
      setUrl("/agents?agent=a");
      render(
        <>
          <main id="main-content" tabIndex={-1} />
          <TargetSheet<Item> param="agent" load={resolved} title={(item) => item.title} description={() => "Room"}>
            {() => null}
          </TargetSheet>
        </>,
      );
      await title("Agent A");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(document.getElementById("main-content")).toHaveFocus());
    });
  });

  describe("binding to the original target (AC-21)", () => {
    it("a stale response never shows on a newly selected target", async () => {
      const responses: Record<string, ReturnType<typeof deferred<Item | null>>> = { a: deferred(), b: deferred() };
      setUrl("/agents?agent=a");
      render(<Screen load={(id) => responses[id].promise} />);
      await act(async () => navigate("/agents?agent=b"));
      await act(async () => responses.b.resolve(ITEMS.b));
      await title("Agent B");
      await act(async () => responses.a.resolve(ITEMS.a));
      expect(screen.getByRole("heading", { name: "Agent B" })).toBeInTheDocument();
      expect(screen.queryByText("Agent A")).toBeNull();
    });

    it("aborts the request it no longer needs", async () => {
      const signals: Record<string, AbortSignal> = {};
      setUrl("/agents?agent=a");
      render(
        <Screen
          load={(id, { signal }) => {
            signals[id] = signal;
            return resolved(id);
          }}
        />,
      );
      await title("Agent A");
      expect(signals.a.aborted).toBe(false);
      await act(async () => navigate("/agents?agent=b"));
      await title("Agent B");
      expect(signals.a.aborted).toBe(true);
    });

    it("a late failure for the old target doesn't touch the new one", async () => {
      const first = deferred<Item | null>();
      setUrl("/agents?agent=a");
      render(<Screen load={(id) => (id === "a" ? first.promise : resolved(id))} />);
      await act(async () => navigate("/agents?agent=b"));
      await title("Agent B");
      await act(async () => first.reject(new Error("late")));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a late not-found for the old target doesn't close the new one", async () => {
      const first = deferred<Item | null>();
      setUrl("/agents?agent=a");
      render(<Screen load={(id) => (id === "a" ? first.promise : resolved(id))} />);
      await act(async () => navigate("/agents?agent=b"));
      await title("Agent B");
      await act(async () => first.resolve(null));
      expect(screen.getByRole("heading", { name: "Agent B" })).toBeInTheDocument();
      expect(currentUrl()).toBe("/agents?agent=b");
    });

    it("a save in flight keeps its target and version, and finishes before the Sheet moves on", async () => {
      const save = deferred<GatewayResult<unknown>>();
      const command = vi.fn((_: SheetBinding) => save.promise);
      setUrl("/agents?agent=a");
      render(<Screen command={command} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(command).toHaveBeenCalledWith({ target: "a", version: 3 });

      await act(async () => navigate("/agents?agent=b"));
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Agent B" })).toBeNull();

      await act(async () => save.resolve({ ok: true, data: {} }));
      await title("Agent B");
      expect(command).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a save that fails after a switch reports on its own target, not the new one", async () => {
      const save = deferred<GatewayResult<unknown>>();
      setUrl("/agents?agent=a");
      render(<Screen command={() => save.promise} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await act(async () => navigate("/agents?agent=b"));
      await act(async () => save.resolve({ ok: false, status: 403, code: "not_allowed" }));
      await title("Agent B");
    });

    it("can't close while a save is in flight, so its result isn't lost", async () => {
      const save = deferred<GatewayResult<unknown>>();
      setUrl("/agents?agent=a");
      render(<Screen command={() => save.promise} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
      expect(currentUrl()).toBe("/agents?agent=a");
      await act(async () => save.resolve({ ok: false, status: 403, code: "not_allowed" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("That didn't save, and nothing changed.");
    });

    it("ignores a repeated save", async () => {
      const save = deferred<GatewayResult<unknown>>();
      const command = vi.fn(() => save.promise);
      setUrl("/agents?agent=a");
      let trigger!: () => void;
      render(
        <TargetSheet<Item> param="agent" load={resolved} title={(item) => item.title} description={() => "Room"}>
          {({ run }) => {
            trigger = () => void run(command);
            return null;
          }}
        </TargetSheet>,
      );
      await title("Agent A");
      await act(async () => {
        trigger();
        trigger();
      });
      expect(command).toHaveBeenCalledTimes(1);
      await act(async () => save.resolve({ ok: true, data: {} }));
    });

    it("a successful save reloads the server's state and refreshes the list behind", async () => {
      let version = 3;
      setUrl("/agents?agent=a");
      const load = vi.fn(async () => ({ ...ITEMS.a, title: `Agent A v${version}`, version }));
      render(<Screen load={load} command={async () => ((version = 4), { ok: true, data: {} })} />);
      await title("Agent A v3");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await title("Agent A v4");
      expect(routerCalls.refresh).toBe(1);
    });
  });

  describe("unsaved edits", () => {
    const edit = async () => {
      await userEvent.type(screen.getByRole("textbox"), "x");
      expect(await screen.findByRole("status")).toHaveTextContent("Unsaved changes");
    };

    it("Escape asks first, and keeping them changes nothing", async () => {
      const command = vi.fn(async () => ({ ok: true as const, data: {} }));
      setUrl("/agents?agent=a");
      render(<Screen command={command} />);
      await title("Agent A");
      await edit();
      await userEvent.keyboard("{Escape}");
      expect(await screen.findByRole("alertdialog")).toHaveTextContent("Your changes to “Agent A” won't be saved.");
      await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(screen.getByRole("textbox")).toHaveValue("x");
      expect(currentUrl()).toBe("/agents?agent=a");
      expect(command).not.toHaveBeenCalled();
    });

    it("discarding closes without saving (AC-20)", async () => {
      const command = vi.fn(async () => ({ ok: true as const, data: {} }));
      setUrl("/agents?agent=a");
      render(<Screen command={command} />);
      await title("Agent A");
      await edit();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await userEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(currentUrl()).toBe("/agents");
      expect(command).not.toHaveBeenCalled();
    });

    it("Back to another target asks first, and staying restores the URL", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      await title("Agent A");
      await edit();
      await act(async () => navigate("/agents?agent=b"));
      await screen.findByRole("alertdialog");
      expect(screen.getByRole("textbox", { hidden: true })).toHaveValue("x");
      await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(currentUrl()).toBe("/agents?agent=a");
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("x");
    });

    it("Escape on the question keeps the edits", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      await title("Agent A");
      await edit();
      await userEvent.keyboard("{Escape}");
      await screen.findByRole("alertdialog");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByRole("textbox")).toHaveValue("x");
      expect(currentUrl()).toBe("/agents?agent=a");
    });

    it("discarding on a switch opens the new target with nothing carried over", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      await title("Agent A");
      await edit();
      await act(async () => navigate("/agents?agent=b"));
      await userEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
      await title("Agent B");
      expect(screen.getByRole("textbox")).toHaveValue("");
      expect(screen.queryByText("Unsaved changes")).toBeNull();
    });
  });

  describe("conflicts and failures", () => {
    it("keeps input on a version conflict, and offers the latest", async () => {
      setUrl("/agents?agent=a");
      const load = vi.fn(resolved);
      render(<Screen load={load} command={async () => ({ ok: false, status: 409, code: "version_conflict" })} />);
      await title("Agent A");
      await userEvent.type(screen.getByRole("textbox"), "mine");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This agent changed while you were editing. Your changes aren't saved.");
      expect(screen.getByRole("textbox")).toHaveValue("mine");
      expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
      await userEvent.click(screen.getByRole("button", { name: "Review latest" }));
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    });

    it("says a denied save didn't happen", async () => {
      setUrl("/agents?agent=a");
      render(<Screen command={async () => ({ ok: false, status: 403, code: "not_allowed" })} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("That didn't save, and nothing changed.");
      expect(routerCalls.refresh).toBe(0);
    });

    it("offers a retry when a read fails, and shows no title", async () => {
      setUrl("/agents?agent=a");
      const load = vi.fn<(id: string) => Promise<Item | null>>().mockRejectedValueOnce(new Error("down")).mockResolvedValue(ITEMS.a);
      render(<Screen load={load} />);
      expect(await title("Couldn't load this")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await title("Agent A")).toBeInTheDocument();
    });

    it("keeps prior data when a refresh fails", async () => {
      setUrl("/agents?agent=a");
      const load = vi.fn<(id: string) => Promise<Item | null>>().mockResolvedValueOnce(ITEMS.a).mockRejectedValue(new Error("down"));
      render(<Screen load={load} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't refresh.");
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
    });
  });

  it("refuses to open a Sheet from inside a Sheet", async () => {
    setUrl("/agents?agent=a");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <TargetSheet<Item> param="agent" load={async () => ITEMS.a} title={(item) => item.title} description={() => "Room"}>
          {() => (
            <SheetLink param="other" target="x">
              Another
            </SheetLink>
          )}
        </TargetSheet>,
      ),
    ).not.toThrow();
    // React rethrows the render error from the load's update.
    await expect(act(async () => new Promise((resolve) => setTimeout(resolve, 0)))).rejects.toThrow("A Sheet can't open another Sheet");
    error.mockRestore();
  });
});
