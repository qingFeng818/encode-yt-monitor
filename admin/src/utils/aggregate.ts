import type { ErrorGroup, ErrorTypeStat } from '@/types/monitor';

/**
 * 把「错误分组」再聚合一层成「错误类型」。
 *
 * 说明：服务端没有单独的类型统计接口，/api/stats/errors 已经按窗口过滤且按次数降序，
 * 前端聚合的结果与「当前展示的 TOP N 分组」一致，用于饼图已经足够；
 * 如果需要全量类型统计，应该在服务端加 SQL，而不是在这里放大 limit。
 */
export function aggregateErrorTypes(groups: ErrorGroup[]): ErrorTypeStat[] {
  const bucket = new Map<string, ErrorTypeStat>();

  groups.forEach((group) => {
    const type = group.errorType || 'UNKNOWN';
    const current = bucket.get(type) ?? { type, count: 0, users: 0, groups: 0 };
    current.count += group.totalCount;
    current.users += group.affectedUsers;
    current.groups += 1;
    bucket.set(type, current);
  });

  return Array.from(bucket.values()).sort((a, b) => b.count - a.count);
}
