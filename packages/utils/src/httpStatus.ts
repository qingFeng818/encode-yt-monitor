/** The status of an Span. */
export enum SpanStatus {
  /** The operation completed successfully. */
  Ok = 'ok',
  /** Deadline expired before operation could complete. */
  DeadlineExceeded = 'deadline_exceeded',
  /** 401 Unauthorized (actually does mean unauthenticated according to RFC 7235) */
  Unauthenticated = 'unauthenticated',
  /** 403 Forbidden */
  PermissionDenied = 'permission_denied',
  /** 404 Not Found. Some requested entity (file or directory) was not found. */
  NotFound = 'not_found',
  /** 429 Too Many Requests */
  ResourceExhausted = 'resource_exhausted',
  /** Client specified an invalid argument. 4xx. */
  InvalidArgument = 'invalid_argument',
  /** 501 Not Implemented */
  Unimplemented = 'unimplemented',
  /** 503 Service Unavailable */
  Unavailable = 'unavailable',
  /** Other/generic 5xx. */
  InternalError = 'internal_error',
  /** Unknown. Any non-standard HTTP status code. */
  UnknownError = 'unknown_error',
  /** The operation was cancelled (typically by the user). */
  Cancelled = 'cancelled',
  /** Already exists (409) */
  AlreadyExists = 'already_exists',
  /** Operation was rejected because the system is not in a state required for the operation's */
  FailedPrecondition = 'failed_precondition',
  /** The operation was aborted, typically due to a concurrency issue. */
  Aborted = 'aborted',
  /** Operation was attempted past the valid range. */
  OutOfRange = 'out_of_range',
  /** Unrecoverable data loss or corruption */
  DataLoss = 'data_loss',
}

export function fromHttpStatus(httpStatus: number): SpanStatus {
  if (httpStatus < 400) {
    return SpanStatus.Ok;
  }

  if (httpStatus >= 400 && httpStatus < 500) {
    switch (httpStatus) {
      case 401:
        return SpanStatus.Unauthenticated;
      case 403:
        return SpanStatus.PermissionDenied;
      case 404:
        return SpanStatus.NotFound;
      case 409:
        return SpanStatus.AlreadyExists;
      case 413:
        return SpanStatus.FailedPrecondition;
      case 429:
        return SpanStatus.ResourceExhausted;
      default:
        return SpanStatus.InvalidArgument;
    }
  }

  if (httpStatus >= 500 && httpStatus < 600) {
    switch (httpStatus) {
      case 501:
        return SpanStatus.Unimplemented;
      case 503:
        return SpanStatus.Unavailable;
      case 504:
        return SpanStatus.DeadlineExceeded;
      default:
        return SpanStatus.InternalError;
    }
  }

  return SpanStatus.UnknownError;
}

/**
 * HTTP 状态码对应的中文描述。
 *
 * 与 fromHttpStatus 的区别：fromHttpStatus 返回机器可读的 SpanStatus 枚举（保留给外部消费者），
 * 上报 message 使用本函数的中文描述，保证与「status=0」分支的中文失败原因风格一致、对排查者友好。
 * 机器可读的状态码本身仍在 payload.response.status 中。
 */
export function fromHttpStatusText(httpStatus: number): string {
  switch (httpStatus) {
    case 400:
      return '请求参数错误';
    case 401:
      return '未授权或登录态失效';
    case 403:
      return '无访问权限';
    case 404:
      return '请求的资源不存在';
    case 405:
      return '请求方法不被允许';
    case 408:
      return '请求超时';
    case 409:
      return '资源冲突';
    case 413:
      return '请求体过大';
    case 429:
      return '请求过于频繁';
    case 500:
      return '服务端内部错误';
    case 501:
      return '服务未实现';
    case 502:
      return '网关错误';
    case 503:
      return '服务不可用';
    case 504:
      return '网关超时';
    default:
      if (httpStatus >= 400 && httpStatus < 500) {
        return '客户端请求异常';
      }
      if (httpStatus >= 500 && httpStatus < 600) {
        return '服务端异常';
      }
      if (httpStatus >= 200 && httpStatus < 400) {
        return '请求成功';
      }
      return '未知状态码';
  }
}
