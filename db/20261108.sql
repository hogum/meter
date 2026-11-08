-- 2026-11-08：重建 status 表（low_balance 改名为 broke、新增 base_line 基线与 duration 持续秒数、保留 last_kwh、delta 改存离散等级）。

CREATE TABLE status_new (
     serial_no        TEXT NOT NULL,
     last_online_time TEXT NOT NULL,
     occupied         INTEGER,
     broke            INTEGER,
     base_line        TEXT,
     last_kwh         REAL,
     delta            INTEGER,
     duration         INTEGER,
     tail             TEXT NOT NULL,
     PRIMARY KEY (serial_no, last_online_time)
   ) WITHOUT ROWID;

INSERT INTO status_new (serial_no, last_online_time, occupied, broke, base_line, last_kwh, delta, duration, tail)
SELECT serial_no, last_online_time, COALESCE(occupied, 0), COALESCE(low_balance, 0), '12w/15m', last_kwh, 0, 0, tail
  FROM status;

DROP TABLE status;
ALTER TABLE status_new RENAME TO status;
