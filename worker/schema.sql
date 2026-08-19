CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  playhq_uid TEXT UNIQUE,
  pin TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(name);

CREATE TABLE IF NOT EXISTS roster_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grade TEXT NOT NULL,
  name TEXT NOT NULL,
  playhq_uid TEXT,
  pin TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_roster_players_grade ON roster_players(grade);

CREATE TABLE IF NOT EXISTS roster_state (
  grade TEXT PRIMARY KEY,
  source TEXT NOT NULL
);
