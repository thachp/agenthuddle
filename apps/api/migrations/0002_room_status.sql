-- Lets a room's list show whether it's archived. A listing read model only, and it's never used to authorize.
ALTER TABLE membership_index ADD COLUMN workspace_status TEXT NOT NULL DEFAULT 'active';
