import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentContent } from "./agent-content";
import { CANT_FORMAT_NOTE } from "./limits";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    if (children.includes("explode")) throw new RangeError("Maximum call stack size exceeded");
    return <p>{children}</p>;
  },
}));

const author = { name: "Code Agent", kind: "agent" as const };

afterEach(() => vi.restoreAllMocks());

describe("when rendering agent text throws", () => {
  it("shows that text as plain text, keeps its author, and leaves its neighbors alone", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <>
        <AgentContent author={author} body="explode <img src=x>" />
        <AgentContent author={author} body="fine" />
      </>,
    );
    expect(screen.getByText(CANT_FORMAT_NOTE)).toBeInTheDocument();
    expect(screen.getByText("explode <img src=x>")).toBeInTheDocument();
    expect(screen.getByText("fine")).toBeInTheDocument();
    expect(screen.getAllByText("Code Agent")).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
  });

  it("tries again when the text changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<AgentContent author={author} body="explode" />);
    expect(screen.getByText(CANT_FORMAT_NOTE)).toBeInTheDocument();
    rerender(<AgentContent author={author} body="fine" />);
    expect(screen.queryByText(CANT_FORMAT_NOTE)).toBeNull();
    expect(screen.getByText("fine")).toBeInTheDocument();
  });
});
