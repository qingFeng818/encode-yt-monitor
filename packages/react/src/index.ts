import { BreadCrumbTypes, ErrorTypes } from 'encode-yt-monitor-shared';
import {
  isError,
  extractErrorStack,
  getLocationHref,
  getTimestamp,
  unknownToString,
  silentConsoleScope,
  Severity,
} from 'encode-yt-monitor-utils';
import { breadcrumb, transportData } from 'encode-yt-monitor-core';
import { ReportDataType } from 'encode-yt-monitor-types';

/**
 * React ErrorBoundary 回调的第二参数，包含组件树堆栈
 */
interface ErrorInfo {
  componentStack?: string;
}

/**
 * 收集react ErrorBoundary中的错误对象
 * 需要用户手动在componentDidCatch中设置
 * @param ex ErrorBoundary中的componentDidCatch的第一个参数error
 * @param errorInfo ErrorBoundary中的componentDidCatch的第二个参数errorInfo，携带组件树堆栈
 */
export function errorBoundaryReport(ex: any, errorInfo?: ErrorInfo): void {
  // extractErrorStack 在堆栈字符串无法匹配任何浏览器格式时返回 null，
  // 不能直接对其结果赋值，否则会在 componentDidCatch 内部抛出二次错误
  const parsedError = isError(ex) ? extractErrorStack(ex, Severity.Normal) : null;

  if (!isError(ex)) {
    silentConsoleScope(() => {
      console.warn('传入的react error不是一个object Error');
    });
  }

  const error: ReportDataType = parsedError
    ? { ...parsedError, type: ErrorTypes.REACT_ERROR }
    : {
        type: ErrorTypes.REACT_ERROR,
        url: getLocationHref(),
        name: isError(ex) ? ex.name : 'unknown',
        message: isError(ex) ? ex.message : unknownToString(ex),
        level: Severity.Normal,
        time: getTimestamp(),
        // 解析失败兜底保留原始堆栈字符串，非 Error 抛出则无堆栈
        stack: isError(ex) ? ex.stack || [] : [],
      };

  // React 提供的组件树堆栈（at UserCard -> at App），定位错误组件的关键信息
  error.componentStack =
    errorInfo && errorInfo.componentStack ? errorInfo.componentStack.trim() : '';

  breadcrumb.push({
    type: BreadCrumbTypes.REACT,
    category: breadcrumb.getCategory(BreadCrumbTypes.REACT),
    data: `${error.name}: ${error.message}`,
    level: Severity.fromString(error.level.toString()),
  });
  transportData.send(error);
}
