-- A person's departure from an organization, written with the removal and held until the API has taken it.
CREATE TABLE org_departure_outbox (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, org_id TEXT NOT NULL, left_at INTEGER NOT NULL, actor_id TEXT NOT NULL);
