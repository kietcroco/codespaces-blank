-- Schema v22: agencies (departments) and their member experts.

CREATE TABLE agencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id     TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE agency_members (
  agency_id       TEXT NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
  expert_agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
  assigned_at     INTEGER NOT NULL
);

UPDATE _schema_version SET version = 22;
