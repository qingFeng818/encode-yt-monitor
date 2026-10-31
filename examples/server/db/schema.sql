-- ============================================================================
-- encode-yt-monitor 采集端库表设计（SQLite 语法，MySQL 差异见 README）
--
-- 【使用方式】由 db/sqliteStore.ts 的 init() 通过 db.exec() 整体执行：
--   1. 脚本里全部是 CREATE ... IF NOT EXISTS，可重复执行（服务重启安全）；
--   2. 只建表建索引，不插数据 —— 默认预警规则由 seedDefaultRules() 在「表为空」时灌入；
--   3. 所有时间列都是**毫秒级 Unix 时间戳**（INTEGER），不是 DATETIME；
--      需要日期分组时用 strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')。
--
-- 【单表 vs 双表 结论】明细合并为一张 events 表，用 kind 区分 error / pv / uv；
-- 错误再单独落两张「聚合表」：error_groups（按指纹聚合）+ error_group_users
-- （按访客去重，用于统计「同类型同 ID 的错误被多少个不同用户触发」）。
--
-- 为什么明细用单表（而不是 error_events + pv_events 双表）：
--   1. 两类报文共享约 90% 的字段（sdk/version/visitor/url/route/ua/time…），
--      双表会把校验、写入、清理、导出、迁移逻辑全部复制一份；
--   2. 可做跨类型分析：错误率 = count(kind='error') / count(kind='pv')，
--      单表一条 SQL 即可，双表需要两个大表 join / 分别扫描再合并；
--   3. 写入路径统一 → 一个写队列、一个事务批次，PV 与错误不会互相抢锁；
--   4. 保留策略只有一套（按 created_at 批量删除）。
-- 代价与缓解：
--   - 列稀疏：错误专属列（stack/http_status/component_name…）在 PV 行上为 NULL，
--     SQLite 对 NULL 几乎零存储成本；MySQL 建议把稀疏列收进 JSON 列；
--   - 数据倾斜：PV 体量远大于错误 → 生产建议按月/按 kind 分区（MySQL LIST/
--     RANGE 分区），或把 PV 单独落到 pv_daily 汇总表（本 demo 直接 SQL 聚合）。
-- ============================================================================

-- 明细事件表：error / pv / uv 统一入库
-- 写入方式（见 sqliteStore.writeEvents）：INSERT OR IGNORE，冲突（event_uid 已存在）即丢弃，
-- 因此「同一批数据重复上报」不会导致 error_groups 的 total_count 被重复累加。
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 幂等键：由 (kind|groupKey|visitor|tracker|clientTime|message|count) 哈希而来，
  -- 用于抵消 SDK 重试、批量重发、beacon + xhr 双发造成的重复入库
  event_uid      TEXT    NOT NULL UNIQUE,
  kind           TEXT    NOT NULL,          -- 'error' | 'pv' | 'uv'
  error_type     TEXT,                      -- JAVASCRIPT_ERROR / RESOURCE_ERROR …
  level          TEXT,
  message        TEXT,
  name           TEXT,                      -- Error.name 或页面名
  stack          TEXT,                      -- SDK 结构化帧数组的 JSON 字符串（func/url/line/column）
  error_id       INTEGER,                   -- SDK 侧 createErrorId 计算的指纹
  group_key      TEXT,                      -- 聚合键（error_id 或本地指纹）
  url            TEXT,
  route_from     TEXT,
  route_to       TEXT,
  title          TEXT,
  count          INTEGER NOT NULL DEFAULT 1, -- PV 聚合次数（SDK 侧合并后的 count）
  is_uv          INTEGER NOT NULL DEFAULT 0,
  http_method    TEXT,
  http_status    INTEGER,
  elapsed_time   INTEGER,
  component_name TEXT,
  custom_tag     TEXT,
  -- 身份：有 token 走 token，没 token 用 IP+UA 生成匿名访客 id
  visitor_id     TEXT    NOT NULL,
  identity_kind  TEXT    NOT NULL,          -- 'token' | 'anonymous'
  user_id        TEXT,                      -- token 里的 sub
  token_jti      TEXT,
  ip_hash        TEXT,                      -- sha256(ip + salt)，不存明文 IP
  ip_prefix      TEXT,                      -- 脱敏网段，如 1.2.x.x
  ua             TEXT,
  tracker_id     TEXT,                      -- SDK authInfo.trackerId，可当会话 id
  sdk_name       TEXT,
  sdk_version    TEXT,
  app_key        TEXT,                      -- authInfo.apikey / trackKey
  client_time    INTEGER,                   -- 上报侧时间戳
  created_at     INTEGER NOT NULL,          -- 服务端接收时间（ms）
  payload        TEXT                       -- 原始条目 JSON（排查用，可截断）
);

-- 索引与查询的对应关系（每个索引都对应一条实际使用的 SQL，别乱加）：
--   (kind, created_at)    → overview / listPvDaily / listPvRoute 的时间窗过滤
--   (group_key, created_at) → 按分组追查某段时间的明细（排查单错误时用）
--   (visitor_id, created_at) → 按访客追查（「这个用户都报了什么」）
--   (url)                 → 按页面聚合/过滤
CREATE INDEX IF NOT EXISTS idx_events_kind_time    ON events (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_events_group_time   ON events (group_key, created_at);
CREATE INDEX IF NOT EXISTS idx_events_visitor_time ON events (visitor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_url          ON events (url);

-- 错误聚合表：同一指纹只保留一行，写入时 UPSERT 累加。
-- 语义：total_count 是「条数」，affected_users 是「不同访客数」（= error_group_users 行数），
-- 两者不能互相推导 —— 一个用户可以把同一个错误触发 100 次（total_count=100, affected_users=1）。
CREATE TABLE IF NOT EXISTS error_groups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key      TEXT    NOT NULL UNIQUE,
  error_type     TEXT,
  name           TEXT,
  message        TEXT,
  sample_url     TEXT,
  total_count    INTEGER NOT NULL DEFAULT 0,
  affected_users INTEGER NOT NULL DEFAULT 0, -- = count(error_group_users)
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_groups_last_seen ON error_groups (last_seen);
CREATE INDEX IF NOT EXISTS idx_error_groups_count     ON error_groups (total_count);

-- 错误 × 访客 去重表：支撑「同 ID 错误被 N 个不同用户触发」的精确统计。
-- 主键 (group_id, visitor_id) 就是去重约束：INSERT OR IGNORE 的 changes 决定要不要把
-- error_groups.affected_users +1；hit_count 记录「这个访客触发了几次」，便于看单用户复现强度。
CREATE TABLE IF NOT EXISTS error_group_users (
  group_id   INTEGER NOT NULL,
  visitor_id TEXT    NOT NULL,
  hit_count  INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (group_id, visitor_id)
);

-- 预警规则：阈值、窗口、冷却、推送渠道都可配。
-- name 唯一：POST /api/alerts/rules 按 name UPSERT（同名即覆盖，id 保持不变）；
-- enabled=0 的规则不会进入 AlertEngine（reload 时被过滤），可当「软删除」用。
CREATE TABLE IF NOT EXISTS alert_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  scope       TEXT    NOT NULL,             -- 'global' | 'error_type' | 'group'
  scope_value TEXT,                         -- error_type 的具体值 / group_key
  metric      TEXT    NOT NULL,             -- 'count' | 'users' | 'new_group'
  threshold   INTEGER NOT NULL,
  window_ms   INTEGER NOT NULL,
  cooldown_ms INTEGER NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  channels    TEXT    NOT NULL DEFAULT '["console"]'
);

-- 预警触发记录（含推送结果，便于追溯漏发 / 重发）。
-- delivered=1 表示「控制台已打印且 webhook（若配置）返回 2xx」；0 表示推送失败，原因在 error。
-- payload 存的是完整文案（与 webhook 正文一致），可直接复制出来手动补发。
CREATE TABLE IF NOT EXISTS alert_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    INTEGER,
  rule_name  TEXT,
  group_key  TEXT,
  metric     TEXT,
  value      INTEGER,
  threshold  INTEGER,
  window_ms  INTEGER,
  channels   TEXT,
  payload    TEXT,
  delivered  INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_log_time ON alert_log (created_at);
