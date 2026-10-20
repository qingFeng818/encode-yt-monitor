import { describe, it, expect, vi } from 'vitest';
import { Queue } from 'encode-yt-monitor-utils';
import type { QueueTask } from 'encode-yt-monitor-utils';

/**
 * Queue 的并发控制与执行语义：
 * - 返回 Promise 的任务才算「在飞」，maxConcurrent 才能生效；
 * - 同步任务按入队顺序执行完，不占并发上限；
 * - 任务异常（同步抛错 / Promise reject）都要释放槽位且不影响后续任务；
 * - flushNow 忽略并发上限，供页面卸载兜底。
 */

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function pendingTask(name: string, started: string[]) {
  let resolve!: () => void;
  const task: QueueTask = () => {
    started.push(name);
    return new Promise<void>((r) => (resolve = r));
  };
  return { task, done: () => resolve() };
}

describe('Queue 并发控制', () => {
  it('maxConcurrent 限制同时在飞的异步任务数量', async () => {
    const queue = new Queue({ maxConcurrent: 2 });
    const started: string[] = [];
    const tasks = ['a', 'b', 'c', 'd'].map((name) => pendingTask(name, started));

    tasks.forEach((item) => queue.addFn(item.task));
    await tick();

    expect(started).toEqual(['a', 'b']);
    expect(queue.getInFlightCount()).toBe(2);
    expect(queue.getPendingCount()).toBe(2);

    tasks[0].done();
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(queue.getInFlightCount()).toBe(2);

    tasks[1].done();
    await tick();
    expect(started).toEqual(['a', 'b', 'c', 'd']);

    tasks[2].done();
    tasks[3].done();
    await tick();
    expect(queue.getInFlightCount()).toBe(0);
    expect(queue.getPendingCount()).toBe(0);
  });

  it('默认并发上限为 5', async () => {
    const queue = new Queue();
    const started: string[] = [];
    for (let i = 0; i < 8; i++) queue.addFn(pendingTask(String(i), started).task);

    await tick();

    expect(started).toHaveLength(5);
    expect(queue.getInFlightCount()).toBe(5);
    expect(queue.getPendingCount()).toBe(3);
  });

  it('同步任务不受 maxConcurrent 限制，按入队顺序执行完', async () => {
    const queue = new Queue({ maxConcurrent: 1 });
    const order: number[] = [];

    for (let i = 0; i < 5; i++) {
      queue.addFn(() => {
        order.push(i);
      });
    }
    await tick();

    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(queue.getInFlightCount()).toBe(0);
  });

  it('同步任务抛错不影响同批其它任务，并回调 onError', async () => {
    const onError = vi.fn();
    const queue = new Queue({ onError });
    const after = vi.fn();

    queue.addFn(() => {
      throw new Error('sync boom');
    });
    queue.addFn(after);
    await tick();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(queue.getInFlightCount()).toBe(0);
  });

  it('异步任务 reject 会释放槽位，后续任务继续执行', async () => {
    const onError = vi.fn();
    const queue = new Queue({ maxConcurrent: 1, onError });
    const after = vi.fn();

    queue.addFn(() => Promise.reject(new Error('network')));
    queue.addFn(after);
    await tick();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(queue.getInFlightCount()).toBe(0);
  });

  it('flushNow 忽略并发上限，供页面卸载兜底', () => {
    const queue = new Queue({ maxConcurrent: 1 });
    const started: string[] = [];

    queue.addFn(() => {
      started.push('a');
      return new Promise<void>(() => undefined);
    });
    queue.addFn(() => {
      started.push('b');
      return new Promise<void>(() => undefined);
    });

    queue.flushNow();

    expect(started).toEqual(['a', 'b']);
  });
});
