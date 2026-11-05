-- An organization admin invites a person by a link sent out of band. Only a hash of the link's secret is kept.
CREATE TABLE org_invitation (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, accepted_by TEXT, accepted_at INTEGER);
CREATE INDEX org_invitation_org ON org_invitation (org_id, status);
-- Who changed an organization's people. IDs only, written in the same batch as the change.
CREATE TABLE org_audit (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, role TEXT, created_at INTEGER NOT NULL);
CREATE INDEX org_audit_org ON org_audit (org_id, created_at);
