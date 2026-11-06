import { parseBody, type ParsedBody } from "./parse";

/** A worker that answers only when told to, and remembers what it was asked. */
export class FakeWorker {
  static all: FakeWorker[] = [];
  static refuse = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  asked: string[] = [];
  terminated = false;

  constructor() {
    if (FakeWorker.refuse) throw new Error("refused by policy");
    FakeWorker.all.push(this);
  }
  postMessage({ text }: { text: string }) {
    this.asked.push(text);
  }
  terminate() {
    this.terminated = true;
  }
  ready() {
    this.onmessage?.({ data: { ready: true } });
  }
  /** Parses for real, unless told what the result is. */
  answer(text = this.asked.at(-1)!, parsed: ParsedBody | null = parseBody(text)) {
    this.onmessage?.({ data: { text, parsed } });
  }
  static get last() {
    return FakeWorker.all.at(-1)!;
  }
  static reset() {
    FakeWorker.all = [];
    FakeWorker.refuse = false;
  }
}
