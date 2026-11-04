// Podster's own directory tables. Better Auth and the plugin manage theirs.
export const PODSTER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS org_member (org_id TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT NOT NULL,
     PRIMARY KEY (org_id, person_id))`,
  `CREATE TABLE IF NOT EXISTS podster_agent (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL,
     generation INTEGER NOT NULL DEFAULT 1, revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS seen_jti (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS identity_link (provider TEXT NOT NULL, external_id TEXT NOT NULL, agent_id TEXT NOT NULL,
     PRIMARY KEY (provider, external_id))`,
];
