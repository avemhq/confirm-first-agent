/** Database schema. Kept as a TS string so it bundles cleanly into Next.js and tsx. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL CHECK (role IN ('viewer','member','admin')),
  PRIMARY KEY (user_id, project_id));
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','blocked','done')),
  assignee_id TEXT REFERENCES users(id),
  due_date TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('doc','report')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  title TEXT NOT NULL,
  args_json TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  target_id TEXT,
  base_version INTEGER,
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','expired','conflict')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, result_json TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web','mcp','cli','system')),
  project_id TEXT,
  event TEXT NOT NULL,
  tool TEXT, args_json TEXT, reason TEXT,
  outcome TEXT NOT NULL,
  proposal_id TEXT, confirmed_by TEXT, detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
`
