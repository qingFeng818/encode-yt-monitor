import { EventRow, Store, WriteResult } from '../db/types';

/**
 * 写队列统计快照（同名字段会出现在 /healthz、/api/stats/overview 与 /metrics 里）。
 *
 * 各字段的口径（数字都是「自进程启动以来的累计值」，depth 是瞬时值）：
 * - received   ：push 进来的总条数（含随后被丢弃的）
 * - accepted   ：真正进入内存队列的条数
 * - dropped    ：因队列已满被丢弃的条数 —— 恒等式 received = accepted + dropped
 * - persisted  ：store 真正插入的条数（event_uid 重复的会被算进 duplicated，不计入这里）
 * - duplicated ：被幂等键拦下的重复条数
 * - batches    ：成功提交的事务批次数量
 * - failures   ：写库抛异常的批次数（这些批次的数据会被丢弃，见 flush 的注释）
 * - depth      ：当前待落库条数（瞬时值，不累计）
 * - lastFlushAt：最近一次成功 flush 的时间戳（0 表示还没写过）
 * - lastError  ：最近一次错误信息（成功不会清空，用于事后排查）
 *
 * 排查建议：dropped > 0 → 存储太慢或 maxQueueSize 太小；failures > 0 → 看 lastError。
 */
export interface WriteQueueStats {
  received: number;
  accepted: number;
  dropped: number;
  persisted: number;
  duplicated: number;
  batches: number;
  failures: number;
  depth: number;
  lastFlushAt: number;
  lastError: string | null;
}

/**
 * 写队列配置。
 *
 * 三个参数的配合关系：
 *   pending.length >= maxBatch        → 立刻 flush（延迟优先）
 *   每 flushIntervalMs 一次            → 定时 flush（吞吐优先，哪怕只有 1 条也写）
 *   pending.length >= maxQueueSize     → 直接丢新数据（保护进程）
 * 因此实际语义是「最多等 flushIntervalMs，最多攒 maxBatch 条，最多存 maxQueueSize 条」。
 */
export interface WriteQueueOptions {
  store: Store;
  /** 攒批时间：到点即使没攒够 maxBatch 也落库 */
  flushIntervalMs: number;
  /** 单个事务最多写多少条 */
  maxBatch: number;
  /** 内存队列上限，超过直接丢弃（保护进程不被 OOM） */
  maxQueueSize: number;
  /** 每落库一批回调一次，预警引擎在这里做实时统计 */
  onFlushed?: (rows: EventRow[], result: WriteResult) => void;
}

/**
 * ============================================================================
 * 串行写队列（内存缓冲 → 批量事务）
 * ============================================================================
 *
 * 并发问题的根源：node:sqlite 是同步 API，但 Express 是异步并发模型，
 * 如果在请求回调里直接写库，多个请求会交错进入事务（还会出现长事务阻塞）。
 * 这里统一收口：
 *   请求 → push(内存队列) → 定时/攒够 → 一个事务批量写 → 返回
 *
 * 顺带解决三件事：
 * 1. 吞吐：批量事务比单条事务快一个量级（WAL 下尤其明显）；
 * 2. 背压：队列超限直接丢弃并计数，宁可丢数据也不拖垮进程；
 * 3. 优雅退出：SIGINT/SIGTERM 时 stop() 会先停定时器、再同步 flush 一次，把队列里剩下的数据写完。
 *
 * 失败语义（很重要，决定了「会不会丢数据」）：
 * - flush 里每个 chunk 都是「先 splice 出队列，再写库」；
 * - 写库抛异常时，这个 chunk 已经不在队列里了 → **该批数据丢失**，只累加 failures + lastError；
 * - 之所以不重试/不回填：坏数据（字段超长、磁盘满、表结构变更）重试也是失败，
 *   回填会造成「永远写不进去 → 队列一直满 → 新数据全丢」的雪崩，快速失败更安全；
 * - 成功时才调用 onFlushed，因此预警统计不会把「写失败的数据」算进去（保证告警与库内一致）。
 *
 * 线程/时序不变量：
 * - flush 是同步方法（node:sqlite 同步），因此 flush 期间不会有别的请求插进事务；
 * - push 内部可能同步触发 flush（攒够 maxBatch 时），此时响应会稍慢一点，但不会丢已入队数据；
 * - start/stop 可重复调用（幂等），避免重复的定时器。
 */
export class WriteQueue {
  private pending: EventRow[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stats: WriteQueueStats = {
    received: 0,
    accepted: 0,
    dropped: 0,
    persisted: 0,
    duplicated: 0,
    batches: 0,
    failures: 0,
    depth: 0,
    lastFlushAt: 0,
    lastError: null,
  };

  constructor(private options: WriteQueueOptions) {}

  /**
   * 入队（同步返回，不阻塞 HTTP 响应）。
   *
   * @returns accepted = 真正进队列的条数；dropped = 因队列满被丢弃的条数
   *
   * 背压策略是「部分接收」而不是「全有或全无」：
   * 队列只剩 10 个位置、这次来了 100 条 → 收 10 条丢 90 条，并把 dropped 如实返回给调用方，
   * 采集接口会把这两个数字写进响应（前端/测试因此能发现「数据被服务端丢了」）。
   */
  push(rows: EventRow[]): { accepted: number; dropped: number } {
    if (!rows || rows.length === 0) return { accepted: 0, dropped: 0 };
    this.stats.received += rows.length;
    const room = this.options.maxQueueSize - this.pending.length;
    if (room <= 0) {
      // 队列已满：整批丢弃（不做「丢弃最老的」），保证已入队数据一定能落库
      this.stats.dropped += rows.length;
      this.stats.lastError = '队列已满，数据被丢弃';
      return { accepted: 0, dropped: rows.length };
    }
    // 只截取能放下的前 room 条，其余计入 dropped
    const acceptedRows = rows.length <= room ? rows : rows.slice(0, room);
    const dropped = rows.length - acceptedRows.length;
    for (const row of acceptedRows) this.pending.push(row);
    this.stats.accepted += acceptedRows.length;
    this.stats.dropped += dropped;
    this.stats.depth = this.pending.length;
    // 攒够一批就立刻写，减少「数据还在内存里进程就被杀」的窗口
    if (this.pending.length >= this.options.maxBatch) this.flush();
    return { accepted: acceptedRows.length, dropped };
  }

  /**
   * 立即落库（同步），返回本次真正写入的条数。
   *
   * 行为细节：
   * - 循环到 pending 为空为止：队列里若有 3*maxBatch 条，会拆成 3 个事务依次提交；
   * - 每个 chunk 用 splice 先从队列摘除再写库，所以「队列长度」在写库期间就已经变小，
   *   同步 API 下不会出现别的请求并发取到同一批数据；
   * - 某批写失败只影响该批（记录 failures + lastError），后续批次继续写，
   *   不会因为一批坏数据挡住后面所有数据；
   * - 返回值只统计成功插入的条数（不含 duplicated），仅用于日志 / 测试断言。
   */
  flush(): number {
    if (this.pending.length === 0) return 0;
    let persisted = 0;
    while (this.pending.length > 0) {
      const chunk = this.pending.splice(0, this.options.maxBatch);
      try {
        const result = this.options.store.writeEvents(chunk);
        persisted += result.inserted;
        this.stats.persisted += result.inserted;
        this.stats.duplicated += result.duplicated;
        this.stats.batches += 1;
        this.stats.lastFlushAt = Date.now();
        // 只有写成功才通知预警引擎：保证「告警统计」和「库内数据」始终一致
        if (this.options.onFlushed) this.options.onFlushed(chunk, result);
      } catch (error) {
        // 失败即丢弃本批（chunk 已出队，不会重试），避免坏批次把队列堵死
        this.stats.failures += 1;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
        console.error('[queue] 批量写库失败，本批数据已丢弃：', error);
      }
    }
    this.stats.depth = this.pending.length;
    return persisted;
  }

  /** 启动定时 flush（幂等：重复调用不会叠加定时器） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.options.flushIntervalMs);
    // 不要因为这个定时器把进程留住
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * 停止定时器并做最后一次同步 flush。
   *
   * 语义：调用它意味着「不再有新的 push 进来」（index.ts 在 server.close() 之前调用），
   * 所以这里的 flush 是「把内存里的数据全部写完」的收尾动作，而不是「尽力而为」。
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }

  /** 当前待落库条数（用于采集响应里的 queueDepth 与告警/健康检查） */
  get depth(): number {
    return this.pending.length;
  }

  /**
   * 统计快照（浅拷贝）。
   * 特意用副本而不是返回 this.stats 引用，避免调用方无意中改到内部计数器；
   * depth 用实时值覆盖，保证和此刻队列长度一致（stats.depth 只在 push/flush 末尾更新）。
   */
  getStats(): WriteQueueStats {
    return { ...this.stats, depth: this.pending.length };
  }
}
