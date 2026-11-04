# Spike (c): SQLite-backed Durable Objects in Rust

Throwaway Phase 0 spike. It tests the kernel's storage behaviors with `workers-rs` in the local Workers runtime. It isn't kernel code, and it isn't deployed.

Needs the rustup toolchain, not Homebrew's Rust, plus `worker-build`:

```bash
export PATH="$(dirname "$(rustup which rustc)"):$HOME/.cargo/bin:$PATH"
npm install
npm test
```

## What it proves

- A task, its event and its outbox row commit together, and a failure after writing rolls them all back.
- A retry returns the first result, and a changed request with the same key is refused.
- Of 20 concurrent accepts, exactly one wins. Stale versions and wrong actors write nothing.
- An alarm drains the outbox into a second object's inbox, and delivery is idempotent.
- Undelivered events stay queued through failures and an object restart.
- Migrations run once and in order, synchronously in the constructor.

## Findings for the spec

1. **Use `transactionSync`, not the crate's `transaction`.** `worker` 0.8.7 only exposes the async form. In that form, a Rust panic mid-transaction left the object wedged: the request and the next one to that object both hung until a restart, although no partial writes survived. Calling `storage.transactionSync` through a small binding rolled back and kept the object working.
2. **A panic still hangs its own request.** The panicking request never gets a response, under either form, and the Wasm app reinitializes. Kernel commands should return errors rather than panic, and the gateway needs a request timeout. After a panic the logs also show "Cannot invoke closure from previous WASM instance".
3. **The compound `SELECT` limit is confirmed.** 5 terms work and 6 fail, so the test database should set the same limit.
4. **The build needs rustup.** `worker-build` can't find the Wasm target through Homebrew's `rustc`, and `~/.cargo/bin` here has no rustup shims, so CI should pin the toolchain.

## Not proven

- Nothing here has been deployed. Panic and restart behavior come from local `workerd` and could differ in production.
- `transactionSync` is reached through a hand-written binding, which a future `worker` release should replace.
- Commands are simplified shapes, not the kernel's real permission checks.
- The disconnect fence isn't built yet, so its latency is unmeasured. Local timings wouldn't predict it anyway.
