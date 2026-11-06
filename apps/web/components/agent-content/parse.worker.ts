import { parseBody } from "./parse";

// It only turns text into data. parse-client.ts ends this worker if it takes too long.
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<{ text: string }>) => void) | null };
scope.onmessage = ({ data }) => scope.postMessage({ text: data.text, parsed: parseBody(data.text) });
scope.postMessage({ ready: true });
