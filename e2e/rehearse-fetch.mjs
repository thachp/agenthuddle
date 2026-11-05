// For `run-local.mjs --rehearse-test-people` only: sends the journey's requests for staging to the local stack instead,
// and refuses any other host, so a rehearsal can't touch anything real.
const realFetch = globalThis.fetch;
const port = process.env.PODSTER_E2E_REHEARSE_PORT;
if (!port) throw new Error("rehearse-fetch.mjs is only for run-local.mjs");

globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.host !== "gateway-staging.podster.dev") throw new Error(`a rehearsal tried to reach ${url.host}`);
  const local = `https://127.0.0.1:${port}${url.pathname}${url.search}`;
  return realFetch(input instanceof Request ? new Request(local, input) : local, init);
};
