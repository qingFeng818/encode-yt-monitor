import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/**
 * 监听元素内容宽度（px）。
 *
 * 为什么不用 canvas `measureText`：
 * - canvas 只能估算字形宽度，测不到 padding / border / icon / flex gap；
 * - 浏览器缩放、用户自定义字体、字体晚加载都会让估算值失真；
 * - 折叠计算需要的是「元素实际占位宽度」，直接用 DOM 测量最准确。
 *
 * 这里用 ResizeObserver 而不是 window.resize：
 * - 侧边栏折叠、父容器栅格变化时元素宽度也会变，window.resize 捕获不到；
 * - ResizeObserver 只在尺寸真正变化时回调，成本更低。
 *
 * 初始值用 Infinity 而不是 0：首次渲染时按「全部放得下」处理，
 * 避免挂载瞬间先渲染成折叠态再展开造成明显跳动；onMounted 里会立刻量一次真实宽度。
 */
export function useElementWidth(target: Ref<HTMLElement | null>): Ref<number> {
  const width = ref(Number.POSITIVE_INFINITY);
  let observer: ResizeObserver | null = null;

  function read(): void {
    const element = target.value;
    if (!element) return;
    const next = Math.round(element.getBoundingClientRect().width);
    if (next > 0 && next !== width.value) width.value = next;
  }

  onMounted(() => {
    read();
    if (!target.value || typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(() => read());
    observer.observe(target.value);
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return width;
}
