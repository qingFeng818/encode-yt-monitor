/**
 * 堆栈解析（错误列表展开行）。
 *
 * SDK 上报的 stack 是 `extractErrorStack()` 解析后的结构化数组，后端以 JSON 字符串落库：
 * `[{ func, url, line, column }]`。但历史数据、手工上报、其它 SDK 也可能给原始堆栈文本
 * （Chrome `at fn (url:line:col)` / Firefox `fn@url:line:col`），所以两种格式都要兼容。
 *
 * 这里不做 source map 映射：没有 source map 时只能给出「压缩后 bundle 的 URL + 行列号」，
 * 这已经是浏览器能提供的精确定位；映射回 .ts/.vue 需要额外上传并在服务端解析 source map。
 */

export interface StackFrame {
  /** 函数名；匿名 / 解析失败时为 'anonymous' */
  func: string;
  /** 脚本 URL；native / 无法识别时为 null */
  url: string | null;
  line: number | null;
  column: number | null;
}

/** 最多展示的帧数：防止一条异常堆栈把详情行撑得过高 */
export const MAX_STACK_FRAMES = 30;

function toPositiveInt(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从结构化帧对象取字段，兼容常见的几种命名 */
function frameFromObject(value: unknown): StackFrame | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const url = textOf(record.url) || textOf(record.sourceURL) || textOf(record.filename) || null;
  const func =
    textOf(record.func) ||
    textOf(record.function) ||
    textOf(record.methodName) ||
    textOf(record.functionName) ||
    'anonymous';
  const line = toPositiveInt(record.line ?? record.lineno ?? record.lineNumber);
  const column = toPositiveInt(record.column ?? record.col ?? record.columnNumber);

  // 只有函数名、没有位置的帧（native / <anonymous>）对定位没有帮助，直接丢掉
  if (!url && line === null) return null;
  return { func, url, line, column };
}

/** 从 `url:line:column` / `url:line` 中拆出位置；端口号不会被误判为行号 */
function frameFromLocation(location: string, func: string): StackFrame | null {
  const text = location.trim().replace(/^\(|\)$/g, '');
  if (!text || text === 'native' || text === '<anonymous>') return null;

  const match = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(text);
  if (!match) {
    // 没有行列号但有 URL（例如 blob: / webpack:）时仍然保留，方便人工判断来源
    return /^(?:https?|file|blob|webpack|chrome-extension):/i.test(text)
      ? { func, url: text, line: null, column: null }
      : null;
  }

  const url = match[1] || null;
  const line = toPositiveInt(match[2]);
  const column = toPositiveInt(match[3]);
  if (!url && line === null) return null;
  return { func, url, line, column };
}

/** 解析单行原始堆栈（Chrome / Firefox / Safari 常见格式） */
function parseRawLine(line: string): StackFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (/^at\s+/i.test(trimmed)) {
    let body = trimmed.replace(/^at\s+/i, '').replace(/^async\s+/i, '');
    let func = 'anonymous';
    let location = body;

    // Chrome: "fn (url:line:col)" / "Object.<anonymous> (url:line:col)"
    const open = body.lastIndexOf(' (');
    if (open !== -1 && body.endsWith(')')) {
      func = body.slice(0, open).trim() || 'anonymous';
      location = body.slice(open + 2, -1).trim();
    }
    return frameFromLocation(location, func);
  }

  // Firefox / Safari: "fn@url:line:col"
  const at = trimmed.lastIndexOf('@');
  if (at !== -1) {
    const func = trimmed.slice(0, at).trim() || 'anonymous';
    return frameFromLocation(trimmed.slice(at + 1), func);
  }

  // 纯位置行（部分自定义 SDK 只上报 location）
  return frameFromLocation(trimmed, 'anonymous');
}

/**
 * 把 stack 字段解析成帧数组。
 *
 * @param raw 后端返回的 stack（JSON 字符串 / 原始堆栈字符串 / null）
 */
export function parseStack(raw: string | null | undefined): StackFrame[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];

  // 1) 结构化 JSON（当前 SDK 的正常路径）
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).stack)
          ? ((parsed as Record<string, unknown>).stack as unknown[])
          : [];
      const frames = list
        .map(frameFromObject)
        .filter((frame): frame is StackFrame => Boolean(frame))
        .slice(0, MAX_STACK_FRAMES);
      if (frames.length > 0) return frames;
    } catch (error) {
      // payload 被截断 / 旧数据不是合法 JSON → 退化到按行解析
    }
  }

  // 2) 原始堆栈文本
  return text
    .split(/\r?\n/)
    .map(parseRawLine)
    .filter((frame): frame is StackFrame => Boolean(frame))
    .slice(0, MAX_STACK_FRAMES);
}

/** 展示用的位置文本（保留完整 URL，方便对照压缩产物） */
export function formatFrameLocation(frame: StackFrame): string {
  if (!frame.url) return frame.line ? `line ${frame.line}` : 'native';
  const line = frame.line ? `:${frame.line}` : '';
  const column = frame.column ? `:${frame.column}` : '';
  return `${frame.url}${line}${column}`;
}

/** 只有 http(s) 的脚本地址适合在浏览器新标签打开（blob: / file: 打开没有意义） */
export function isLinkableFrame(frame: StackFrame): boolean {
  return Boolean(frame.url && /^https?:\/\//i.test(frame.url));
}

/** 复制整条堆栈时使用的纯文本格式 */
export function formatStackForCopy(frames: StackFrame[]): string {
  return frames.map((frame, index) => `#${index} ${frame.func} (${formatFrameLocation(frame)})`).join('\n');
}
