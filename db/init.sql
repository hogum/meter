-- 与 src/db/schema.js 保持一致；改表结构时两处同步。

CREATE TABLE IF NOT EXISTS users (
     user      TEXT COLLATE NOCASE PRIMARY KEY NOT NULL,
     pw        TEXT NOT NULL,
     serial_no TEXT NOT NULL
   ) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS data (
     ts        INTEGER NOT NULL,
     serial_no TEXT NOT NULL,
     room      TEXT,
     time      TEXT,
     kwh       REAL,
     balance   REAL,
     ms        INTEGER,
     raw       TEXT NOT NULL,
     PRIMARY KEY (serial_no, ts)
   ) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS status (
     serial_no        TEXT NOT NULL,
     last_online_time TEXT NOT NULL,
     occupied         INTEGER,
     low_balance      INTEGER,
     delta            REAL,
     last_kwh         REAL,
     tail             TEXT NOT NULL,
     PRIMARY KEY (serial_no, last_online_time)
   ) WITHOUT ROWID;
