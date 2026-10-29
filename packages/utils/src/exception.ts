import { voidFun } from 'encode-yt-monitor-shared';
import { logger } from './logger';

export function nativeTryCatch(fn: voidFun, errorFn?: (err: any) => void): void {
  try {
    fn();
  } catch (err) {
    // 不能用 console.* 打日志：console 本身可能已被 SDK 拦截，
    // 在「错误处理」里再调用 console 会把异常重新送回拦截逻辑，形成递归。
    // logger 持有的是拦截前捕获的原始 console 方法，且只在 debug 模式输出。
    logger.error('nativeTryCatch 捕获到异常：', err);
    if (errorFn) {
      errorFn(err);
    }
  }
}
