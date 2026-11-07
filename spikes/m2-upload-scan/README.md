# Spike (M2 step 0): upload streaming and ClamAV scanning

Throwaway. It answers what [ADR 0006](../../docs/adr/0006-uploads-and-scanning.md) says the spike has to show. Nothing here is product code, and none of it reaches the normal deploy: each Worker has its own `podster-spike-*` name and config, and CI and `docs/staging.md` never touch this folder.

**Status: tested locally only.** The result goes into ADR 0006 after a real run.

## What's here

| Folder | What it is |
| --- | --- |
| `web/` | The application's shape. The only public address, and it answers 404 without the spike's token |
| `gateway/` | The gateway's shape. Refuses too large or no length before reading a byte, by service binding only |
| `api/` | The Rust API's shape, on `worker` 0.8.7. No route and no workers.dev address. Counts and hashes while streaming to R2 |
| `scanner/` | A queue consumer and a ClamAV Container, with no route or workers.dev address |
| `local/` | Test files, and the two measuring scripts |

The chain is web → gateway → API → R2, then queue → scanner → Container, with the verdict recorded back through the API. Logs carry IDs only.

## Local results

Run on 2026-11-06, on an Apple Silicon Mac with Docker Desktop, using ClamAV 1.5.4 with the signatures in the image (database 28172, November 2).

**Streaming through real workerd, local R2 and service bindings:**

- 100 MB went through with **1.3 MB of Wasm memory** at its peak, in 24,415 chunks of at most 4,096 bytes, so nothing buffers the file.
- 100,000,001 bytes answers 413, and no length answers 411.
- A wrong hash answers 422 and leaves no object. An upload cut off partway leaves no object.

**The scanner, under Docker's limits for each instance:**

| Instance | Memory at ready | After scanning 100 MB | Cold start |
| --- | --- | --- | --- |
| `basic` (1 GiB, 1/4 vCPU) | 1.02 GB, with 49 MB to spare | **OOM-killed** | 42 s |
| 2 GiB, 1/2 vCPU (Docker only: a custom instance needs 1 vCPU and 3 GiB) | 1.02 GB | Fine, 1.33 GB peak | 14 s |
| `standard-1` (4 GiB, 1/2 vCPU) | 1.02 GB | Fine, 1.33 GB peak, 2.0 GB during a signature reload | 14 to 15 s, 4 runs |

So `standard-1` is the smallest named instance that fits.

**Verdicts, all as expected:**

| File | Verdict | Said by | Time |
| --- | --- | --- | --- |
| Small text, empty, 100 MB of random bytes, an ordinary nested zip | clean | clamd | 100 MB: 6.8 s |
| EICAR, in a zip, and in nested zips | blocked | clamd | Milliseconds |
| Password-protected zip | blocked | clamd | 9 ms |
| Zip nested 15 deep | blocked | clamd | 45 ms |
| Zip of 20,000 files | blocked | clamd | 12 s |
| **Zip expanding to 2 GB** | blocked | **archive walk, clamd said OK** | 9.8 s |
| **Nested zip expanding to 655 GB** | blocked | **archive walk, clamd said OK** | 3.9 s |
| **EICAR past 150 MB inside a zip entry** | blocked | **archive walk, clamd said OK** | 0.9 s |
| **Truncated zip, and a fake zip** | blocked | **archive walk, clamd said OK** | Under 1 s |

**The main finding: ClamAV's limits aren't enough on their own.** With `AlertExceedsMax` on, it still answered OK for an archive it stopped reading at `MaxFileSize` or `MaxScanSize`, and for archives it couldn't parse. The EICAR row shows why that matters: a known test virus past the limit passed as clean. `container/server.py` adds a small walk after clamd says OK. It decompresses zips to count them, with the same limits, and blocks at the first one it exceeds. Bombs didn't threaten the scanner itself: no run ran out of memory on `standard-1`.

Limits of that walk: it only reads zip, including Office files, which are zips. Other archive types would have to be refused by the upload type check, as the upload policy already implies. It hasn't been tried against crafted zips, such as overlapping entries.

**Other results:**

- A scanner that never answers ends as `failed`, not clean, after the queue's retries and dead-letter queue.
- `freshclam` worked through the local proxy once Cloudflare's CA was trusted. It moved the database from 28172 to 28175 in 4.3 s, and the reload took 20 s more, with memory peaking at **2.0 GB**. So a reload needs room for both copies, which also rules out 2 GiB.
- `example.com` answered 520 from the local proxy, and the mirror's own answer was 403 to a request for `/`. That suggests the allowlist holds, but a local proxy isn't proof.

## What only a deployment can show

- **Cold start on real hardware.** Local was Apple Silicon, and `standard-1` is a real 1/2 vCPU on amd64. It sets how long the first scan after sleeping takes.
- **Whether the image runs there at all.** It built and ran as amd64 locally through emulation.
- **The request limit on a real host.** 100 MB is the limit on Free and Pro zones. workers.dev here says nothing about `app.podster.dev`, and the zone's plan is still unchecked.
- **CPU time** for hashing 100 MB in Wasm against the Worker's limit. Local has no CPU limit. Check `cpuTime` in the Workers metrics.
- **The real Worker memory limit,** and streaming with real latency between Workers and R2.
- **A 100 MB body from a Durable Object into its Container.** Cloudflare's 100 MiB limit is documented for external requests, and this path hasn't been tried at this size there.
- **The egress allowlist.** `/probes/probe` reports what `database.clamav.net` and `example.com` answer.
- **`freshclam` from Cloudflare's addresses.** `/probes/probe-update` reports its result, timing and memory. ClamAV's mirrors may refuse those addresses.

**Staying current is still a choice.** A Container's disk is lost when it sleeps, so an update in the Container lasts only until then. A real scanner needs either a scheduled image rebuild and deploy, with signatures as old as the last build and possibly no outbound traffic at all, or an update on every start, with a slower cold start. The second adds about 25 s here.

## Run it locally

Needs Docker, and the rustup toolchain rather than Homebrew's Rust, plus `worker-build` 0.8.7. Run everything from this folder.

```bash
export PATH="$(dirname "$(rustup which rustc)"):$HOME/.cargo/bin:$PATH"
```

```bash
npm ci
```

```bash
npm run fixtures
```

```bash
npm run measure:container
```

```bash
npm run measure:path
```

`npm run fixtures` makes test files in `fixtures/`, about 200 MB, none with real data. Results go to `results/`. Neither folder is committed.

## Deploy to staging (for whoever holds the account)

None of this has been run. It needs Docker running. The queues `podster-scan-staging` and `podster-scan-dlq-staging` and the private bucket `podster-assets-staging` already exist. Keep the account ID in the environment, not in this repo.

```bash
export CLOUDFLARE_ACCOUNT_ID=<the account holding podster.dev>
```

```bash
export PATH="$(dirname "$(rustup which rustc)"):$HOME/.cargo/bin:$PATH"
```

```bash
npm ci
```

Add a rule that removes what the spike leaves behind. It covers the whole bucket, so only add it while the bucket holds nothing else.

```bash
npx wrangler r2 bucket lifecycle add podster-assets-staging spike-expiry --expire-days 7 --force
```

Deploy in this order, because each one binds the one before. The scanner step builds and pushes the image, and takes a few minutes.

```bash
npx wrangler deploy -c api/wrangler.jsonc
```

```bash
npx wrangler deploy -c scanner/wrangler.jsonc
```

```bash
npx wrangler deploy -c gateway/wrangler.jsonc
```

```bash
npx wrangler deploy -c web/wrangler.jsonc
```

Set the token. Pick any long random value, and don't put it in the repo. It's the only secret here, and only `web` holds it.

```bash
npx wrangler secret put SPIKE_TOKEN -c web/wrangler.jsonc
```

Then run the same path against it, using the address `wrangler deploy` printed for `web`, and read the results in `results/path-deployed.json`.

```bash
npm run fixtures
```

```bash
SPIKE_URL=https://podster-spike-web.<subdomain>.workers.dev SPIKE_TOKEN=<token> npm run measure:path
```

The real cold start is `cold_start_ms` on the first verdict. Also check `cpuTime` for `podster-spike-api` in the dashboard, and that `wrangler tail` shows IDs only.

## Cost at spike volume (my estimate)

Assuming about 25 uploads, under 2 GB stored, and the Container awake for about an hour in total. Everything falls inside what Workers Paid and R2 include, so I expect **$0 above the plan**.

| Resource | Spike use | Included per month | Past that |
| --- | --- | --- | --- |
| Container memory, `standard-1` | 4 GiB-hours | 25 GiB-hours | $0.0000025 per GiB-second |
| Container CPU, active only | Under 30 vCPU-minutes | 375 vCPU-minutes | $0.000020 per vCPU-second |
| Container disk | 8 GB-hours | 200 GB-hours | $0.00000007 per GB-second |
| R2 storage | Under 2 GB | 10 GB-months | $0.015 per GB-month |
| R2 operations | Hundreds | 1M writes, 10M reads | $4.50 and $0.36 per million |
| Queues, Workers, Durable Objects | Hundreds of operations | Far more | Not reached |

The Container bills only while awake and sleeps after 5 minutes, so leaving it deployed costs nothing while idle. For scale, one hour past the allowance is about $0.04 of memory, and a `standard-1` that never slept would be about $26 a month in memory alone. I didn't find a stated charge for image storage. Check the billing page afterward.

## Tear it down

```bash
npx wrangler delete podster-spike-web
```

```bash
npx wrangler delete podster-spike-gateway
```

```bash
npx wrangler delete podster-spike-scanner
```

```bash
npx wrangler delete podster-spike-api
```

```bash
npx wrangler containers images list
```

```bash
npx wrangler containers images delete <the image it lists for podster-spike-scanner>
```

Keep the bucket and the queues if M2's real build will use them, because their names are the real ones. Only `spike/` and `results/` objects come from this spike, and the 7-day rule removes them. Remove that rule when the real build starts, or real files would expire too:

```bash
npx wrangler r2 bucket lifecycle remove podster-assets-staging --name spike-expiry
```

To remove the bucket as well, wait for it to empty, then:

```bash
npx wrangler r2 bucket delete podster-assets-staging
```
