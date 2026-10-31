import { resolve } from 'path';
import { CollectorConfig } from '../config';
import { JsonStore } from './jsonStore';
import { loadSqlite, SqliteStore } from './sqliteStore';
import { Store } from './types';

export * from './types';

/**
 * ============================================================================
 * 存储工厂：选驱动 + 初始化 + 失败降级
 * ============================================================================
 *
 * 决策顺序（先明确意愿，再探测能力，最后兜底）：
 *   1. MONITOR_FORCE_JSON=1            → 直接用 JsonStore（想「零依赖跑通」时用）
 *   2. 加载不到 node:sqlite            → 降级 JsonStore（Node 版本过低 / 未加 --experimental-sqlite）
 *   3. SQLite 初始化抛异常（磁盘/权限/锁） → 降级 JsonStore，并打印原始错误
 *   4. 其余                               → SqliteStore
 *
 * 关键语义：
 * - 「建表 + 灌默认规则」都在 store.init() 里做，且都是幂等的（CREATE TABLE IF NOT EXISTS、
 *   INSERT OR IGNORE），所以重启服务不会破坏已有数据、也不会覆盖用户改过的预警阈值；
 * - 降级是**静默可用**而不是报错退出：demo 的第一目标是「能跑起来看到数据」；
 *   但降级信息会打印 warn（含原因），生产部署应通过 /healthz 的 driver 字段做校验；
 * - JSON 存储固定用 <dataDir>/monitor.json（不受 MONITOR_DB_FILE 影响），
 *   因为 MONITOR_DB_FILE 语义上是「sqlite 文件路径」。
 */
export function createStore(config: CollectorConfig): Store {
  const jsonFile = resolve(config.dataDir, 'monitor.json');
  if (config.forceJsonStore) {
    const store = new JsonStore(jsonFile);
    store.init();
    console.log(`[store] 使用 JSON 文件存储（MONITOR_FORCE_JSON=1）：${store.location}`);
    return store;
  }

  // loadSqlite 只是 require 一次，不建库；失败返回 null（不会抛异常）
  if (!loadSqlite()) {
    const store = new JsonStore(jsonFile);
    store.init();
    console.warn(
      '[store] 当前 Node 无法加载 node:sqlite（22.12 及以下需加 --experimental-sqlite），已降级为 JSON 存储：' +
        store.location,
    );
    return store;
  }

  try {
    const store = new SqliteStore(config.dbFile);
    store.init();
    console.log(`[store] 使用 SQLite 存储：${store.location}`);
    return store;
  } catch (error) {
    // 常见原因：目录不可写、文件被其他进程独占、schema.sql 缺失
    const store = new JsonStore(jsonFile);
    store.init();
    console.warn('[store] SQLite 初始化失败，已降级为 JSON 存储：', error);
    return store;
  }
}
