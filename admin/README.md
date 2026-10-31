# Encode Monitor Admin

`encode-yt-monitor` 的数据可视化后台：消费 `examples/server` 的 `/api/stats/*` 接口，展示错误采集链路健康度、错误分组与 PV/UV 趋势。

技术栈：**Vue 3 + Vite + Pinia + Vue Router + ECharts**，全部为前端静态路由（无登录鉴权）。

## 快速开始

```bash
# 仓库根目录
pnpm install

# 终端 1：启动采集服务（默认 http://localhost:2021）
pnpm demo

# 终端 2：启动管理后台（默认 http://localhost:5174）
pnpm admin
```

也可以只在 `admin/` 目录内操作：

```bash
cd admin
pnpm install
pnpm dev       # 开发服务器，/api 与 /healthz 代理到 VITE_PROXY_TARGET
pnpm build     # vue-tsc 类型检查 + vite build
pnpm preview   # 预览 dist
```

## 环境变量

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `VITE_PROXY_TARGET` | 开发态代理目标（`/api`、`/healthz`） | `http://localhost:2021` |
| `VITE_API_BASE_URL` | 生产态直接请求的 API 前缀；留空表示同域 | 空 |

- 开发：`admin/.env.development`，浏览器只访问 5174，代理层解决跨域。
- 生产：`admin/.env.production`，默认同域部署（推荐 nginx 把 `/api` 转发给采集服务）。
- 采集服务开启 `TOKEN_STRICT=1` 时，本后台尚未接入鉴权头，需要先关掉严格模式或自行扩展 `src/api/http.ts`。

## 页面与数据来源

| 页面 | 接口 | 说明 |
| --- | --- | --- |
| 顶部指标卡 | `GET /api/stats/overview?windowHours=` | errors / pv / uv / errorRate + 写队列统计 |
| 错误类型分布 | `GET /api/stats/errors?windowHours=&limit=20` | 前端按 `errorType` 聚合分组累计次数 |
| 错误分组表 | 同上 | 只展示最近窗口出现过的分组 |
| PV/UV 趋势 | `GET /api/stats/pv?days=&limit=10` | 日趋势 |
| 路由排行 | 同上 | 接口固定返回最近 24h 的 TOP N |
| 错误列表页（`/errors`） | `GET /api/stats/errors?windowHours=&limit=200` | 关键词/类型/新错误/最小次数/来源页面筛选 + 排序 + 分页 + CSV 导出 |
| 错误堆栈（展开行） | `GET /api/stats/errors/:groupKey/samples?limit=5` | 最近 5 条错误明细，展开行展示 stack（`JS 文件:行:列`） |

口径提醒（与服务端实现一致）：

- `errors` 是错误**上报条数**，不是去重后的分组数；
- `pv` 是 `SUM(count)`，SDK 可能把多次 PV 合并成一条上报；
- `errorRate = errors / pv`，是**比值**（可能大于 1，例如 7 条错误 / 5 次 PV = 1.4，展示为 140%）；`pv = 0` 时服务端返回 0；
- `/api/stats/errors` 的窗口只过滤 `lastSeen`，`totalCount` / `affectedUsers` 为分组**历史累计值**；
- 错误类型饼图基于当前 TOP 20 分组聚合，用于看占比，不等价于全量类型统计。

## 错误列表页（`/errors`）

标准后台三段式布局，三层职责分开：

1. **搜索栏**（`components/errors/ErrorFilterBar.vue`）
   - 字段全部由 `FilterFieldConfig[]` 配置驱动（key / label / type / width / advanced / options）；
   - 窗口变窄时放不下的字段自动收进「更多筛选」，配置 `advanced: true` 的字段默认收起；
   - 搜索栏里只改草稿，点功能栏的「查询」或输入框回车才生效；「更多筛选」角标显示收起字段里已填写的条件数。
2. **功能栏**（`components/common/OverflowActions.vue`）
   - 查询 / 重置 / 刷新 / 导出 CSV / 复制链接 / 密度切换；
   - `pinned: true` 的动作（查询、重置、刷新）排在最前、优先常驻，其余按实测宽度自动进「更多」下拉；极窄屏放不下时，尾部 pinned 动作也会进「更多」，优先保证工具栏不溢出；
   - 侧边栏折叠、窗口缩放、浏览器字体加载完成后都会重新测量。
3. **展示栏**（`components/errors/ErrorTable.vue`）
   - 表头点击排序、每页 10/20/50 条、列显隐（至少保留两列）、行展开查看完整消息、来源页面与最近堆栈；
   - 骨架屏 / 空态（区分「没数据」与「筛选无结果」）/ 错误横幅 + 重试；
   - CSV 导出为筛选后的**全部分组**，不受分页限制（含 BOM、防公式注入）。

**查询条件会写回 URL**（`window` / `q` / `type` / `newOnly` / `minCount` / `minUsers` / `route` / `sort` / `page` / `size`），刷新或分享链接能还原；未点「查询」的草稿不会写入。

### 错误定位（stack）

展开某一行时会按需请求 `GET /api/stats/errors/:groupKey/samples?limit=5`，展示最近一条错误的堆栈帧：

- SDK 上报的 `stack` 是结构化帧数组（`func / url / line / column`），服务端以 JSON 字符串存入 `events.stack`；
- 后台同时兼容旧数据 / 手工上报的原始堆栈文本（Chrome `at fn (url:line:col)`、Firefox `fn@url:line:col`）；
- 每帧显示 `JS 文件:行:列`，可复制单帧位置或整条堆栈；http(s) 脚本地址可直接新标签打开；
- **生产环境通常是压缩后的 bundle**：当前能精确定位到「哪个 JS 文件、哪一行、哪一列」，但映射回 `.ts/.vue` 源码需要构建时保留 source map，并在服务端（或 source map 服务）解析后回填；这是下一步扩展，不是本页当前能力。
- 明细受 `RETENTION_DAYS` 限制，过保留期后展开行会提示「只保留聚合计数」。

### 动态折叠为什么不用 canvas

实现前对比过三种方案：

| 方案 | 结论 |
| --- | --- |
| canvas `measureText` 估算文本宽度 | **不采用**。只能测字形，测不到图标 / padding / 边框 / gap；浏览器缩放、自定义字体、字体晚加载都会让估算值失真 |
| CSS 断点 + 固定隐藏数量 | **不采用**。中英文文案长度不同，断点很难覆盖所有侧边栏宽度与缩放比例 |
| DOM 实测（`getBoundingClientRect` + `ResizeObserver`） | **按钮栏采用**。隐藏探针行与真实按钮同 class / 字体，测量结果与布局完全一致，重新计算成本 O(n)（n ≤ 10） |
| 配置宽度 + 整数运算 | **搜索栏采用**。字段宽度本来就是产品配置的固定值，直接用容器宽度做加减法最稳定、可预测 |

`composables/useElementWidth.ts` 统一封装 `ResizeObserver`，两处折叠组件共用；canvas 适合「渲染前估算上千行虚拟列表」，不适合只有几个按钮的工具栏。

**服务端限制**：`/api/stats/errors` 只有 `limit`（最大 200）和 `windowHours`，没有 offset / 关键词参数。因此本页的关键词、类型、排序、分页都是「已加载的窗口内 TOP 200 分组」范围内完成，页面与 README 都显式标注；需要全量检索时应先给 `Store.listErrorGroups` 与路由增加查询参数，而不是把 limit 调大。

## 目录结构

```
admin/
├─ src/
│  ├─ api/           # fetch 封装（统一处理 { code, message, data }）+ 接口定义
│  ├─ components/    # 布局组件、指标卡、EChart 容器、看板子组件
│  │  ├─ common/     # 通用交互：OverflowActions（按钮溢出折叠）
│  │  └─ errors/     # 错误列表：FilterField / ErrorFilterBar / ErrorTable
│  ├─ composables/   # useElementWidth（ResizeObserver 容器宽度）
│  ├─ layouts/       # AdminLayout：侧边栏 + 顶栏 + 内容区
│  ├─ plugins/       # ECharts 按需注册
│  ├─ router/        # 前端路由表 + 菜单数据源
│  ├─ stores/        # Pinia：app（主题/侧边栏）、dashboard、errorList
│  ├─ styles/        # 设计令牌与全局样式（亮/暗色）
│  ├─ types/         # 与 examples/server 对齐的响应类型
│  ├─ utils/         # 格式化、聚合、chart option、CSV、剪贴板
│  └─ views/         # 页面（dashboard / errors）
├─ vite.config.ts    # 端口 5174 + 代理
└─ tsconfig.json
```

## 交互说明

- 顶部时间窗口（1h / 6h / 24h / 7d / 30d）同时作用于概览与错误分组；
- PV 趋势的天数（7 / 14 / 30）独立选择；
- 数据看板默认每 30 秒自动刷新（页面隐藏时跳过），可关闭或手动刷新；错误列表页通过功能栏「刷新」手动拉取；
- 错误列表页（`/errors`）：搜索栏与功能栏会随宽度自动折叠，表头排序 / 翻页 / 改每页条数 / 查询 / 重置都会同步到 URL；
- 主题切换写入 `localStorage`（`monitor-admin:theme`），并在 `index.html` 内联脚本中提前应用，避免白屏闪烁；
- 移动端（≤900px）侧边栏切换为抽屉模式；≤640px 时搜索字段改为整行，导出的 toast 贴底展示。

## 部署

`pnpm build` 产物在 `admin/dist`，使用 history 路由，需要把未知路径回退到 `index.html`：

```nginx
location / {
  root /path/to/admin/dist;
  try_files $uri $uri/ /index.html;
}

location /api/ {
  proxy_pass http://127.0.0.1:2021;
}
```

如果管理后台与采集服务同域部署，注意 `/errors` 是前端 history 路由，而采集服务的上传入口是 `/errors/upload`：把采集 location 限定到上传路径，避免把页面请求误转发给采集服务。

```nginx
# 与 location / 共存时按最长前缀匹配到它；不要写成 location /errors（会吞掉前端页面）
location /errors/upload {
  proxy_pass http://127.0.0.1:2021;
}
```

## 已知限制

- 未接入登录 / 权限；路由与菜单目前完全由前端静态配置控制（`src/router/routes.ts`、`src/router/menu.ts`）。
- 错误列表默认为「分组级」视图；展开行会按需拉取最近 5 条明细并展示 stack。没有 source map 时只能定位到压缩后的 `bundle:line:column`，映射回源码需额外接入 source map 解析。
- `/api/stats/errors` 没有 offset / 关键词参数，错误列表页的搜索、排序、分页仅作用于窗口内 TOP 200 分组；需要全量检索要先扩展服务端接口。
- 没有告警规则编辑页：需要服务端补接口后再扩展。
- 数据为轮询获取，不是 WebSocket 实时推送。
