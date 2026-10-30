CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history (t INTEGER PRIMARY KEY, tank REAL, fridge REAL);

-- Devices the owner has added to the dashboard. status: 'active' or 'removed' (hidden but restorable).
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'appliance',
  icon TEXT NOT NULL DEFAULT 'plug',
  status TEXT NOT NULL DEFAULT 'active',
  sort INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL
);

-- One power reading per device per poll. w is NULL while the device is offline.
CREATE TABLE IF NOT EXISTS samples (
  t INTEGER NOT NULL,
  id TEXT NOT NULL,
  w REAL,
  PRIMARY KEY (t, id)
);
CREATE INDEX IF NOT EXISTS samples_id_t ON samples (id, t);

-- Mains presence from the device with the 'grid' role: present = 1 while it is online.
CREATE TABLE IF NOT EXISTS grid (t INTEGER PRIMARY KEY, present INTEGER NOT NULL);

-- Battery camera: the most recent photos (base64 JPEG) and what was read from them.
CREATE TABLE IF NOT EXISTS photos (t INTEGER PRIMARY KEY, b64 TEXT NOT NULL, pct REAL, note TEXT);
CREATE TABLE IF NOT EXISTS battery (t INTEGER PRIMARY KEY, pct REAL NOT NULL);

-- Home view: pictures from the selfie camera, taken only when asked for from the app.
CREATE TABLE IF NOT EXISTS snaps (t INTEGER PRIMARY KEY, b64 TEXT NOT NULL);

-- Automation: what it did and why, and a record of every variable every 2 minutes for later analysis.
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL, msg TEXT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS events_t ON events (t);
CREATE TABLE IF NOT EXISTS datalog (t INTEGER PRIMARY KEY, d TEXT NOT NULL);
