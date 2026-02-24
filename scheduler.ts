import { run } from 'node:test';

export type SchedulerTask = () => void;
export type StopFuleshUpdates = () => void;
export type Scheduler = {
  tick: Promise<void>; // 执行所有已有的微任务
  enquene: (task: SchedulerTask) => void;
  flush: () => void; // 注入微任务的执行
  flushSync: () => void; // 同步执行已有任务
  onBeforeFlush: (callbask: () => void) => StopFuleshUpdates; // 注入微任务执行前
  onFlush: (callbask: () => void) => StopFuleshUpdates; // 注入微任务执行后
};

// queueMicrotask(() => {});  微任务调用，不会干扰当前事件循环，但是会在下一轮事件循环中执行
export function createScheduler(): Scheduler {
  const queue = new Set<SchedulerTask>();
  const microtask = Promise.resolve();
  const beforeCallbacks = new Set<() => void>();
  const afterCallbacks = new Set<() => void>();
  const queueTask = typeof queueMicrotask !== 'undefined' ? queueMicrotask : microtask.then;

  const enqueue = (task: SchedulerTask) => {
    queue.add(task);
    schedulerFlush();
  };

  let flushing = false;
  const schedulerFlush = () => {
    if (flushing) return;
    flushing = true;
    queueTask(flush);
  };

  const flush = () => {
    runAll(beforeCallbacks);
    for (const task of queue) {
      task();
      queue.delete(task);
    }
    runAll(afterCallbacks);
    flushing = false;
  };
  const runAll = (callbacks: Set<() => void>) => {
    for (const callback of callbacks) callback();
  };

  const hooks = (callbacks: Set<() => void>) => {
    return (callback: () => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    };
  };

  return {
    tick: microtask,
    enquene: enqueue,
    flush: schedulerFlush,
    flushSync: flush,
    onBeforeFlush: hooks(beforeCallbacks),
    onFlush: hooks(afterCallbacks),
  };
}
