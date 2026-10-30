class Router {
  constructor(routes = [], options = {}) {
    this.routes = routes;

    // 完整路径 -> 路由记录
    this.routerMap = new Map();

    // 页面挂载容器
    this.root = options.root || '#app';

    // 404 页面
    this.notFound =
      options.notFound ||
      (() => `
      <div>
        <h1>404</h1>
        <p>页面不存在</p>
      </div>
    `);

    // 绑定 this，避免事件回调中的 this 丢失
    this.render = this.render.bind(this);
    this.handleClick = this.handleClick.bind(this);

    this.initRouterMap();
    this.initRouter();
  }

  /**
   * 规范化路径
   */
  normalizePath(path) {
    if (!path || path === '/') {
      return '/';
    }

    const segments = path.split('/').filter(Boolean);

    return '/' + segments.join('/');
  }

  /**
   * 递归构建路由表
   */
  initRouterMap(routes = this.routes, parent = null) {
    routes.forEach((item) => {
      const rawPath = item.path || '';

      // 支持相对路径和绝对路径
      let fullPath;

      if (rawPath.startsWith('/')) {
        fullPath = this.normalizePath(rawPath);
      } else {
        const parentPath = parent ? parent.path : '';

        fullPath = this.normalizePath(`${parentPath}/${rawPath}`);
      }

      // 创建路由记录
      const record = {
        path: fullPath,
        component: item.component,
        parent,
        children: [],
      };

      // 保存完整路径对应的路由记录
      this.routerMap.set(fullPath, record);

      // 维护父子关系
      if (parent) {
        parent.children.push(record);
      }

      // 递归处理子路由
      if (item.children?.length) {
        this.initRouterMap(item.children, record);
      }
    });
  }

  /**
   * 初始化路由系统
   */
  initRouter() {
    // 浏览器前进、后退
    window.addEventListener('popstate', this.render);

    // 拦截站内导航链接
    document.addEventListener('click', this.handleClick);

    // 首次加载时渲染
    this.render();
  }

  /**
   * 获取当前路由记录及其所有父级记录
   */
  getMatched(path) {
    const record = this.routerMap.get(this.normalizePath(path));

    if (!record) {
      return [];
    }

    const matched = [];

    let current = record;

    // 从当前路由向上寻找所有父级
    while (current) {
      matched.unshift(current);
      current = current.parent;
    }

    return matched;
  }

  /**
   * 将组件内容转换为 DOM 元素
   *
   * component 可以是：
   * 1. HTML 字符串
   * 2. 返回 HTML 字符串的函数
   * 3. 返回 DOM 元素的函数
   */
  createElement(component) {
    if (typeof component === 'function') {
      component = component();
    }

    if (component instanceof Node) {
      // 避免直接移动调用者提供的 DOM 节点
      return component.cloneNode(true);
    }

    if (typeof component !== 'string') {
      throw new TypeError('路由组件必须返回 HTML 字符串或 DOM 节点');
    }

    const template = document.createElement('template');

    template.innerHTML = component.trim();

    const wrapper = document.createElement('div');

    wrapper.appendChild(template.content.cloneNode(true));

    return wrapper;
  }

  /**
   * 渲染当前路由
   */
  render() {
    const root = document.querySelector(this.root);

    if (!root) {
      console.error(`找不到路由挂载容器：${this.root}`);
      return;
    }

    const url = new URL(window.location.href);

    // 只用 pathname 匹配路由
    const matched = this.getMatched(url.pathname);

    // 未匹配到路由
    if (matched.length === 0) {
      const notFoundElement = this.createElement(this.notFound);

      root.replaceChildren(...notFoundElement.childNodes);

      return;
    }

    // 从最内层子组件开始构建
    let childElement = null;

    for (let i = matched.length - 1; i >= 0; i--) {
      const record = matched[i];

      const currentElement = this.createElement(record.component);

      // 查找当前组件提供的子路由出口
      const outlet = currentElement.querySelector('router-view');

      if (outlet) {
        if (childElement) {
          outlet.replaceWith(childElement);
        } else {
          // 当前没有匹配到更深层的路由
          outlet.remove();
        }
      }

      childElement = currentElement;
    }

    // 将最终组装好的父子组件树挂载到页面
    root.replaceChildren(...childElement.childNodes);
  }

  /**
   * 程序化导航
   */
  push(state, url) {
    const target = new URL(url, window.location.href);

    // 不允许用当前路由实例导航到其他源
    if (target.origin !== window.location.origin) {
      window.location.assign(target.href);
      return;
    }

    // 更新浏览器历史记录
    window.history.pushState(state, '', url);

    // pushState 不会自动触发 popstate
    this.render();
  }

  /**
   * 处理站内链接点击
   */
  handleClick(event) {
    // 不拦截鼠标中键、Ctrl 点击等浏览器默认操作
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const link = event.target.closest('a[data-router-link]');

    if (!link) {
      return;
    }

    if (link.target || link.hasAttribute('download')) {
      return;
    }

    const target = new URL(link.href);

    if (target.origin !== window.location.origin) {
      return;
    }

    event.preventDefault();

    this.push(null, target.href);
  }

  /**
   * 销毁路由监听器
   */
  destroy() {
    window.removeEventListener('popstate', this.render);

    document.removeEventListener('click', this.handleClick);
  }
}
window.Router = Router;
