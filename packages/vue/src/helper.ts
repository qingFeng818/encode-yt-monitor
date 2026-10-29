import {
  getBigVersion,
  getLocationHref,
  getTimestamp,
  variableTypeDetection,
  Severity,
  isError,
  extractErrorStack,
} from 'encode-yt-monitor-utils';
import { ErrorTypes, BreadCrumbTypes } from 'encode-yt-monitor-shared';
import { breadcrumb, transportData } from 'encode-yt-monitor-core';
import { ReportDataType, ViewModel, VueInstance } from 'encode-yt-monitor-types';

export function handleVueError(
  err: Error,
  vm: ViewModel,
  info: string,
  level: Severity,
  breadcrumbLevel: Severity,
  Vue: VueInstance,
): void {
  const version = Vue?.version || Vue.config?.globalProperties?.$vue?.version || '3';
  // 将 err.stack 原始字符串解析为结构化栈帧数组，与 window error、Promise 错误保持同一格式
  const parsedError = isError(err) ? extractErrorStack(err, level) : null;
  let data: ReportDataType = {
    type: ErrorTypes.VUE_ERROR,
    message: `${err.message}(${info})`,
    level,
    url: getLocationHref(),
    name: err.name,
    // 解析成功用结构化数组；解析失败（正则不匹配/无 stack）兜底保留原始字符串
    stack: parsedError?.stack || err.stack || [],
    time: getTimestamp(),
  };
  if (variableTypeDetection.isString(version)) {
    switch (getBigVersion(version)) {
      case 2:
        data = { ...data, ...vue2VmHandler(vm) };
        break;
      case 3:
        data = { ...data, ...vue3VmHandler(vm) };
        break;
      default:
        break;
    }
  }
  breadcrumb.push({
    type: BreadCrumbTypes.VUE,
    category: breadcrumb.getCategory(BreadCrumbTypes.VUE),
    data,
    level: breadcrumbLevel,
  });
  transportData.send(data);
}
function vue2VmHandler(vm: ViewModel) {
  if (!vm) return { componentName: 'outside component' };
  let componentName = '';
  if (vm.$root === vm) {
    componentName = 'root';
  } else {
    const name = vm._isVue
      ? (vm.$options && vm.$options.name) || (vm.$options && vm.$options._componentTag)
      : vm.name;
    componentName =
      (name ? 'component <' + name + '>' : 'anonymous component') +
      (vm._isVue && vm.$options && vm.$options.__file
        ? ' at ' + (vm.$options && vm.$options.__file)
        : '');
  }
  return {
    componentName,
    propsData: vm.$options && vm.$options.propsData,
  };
}
function vue3VmHandler(vm: ViewModel) {
  if (!vm) return { componentName: 'outside component' };
  let componentName = '';
  if (vm.$root === vm) {
    componentName = 'root';
  } else {
    const name = vm.$options && vm.$options.name;
    componentName = name ? 'component <' + name + '>' : 'anonymous component';
  }
  return {
    componentName,
    propsData: vm.$props,
  };
}
