# encode-yt-monitor 采集端（examples/server）

SDK 的 demo 服务，同时也是**采集服务端的最小可运行参考实现**：建库建表、身份识别（token / 匿名访客）、
并发写队列、错误聚合、阈值预警、查询与运维接口都在这里。

> 定位：demo + 生产脚手架的「骨架」。存储层抽了 `Store` 接口，换成 MySQL / ClickHouse / Kafka 只需要再实现一遍。

## 一、快速开始

```bash
# 1. JSON 存储（零依赖，任何 Node 都能跑）
pnpm demo

# 2. SQLite 存储（Node 22.5~22.12 需要 --experimental-sqlite，脚本已带）
pnpm demo:sqlite

# 3. 生成测试 token（HS256）
pnpm token -- --sub=user_1 --ttl=7200
```

- demo 页面：<http://localhost:2021/JS/index.html>
- 接口索引：<http://localhost:2021/api>
- 看板数据：<http://localhost:2021/api/stats/overview>
- 本地数据文件：`examples/server/.data/monitor.sqlite`（或 `monitor.json`），已加入 `.gitignore`

## 二、库表设计：错误 / PV 用一张表还是两张表？

### 2.1 三个候选方案

| 方案                   | 说明                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| A. 完全双表            | `error_events` + `pv_events`，两套表两套写入                       |
| B. 完全单表            | `events` + `kind` 字段区分 error/pv/uv                             |
| C. 单表明细 + 双表聚合 | `events`（明细）+ `error_groups` / `error_group_users`（错误聚合） |

### 2.2 优缺点对比

| 维度                      | A. 双表              | B. 单表                         | C. 本方案（单表明细 + 聚合表） |
| ------------------------- | -------------------- | ------------------------------- | ------------------------------ |
| 字段重合度                | 差：90% 字段要写两遍 | 好：一套 DDL                    | 好                             |
| 列稀疏                    | 无                   | 有（错误专属列在 PV 行为 NULL） | 有，但仅明细表                 |
| 写入代码                  | 两套校验 + 两套事务  | 一套                            | 一套                           |
| 跨类型分析（错误率）      | 需 join 两个大表     | 一条 SQL                        | 一条 SQL                       |
| 索引体积                  | 两个较小索引         | 一个索引带 kind，略大           | 同左                           |
| 保留策略                  | 两套 TTL             | 一套                            | 一套                           |
| 「同错误影响多少用户」    | 需再建聚合表         | 需 `COUNT(DISTINCT)` 扫全表     | 增量维护，O(1) 查询            |
| 迁移 / 演进               | 改一个类型要动两张表 | 加列即可                        | 加列即可                       |
| 数据倾斜（PV 远多于错误） | 天然隔离             | 需分区 / 汇总表缓解             | 同左                           |

**结论：采用 C（`events` 单表 + `error_groups` / `error_group_users` 聚合表）**

理由：

1. 两类报文共享 `sdk/tracker/visitor/url/route/ua/time/level` 等 90% 字段，双表会让
   校验、写入、清理、导出、迁移全部翻倍；
2. 错误率（errors / pv）是监控最核心的指标，单表一条 SQL 就能算，双表要么两表分别扫，要么 join；
3. 错误需要的「按指纹聚合 + 按用户去重」本质上是**另一个粒度的物化视图**，放在聚合表里
   比在明细表上反复 `GROUP BY` 便宜得多（明细可以按天清理，聚合长期保留）；
4. 写入路径统一：一次批量事务里同时写明细与聚合，不会出现「错误写成功、PV 写失败」的不一致。

**列稀疏的缓解措施**

- demo（SQLite）：NULL 几乎零成本，且错误专属列只有 8 个；
- 生产（MySQL）：把 `stack/component_name/custom_tag/request/response` 收进 `payload JSON` 列，
  仅把需要检索/排序的字段提升为普通列（`error_type`、`url`、`created_at`、`visitor_id`）；
- 体量倾斜：`events` 按月分区（`PARTITION BY RANGE (created_at)`），PV 可再按天预聚合成 `pv_daily`。

### 2.3 表清单

| 表                  | 粒度            | 作用                                      | 生命周期                             |
| ------------------- | --------------- | ----------------------------------------- | ------------------------------------ |
| `events`            | 一条上报明细    | 错误 / PV / UV 原始数据，支持任意维度回溯 | 按 `RETENTION_DAYS`（默认 7 天）清理 |
| `error_groups`      | 一个错误指纹    | 累计次数、影响用户数、首末次出现时间      | 长期保留（`last_seen` 过旧才清理）   |
| `error_group_users` | 错误指纹 × 访客 | 精确去重「多少用户踩到同一个错误」        | 跟随 `error_groups`                  |
| `alert_rules`       | 一条规则        | 阈值、窗口、冷却、渠道                    | 长期                                 |
| `alert_log`         | 一次触发        | 触发值、推送渠道、送达结果、失败原因      | 随明细清理                           |

完整 DDL 见 [`db/schema.sql`](./db/schema.sql)，关键索引：

```sql
CREATE INDEX idx_events_kind_time    ON events (kind, created_at);   -- 错误率 / PV 趋势
CREATE INDEX idx_events_group_time   ON events (group_key, created_at); -- 单错误下钻
CREATE INDEX idx_events_visitor_time ON events (visitor_id, created_at); -- 单用户行为
CREATE INDEX idx_error_groups_count  ON error_groups (total_count);  -- 错误排行
```

`events.event_uid` 是唯一索引，用作**幂等键**：SDK 重试、批量重发、beacon + xhr 双发都只会入库一次。

`events.stack` 存 SDK 结构化帧数组的 JSON 字符串（`func / url / line / column`）；`GET /api/stats/errors/:groupKey/samples` 读取它给后台展开行定位错误。修复前入库的旧行 `stack` 为 NULL，接口会从 `payload.stack` 回填。

## 三、身份识别：有 token 解 token，没 token 用 IP 生成访客 id

所有请求都过一遍 `identityMiddleware`（`core/identity.ts`）：

```
Authorization: Bearer <jwt>   >   ?token=<jwt>   >   body.token
        ↓ 有
  verifyToken(HS256)  →  ok?  visitor_id = u_<hash(sub)>   identity_kind = 'token'
        ↓ 无 / 校验失败
  visitor_id = v_<hash(ip + ua + salt)>                    identity_kind = 'anonymous'
```

设计要点：

| 关注点     | 做法                                                                                 | 原因                                                                                         |
| ---------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| token 来源 | header / query / body 三选一                                                         | 图片上报（`useImgUpload`）用 `img.src`，带不了 header；`sendBeacon` 卸载阶段也常退化成 query |
| 签名算法   | 仅 HS256（`crypto.createHmac`）                                                      | demo 零依赖；生产换 RS256/JWKS 只需替换 `core/token.ts`                                      |
| 校验内容   | 结构、签名（`timingSafeEqual`）、`exp`、`nbf`、可选 `iss`                            | 防过期 token 与跨环境混用                                                                    |
| 校验失败   | 默认**降级为匿名**并继续采集；`TOKEN_STRICT=1` 时返回 401                            | 采集链路的第一优先级是「不丢数据」，auth 失败不该让用户数据消失                              |
| 保护范围   | `TOKEN_STRICT=1` 时 `/api/stats*`、`/api/alerts*` 必须有合法 token；采集接口始终放行 | 查询接口会暴露业务数据，采集接口面向公网                                                     |
| 响应头     | `x-identity-kind` / `x-visitor-id`                                                   | 方便联调时肉眼确认身份链路                                                                   |

**匿名访客 id 的取舍**：`v_ = sha256(ip + ua + salt)` 前 20 位。

- 优点：无 cookie、无埋点前置条件，服务端独立可算，同一网络同一浏览器稳定；
- 缺点：IPv4 NAT 下多人共用出口 IP 会被合并成一个访客（UV 偏低）；浏览器升级 UA 会变；
- 缓解：SDK 的 `authInfo.trackerId` 已入库，可叠加成 `ip+ua+trackerId` 的更细粒度；
  生产建议由网关注入 `X-Device-Id`（前端生成的持久化 uuid）。

**隐私**：明文 IP 不落库。只存 `ip_hash`（`sha256(ip+salt)`）与 `ip_prefix`（`1.2.x.x`），
`ANONYMIZE_IP=0` 时也只存归一化 IP。

## 四、并发入库：为什么一定要队列

SDK 侧是「一条错误一个请求 / 批量请求」，服务端是 Express 的异步并发模型，而 `node:sqlite` 是**同步 API**：

- 直接在请求回调里写库 → 每个请求一次事务，吞吐低，且遇到大事务会阻塞事件循环；
- SQLite 同一时刻只允许一个写事务 → 多请求并发写会撞 `SQLITE_BUSY`。

因此统一收口到一个 `WriteQueue`（`core/writeQueue.ts`）：

```
HTTP handler → 归一化 → queue.push(rows) → 立即 200
                                   ↓ 定时 flushIntervalMs / 攒够 maxBatch
                            一个事务批量写 events + error_groups + error_group_users
                                   ↓ onFlushed
                            预警引擎 observe（内存滑动窗口）
```

| 机制       | 参数                         | 说明                                                                    |
| ---------- | ---------------------------- | ----------------------------------------------------------------------- |
| 攒批间隔   | `FLUSH_INTERVAL_MS`（200ms） | 兼顾时效与吞吐                                                          |
| 单事务上限 | `MAX_BATCH`（200 条）        | 事务过大时拆成多批，避免长事务阻塞                                      |
| 背压       | `MAX_QUEUE_SIZE`（5000 条）  | 超过直接丢弃并计入 `monitor_events_dropped_total`，宁可丢数据也不能 OOM |
| 优雅退出   | `SIGINT` / `SIGTERM`         | `queue.stop()` 先把剩余数据写完，再关库；容器滚动更新不丢最后一批       |
| 强一致调试 | `?sync=1`                    | 请求内同步落库，方便联调 / 断言                                         |

**多实例 / 大规模**时 SQLite 不是终点：把 `Store` 接口换成「投递到 Kafka / Redis Stream + 独立消费者批量写
ClickHouse / MySQL」，采集端只保留 `queue.push()` 之前的部分即可，路由和预警代码不用改。

## 五、同一错误、不同用户的统计怎么做

`error_groups` 存「指纹维度」的累计值，`error_group_users` 存「指纹 × 访客」的去重关系：

```sql
-- 写入时 UPSERT，一次事务内完成
INSERT INTO error_groups (group_key, ..., total_count, affected_users, first_seen, last_seen)
VALUES (?, ..., 1, 0, ?, ?)
ON CONFLICT(group_key) DO UPDATE SET total_count = total_count + 1, last_seen = excluded.last_seen;

INSERT OR IGNORE INTO error_group_users (group_id, visitor_id, hit_count, first_seen, last_seen)
VALUES (?, ?, 1, ?, ?);           -- 真的插入了才 affected_users + 1
```

- `affected_users` 是**增量维护**的精确值，不用 `COUNT(DISTINCT)` 扫明细；
- 想按时间窗口看「最近 1 小时影响多少用户」，再对 `error_group_users.last_seen` 过滤即可；
- 指纹优先用 SDK 的 `errorId`（`createErrorId` 已做过 url/stack 归一化），缺失时本地按
  `type|name|message|route` 哈希兜底（`fp_xxx`），保证同一错误不会因为换页面而分裂。

实测（`/api/stats/errors`）：`err_123` 被匿名访客与 token 用户各触发 1 次 →
`totalCount: 2, affectedUsers: 2`。

## 六、预警阈值与三方推送

### 6.1 规则模型

```jsonc
{
  "name": "JS错误-1分钟",
  "scope": "error_type", // global | error_type | group
  "scopeValue": "JAVASCRIPT_ERROR",
  "metric": "count", // count | users | new_group
  "threshold": 20, // 阈值
  "windowMs": 60000, // 滑动窗口
  "cooldownMs": 300000, // 冷却期，防告警风暴
  "enabled": 1,
  "channels": ["console", "webhook"],
}
```

内置 4 条规则（`db/types.ts` 的 `DEFAULT_ALERT_RULES`，只在表为空时写入）：

| 规则                 | 口径                       | 默认阈值                 |
| -------------------- | -------------------------- | ------------------------ |
| 错误总量-1分钟       | 全局错误条数               | 50 / 1min，冷却 5min     |
| JS错误-1分钟         | `JAVASCRIPT_ERROR` 条数    | 20 / 1min，冷却 5min     |
| 单错误影响用户-5分钟 | 单个分组内的**去重访客数** | 10 人 / 5min，冷却 10min |
| 新错误首次出现       | 新指纹数量                 | 1 / 1min，冷却 10min     |

### 6.2 评估与推送链路

```
queue.onFlushed → AlertEngine.observe()   # 每条错误同时进 global / type:X / group:G 三个窗口桶
定时 tick（ALERT_EVALUATE_INTERVAL_MS）
  → AlertEngine.evaluate()               # 滑动窗口裁剪 + 阈值判断 + 冷却判断
  → Notifier.send()                      # console 必打；配了 ALERT_WEBHOOK_URL 才推送
  → store.logAlert()                     # 落 alert_log，记录 delivered / error
```

- **滑动窗口而非固定窗口**：避免「跨窗口边界漏报」；
- **内存计数而非 SQL 聚合**：阈值判断 O(窗口条数)，不扫表；
- **冷却键 = 规则 + 分组**：单条错误连续爆量只提醒一次，但计数继续累计；
- **推送失败不重试风暴**：单次超时 `ALERT_WEBHOOK_TIMEOUT_MS`（3s）+ 1 次重试，失败写 `alert_log.error`；
- **不阻塞主流程**：`runOnce()` 是异步的，`evaluating` 标志防止定时器重入。

### 6.3 三方渠道

`ALERT_WEBHOOK_FORMAT` 支持 `raw`（自有 JSON）/ `feishu` / `dingtalk` / `wecom`，自动拼装各自的报文：

```bash
# 飞书 / 钉钉 / 企微 群机器人
ALERT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx \
ALERT_WEBHOOK_FORMAT=feishu \
pnpm demo:sqlite

# 手动验证配置是否通
curl -X POST http://localhost:2021/api/alerts/test
```

真实触发（实测输出，21 条 JS 错误打进 1 分钟窗口）：

```json
{ "ruleName": "JS错误-1分钟", "value": 24, "threshold": 20, "delivered": 1 }
{ "ruleName": "新错误首次出现", "value": 26, "threshold": 1, "delivered": 1 }
```

## 七、补充建议（已落地 / 待落地）

### 7.1 已经做了的加固

| 能力     | 位置                        | 说明                                                             |
| -------- | --------------------------- | ---------------------------------------------------------------- |
| 幂等去重 | `events.event_uid` 唯一索引 | 重试 / 双发不重复计数，指标里单列 `duplicated`                   |
| 入口限流 | `core/rateLimit.ts`         | 按访客令牌桶，`RATE_LIMIT_PER_MINUTE`，超限 429                  |
| PV 采样  | `ingest/normalize.ts`       | `PV_SAMPLE_RATE`（0~1），**只采 PV，错误不采样**                 |
| 数据保留 | `store.purgeBefore`         | `RETENTION_DAYS`，定时分批删除，避免长事务                       |
| 报文兼容 | `routes/collect.ts`         | JSON / text/plain / `?data=` / 批量 `batch:true` / 单条数组 data |
| 图片上报 | `routes/collect.ts`         | `useImgUpload` 的 GET 请求返回 1×1 GIF                           |
| 跨域     | `index.ts`                  | 采集接口支持 CORS + OPTIONS 预检                                 |
| 可观测   | `/healthz`、`/metrics`      | 队列深度、丢弃数、去重数、预警次数，Prometheus 文本格式          |
| 优雅退出 | `index.ts`                  | SIGINT/SIGTERM 先 flush 再关库                                   |
| 隐私     | `core/visitor.ts`           | IP 只存 hash + 网段，UA 截断 512                                 |

### 7.2 建议后续再做（当前 demo 未做，生产必须补）

1. **鉴权升级**：RS256 + JWKS、`aud` 白名单、token 吊销列表（`jti` 黑名单）；
2. **多实例**：SQLite → MySQL/ClickHouse；采集与消费分离（Kafka / Redis Stream），消费者幂等写入；
3. **PV 预聚合**：`pv_daily(day, route, pv, uv)` 定时物化，避免明细表越来越大；
4. **限流升级**：单机内存桶 → Redis 令牌桶 / 网关层限流，避免多实例互相绕过；
5. **告警升级**：同类错误合并成一条、告警升级策略（5 分钟未处理 → 电话）、
   `alert_rules` 支持 `minAffectedUsers`、按环境（dev/prod）分流；
6. **数据质量**：上报报文 schema 校验（zod）、字段长度上限（已做基础截断）；
7. **自身监控**：写队列积压、`SQLITE_BUSY`、webhook 失败率接入 Prometheus 告警（指标已暴露）；
8. **安全**：采集接口加签名（`dsn` 带 `apikey` 校验）、body 大小限制（已 1mb）、
   webhook 地址白名单（防 SSRF）。

## 八、接口与环境变量

### 8.1 接口

| 方法     | 路径                                        | 说明                                 |
| -------- | ------------------------------------------- | ------------------------------------ |
| POST/GET | `/errors/upload`、`/errors/upload.gif`      | 错误上报（SDK `dsn`）                |
| POST/GET | `/pv/upload`                                | PV/UV 上报（SDK `trackDsn`）         |
| POST     | `/api/collect/error`、`/api/collect/pv`     | 采集别名                             |
| GET      | `/api/stats/overview?windowHours=24`        | 错误数 / PV / UV / 错误率 / 队列状态 |
| GET      | `/api/stats/errors?limit=20&windowHours=24` | 错误分组排行（含影响用户数）         |
| GET      | `/api/stats/errors/:groupKey/samples?limit=5` | 单个分组的最近错误明细（含 stack）   |
| GET      | `/api/stats/pv?days=7`                      | PV/UV 按天趋势 + Top 路由            |
| GET/POST | `/api/alerts/rules`                         | 查询 / 新增或覆盖预警规则            |
| GET      | `/api/alerts?limit=20`                      | 预警历史（含送达结果）               |
| POST     | `/api/alerts/test`                          | 手动触发一次推送，验证 webhook       |
| GET      | `/healthz`                                  | 健康检查（驱动、队列、保留天数）     |
| GET      | `/metrics`                                  | Prometheus 指标                      |

采集接口统一返回：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "received": 1,
    "accepted": 1,
    "dropped": 0,
    "sampled": 0,
    "identityKind": "token",
    "visitorId": "u_xxx",
    "queueDepth": 0
  }
}
```

> 注意：即使 `dropped / sampled > 0` 也返回 200 —— 这是服务端的主动决策，
> 返回非 2xx 只会让 SDK 反复重试，放大流量。

### 8.2 环境变量

| 变量                                                      | 默认                                   | 说明                                            |
| --------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| `MONITOR_DB_FILE`                                         | `examples/server/.data/monitor.sqlite` | SQLite 文件位置                                 |
| `MONITOR_FORCE_JSON`                                      | `false`                                | 强制用 JSON 存储                                |
| `VISITOR_SALT`                                            | demo 值                                | 访客 / IP 哈希盐，改盐等于换一套访客 id         |
| `ANONYMIZE_IP`                                            | `true`                                 | IP 是否只保留网段                               |
| `TOKEN_SECRET`                                            | demo 值                                | JWT HS256 密钥                                  |
| `TOKEN_ISSUER`                                            | 空                                     | 校验 `iss`                                      |
| `TOKEN_STRICT`                                            | `false`                                | 严格模式：token 非法直接 401                    |
| `FLUSH_INTERVAL_MS` / `MAX_BATCH` / `MAX_QUEUE_SIZE`      | `200` / `200` / `5000`                 | 写队列参数                                      |
| `RATE_LIMIT_PER_MINUTE`                                   | `600`                                  | 每访客每分钟上报上限，0 不限流                  |
| `PV_SAMPLE_RATE`                                          | `1`                                    | PV 采样率                                       |
| `RETENTION_DAYS` / `PURGE_INTERVAL_MS`                    | `7` / `1h`                             | 明细保留与清理频率                              |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_FORMAT`              | 空 / `raw`                             | 告警推送地址与格式（raw/feishu/dingtalk/wecom） |
| `ALERT_WEBHOOK_TIMEOUT_MS` / `ALERT_EVALUATE_INTERVAL_MS` | `3000` / `5000`                        | 推送超时 / 评估间隔                             |
| `CORS_ORIGINS`                                            | `*`                                    | 允许的跨域来源                                  |

## 九、目录结构

```
examples/server/
├── index.ts              # 组装：存储 → 写队列 → 预警 → 路由 → 静态资源 → 优雅退出
├── config.ts             # 配置（文件路径 / 阈值 / 环境变量）
├── db/
│   ├── schema.sql        # 建库建表 DDL（单表方案说明写在注释里）
│   ├── types.ts          # 行类型 + Store 接口 + 内置预警规则
│   ├── sqliteStore.ts    # node:sqlite 实现（事务 / UPSERT / 幂等）
│   ├── jsonStore.ts      # JSON 文件降级实现（同一接口）
│   └── store.ts          # 工厂：自动探测 + 降级
├── core/
│   ├── identity.ts       # 身份识别中间件（token / 匿名访客）
│   ├── token.ts          # JWT(HS256) 签发 / 校验
│   ├── visitor.ts        # IP 归一化 / 脱敏 / 访客 id 派生
│   ├── rateLimit.ts      # 令牌桶限流
│   ├── writeQueue.ts     # 串行写队列（攒批 / 背压 / 优雅退出）
│   ├── alert.ts          # 滑动窗口 + 规则评估（纯内存）
│   ├── alertService.ts   # 评估 → 落库 → 推送
│   └── notifier.ts       # console / webhook（飞书/钉钉/企微/raw）
├── ingest/normalize.ts   # 报文归一化（单条 / 批量 / PV 数组 / 采样）
├── routes/
│   ├── collect.ts        # 采集接口
│   └── stats.ts          # 查询 / 预警管理 / 健康检查 / 指标
└── tools/mint-token.ts   # 生成测试 token
```
