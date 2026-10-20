import { BreadcrumbPushData } from './breadcrumb';
import { DeviceInfo, EActionType } from './track';

export interface AuthInfo {
  apikey?: string;
  trackKey?: string;
  sdkVersion: string;
  sdkName: string;
  trackerId: string;
}

export interface TransportDataType {
  authInfo: AuthInfo;
  breadcrumb?: BreadcrumbPushData[];
  data?: FinalReportType;
  record?: any[];
  deviceInfo?: DeviceInfo;
}

/**
 * 批量上报报文。
 *
 * 开启批量上报（enableBatch）后，同一 dsn 下的多条单条报文会被攒起来合并成一个请求：
 * - batch 固定为 true，服务端据此走批量分支；
 * - data 是数组，每个元素都是一条完整的单条报文（各自带 authInfo / breadcrumb / record / deviceInfo），
 *   服务端按元素逐条入库即可，不需要再做拆分。
 *
 * 只攒到 1 条时会退化成原协议（没有 batch / count 字段），保证服务端可以灰度接入。
 */
export interface BatchTransportDataType {
  authInfo: AuthInfo;
  batch: true;
  /** 本批包含的条数，便于服务端校验与观测 */
  count: number;
  data: TransportDataType[];
}

export type FinalReportType = ReportDataType | TrackReportData;

interface ICommonDataType {
  isTrackData?: boolean;
}

export interface ReportDataType extends ICommonDataType {
  type?: string;
  message?: string;
  url: string;
  name?: string;
  stack?: any;
  time?: number;
  errorId?: number;
  level: string;
  // ajax
  elapsedTime?: number;
  request?: {
    httpType?: string;
    traceId?: string;
    method: string;
    url: string;
    data: any;
  };
  response?: {
    status: number;
    data: string | boolean;
  };
  // vue
  componentName?: string;
  propsData?: any;
  // react ErrorBoundary 的组件树堆栈
  componentStack?: string;
  customTag?: string;
}

export interface TrackReportData extends ICommonDataType {
  // uuid
  id?: string;
  // 埋点code 一般由人为传进来，可以自定义规范
  trackId?: string;
  // 埋点类型
  actionType: EActionType;
  // 埋点开始时间
  startTime?: number;
  // 埋点停留时间
  durationTime?: number;
  // 上报时间
  trackTime?: number;
}

export function isReportDataType(data: ReportDataType | TrackReportData): data is ReportDataType {
  return (<TrackReportData>data).actionType === undefined && !data.isTrackData;
}
