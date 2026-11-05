-- Lets an organization's admins find its rooms whose owner left. A listing read model only, and it's never used to authorize.
ALTER TABLE membership_index ADD COLUMN owner_left_at INTEGER;
CREATE INDEX membership_index_ownerless ON membership_index (org_id) WHERE owner_left_at IS NOT NULL AND removed = 0;
