-- A person has one personal organization, so restoring a missing one can run more than once, or twice at the same moment.
CREATE UNIQUE INDEX organization_one_personal ON organization (created_by) WHERE personal = 1;
