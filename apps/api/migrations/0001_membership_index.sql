-- Listing read model only. It is never used to authorize.
CREATE TABLE membership_index (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  role TEXT,
  workspace_name TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, principal_id)
);
CREATE INDEX membership_index_principal ON membership_index (principal_id, removed);
