import { _global } from './global';

/**
 * 队列任务。
 *
 * - 返回 void：同步任务，函数返回即视为执行完成；
 * - 返回 Promise：异步任务（例如一次上报请求），Promise settle 后才释放并发槽位。
 *
 * 注意：只有让任务返回 Promise，maxConcurrent 才有意义；否则队列无法知道请求何时结束，
 * 只能在同一 tick 内把任务全部发起，等于没有任何并发控制。
 */
export type QueueTask = () => void | Promise<void>;

export type QueueOptions = {
  /** 同时执行中的异步任务上限，默认 5；<=0 表示不限制 */
  maxConcurrent?: number;
  onError?: (err: unknown) => void;
};

export class Queue {
  private micro: Promise<void>;
  private stack: QueueTask[] = [];
  private isFlushing = false;
  /** 是否正在批量执行，避免重入 */
  private isDraining = false;
  /** 已启动但还没结束的异步任务数 */
  private inFlight = 0;
  private maxConcurrent = 5;
  private onError?: (err: unknown) => void;
  constructor(options: QueueOptions = {}) {
    if (!('Promise' in _global)) return;
    this.micro = Promise.resolve();
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.onError = options.onError || console.error;
  }
  addFn(fn: QueueTask): void {
    if (typeof fn !== 'function') return;
    if (!('Promise' in _global)) {
      this.run(fn);
      return;
    }
    this.stack.push(fn);
    this.schedule();
  }
  clear() {
    this.stack.length = 0;
  }
  getStack() {
    return this.stack;
  }
  /** 待执行任务数 */
  getPendingCount(): number {
    return this.stack.length;
  }
  /** 执行中的异步任务数 */
  getInFlightCount(): number {
    return this.inFlight;
  }
  /**
   * 按并发上限继续执行队列：到上限就停下，等某个任务结束由 release() 再次触发。
   * 页面卸载这类「没有下一次机会」的场景请用 flushNow()。
   */
  flushStack(): void {
    this.isFlushing = false;
    this.drain();
  }
  /** 忽略并发上限、同步清空队列（页面卸载兜底） */
  flushNow(): void {
    if (this.isDraining) return;
    this.isDraining = true;
    try {
      while (this.stack.length) {
        const fn = this.stack.shift();
        if (!fn) break;
        this.run(fn);
      }
    } finally {
      this.isDraining = false;
    }
    if (this.stack.length && this.canRun()) this.schedule();
  }
  private schedule(): void {
    if (this.isDraining || this.isFlushing || !this.stack.length || !this.canRun()) return;
    this.isFlushing = true;
    this.micro.then(() => this.flushStack());
  }
  private canRun(): boolean {
    return this.maxConcurrent <= 0 || this.inFlight < this.maxConcurrent;
  }
  private drain(): void {
    if (this.isDraining) return;
    this.isDraining = true;
    try {
      while (this.stack.length && this.canRun()) {
        const fn = this.stack.shift();
        if (!fn) break;
        this.run(fn);
      }
    } finally {
      this.isDraining = false;
    }
    // 被并发上限打断：等 release() 触发；否则只会是空队列
    if (this.stack.length && this.canRun()) this.schedule();
  }
  private run(fn: QueueTask): void {
    this.inFlight++;
    let result: void | Promise<void>;
    try {
      result = fn();
    } catch (error) {
      this.release();
      this.onError?.(error);
      return;
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).then(
        () => this.release(),
        (error) => {
          this.onError?.(error);
          this.release();
        },
      );
      return;
    }
    // 同步任务：返回即完成
    this.release();
  }
  private release(): void {
    if (this.inFlight > 0) this.inFlight--;
    if (this.isDraining) return;
    this.schedule();
  }
}
