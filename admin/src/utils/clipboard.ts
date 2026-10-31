/**
 * 复制文本到剪贴板。
 *
 * navigator.clipboard 只在安全上下文（https / localhost）可用，
 * 内网用 http 访问后台时会拿到 undefined，所以保留 execCommand 兜底。
 * 返回是否成功，由调用方决定提示文案，不在这里抛异常。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒（例如 iframe 未授权）时继续走兜底方案
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
