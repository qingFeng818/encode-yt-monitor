/**
 * ============================================================================
 * 令牌桶限流（按访客维度）
 * ============================================================================
 *
 * 为什么需要：SDK 在异常场景（比如拦截器死循环、错误上报自身报错）下可能瞬间打出大量请求，
 * 服务端必须在入口挡住，否则会把写队列和存储一起打挂。
 *
 * 算法（标准令牌桶，无第三方依赖）：
 *   capacity      = limitPerMinute（桶容量 = 每分钟允许的条数）
 *   refillPerMs   = capacity / 60000（每毫秒匀速补 1/60000 个桶）
 *   取令牌：先把「距离上次取令牌这段时间」应补的令牌补上（不超过容量），再尝试扣 1 个。
 *
 * 与「固定窗口计数」的区别（为什么选令牌桶）：
 * - 固定窗口在窗口边界会放过 2 倍流量（59s 打满 + 01s 又打满）；
 * - 令牌桶允许「短时突发」到 capacity，但长期平均速率被严格限制在 limitPerMinute；
 * - 对上报场景友好：页面刚打开时的一波初始化上报不会被误杀。
 *
 * 失效语义：
 * - limitPerMinute <= 0 → 直接放行（demo 想关掉限流时用）；
 * - key 用 visitorId（不是 IP）：带 token 时按账号限流，同一账号多标签页共享配额，符合预期。
 *
 * 已知取舍：
 * - 状态在单进程内存里，多实例部署时每个实例各自一份（总量会是 N 倍）；
 *   生产要全局精确限流得换 Redis 令牌桶，本 demo 不做；
 * - Map 会随访客数增长，sweep() 提供按空闲时间清理的入口（默认 10 分钟没活动就删）。
 */
export class RateLimiter {
  /** key = visitorId；value = { 当前剩余令牌, 上次补令牌的时间戳 } */
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();
  /** 桶容量 = 每分钟允许条数 */
  private capacity: number;
  /** 每毫秒补充的令牌数；capacity=0 时也是 0（配合 enabled 直接短路） */
  private refillPerMs: number;

  /** @param limitPerMinute 每分钟允许的条数，<=0 表示不限流 */
  constructor(limitPerMinute: number) {
    // 负值按 0 处理，避免 refillPerMs 变负数把 tokens 越补越少
    this.capacity = Math.max(0, limitPerMinute);
    this.refillPerMs = this.capacity / 60000;
  }

  /** 是否开启限流（capacity=0 表示配置了「不限流」） */
  get enabled(): boolean {
    return this.capacity > 0;
  }

  /**
   * 取一个令牌。
   *
   * @param key 限流维度，实际传 visitorId
   * @param now 可注入的当前时间（单测用它模拟时间流逝，不依赖真实等待）
   * @returns true = 放行（已扣 1 个令牌）；false = 超限（不扣令牌，调用方应返回 429）
   *
   * 细节：
   * - 首次出现的 key 直接给满桶，所以「新访客的第一批上报」永远放行；
   * - 补令牌用 Math.min 封顶，长时间没请求不会攒出超过 capacity 的配额（防突发雪崩）；
   * - elapsed 用 Math.max(0, ...) 兜底，防止调用方传入比 updatedAt 更早的 now（单测常见）时倒扣令牌。
   */
  take(key: string, now: number = Date.now()): boolean {
    if (!this.enabled) return true;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * 定期清理空闲桶，避免 Map 无限增长。
   *
   * 判定标准：now - updatedAt > idleMs（默认 10 分钟）。
   * 之所以能安全删除：空闲 10 分钟的桶一定已经被补满（10 分钟 >> 1 分钟），
   * 删掉等价于「下次访问时重新给满桶」，不会让任何访客因此获得额外配额。
   *
   * 注意：本类不自带定时器（避免库代码偷偷起后台任务），需要宿主定期调用；
   * 本 demo 的 index.ts 未调度该方法，长时间运行且访客极多时 Map 会缓慢增长
   *（每个访客一条记录，量级 ~100 字节/访客，可接受；生产建议接一个 5~10 分钟的 sweep）。
   */
  sweep(now: number = Date.now(), idleMs = 10 * 60 * 1000): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > idleMs) this.buckets.delete(key);
    }
  }

  /** 当前跟踪的访客数（用于监控 / 单测断言） */
  get size(): number {
    return this.buckets.size;
  }
}
