import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractToken, signToken, verifyToken } from '../../examples/server/core/token';
import {
  createUserVisitorId,
  createVisitorId,
  getClientIp,
  hashIp,
  maskIp,
  normalizeIp,
} from '../../examples/server/core/visitor';
import { RateLimiter } from '../../examples/server/core/rateLimit';
import { Identity } from '../../examples/server/core/identity';
import { AlertEngine } from '../../examples/server/core/alert';
import { normalizePayload } from '../../examples/server/ingest/normalize';
import { stackFromPayload, stackToText } from '../../examples/server/db/stack';
import { JsonStore } from '../../examples/server/db/jsonStore';
import { AlertRuleRow, EventRow, GroupStat, Store } from '../../examples/server/db/types';

/**
 * 采集端核心逻辑单测。
 *
 * 这些模块是「数据正确性 + 告警正确性」的地基：
 * - token / 访客 id 决定统计口径，算错就全盘失真；
 * - 归一化决定入库字段，错一个字段报表就错；
 * - 预警引擎决定阈值判定，误报漏报都会被骂；
 * - JsonStore 的聚合逻辑与 SqliteStore 语义必须一致。
 */

const SECRET = 'unit-test-secret';

function makeIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    visitorId: 'v_test_visitor',
    identityKind: 'anonymous',
    userId: null,
    tokenJti: null,
    tokenStatus: 'none',
    ip: '1.2.3.4',
    ipHash: 'ip_hash',
    ipPrefix: '1.2.x.x',
    ua: 'unit-test-agent',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventUid: `uid_${Math.random().toString(36).slice(2)}`,
    kind: 'error',
    errorType: 'JAVASCRIPT_ERROR',
    level: 'error',
    message: 'boom',
    name: 'Error',
    stack: null,
    errorId: 1,
    groupKey: 'err_1',
    url: 'http://localhost/page',
    routeFrom: null,
    routeTo: null,
    title: null,
    count: 1,
    isUv: 0,
    httpMethod: null,
    httpStatus: null,
    elapsedTime: null,
    componentName: null,
    customTag: null,
    visitorId: 'v_test_visitor',
    identityKind: 'anonymous',
    userId: null,
    tokenJti: null,
    ipHash: 'ip_hash',
    ipPrefix: '1.2.x.x',
    ua: 'unit-test-agent',
    trackerId: null,
    sdkName: 'test-sdk',
    sdkVersion: '0.0.1',
    appKey: 'ak',
    clientTime: 1700000000000,
    createdAt: Date.now(),
    payload: null,
    ...overrides,
  };
}

function makeRule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: 1,
    name: '单元测试规则',
    scope: 'global',
    scopeValue: null,
    metric: 'count',
    threshold: 3,
    windowMs: 60 * 1000,
    cooldownMs: 60 * 1000,
    enabled: 1,
    channels: '["console"]',
    ...overrides,
  };
}

/** AlertEngine 只依赖 listAlertRules，这里给一个最小 Store 替身 */
function makeRuleStore(rules: AlertRuleRow[]): Store {
  return { listAlertRules: () => rules } as unknown as Store;
}

describe('token（HS256）', () => {
  it('签发后能校验通过，并带出 claims', () => {
    const token = signToken({ sub: 'user_1', jti: 'jti_1' }, SECRET, 60);
    const result = verifyToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('user_1');
      expect(result.claims.jti).toBe('jti_1');
      expect(result.claims.exp).toBeGreaterThan(result.claims.iat as number);
    }
  });

  it('签名被篡改时返回 bad-signature', () => {
    const token = signToken({ sub: 'user_1' }, SECRET, 60);
    const tampered = `${token.slice(0, -3)}abc`;
    const result = verifyToken(tampered, SECRET);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('bad-signature');
  });

  it('换密钥后校验失败', () => {
    const token = signToken({ sub: 'user_1' }, SECRET, 60);
    const result = verifyToken(token, 'other-secret');
    expect(result.ok).toBe(false);
  });

  it('过期 token 返回 expired，未生效返回 not-active', () => {
    const expired = signToken({ sub: 'u', exp: 1000 }, SECRET, 60);
    const expiredResult = verifyToken(expired, SECRET, { now: 2000 });
    expect(expiredResult.ok).toBe(false);
    if (expiredResult.ok === false) expect(expiredResult.reason).toBe('expired');

    const notActive = signToken({ sub: 'u', nbf: 5000 }, SECRET, 60);
    const nbfResult = verifyToken(notActive, SECRET, { now: 1000 });
    expect(nbfResult.ok).toBe(false);
    if (nbfResult.ok === false) expect(nbfResult.reason).toBe('not-active');
  });

  it('结构不合法 / 算法不是 HS256 时返回 malformed', () => {
    expect(verifyToken('not-a-token', SECRET).ok).toBe(false);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url');
    const result = verifyToken(`${header}.${payload}.`, SECRET);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('malformed');
  });

  it('iss 不匹配时返回 bad-issuer', () => {
    const token = signToken({ sub: 'u', iss: 'a' }, SECRET, 60);
    const result = verifyToken(token, SECRET, { issuer: 'b' });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('bad-issuer');
  });

  it('extractToken 按 header > query > body 的优先级取 token', () => {
    expect(
      extractToken({
        headers: { authorization: 'Bearer from-header' },
        query: { token: 'from-query' },
        body: { token: 'from-body' },
      }),
    ).toBe('from-header');
    expect(extractToken({ headers: {}, query: { token: 'from-query' } })).toBe('from-query');
    expect(extractToken({ headers: {}, body: { token: 'from-body' } })).toBe('from-body');
    expect(extractToken({ headers: {}, query: {} })).toBeUndefined();
    // 非 Bearer 形式不算 token
    expect(extractToken({ headers: { authorization: 'Basic xxx' } })).toBeUndefined();
  });
});

describe('visitor（IP / 访客 id）', () => {
  it('归一化 IPv4-mapped / 带端口 / 方括号 IPv6', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('1.2.3.4:5678')).toBe('1.2.3.4');
    expect(normalizeIp('[::1]:2021')).toBe('::1');
    expect(normalizeIp('  10.0.0.1 ')).toBe('10.0.0.1');
    expect(normalizeIp('')).toBe('');
  });

  it('优先取 X-Forwarded-For 的第一跳', () => {
    expect(
      getClientIp({
        headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' },
        socketAddress: '127.0.0.1',
      }),
    ).toBe('9.9.9.9');
    expect(getClientIp({ headers: { 'x-real-ip': '8.8.8.8' }, socketAddress: '127.0.0.1' })).toBe(
      '8.8.8.8',
    );
    // trustProxy=false 时只用 socket 地址
    expect(
      getClientIp({
        headers: { 'x-forwarded-for': '9.9.9.9' },
        socketAddress: '127.0.0.1',
        trustProxy: false,
      }),
    ).toBe('127.0.0.1');
  });

  it('脱敏网段：IPv4 保留前两段，IPv6 保留前四组', () => {
    expect(maskIp('1.2.3.4')).toBe('1.2.x.x');
    expect(maskIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(maskIp('')).toBe('unknown');
  });

  it('IP 哈希不可逆，且加盐后变化', () => {
    expect(hashIp('1.2.3.4', 'salt-a')).not.toContain('1.2.3.4');
    expect(hashIp('1.2.3.4', 'salt-a')).toBe(hashIp('1.2.3.4', 'salt-a'));
    expect(hashIp('1.2.3.4', 'salt-a')).not.toBe(hashIp('1.2.3.4', 'salt-b'));
  });

  it('匿名访客 id：同 IP + 同 UA 稳定，换 UA 变化', () => {
    const a = createVisitorId('1.2.3.4', 'ua-1', 'salt');
    const b = createVisitorId('1.2.3.4', 'ua-1', 'salt');
    const c = createVisitorId('1.2.3.4', 'ua-2', 'salt');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('v_')).toBe(true);
    expect(createUserVisitorId('user_1', 'salt').startsWith('u_')).toBe(true);
  });
});

describe('RateLimiter（令牌桶）', () => {
  it('超过容量后拒绝，随时间补充令牌', () => {
    const limiter = new RateLimiter(2);
    const now = 1_000_000;
    expect(limiter.take('a', now)).toBe(true);
    expect(limiter.take('a', now)).toBe(true);
    expect(limiter.take('a', now)).toBe(false);
    // 30s 后补 1 个令牌（2/分钟）
    expect(limiter.take('a', now + 30_000)).toBe(true);
    // 不同访客互不影响
    expect(limiter.take('b', now)).toBe(true);
  });

  it('限流为 0 时不做限制', () => {
    const limiter = new RateLimiter(0);
    expect(limiter.enabled).toBe(false);
    for (let i = 0; i < 100; i += 1) expect(limiter.take('a', 1)).toBe(true);
  });

  it('sweep 清理空闲桶', () => {
    const limiter = new RateLimiter(10);
    limiter.take('a', 1_000);
    expect(limiter.size).toBe(1);
    limiter.sweep(1_000 + 11 * 60 * 1000);
    expect(limiter.size).toBe(0);
  });
});

describe('normalizePayload（报文归一化）', () => {
  const identity = makeIdentity();
  const now = 1_700_000_000_000;
  const opts = { identity, endpoint: 'error' as const, pvSampleRate: 1, now };

  it('单条错误报文：字段落位 + 指纹用 errorId', () => {
    const result = normalizePayload(
      {
        authInfo: { apikey: 'ak', sdkName: 'web', sdkVersion: '1.0.0', trackerId: 't1' },
        data: {
          type: 'JAVASCRIPT_ERROR',
          message: 'boom',
          name: 'TypeError',
          url: 'http://localhost/page',
          time: 1700000000000,
          level: 'error',
          errorId: 123,
          stack: 'at foo',
        },
      },
      opts,
    );

    expect(result.rawCount).toBe(1);
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event.kind).toBe('error');
    expect(event.groupKey).toBe('err_123');
    expect(event.errorId).toBe(123);
    expect(event.visitorId).toBe(identity.visitorId);
    expect(event.identityKind).toBe('anonymous');
    expect(event.trackerId).toBe('t1');
    expect(event.appKey).toBe('ak');
    expect(event.createdAt).toBe(now);
    expect(event.eventUid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('结构化 stack 数组按 JSON 落库，不再被 toText 丢掉', () => {
    const stack = [
      { url: 'http://localhost/assets/index-abc.js', func: 'handleClick', line: 10, column: 5 },
      { url: 'http://localhost/assets/index-abc.js', func: 'anonymous', line: 20, column: 9 },
    ];
    const result = normalizePayload(
      {
        data: {
          type: 'JAVASCRIPT_ERROR',
          message: 'boom',
          errorId: 456,
          stack,
        },
      },
      opts,
    );

    expect(result.events[0].stack).toBe(JSON.stringify(stack));
  });

  it('stackToText 按整帧截断，结果仍是合法 JSON；旧 payload 可回填', () => {
    const frames = Array.from({ length: 6 }, (_, index) => ({
      url: `http://localhost/assets/${'x'.repeat(80)}-${index}.js`,
      func: 'fn',
      line: index + 1,
      column: 1,
    }));
    const text = stackToText(frames, 300);
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text as string) as unknown[];
    expect(parsed.length).toBeLessThan(frames.length);

    const payload = JSON.stringify({ message: 'boom', stack: frames });
    expect(JSON.parse(stackFromPayload(payload) as string)).toHaveLength(frames.length);
    expect(stackFromPayload('{broken')).toBeNull();
  });

  it('PV/UV 数组：UV 标记 isUv，PV 保留聚合 count', () => {
    const result = normalizePayload(
      {
        authInfo: { trackKey: 'tk', sdkName: 'web', sdkVersion: '1.0.0' },
        data: [
          { type: 'UV', to: '/home', time: 1, isUv: true },
          { type: 'PV', from: '/home', to: '/detail', time: 2, count: 3 },
        ],
      },
      { identity, endpoint: 'pv', pvSampleRate: 1, now },
    );

    expect(result.events).toHaveLength(2);
    expect(result.events[0].kind).toBe('uv');
    expect(result.events[0].isUv).toBe(1);
    expect(result.events[1].kind).toBe('pv');
    expect(result.events[1].count).toBe(3);
    expect(result.events[1].groupKey).toBeNull();
    expect(result.events[0].appKey).toBe('tk');
  });

  it('批量报文（batch:true）拆成多条', () => {
    const result = normalizePayload(
      {
        authInfo: { apikey: 'ak' },
        batch: true,
        count: 2,
        data: [
          { authInfo: { apikey: 'ak' }, data: { type: 'RESOURCE_ERROR', message: 'a', errorId: 1 } },
          { authInfo: { apikey: 'ak' }, data: { type: 'HTTP_ERROR', message: 'b', errorId: 2 } },
        ],
      },
      opts,
    );

    expect(result.rawCount).toBe(2);
    expect(result.events.map((event) => event.groupKey)).toEqual(['err_1', 'err_2']);
  });

  it('没有 errorId 时按 type|name|message|route 生成稳定指纹', () => {
    const build = (message: string) =>
      normalizePayload(
        { data: { type: 'RESOURCE_ERROR', message, url: 'http://localhost/a' } },
        opts,
      ).events[0].groupKey;

    const first = build('同一错误');
    expect(first).toMatch(/^fp_[0-9a-f]{16}$/);
    expect(build('同一错误')).toBe(first);
    expect(build('另一个错误')).not.toBe(first);
  });

  it('PV 采样只影响 PV，不影响错误', () => {
    const pvResult = normalizePayload(
      { data: [{ type: 'PV', to: '/a', count: 1 }] },
      { identity, endpoint: 'pv', pvSampleRate: 0, now },
    );
    expect(pvResult.events).toHaveLength(0);
    expect(pvResult.sampled).toBe(1);

    const errorResult = normalizePayload(
      { data: { type: 'JAVASCRIPT_ERROR', message: 'x', errorId: 7 } },
      { identity, endpoint: 'error', pvSampleRate: 0, now },
    );
    expect(errorResult.events).toHaveLength(1);
    expect(errorResult.sampled).toBe(0);
  });

  it('结构不合法时计入 invalid，不抛异常', () => {
    expect(normalizePayload(null, opts).invalid).toBe(1);
    expect(normalizePayload('oops', opts).invalid).toBe(1);
    const empty = normalizePayload({ authInfo: {} }, opts);
    expect(empty.events).toHaveLength(0);
    expect(empty.invalid).toBe(1);
  });
});

describe('AlertEngine（滑动窗口 + 冷却）', () => {
  const now = 1_700_000_000_000;

  function makeGroup(overrides: Partial<GroupStat> = {}): GroupStat {
    return {
      groupKey: 'err_1',
      errorType: 'JAVASCRIPT_ERROR',
      name: 'Error',
      message: 'boom',
      sampleUrl: 'http://localhost/page',
      totalCount: 1,
      affectedUsers: 1,
      firstSeen: now,
      lastSeen: now,
      isNew: false,
      ...overrides,
    };
  }

  it('全局条数达到阈值才触发，冷却期内不重复触发', () => {
    const engine = new AlertEngine(
      makeRuleStore([makeRule({ threshold: 3, windowMs: 60_000, cooldownMs: 60_000 })]),
    );
    engine.observe([makeEvent(), makeEvent()], [], now);
    expect(engine.evaluate(now)).toHaveLength(0);

    engine.observe([makeEvent()], [], now);
    const fired = engine.evaluate(now);
    expect(fired).toHaveLength(1);
    expect(fired[0].value).toBe(3);
    expect(fired[0].threshold).toBe(3);

    // 冷却期内：即使又有新错误也不重复推送
    engine.observe([makeEvent()], [], now + 1000);
    expect(engine.evaluate(now + 1000)).toHaveLength(0);
  });

  it('窗口滑过后旧数据不再计数', () => {
    const engine = new AlertEngine(
      makeRuleStore([makeRule({ threshold: 2, windowMs: 10_000, cooldownMs: 0 })]),
    );
    engine.observe([makeEvent(), makeEvent()], [], now);
    expect(engine.evaluate(now)).toHaveLength(1);
    expect(engine.evaluate(now + 11_000)).toHaveLength(0);
  });

  it('users 口径按访客去重，同一访客重复上报不虚增', () => {
    const engine = new AlertEngine(
      makeRuleStore([makeRule({ scope: 'group', metric: 'users', threshold: 2, cooldownMs: 0 })]),
    );
    engine.observe([makeEvent({ visitorId: 'v1' }), makeEvent({ visitorId: 'v2' })], [], now);
    const fired = engine.evaluate(now);
    expect(fired).toHaveLength(1);
    expect(fired[0].value).toBe(2);

    engine.observe([makeEvent({ visitorId: 'v1' }), makeEvent({ visitorId: 'v1' })], [], now + 10);
    const again = engine.evaluate(now + 10);
    expect(again[0].value).toBe(2);
  });

  it('error_type 口径只统计对应类型', () => {
    const engine = new AlertEngine(
      makeRuleStore([
        makeRule({ scope: 'error_type', scopeValue: 'JAVASCRIPT_ERROR', threshold: 2, cooldownMs: 0 }),
      ]),
    );
    engine.observe(
      [makeEvent({ errorType: 'RESOURCE_ERROR' }), makeEvent({ errorType: 'RESOURCE_ERROR' })],
      [],
      now,
    );
    expect(engine.evaluate(now)).toHaveLength(0);

    engine.observe(
      [makeEvent({ errorType: 'JAVASCRIPT_ERROR' }), makeEvent({ errorType: 'JAVASCRIPT_ERROR' })],
      [],
      now,
    );
    expect(engine.evaluate(now)).toHaveLength(1);
  });

  it('new_group 口径只认新建分组', () => {
    const engine = new AlertEngine(
      makeRuleStore([makeRule({ metric: 'new_group', threshold: 1, cooldownMs: 0 })]),
    );
    engine.observe([], [makeGroup({ groupKey: 'err_1', isNew: false })], now);
    expect(engine.evaluate(now)).toHaveLength(0);

    engine.observe([], [makeGroup({ groupKey: 'err_2', isNew: true })], now);
    const fired = engine.evaluate(now);
    expect(fired).toHaveLength(1);
    expect(fired[0].groupKey).toBeNull();
    expect(fired[0].metric).toBe('new_group');
  });

  it('enabled=0 的规则不参与评估', () => {
    const engine = new AlertEngine(makeRuleStore([makeRule({ enabled: 0, threshold: 1 })]));
    engine.observe([makeEvent()], [], now);
    expect(engine.evaluate(now)).toHaveLength(0);
    expect(engine.getRules()).toHaveLength(0);
  });
});

describe('JsonStore（降级存储的聚合语义）', () => {
  let dir: string;
  let store: JsonStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monitor-store-'));
    store = new JsonStore(join(dir, 'store.json'));
    store.init();
  });

  afterEach(() => {
    store.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('初始化时写入内置预警规则', () => {
    expect(store.driver).toBe('json');
    expect(store.listAlertRules().length).toBeGreaterThanOrEqual(4);
  });

  it('写入明细时同步维护分组次数与去重用户数', () => {
    const result = store.writeEvents([
      makeEvent({ eventUid: 'u1', visitorId: 'v1' }),
      makeEvent({ eventUid: 'u2', visitorId: 'v2' }),
    ]);

    expect(result.inserted).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].totalCount).toBe(2);
    expect(result.groups[0].affectedUsers).toBe(2);
    expect(result.groups[0].isNew).toBe(true);

    const groups = store.listErrorGroups(10, 0);
    expect(groups[0].groupKey).toBe('err_1');
    expect(groups[0].affectedUsers).toBe(2);
  });

  it('同一访客重复触发不会虚增 affectedUsers', () => {
    store.writeEvents([makeEvent({ eventUid: 'u1', visitorId: 'v1' })]);
    store.writeEvents([makeEvent({ eventUid: 'u2', visitorId: 'v1' })]);
    const groups = store.listErrorGroups(10, 0);
    expect(groups[0].totalCount).toBe(2);
    expect(groups[0].affectedUsers).toBe(1);
  });

  it('按 groupKey 返回最近错误样本，并可从 payload 回填旧堆栈', () => {
    const oldStack = [{ url: 'http://localhost/old.js', func: 'oldFn', line: 3, column: 4 }];
    store.writeEvents([
      makeEvent({
        eventUid: 'old-sample',
        message: 'old',
        // 模拟修复前入库：stack 为空，但 payload 保留了原始上报
        stack: null,
        payload: JSON.stringify({ message: 'old', stack: oldStack }),
        createdAt: 1_700_000_000_000,
      }),
    ]);
    store.writeEvents([
      makeEvent({
        eventUid: 'new-sample',
        message: 'new',
        stack: JSON.stringify([{ url: 'http://localhost/new.js', func: 'newFn', line: 8, column: 2 }]),
        createdAt: 1_700_000_000_001,
      }),
    ]);

    const samples = store.listErrorSamples('err_1', 5);
    expect(samples.map((sample) => sample.message)).toEqual(['new', 'old']);
    expect(JSON.parse(samples[0].stack as string)[0]).toMatchObject({ func: 'newFn', line: 8 });
    expect(JSON.parse(samples[1].stack as string)).toEqual(oldStack);
    expect(store.listErrorSamples('err_missing', 5)).toEqual([]);
  });

  it('错误样本接口只返回错误明细，不带 PV 行', () => {
    store.writeEvents([
      makeEvent({ eventUid: 'e1', kind: 'error', groupKey: 'err_1' }),
      makeEvent({ eventUid: 'p1', kind: 'pv', groupKey: 'err_1', message: 'pv-row' }),
    ]);
    const samples = store.listErrorSamples('err_1', 10);
    expect(samples).toHaveLength(1);
    expect(samples[0].message).toBe('boom');
  });

  it('eventUid 重复时幂等丢弃', () => {
    store.writeEvents([makeEvent({ eventUid: 'same' })]);
    const second = store.writeEvents([makeEvent({ eventUid: 'same' })]);
    expect(second.inserted).toBe(0);
    expect(second.duplicated).toBe(1);
    expect(store.overview(0).errors).toBe(1);
  });

  it('PV / UV 汇总：PV 按 count 累加，UV 按访客去重', () => {
    store.writeEvents([
      makeEvent({ eventUid: 'p1', kind: 'pv', count: 3, groupKey: null, visitorId: 'v1' }),
      makeEvent({ eventUid: 'p2', kind: 'uv', groupKey: null, visitorId: 'v1' }),
    ]);

    const overview = store.overview(0);
    expect(overview.pv).toBe(3);
    expect(overview.uv).toBe(1);
    expect(overview.errors).toBe(0);
    expect(overview.errorRate).toBe(0);

    const daily = store.listPvDaily(7);
    expect(daily).toHaveLength(1);
    expect(daily[0].pv).toBe(3);
    expect(daily[0].uv).toBe(1);
  });

  it('purgeBefore 清理过期明细与分组', () => {
    store.writeEvents([makeEvent({ eventUid: 'old', createdAt: 1000 })]);
    const removed = store.purgeBefore(2000);
    expect(removed).toBeGreaterThan(0);
    expect(store.overview(0).errors).toBe(0);
    expect(store.listErrorGroups(10, 0)).toHaveLength(0);
  });

  it('预警日志可写入并按倒序查询', () => {
    store.logAlert({
      ruleId: 1,
      ruleName: '规则A',
      groupKey: 'err_1',
      metric: 'count',
      value: 10,
      threshold: 5,
      windowMs: 60_000,
      channels: '["console"]',
      payload: 'text',
      delivered: 1,
      error: null,
      createdAt: 1000,
    });
    store.logAlert({
      ruleId: 2,
      ruleName: '规则B',
      groupKey: null,
      metric: 'new_group',
      value: 1,
      threshold: 1,
      windowMs: 60_000,
      channels: '["console"]',
      payload: 'text2',
      delivered: 0,
      error: 'HTTP 500',
      createdAt: 2000,
    });

    const alerts = store.listAlerts(10);
    expect(alerts).toHaveLength(2);
    expect(alerts[0].ruleName).toBe('规则B');
    expect(alerts[0].error).toBe('HTTP 500');
  });
});
