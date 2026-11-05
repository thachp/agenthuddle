-- Finds the rooms an organization's agents are in. A listing read model only, and it's never used to authorize.
CREATE INDEX membership_index_org ON membership_index (org_id, removed);
