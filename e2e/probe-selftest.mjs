// Checks that the AC-19 probe can fail: an always-green probe would prove nothing.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const probe = join(dirname(fileURLToPath(import.meta.url)), "probe-api.mjs");
const run = (args) => new Promise((done) => spawn(process.execPath, [probe, ...args], { stdio: "ignore" }).on("exit", done));

// Answers the way apps/api does: `ok` from /health, and invalid_assertion without an assertion.
const fakeApi = createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  res.statusCode = 401;
  res.end('{"error":{"code":"invalid_assertion","message":"invalid_assertion"}}');
});
await new Promise((done) => fakeApi.listen(0, "127.0.0.1", done));
const { port } = fakeApi.address();

const cases = [
  ["a gateway that is really the API", ["--gateway", `http://127.0.0.1:${port}`, "--gateway-only"], 1],
  ["a gateway nothing answers on", ["--gateway", "http://127.0.0.1:9", "--gateway-only"], 1],
  ["no gateway at all", [], 2],
];
let failed = false;
for (const [name, args, expected] of cases) {
  const code = await run(args);
  console.log(`${code === expected ? "ok  " : "FAIL"} the probe, given ${name}, exits ${code}`);
  if (code !== expected) failed = true;
}
fakeApi.close();
process.exit(failed ? 1 : 0);
