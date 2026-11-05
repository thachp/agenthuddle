import { env } from "cloudflare:workers";

export type WebEnv = {
  /** The gateway's Worker. There is no binding to the Rust API, D1 or Durable Objects. */
  GATEWAY: Fetcher;
  /** This application's public origin. */
  APP_URL: string;
  /** The gateway's public address, which agents connect to. It's shown to people and never called from here. */
  GATEWAY_URL: string;
  SIGN_IN_PROVIDERS: string;
  LOCAL_PASSWORD_SIGNIN: string;
};

export const webEnv = () => env as unknown as WebEnv;
