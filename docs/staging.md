# Deploying to staging

Staging runs at `gateway-staging.podster.dev`, on the Cloudflare account that holds `podster.dev`.

## Before you start

- Node, and `npm ci` in `apps/gateway` and `apps/api`.
- Rust and `worker-build` 0.8.7, because deploying the API builds it: `cargo install worker-build --version 0.8.7 --locked`.
- `npx wrangler login` from an app folder, or `CLOUDFLARE_API_TOKEN` in your shell.
- The account ID in your shell. It stays out of this repo.

```bash
export CLOUDFLARE_ACCOUNT_ID=<the account that holds podster.dev>
```

Run every `wrangler` command from the app folder named in its step, so it uses that app's pinned version.

## First deploy

This has been done once for staging, so it's kept here for rebuilding it, and as the outline for production. To ship a change, run `npx wrangler deploy --env staging` from the app that changed, and apply any new migrations first.

### 1. Register the GitHub OAuth app

In GitHub, go to Settings, then Developer settings, then OAuth Apps. Use these values, and keep the client ID and secret for step 6:

- **Homepage URL:** `https://gateway-staging.podster.dev`
- **Authorization callback URL:** `https://gateway-staging.podster.dev/api/auth/callback/github`

### 2. Create the databases and KV namespace

From `apps/gateway`. If wrangler offers to add a binding to your config, answer no, because it would write to the top level and not to `env.staging`.

```bash
npx wrangler d1 create podster-gateway-staging
```

```bash
npx wrangler kv namespace create podster-oauth-staging
```

From `apps/api`, again answering no:

```bash
npx wrangler d1 create podster-api-staging
```

Staging's IDs are already in the two `wrangler.jsonc` files. If you ever recreate these, put the new IDs under `env.staging` there.

### 3. Apply migrations

From `apps/gateway`:

```bash
npx wrangler d1 migrations apply podster-gateway-staging --remote --env staging
```

From `apps/api`:

```bash
npx wrangler d1 migrations apply podster-api-staging --remote --env staging
```

### 4. Generate the assertion keys

The gateway signs with the private key, and the API verifies with the public half. This prints both, in the formats each Worker needs. Don't save the output in the repo.

```bash
node --input-type=module -e "import {generateKeyPairSync as g} from 'node:crypto';const {publicKey:p,privateKey:s}=g('ed25519');const kid='gateway-1';console.log('ASSERTION_KEYS='+JSON.stringify({[kid]:p.export({format:'jwk'}).x}));console.log('ASSERTION_SIGNING_JWK='+JSON.stringify({...s.export({format:'jwk'}),kid}))"
```

### 5. Deploy the API

The gateway's service binding needs the API to exist. From `apps/api`, paste the `ASSERTION_KEYS` value when asked:

```bash
npx wrangler secret put ASSERTION_KEYS --env staging
```

```bash
npx wrangler deploy --env staging
```

### 6. Deploy the gateway, then set its secrets

From `apps/gateway`:

```bash
npx wrangler deploy --env staging
```

The domain goes live on this deploy, and that's safe before the secrets are set. Without `AUTH_SECRET`, anything using sign-in, sessions or claims fails rather than using a default secret. OAuth discovery, `/oauth/register` and `/mcp`'s 401 still answer, and no token can exist yet.

Paste each value when asked. For `AUTH_SECRET`, generate one first with `openssl rand -base64 32`.

```bash
npx wrangler secret put AUTH_SECRET --env staging
```

```bash
npx wrangler secret put ASSERTION_SIGNING_JWK --env staging
```

```bash
npx wrangler secret put GITHUB_CLIENT_ID --env staging
```

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET --env staging
```

## After a deploy

Run the journey in the [kernel success criteria](spec/PRODUCT.md#coordination-kernel-success-criteria) against the real hostname, and probe that the API has no public route.
