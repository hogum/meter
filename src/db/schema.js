/** 与 db/init.sql 同步；status 保存原文后半段版本及通知增量状态。 */

export const SCHEMA_STATEMENTS = [
  // 平台登录账号，与电表采集配置独立维护。
  `CREATE TABLE IF NOT EXISTS users (
     user      TEXT COLLATE NOCASE PRIMARY KEY NOT NULL,
     pw        TEXT NOT NULL,
     serial_no TEXT NOT NULL
   ) WITHOUT ROWID`,

  // ms 为最后一次请求耗时；9999 表示超时，历史导入留空。
  `CREATE TABLE IF NOT EXISTS data (
     ts        INTEGER NOT NULL,
     serial_no TEXT NOT NULL,
     room      TEXT,
     time      TEXT,
     kwh       REAL,
     balance   REAL,
     ms        INTEGER,
     raw       TEXT NOT NULL,
     PRIMARY KEY (serial_no, ts)
   ) WITHOUT ROWID`,

  // last_online_time 为本版本最后有效时间，内容变化后冻结旧行。
  // 格式固定为 YYYY-MM-DD HH:MM:SS，字典序即时间序，可直接 ORDER BY 比较。
  `CREATE TABLE IF NOT EXISTS status (
     serial_no        TEXT NOT NULL,
     last_online_time TEXT NOT NULL,
     occupied         INTEGER,
     low_balance      INTEGER,
     delta            REAL,
     last_kwh         REAL,
     tail             TEXT NOT NULL,
     PRIMARY KEY (serial_no, last_online_time)
   ) WITHOUT ROWID`,
];

export const EXPECTED_TABLES = ['users', 'data', 'status'];
