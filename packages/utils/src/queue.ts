import { _global } from './global';
import type { QueueOptions } from 'encode-yt-monitor-types';

export type { QueueOptions };

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

export class Queue {
  private micro: Promise<void>;
  private stack: QueueTask[] = [];
  private isFlushing = false;
  /** 是否正在执行同步 drain 循环（重入锁），不代表请求已结束；在飞数量见 inFlight */
  private isDraining = false;
  /** 已启动但还没结束的异步任务数 */
  private inFlight = 0;
  private maxConcurrent = 5;
  private onError?: (err: unknown) => void;
  constructor(options: QueueOptions = {}) {
    this.onError = console.error;
    if (!('Promise' in _global)) return;
    this.micro = Promise.resolve();
    this.bindOptions(options);
  }
  /** 运行时更新配置（init 时由 TransportData 调用），不会丢弃已入队的任务 */
  bindOptions(options: QueueOptions = {}): void {
    const { maxConcurrent, onError } = options;
    if (typeof maxConcurrent === 'number') {
      this.maxConcurrent = maxConcurrent;
    }
    if (typeof onError === 'function') {
      this.onError = onError;
    }
    // 上限被调大后，积压的任务可以继续执行
    if (this.stack.length && this.canRun()) this.schedule();
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
    return this.stack.slice(0);
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
    if (this.isDraining) return;
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
    if (!this.micro) return;
    if (this.isDraining || this.isFlushing || !this.stack.length || !this.canRun()) return;
    this.isFlushing = true;
    // drain 内部已兜住任务异常；这里再兜一层，避免微任务里抛错变成 unhandledrejection
    this.micro.then(() => {
      try {
        this.flushStack();
      } catch (error) {
        this.safeOnError(error);
      }
    });
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
      // isDraining 只保护「同步出队循环」本身：循环结束就释放；
      // 异步请求是否结束由 inFlight + release() 负责
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
      this.safeOnError(error);
      return;
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).then(
        () => this.release(),
        (error) => {
          // release 必须执行：onError 抛错也不能把并发槽位卡死
          this.safeOnError(error);
          this.release();
        },
      );
      return;
    }
    // 同步任务：返回即完成
    this.release();
  }
  /** onError 由使用方传入，自身抛错不能影响队列：否则会漏掉 release / 变成 unhandledrejection */
  private safeOnError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch (e) {
      // 兜底回调自身失败时不再向外抛，避免形成 unhandledrejection 自激
    }
  }
  private release(): void {
    if (this.inFlight > 0) this.inFlight--;
    if (this.isDraining) return;
    this.schedule();
  }
}
