# Deploying to staging

Staging runs at `gateway-staging.podster.dev`, on the Cloudflare account that holds `podster.dev`. The account ID stays out of this repo, so set it in your shell:

```bash
export CLOUDFLARE_ACCOUNT_ID=<the account that holds podster.dev>
```

Order matters. The gateway's service binding needs the API to exist, and the gateway must have its secrets before it takes traffic, because it refuses to run without `AUTH_SECRET`.

## First deploy

1. Create the resources, and replace each `set-when-created` in `apps/gateway/wrangler.jsonc` and `apps/api/wrangler.jsonc`:

   ```bash
   npx wrangler d1 create podster-gateway-staging
   ```

   ```bash
   npx wrangler d1 create podster-api-staging
   ```

   ```bash
   npx wrangler kv namespace create podster-oauth-staging
   ```

2. Apply migrations, from each app's folder:

   ```bash
   npx wrangler d1 migrations apply podster-gateway-staging --remote --env staging
   ```

   ```bash
   npx wrangler d1 migrations apply podster-api-staging --remote --env staging
   ```

3. Generate an assertion key pair. The API gets the public half as `ASSERTION_KEYS`, and the gateway gets the whole key as `ASSERTION_SIGNING_JWK`.

4. In `apps/api`, set `ASSERTION_KEYS`, then deploy:

   ```bash
   npx wrangler secret put ASSERTION_KEYS --env staging
   ```

   ```bash
   npx wrangler deploy --env staging
   ```

5. In `apps/gateway`, deploy, then set `AUTH_SECRET`, `ASSERTION_SIGNING_JWK`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Until `AUTH_SECRET` is set, every request fails rather than running on a default secret.

   ```bash
   npx wrangler deploy --env staging
   ```

   ```bash
   npx wrangler secret put AUTH_SECRET --env staging
   ```

6. Register the GitHub OAuth app with the callback `https://gateway-staging.podster.dev/api/auth/callback/github`.

## After a deploy

Run the journey in the [kernel success criteria](spec/PRODUCT.md#coordination-kernel-success-criteria) against the real hostname, and probe that the API has no public route.
