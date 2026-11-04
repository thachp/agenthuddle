-- Podster's directory. Better Auth and the Agent Auth plugin keep their own tables, including one named agent.
CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, personal INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE org_member (org_id TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (org_id, person_id));
CREATE INDEX org_member_person ON org_member (person_id);
CREATE TABLE podster_agent (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, generation INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX podster_agent_org ON podster_agent (org_id);
CREATE TABLE identity_link (provider TEXT NOT NULL, external_id TEXT NOT NULL, agent_id TEXT NOT NULL, person_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (provider, external_id));
CREATE INDEX identity_link_agent ON identity_link (agent_id);
-- The plugin's replay guard doesn't span requests here, so each token is consumed here. Phase 3 moves this to the agent's Principal.
CREATE TABLE seen_jti (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
