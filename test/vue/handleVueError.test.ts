import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { handleVueError } from 'encode-yt-monitor-vue/helper';
import { MonitorVue } from 'encode-yt-monitor-vue/index';
import { breadcrumb, transportData } from 'encode-yt-monitor-core';
import { ErrorTypes } from 'encode-yt-monitor-shared';
import { Severity } from 'encode-yt-monitor-utils';
import { SCRIPT_ERROR_FIXTURES, EXPECTED_REPORT_TYPE } from '../helpers/errorFixtures';
import type { ViewModel, VueInstance } from 'encode-yt-monitor-vue/types';
import type { ReportDataType } from 'encode-yt-monitor-types';

function createVue3MockVm(componentName = 'DemoCard'): ViewModel {
  return {
    $root: {} as ViewModel,
    $options: { name: componentName, __file: 'DemoCard.vue' },
    $props: { id: 1 },
  } as ViewModel;
}

function createVue3Instance(version = '3.4.0'): VueInstance {
  return {
    version,
    config: {
      errorHandler: undefined,
      silent: true,
    },
  } as VueInstance;
}

describe('Vue 框架错误（errorHandler，非 window.onerror）', () => {
  let sendSpy: MockInstance<(data: ReportDataType) => Promise<void>>;

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  describe('handleVueError 按错误类型', () => {
    it.each(SCRIPT_ERROR_FIXTURES)('$name 应上报 VUE_ERROR', ({ name, error }) => {
      const err = error();
      const vm = createVue3MockVm('UserList');
      const Vue = createVue3Instance();

      handleVueError(err, vm, 'render function', Severity.Normal, Severity.Error, Vue);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = sendSpy.mock.calls[0][0];
      expect(payload.type).toBe(EXPECTED_REPORT_TYPE.vue);
      expect(payload.name).toBe(name);
      expect(payload.message).toContain('render function');
      expect(payload.componentName).toContain('UserList');
    });

    it('Vue2 实例应附带 propsData', () => {
      const err = new TypeError('vue2 type error');
      const vm = {
        $root: {},
        _isVue: true,
        $options: { name: 'Legacy', propsData: { title: 'hi' } },
        $props: {},
      } as ViewModel;
      const Vue = createVue3Instance('2.7.16');

      handleVueError(err, vm, 'mounted hook', Severity.Normal, Severity.Error, Vue);

      const payload = sendSpy.mock.calls[0][0];
      expect(payload.type).toBe(ErrorTypes.VUE_ERROR);
      expect(payload.propsData).toEqual({ title: 'hi' });
    });
  });

  describe('MonitorVue.install', () => {
    it('安装后 errorHandler 应转发到上报逻辑', () => {
      const Vue = createVue3Instance();

      MonitorVue.install(Vue);
      expect(Vue.config.errorHandler).toBeTypeOf('function');

      const err = new ReferenceError('ref in template');
      Vue.config.errorHandler!(err, createVue3MockVm(), 'render');

      expect(sendSpy).toHaveBeenCalled();
      const payload = sendSpy.mock.calls.at(-1)?.[0];
      expect(payload?.type).toBe(ErrorTypes.VUE_ERROR);
      expect(payload?.name).toBe('ReferenceError');
    });
  });
});
