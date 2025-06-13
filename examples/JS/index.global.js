'use strict';
function e(e, t) {
  if (t == null || t > e.length) t = e.length;
  for (var n = 0, r = new Array(t); n < t; n++) r[n] = e[n];
  return r;
}
function t(t) {
  if (Array.isArray(t)) return e(t);
}
function n(e, t, n, r, a, o, i) {
  try {
    var c = e[o](i);
    var u = c.value;
  } catch (e) {
    n(e);
    return;
  }
  if (c.done) {
    t(u);
  } else {
    Promise.resolve(u).then(r, a);
  }
}
function r(e) {
  return function () {
    var t = this,
      r = arguments;
    return new Promise(function (a, o) {
      var i = e.apply(t, r);
      function c(e) {
        n(i, a, o, c, u, 'next', e);
      }
      function u(e) {
        n(i, a, o, c, u, 'throw', e);
      }
      c(undefined);
    });
  };
}
function a(e, t) {
  if (!(e instanceof t)) {
    throw new TypeError('Cannot call a class as a function');
  }
}
function o(e, t) {
  for (var n = 0; n < t.length; n++) {
    var r = t[n];
    r.enumerable = r.enumerable || false;
    r.configurable = true;
    if ('value' in r) r.writable = true;
    Object.defineProperty(e, r.key, r);
  }
}
function i(e, t, n) {
  if (t) o(e.prototype, t);
  if (n) o(e, n);
  return e;
}
function c(e, t, n) {
  if (t in e) {
    Object.defineProperty(e, t, { value: n, enumerable: true, configurable: true, writable: true });
  } else {
    e[t] = n;
  }
  return e;
}
function u(e, t) {
  if (t != null && typeof Symbol !== 'undefined' && t[Symbol.hasInstance]) {
    return !!t[Symbol.hasInstance](e);
  } else {
    return e instanceof t;
  }
}
function s(e) {
  if ((typeof Symbol !== 'undefined' && e[Symbol.iterator] != null) || e['@@iterator'] != null)
    return Array.from(e);
}
function l() {
  throw new TypeError(
    'Invalid attempt to spread non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.',
  );
}
function f(e) {
  for (var t = 1; t < arguments.length; t++) {
    var n = arguments[t] != null ? arguments[t] : {};
    var r = Object.keys(n);
    if (typeof Object.getOwnPropertySymbols === 'function') {
      r = r.concat(
        Object.getOwnPropertySymbols(n).filter(function (e) {
          return Object.getOwnPropertyDescriptor(n, e).enumerable;
        }),
      );
    }
    r.forEach(function (t) {
      c(e, t, n[t]);
    });
  }
  return e;
}
function h(e, t) {
  var n = Object.keys(e);
  if (Object.getOwnPropertySymbols) {
    var r = Object.getOwnPropertySymbols(e);
    if (t) {
      r = r.filter(function (t) {
        return Object.getOwnPropertyDescriptor(e, t).enumerable;
      });
    }
    n.push.apply(n, r);
  }
  return n;
}
function p(e, t) {
  t = t != null ? t : {};
  if (Object.getOwnPropertyDescriptors) {
    Object.defineProperties(e, Object.getOwnPropertyDescriptors(t));
  } else {
    h(Object(t)).forEach(function (n) {
      Object.defineProperty(e, n, Object.getOwnPropertyDescriptor(t, n));
    });
  }
  return e;
}
function d(e) {
  return t(e) || s(e) || v(e) || l();
}
function g(e) {
  '@swc/helpers - typeof';
  return e && typeof Symbol !== 'undefined' && e.constructor === Symbol ? 'symbol' : typeof e;
}
function v(t, n) {
  if (!t) return;
  if (typeof t === 'string') return e(t, n);
  var r = Object.prototype.toString.call(t).slice(8, -1);
  if (r === 'Object' && t.constructor) r = t.constructor.name;
  if (r === 'Map' || r === 'Set') return Array.from(r);
  if (r === 'Arguments' || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(r)) return e(t, n);
}
function y(e, t) {
  var n,
    r,
    a,
    o = {
      label: 0,
      sent: function () {
        if (a[0] & 1) throw a[1];
        return a[1];
      },
      trys: [],
      ops: [],
    },
    i = Object.create((typeof Iterator === 'function' ? Iterator : Object).prototype);
  return (
    (i.next = c(0)),
    (i['throw'] = c(1)),
    (i['return'] = c(2)),
    typeof Symbol === 'function' &&
      (i[Symbol.iterator] = function () {
        return this;
      }),
    i
  );
  function c(e) {
    return function (t) {
      return u([e, t]);
    };
  }
  function u(c) {
    if (n) throw new TypeError('Generator is already executing.');
    while ((i && ((i = 0), c[0] && (o = 0)), o))
      try {
        if (
          ((n = 1),
          r &&
            (a =
              c[0] & 2
                ? r['return']
                : c[0]
                ? r['throw'] || ((a = r['return']) && a.call(r), 0)
                : r.next) &&
            !(a = a.call(r, c[1])).done)
        )
          return a;
        if (((r = 0), a)) c = [c[0] & 2, a.value];
        switch (c[0]) {
          case 0:
          case 1:
            a = c;
            break;
          case 4:
            o.label++;
            return { value: c[1], done: false };
          case 5:
            o.label++;
            r = c[1];
            c = [0];
            continue;
          case 7:
            c = o.ops.pop();
            o.trys.pop();
            continue;
          default:
            if (
              !((a = o.trys), (a = a.length > 0 && a[a.length - 1])) &&
              (c[0] === 6 || c[0] === 2)
            ) {
              o = 0;
              continue;
            }
            if (c[0] === 3 && (!a || (c[1] > a[0] && c[1] < a[3]))) {
              o.label = c[1];
              break;
            }
            if (c[0] === 6 && o.label < a[1]) {
              o.label = a[1];
              a = c;
              break;
            }
            if (a && o.label < a[2]) {
              o.label = a[2];
              o.ops.push(c);
              break;
            }
            if (a[2]) o.ops.pop();
            o.trys.pop();
            continue;
        }
        c = t.call(e, o);
      } catch (e) {
        c = [6, e];
        r = 0;
      } finally {
        n = a = 0;
      }
    if (c[0] & 5) throw c[1];
    return { value: c[0] ? c[1] : void 0, done: true };
  }
}
var encodeMonitor = (function () {
  var e = function e(e) {
    return function (t) {
      return eN.call(t) === '[object '.concat(e, ']');
    };
  };
  var t = function e(e) {
    switch (eN.call(e)) {
      case '[object Error]':
        return !0;
      case '[object Exception]':
        return !0;
      case '[object DOMException]':
        return !0;
      default:
        return o(e, Error);
    }
  };
  var n = function e(e) {
    return (eI.isString(e) && e.trim() === '') || e === void 0 || e === null;
  };
  var o = function e(e, t) {
    try {
      return u(e, t);
    } catch (e) {
      return !1;
    }
  };
  var c = function e(e, t) {
    return e.hasOwnProperty(t);
  };
  var s = function e() {
    if (eC) return window;
    if (eU) return wx;
    if (ej) return process;
  };
  var l = function e(e, t) {
    eF[e] || (eF[e] = t);
  };
  var h = function e(e) {
    return !!eF[e];
  };
  var v = function e() {
    return (eD.__Monitor__ = eD.__Monitor__ || {}), eD.__Monitor__;
  };
  var m = function e() {
    var e = eD.chrome,
      t = e && e.app && e.app.runtime,
      n = 'history' in eD && !!eD.history.pushState && !!eD.history.replaceState;
    return !t && n;
  };
  var b = function e() {
    return (typeof document === 'undefined' ? 'undefined' : g(document)) > 'u' ||
      document.location == null
      ? ''
      : document.location.href;
  };
  var O = function e(e, t, n) {
    var r = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : !1;
    e.addEventListener(t, n, r);
  };
  var k = function e(e, t, n) {
    var r = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : !1;
    if (e !== void 0 && (t in e || r)) {
      var a = e[t],
        o = n(a);
      typeof o == 'function' && (e[t] = o);
    }
  };
  var x = function e(e) {
    return !e || typeof e != 'function' ? eW : e.name || eW;
  };
  var R = function e() {
    return Date.now();
  };
  var w = function e(e, t) {
    return (typeof e === 'undefined' ? 'undefined' : g(e)) === t;
  };
  var T = function e(e, t) {
    return eN.call(e) === t;
  };
  var S = function e(e, t, n) {
    return w(e, n)
      ? !0
      : ((typeof e === 'undefined' ? 'undefined' : g(e)) < 'u' &&
          eq.error(
            ''
              .concat(t, '期望传入')
              .concat(n, '类型，目前是')
              .concat(typeof e === 'undefined' ? 'undefined' : g(e), '类型'),
          ),
        !1);
  };
  var P = function e(e, t, n) {
    return T(e, n)
      ? !0
      : ((typeof e === 'undefined' ? 'undefined' : g(e)) < 'u' &&
          eq.error(''.concat(t, '期望传入').concat(n, '类型，目前是').concat(eN.call(e), '类型')),
        !1);
  };
  var A = function e(e) {
    (eE.isLogAddBreadcrumb = !1), e(), (eE.isLogAddBreadcrumb = !0);
  };
  var _ = function e() {
    var e = new Date().getTime();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (t) {
      var n = (e + Math.random() * 16) % 16 | 0;
      return (e = Math.floor(e / 16)), (t == 'x' ? n : (n & 3) | 8).toString(16);
    });
  };
  var E = function e(e) {
    return eI.isString(e) ? e : eI.isUndefined(e) ? 'undefined' : JSON.stringify(e);
  };
  var N = function e(e, t) {
    var n = [];
    return (
      Object.keys(t).forEach(function (e) {
        n.push(''.concat(e, '=').concat(t[e]));
      }),
      e.indexOf('?') !== -1
        ? (e = ''.concat(e, '&').concat(n.join('&')))
        : (e = ''.concat(e, '?').concat(n.join('&'))),
      e
    );
  };
  var I = function e(e, t) {
    return eI.isString(e)
      ? e.slice(0, t) + (e.length > t ? ':截取前'.concat(t, '个字符') : '')
      : '';
  };
  var j = function e() {
    if (!eI.isFunction(getCurrentPages)) return '';
    var e = getCurrentPages();
    if (!e.length) return 'App';
    var t = e.pop();
    return N(t.route, t.options);
  };
  var U = function e(e) {
    var t = e.tagName.toLowerCase();
    if (t === 'body') return null;
    var n = e.classList.value;
    n = n !== '' ? ' class="'.concat(n, '"') : '';
    var r = e.id ? ' id="'.concat(e.id, '"') : '',
      a = e.innerText;
    return '<'
      .concat(t)
      .concat(r)
      .concat(n !== '' ? n : '', '>')
      .concat(a, '</')
      .concat(t, '>');
  };
  var C = function e(e) {
    if (!e) return {};
    var t = e.match(/^(([^:\/?#]+):)?(\/\/([^\/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/);
    if (!t) return {};
    var n = t[6] || '',
      r = t[8] || '';
    return { host: t[4], path: t[5], protocol: t[2], relative: t[5] + n + r };
  };
  var D = function e() {
    var e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    l('xhr', !!e.silentXhr),
      l('fetch', !!e.silentFetch),
      l('console', !!e.silentConsole),
      l('dom', !!e.silentDom),
      l('history', !!e.silentHistory),
      l('error', !!e.silentError),
      l('hashchange', !!e.silentHashchange),
      l('unhandledrejection', !!e.silentUnhandledrejection),
      l('Vue', !!e.silentVue),
      l('AppOnError', !!e.silentWxOnError),
      l('AppOnUnhandledRejection', !!e.silentUnhandledrejection),
      l('AppOnPageNotFound', !!e.silentWxOnPageNotFound),
      l('PageOnShareAppMessage', !!e.silentWxOnShareAppMessage),
      l('miniRoute', !!e.silentMiniRoute);
  };
  var H = function e(e, t) {
    var n = { time: R(), url: b(), name: e.name, level: t, message: e.message };
    if (g(e.stack) > 'u' || !e.stack) return n;
    var r =
        /^\s*at (.*?) ?\(((?:file|https?|blob|chrome-extension|native|eval|webpack|<anonymous>|[a-z]:|\/).*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i,
      a =
        /^\s*(.*?)(?:\((.*?)\))?(?:^|@)((?:file|https?|blob|chrome|webpack|resource|\[native).*?|[^@]*bundle)(?::(\d+))?(?::(\d+))?\s*$/i,
      o =
        /^\s*at (?:((?:\[object object\])?.+) )?\(?((?:file|ms-appx|https?|webpack|blob):.*?):(\d+)(?::(\d+))?\)?\s*$/i,
      i = /(\S+) line (\d+)(?: > eval line \d+)* > eval/i,
      c = /\((\S*)(?::(\d+))(?::(\d+))\)/,
      u = e.stack.split('\n'),
      s = [],
      l,
      h,
      d;
    for (var v = 0, y = u.length; v < y; ++v) {
      if ((h = r.exec(u[v]))) {
        var m = h[2] && h[2].indexOf('native') === 0;
        h[2] &&
          h[2].indexOf('eval') === 0 &&
          (l = c.exec(h[2])) &&
          ((h[2] = l[1]), (h[3] = l[2]), (h[4] = l[3])),
          (d = {
            url: m ? null : h[2],
            func: h[1] || 'UNKNOWN_FUNCTION',
            args: m ? [h[2]] : [],
            line: h[3] ? +h[3] : null,
            column: h[4] ? +h[4] : null,
          });
      } else if ((h = o.exec(u[v])))
        d = {
          url: h[2],
          func: h[1] || 'UNKNOWN_FUNCTION',
          args: [],
          line: +h[3],
          column: h[4] ? +h[4] : null,
        };
      else if ((h = a.exec(u[v])))
        h[3] && h[3].indexOf(' > eval') > -1 && (l = i.exec(h[3]))
          ? ((h[3] = l[1]), (h[4] = l[2]), (h[5] = null))
          : v === 0 && !h[5] && g(e.columnNumber) < 'u' && (s[0].column = e.columnNumber + 1),
          (d = {
            url: h[3],
            func: h[1] || 'UNKNOWN_FUNCTION',
            args: h[2] ? h[2].split(',') : [],
            line: h[4] ? +h[4] : null,
            column: h[5] ? +h[5] : null,
          });
      else continue;
      !d.func && d.line && (d.func = 'UNKNOWN_FUNCTION'), s.push(d);
    }
    return s.length ? p(f({}, n), { stack: s }) : null;
  };
  var F = function e(e, t) {
    try {
      e();
    } catch (e) {
      console.log('err', e), t && t(e);
    }
  };
  var M = function e(e) {
    if (e < 400) return 'ok';
    if (e >= 400 && e < 500)
      switch (e) {
        case 401:
          return 'unauthenticated';
        case 403:
          return 'permission_denied';
        case 404:
          return 'not_found';
        case 409:
          return 'already_exists';
        case 413:
          return 'failed_precondition';
        case 429:
          return 'resource_exhausted';
        default:
          return 'invalid_argument';
      }
    if (e >= 500 && e < 600)
      switch (e) {
        case 501:
          return 'unimplemented';
        case 503:
          return 'unavailable';
        case 504:
          return 'deadline_exceeded';
        default:
          return 'internal_error';
      }
    return 'unknown_error';
  };
  var L = function e(e, t) {
    var n = eG.includeHttpUrlTraceIdRegExp,
      r = eG.enableTraceId;
    if (r && n && n.test(e)) {
      var a = _();
      t(eG.traceIdFieldName, a);
    }
  };
  var q = function e() {
    var e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    D(e), e$.bindOptions(e), eq.bindOptions(e.debug), eY.bindOptions(e), eG.bindOptions(e);
  };
  var W = function e(e, t) {
    var n;
    switch (e.type) {
      case 'HTTP_ERROR':
        n = e.type + e.request.method + e.response.status + X(e.request.url) + t;
        break;
      case 'JAVASCRIPT_ERROR':
      case 'VUE_ERROR':
      case 'REACT_ERROR':
        n = e.type + e.name + e.message + t;
        break;
      case 'LOG_ERROR':
        n = e.customTag + e.type + e.name + t;
        break;
      case 'PROMISE_ERROR':
        n = B(e, t);
        break;
      default:
        n = e.type + e.message + t;
        break;
    }
    return (
      (n = J(n)),
      ez[n] >= eG.maxDuplicateCount ? null : (typeof ez[n] == 'number' ? ez[n]++ : (ez[n] = 1), n)
    );
  };
  var B = function e(e, t) {
    var n = X(e.url);
    return e.name === 'unhandledrejection'
      ? e.type + K(e.message) + t
      : e.type + e.name + K(e.message) + n;
  };
  var K = function e(e) {
    var t = function (e) {
      return Object.keys(e)
        .sort()
        .reduce(function (n, r) {
          return eI.isObject(e[r]) ? (n[r] = t(e[r])) : (n[r] = e[r]), n;
        }, {});
    };
    try {
      if (/\{.*\}/.test(e)) {
        var n = JSON.parse(e);
        return (n = t(n)), JSON.stringify(n);
      }
    } catch (t) {
      return e;
    }
  };
  var X = function e(e) {
    return e.replace(/[\?#].*$/, '').replace(/\/\d+([\/]*$)/, '{param}$1');
  };
  var J = function e(e) {
    var t = 0;
    if (e.length == 0) return t;
    for (var n = 0; n < e.length; n++) {
      var r = e.charCodeAt(n);
      (t = (t << 5) - t + r), (t = t & t);
    }
    return t;
  };
  var $ = function e(e) {
    return e.actionType === void 0 && !e.isTrackData;
  };
  var V = function e(e) {
    var n = e.message,
      r = n === void 0 ? 'emptyMsg' : n,
      a = e.tag,
      o = a === void 0 ? '' : a,
      i = e.level,
      c = i === void 0 ? 'critical' : i,
      u = e.ex,
      s = u === void 0 ? '' : u,
      l = e.type,
      h = l === void 0 ? 'LOG_ERROR' : l;
    var p = {};
    t(s) && (p = H(s, c));
    var d = f(
      {
        type: h,
        level: c,
        message: E(r),
        name: 'Monitor.log',
        customTag: E(o),
        time: R(),
        url: eU ? j() : b(),
      },
      p,
    );
    e$.push({
      type: 'Customer',
      category: e$.getCategory('Customer'),
      data: r,
      level: eX.fromString(c.toString()),
    }),
      eY.send(d);
  };
  var G = function e(e) {
    var t = '',
      n = e.elapsedTime,
      r = e.time,
      a = e.method,
      o = e.traceId,
      i = e.type,
      c = e.status,
      u = ''.concat(i, '--').concat(a);
    return (
      c === 0
        ? (t =
            n <= eE.crossOriginThreshold
              ? 'http请求失败，失败原因：跨域限制或域名不存在'
              : 'http请求失败，失败原因：超时')
        : (t = M(c)),
      (t = t === 'ok' ? t : ''.concat(t, ' ').concat(X(e.url))),
      {
        type: 'HTTP_ERROR',
        url: b(),
        time: r,
        elapsedTime: n,
        level: 'low',
        message: t,
        name: u,
        request: { httpType: i, traceId: o, method: a, url: e.url, data: e.reqData || '' },
        response: { status: c, data: e.responseText },
      }
    );
  };
  var z = function e(e) {
    return {
      type: 'RESOURCE_ERROR',
      url: b(),
      message: '资源地址: ' + (I(e.src, 120) || I(e.href, 120)),
      level: 'low',
      time: R(),
      name: ''.concat(eZ[e.localName] || e.localName, '加载失败'),
    };
  };
  var Q = function e(e) {
    eE.isLogAddBreadcrumb &&
      e$.push({
        type: 'Console',
        category: e$.getCategory('Console'),
        data: e,
        level: eX.fromString(e.level),
      });
  };
  var Y = function e(e) {
    return !e || h(e.type)
      ? !1
      : (l(e.type, !0), (e0[e.type] = e0[e.type] || []), e0[e.type].push(e.callback), !0);
  };
  var Z = function e(e, t) {
    !e ||
      !e0[e] ||
      e0[e].forEach(function (n) {
        F(
          function () {
            n(t);
          },
          function (t) {
            eq.error(
              '重写事件triggerHandlers的回调函数发生错误\nType:'
                .concat(e, '\nName: ')
                .concat(x(n), '\nError: ')
                .concat(t),
            );
          },
        );
      });
  };
  var ee = function e(e) {
    return eG.filterXhrUrlRegExp && eG.filterXhrUrlRegExp.test(e);
  };
  var et = function e(e) {
    switch (e) {
      case 'xhr':
        er();
        break;
      case 'fetch':
        ea();
        break;
      case 'error':
        ei();
        break;
      case 'console':
        ec();
        break;
      case 'history':
        eu();
        break;
      case 'unhandledrejection':
        es();
        break;
      case 'dom':
        el();
        break;
      case 'hashchange':
        eo();
        break;
      default:
        break;
    }
  };
  var en = function e(e) {
    Y(e) && et(e.type);
  };
  var er = function e() {
    if (!('XMLHttpRequest' in eD)) return;
    var e = XMLHttpRequest.prototype;
    k(e, 'open', function (e) {
      return function () {
        for (var t = arguments.length, n = new Array(t), r = 0; r < t; r++) {
          n[r] = arguments[r];
        }
        (this.monitor_xhr = {
          method: eI.isString(n[0]) ? n[0].toUpperCase() : n[0],
          url: n[1],
          sTime: R(),
          type: 'xhr',
        }),
          e.apply(this, n);
      };
    }),
      k(e, 'send', function (e) {
        return function () {
          var t = this;
          for (var n = arguments.length, r = new Array(n), a = 0; a < n; a++) {
            r[a] = arguments[a];
          }
          var o = this.monitor_xhr,
            i = o.method,
            c = o.url;
          L(c, function (e, n) {
            (t.monitor_xhr.traceId = n), t.setRequestHeader(e, n);
          }),
            eG.beforeAppAjaxSend && eG.beforeAppAjaxSend({ method: i, url: c }, this),
            O(this, 'loadend', function () {
              if ((i === 'POST' && eY.isSdkTransportUrl(c)) || ee(c)) return;
              var e = this,
                t = e.responseType,
                n = e.response,
                a = e.status;
              this.monitor_xhr.reqData = r[0];
              var o = R();
              (this.monitor_xhr.time = this.monitor_xhr.sTime),
                (this.monitor_xhr.status = a),
                ['', 'json', 'text'].indexOf(t) !== -1 &&
                  (this.monitor_xhr.responseText =
                    (typeof n === 'undefined' ? 'undefined' : g(n)) == 'object'
                      ? JSON.stringify(n)
                      : n),
                (this.monitor_xhr.elapsedTime = o - this.monitor_xhr.sTime),
                Z('xhr', this.monitor_xhr);
            }),
            e.apply(this, r);
        };
      });
  };
  var ea = function e() {
    'fetch' in eD &&
      k(eD, 'fetch', function (e) {
        return function (t) {
          var n = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
          var r = R(),
            a = (n && n.method) || 'GET',
            o = { type: 'fetch', method: a, reqData: n && n.body, url: t },
            i = new Headers(n.headers || {});
          return (
            Object.assign(i, { setRequestHeader: i.set }),
            L(t, function (e, t) {
              (o.traceId = t), i.set(e, t);
            }),
            eG.beforeAppAjaxSend && eG.beforeAppAjaxSend({ method: a, url: t }, i),
            (n = p(f({}, n), { headers: i })),
            e.apply(eD, [t, n]).then(
              function (e) {
                var n = e.clone(),
                  i = R();
                return (
                  (o = p(f({}, o), { elapsedTime: i - r, status: n.status, time: r })),
                  n.text().then(function (e) {
                    (a === 'POST' && eY.isSdkTransportUrl(t)) ||
                      ee(t) ||
                      ((o.responseText = n.status > 401 && e), Z('fetch', o));
                  }),
                  e
                );
              },
              function (e) {
                var n = R();
                if (!(a === 'POST' && eY.isSdkTransportUrl(t)) && !ee(t))
                  throw (
                    ((o = p(f({}, o), { elapsedTime: n - r, status: 0, time: r })),
                    Z('fetch', o),
                    e)
                  );
              },
            )
          );
        };
      });
  };
  var eo = function e() {
    c(eD, 'onpopstate') ||
      O(eD, 'hashchange', function (e) {
        Z('hashchange', e);
      });
  };
  var ei = function e() {
    O(
      eD,
      'error',
      function (e) {
        Z('error', e);
      },
      !0,
    );
  };
  var ec = function e() {
    if (!('console' in eD)) return;
    ['log', 'debug', 'info', 'warn', 'error', 'assert'].forEach(function (e) {
      e in eD.console &&
        k(eD.console, e, function (t) {
          return function () {
            for (var n = arguments.length, r = new Array(n), a = 0; a < n; a++) {
              r[a] = arguments[a];
            }
            t && (Z('console', { args: r, level: e }), t.apply(eD.console, r));
          };
        });
    });
  };
  var eu = function e() {
    if (!m()) return;
    var e = eD.onpopstate;
    eD.onpopstate = function () {
      for (var t = arguments.length, n = new Array(t), r = 0; r < t; r++) {
        n[r] = arguments[r];
      }
      var a = b(),
        o = e2;
      (e2 = a), Z('history', { from: o, to: a }), e && e.apply(this, n);
    };
    function t(e) {
      return function () {
        for (var t = arguments.length, n = new Array(t), r = 0; r < t; r++) {
          n[r] = arguments[r];
        }
        var a = n.length > 2 ? n[2] : void 0;
        if (a) {
          var o = e2,
            i = String(a);
          (e2 = i), Z('history', { from: o, to: i });
        }
        return e.apply(this, n);
      };
    }
    k(eD.history, 'pushState', t), k(eD.history, 'replaceState', t);
  };
  var es = function e() {
    O(eD, 'unhandledrejection', function (e) {
      Z('unhandledrejection', e);
    });
  };
  var el = function e() {
    if (!('document' in eD)) return;
    var e = eB(Z, eG.throttleDelayTime);
    O(
      eD.document,
      'click',
      function () {
        e('dom', { category: 'click', data: this });
      },
      !0,
    );
  };
  var ef = function e() {
    en({
      callback: function (e) {
        e1.handleHttp(e, 'Xhr');
      },
      type: 'xhr',
    }),
      en({
        callback: function (e) {
          e1.handleHttp(e, 'Fetch');
        },
        type: 'fetch',
      }),
      en({
        callback: function (e) {
          e1.handleError(e);
        },
        type: 'error',
      }),
      en({
        callback: function (e) {
          Q(e);
        },
        type: 'console',
      }),
      en({
        callback: function (e) {
          e1.handleHistory(e);
        },
        type: 'history',
      }),
      en({
        callback: function (e) {
          e1.handleUnhandleRejection(e);
        },
        type: 'unhandledrejection',
      }),
      en({
        callback: function (e) {
          var t = U(e.data.activeElement);
          t &&
            e$.push({ type: 'Click', category: e$.getCategory('Click'), data: t, level: 'info' });
        },
        type: 'dom',
      }),
      en({
        callback: function (e) {
          e1.handleHashchange(e);
        },
        type: 'hashchange',
      });
  };
  var eh = function e() {
    var e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    !('XMLHttpRequest' in eD) || e.disabled || (q(e), ef());
  };
  var ep = function e() {
    var e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    eh(e);
  };
  var ed = Object.defineProperty;
  var eg = Object.getOwnPropertyDescriptor;
  var ev = Object.getOwnPropertyNames;
  var ey = Object.prototype.hasOwnProperty;
  var em = function (e, t) {
      for (var n in t) ed(e, n, { get: t[n], enumerable: !0 });
    },
    eb = function (e, t, n, r) {
      var a = true,
        o = false,
        i = undefined;
      if (
        (t && (typeof t === 'undefined' ? 'undefined' : g(t)) == 'object') ||
        typeof t == 'function'
      )
        try {
          var c = function () {
            var a = s.value;
            !ey.call(e, a) &&
              a !== n &&
              ed(e, a, {
                get: function () {
                  return t[a];
                },
                enumerable: !(r = eg(t, a)) || r.enumerable,
              });
          };
          for (var u = ev(t)[Symbol.iterator](), s; !(a = (s = u.next()).done); a = true) c();
        } catch (e) {
          o = true;
          i = e;
        } finally {
          try {
            if (!a && u.return != null) {
              u.return();
            }
          } finally {
            if (o) {
              throw i;
            }
          }
        }
      return e;
    };
  var eO = function (e) {
    return eb(ed({}, '__esModule', { value: !0 }), e);
  };
  var ek = {};
  em(ek, {
    HandleEvents: function () {
      return e1;
    },
    SDK_NAME: function () {
      return eR;
    },
    SDK_VERSION: function () {
      return ew;
    },
    addReplaceHandler: function () {
      return en;
    },
    init: function () {
      return ep;
    },
    log: function () {
      return V;
    },
    setupReplace: function () {
      return ef;
    },
  });
  var ex = '0.0.2';
  var eR = 'encode-yt-monitor',
    ew = ex;
  var eT = (function (e) {
      return (
        (e.AppOnLaunch = 'AppOnLaunch'),
        (e.AppOnShow = 'AppOnShow'),
        (e.AppOnHide = 'AppOnHide'),
        (e.AppOnError = 'AppOnError'),
        (e.AppOnPageNotFound = 'AppOnPageNotFound'),
        (e.AppOnUnhandledRejection = 'AppOnUnhandledRejection'),
        e
      );
    })(eT || {}),
    eS = (function (e) {
      return (
        (e.PageOnLoad = 'PageOnLoad'),
        (e.PageOnShow = 'PageOnShow'),
        (e.PageOnHide = 'PageOnHide'),
        (e.PageOnReady = 'PageOnReady'),
        (e.PageOnUnload = 'PageOnUnload'),
        (e.PageOnShareAppMessage = 'PageOnShareAppMessage'),
        (e.PageOnShareTimeline = 'PageOnShareTimeline'),
        (e.PageOnTabItemTap = 'PageOnTabItemTap'),
        e
      );
    })(eS || {}),
    eP = (function (e) {
      return (
        (e.SwitchTab = 'switchTab'),
        (e.ReLaunch = 'reLaunch'),
        (e.RedirectTo = 'redirectTo'),
        (e.NavigateTo = 'navigateTo'),
        (e.NavigateBack = 'navigateBack'),
        (e.NavigateToMiniProgram = 'navigateToMiniProgram'),
        (e.RouteFail = 'routeFail'),
        e
      );
    })(eP || {}),
    eA = f({}, eT, eS, eP);
  var e_ =
      /^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/,
    eE = { isLogAddBreadcrumb: !0, crossOriginThreshold: 1e3 };
  var eN = Object.prototype.toString;
  var eI = {
    isNumber: e('Number'),
    isString: e('String'),
    isBoolean: e('Boolean'),
    isNull: e('Null'),
    isUndefined: e('Undefined'),
    isSymbol: e('Symbol'),
    isFunction: e('Function'),
    isObject: e('Object'),
    isArray: e('Array'),
    isProcess: e('process'),
    isWindow: e('Window'),
  };
  var ej = eI.isProcess(
      (typeof process === 'undefined' ? 'undefined' : g(process)) < 'u' ? process : 0,
    ),
    eU =
      eI.isObject((typeof wx === 'undefined' ? 'undefined' : g(wx)) < 'u' ? wx : 0) &&
      eI.isFunction((typeof App === 'undefined' ? 'undefined' : g(App)) < 'u' ? App : 0),
    eC = eI.isWindow((typeof window === 'undefined' ? 'undefined' : g(window)) < 'u' ? window : 0);
  var eD = s(),
    eH = v();
  eH.replaceFlag = eH.replaceFlag || {};
  var eF = eH.replaceFlag;
  var eM = 'Monitor Logger',
    eL = /*#__PURE__*/ (function () {
      function e() {
        var t = this;
        a(this, e);
        this.enabled = !1;
        this._console = {};
        (eD.console = console || eD.console),
          (console || eD.console) &&
            ['log', 'debug', 'info', 'warn', 'error', 'assert'].forEach(function (e) {
              e in eD.console && (t._console[e] = eD.console[e]);
            });
      }
      i(e, [
        {
          key: 'disable',
          value: function e() {
            this.enabled = !1;
          },
        },
        {
          key: 'bindOptions',
          value: function e(e) {
            this.enabled = !!e;
          },
        },
        {
          key: 'enable',
          value: function e() {
            this.enabled = !0;
          },
        },
        {
          key: 'getEnableStatus',
          value: function e() {
            return this.enabled;
          },
        },
        {
          key: 'log',
          value: function e() {
            for (var e = arguments.length, t = new Array(e), n = 0; n < e; n++) {
              t[n] = arguments[n];
            }
            var r;
            this.enabled &&
              (r = this._console).log.apply(r, [''.concat(eM, '[Log]:')].concat(d(t)));
          },
        },
        {
          key: 'warn',
          value: function e() {
            for (var e = arguments.length, t = new Array(e), n = 0; n < e; n++) {
              t[n] = arguments[n];
            }
            var r;
            this.enabled &&
              (r = this._console).warn.apply(r, [''.concat(eM, '[Warn]:')].concat(d(t)));
          },
        },
        {
          key: 'error',
          value: function e() {
            for (var e = arguments.length, t = new Array(e), n = 0; n < e; n++) {
              t[n] = arguments[n];
            }
            var r;
            this.enabled &&
              (r = this._console).error.apply(r, [''.concat(eM, '[Error]:')].concat(d(t)));
          },
        },
      ]);
      return e;
    })(),
    eq = eH.logger || (eH.logger = new eL());
  var eW = '<anonymous>';
  var eB = function (e, t) {
    var n = !0;
    return function r() {
      for (var r = arguments.length, a = new Array(r), o = 0; o < r; o++) {
        a[o] = arguments[o];
      }
      n &&
        (e.apply(this, a),
        (n = !1),
        setTimeout(function () {
          n = !0;
        }, t));
    };
  };
  var eK = /*#__PURE__*/ (function () {
    function e() {
      a(this, e);
      this.stack = [];
      this.isFlushing = !1;
      'Promise' in eD && (this.micro = Promise.resolve());
    }
    i(e, [
      {
        key: 'addFn',
        value: function e(e) {
          var t = this;
          if (typeof e == 'function') {
            if (!('Promise' in eD)) {
              e();
              return;
            }
            this.stack.push(e),
              this.isFlushing ||
                ((this.isFlushing = !0),
                this.micro.then(function () {
                  return t.flushStack();
                }));
          }
        },
      },
      {
        key: 'clear',
        value: function e() {
          this.stack = [];
        },
      },
      {
        key: 'getStack',
        value: function e() {
          return this.stack;
        },
      },
      {
        key: 'flushStack',
        value: function e() {
          var e = this.stack.slice(0);
          (this.stack.length = 0), (this.isFlushing = !1);
          for (var t = 0; t < e.length; t++) e[t]();
        },
      },
    ]);
    return e;
  })();
  var eX = (function (e) {
    return (
      (e.Else = 'else'),
      (e.Error = 'error'),
      (e.Warning = 'warning'),
      (e.Info = 'info'),
      (e.Debug = 'debug'),
      (e.Low = 'low'),
      (e.Normal = 'normal'),
      (e.High = 'high'),
      (e.Critical = 'critical'),
      e
    );
  })(eX || {});
  (function (e) {
    var t = function e(e) {
      switch (e) {
        case 'debug':
          return 'debug';
        case 'info':
        case 'log':
        case 'assert':
          return 'info';
        case 'warn':
        case 'warning':
          return 'warning';
        case 'low':
        case 'normal':
        case 'high':
        case 'critical':
        case 'error':
          return 'error';
        default:
          return 'else';
      }
    };
    e.fromString = t;
  })(eX || (eX = {}));
  var eJ = /*#__PURE__*/ (function () {
      function e() {
        a(this, e);
        this.maxBreadcrumbs = 10;
        this.beforePushBreadcrumb = null;
        this.stack = [];
      }
      i(e, [
        {
          key: 'push',
          value: function e(e) {
            var t = this;
            if (typeof this.beforePushBreadcrumb == 'function') {
              var n = null,
                r = this.beforePushBreadcrumb;
              if (
                (A(function () {
                  n = r(t, e);
                }),
                !n)
              )
                return;
              this.immediatePush(n);
              return;
            }
            this.immediatePush(e);
          },
        },
        {
          key: 'immediatePush',
          value: function e(e) {
            e.time || (e.time = R()),
              this.stack.length >= this.maxBreadcrumbs && this.shift(),
              this.stack.push(e),
              this.stack.sort(function (e, t) {
                return e.time - t.time;
              }),
              eq.log(this.stack);
          },
        },
        {
          key: 'shift',
          value: function e() {
            return this.stack.shift() !== void 0;
          },
        },
        {
          key: 'clear',
          value: function e() {
            this.stack = [];
          },
        },
        {
          key: 'getStack',
          value: function e() {
            return this.stack;
          },
        },
        {
          key: 'getCategory',
          value: function e(e) {
            switch (e) {
              case 'Xhr':
              case 'Fetch':
                return 'http';
              case 'Click':
              case 'Route':
              case 'Tap':
              case 'Touchmove':
                return 'user';
              case 'Customer':
              case 'Console':
                return 'debug';
              case 'App On Launch':
              case 'App On Show':
              case 'App On Hide':
              case 'Page On Show':
              case 'Page On Hide':
              case 'Page On Share App Message':
              case 'Page On Share Timeline':
              case 'Page On Tab Item Tap':
                return 'lifecycle';
              case 'Unhandledrejection':
              case 'Code Error':
              case 'Resource':
              case 'Vue':
              case 'React':
              default:
                return 'exception';
            }
          },
        },
        {
          key: 'bindOptions',
          value: function e() {
            var e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
            var t = e.maxBreadcrumbs,
              n = e.beforePushBreadcrumb;
            S(t, 'maxBreadcrumbs', 'number') && (this.maxBreadcrumbs = t),
              S(n, 'beforePushBreadcrumb', 'function') && (this.beforePushBreadcrumb = n);
          },
        },
      ]);
      return e;
    })(),
    e$ = eH.breadcrumb || (eH.breadcrumb = new eJ());
  var eV = /*#__PURE__*/ (function () {
      function e() {
        a(this, e);
        this.beforeAppAjaxSend = function () {};
        this.traceIdFieldName = 'Trace-Id';
        this.throttleDelayTime = 0;
        this.maxDuplicateCount = 2;
        this.appOnLaunch = function () {};
        this.appOnShow = function () {};
        this.onPageNotFound = function () {};
        this.appOnHide = function () {};
        this.pageOnUnload = function () {};
        this.pageOnShow = function () {};
        this.pageOnHide = function () {};
        this.onShareAppMessage = function () {};
        this.onShareTimeline = function () {};
        this.onTabItemTap = function () {};
        this.triggerWxEvent = function () {};
        this.enableTraceId = !1;
      }
      i(e, [
        {
          key: 'bindOptions',
          value: function e() {
            var e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
            var t = e.beforeAppAjaxSend,
              n = e.enableTraceId,
              r = e.filterXhrUrlRegExp,
              a = e.traceIdFieldName,
              o = e.throttleDelayTime,
              i = e.includeHttpUrlTraceIdRegExp,
              c = e.appOnLaunch,
              u = e.appOnShow,
              s = e.appOnHide,
              l = e.pageOnUnload,
              f = e.pageOnShow,
              h = e.pageOnHide,
              p = e.onPageNotFound,
              d = e.onShareAppMessage,
              g = e.onShareTimeline,
              v = e.onTabItemTap,
              y = e.wxNavigateToMiniProgram,
              m = e.triggerWxEvent,
              b = e.maxDuplicateCount,
              O = e.onRouteChange;
            S(t, 'beforeAppAjaxSend', 'function') && (this.beforeAppAjaxSend = t),
              S(c, 'appOnLaunch', 'function') && (this.appOnLaunch = c),
              S(u, 'appOnShow', 'function') && (this.appOnShow = u),
              S(s, 'appOnHide', 'function') && (this.appOnHide = s),
              S(l, 'pageOnUnload', 'function') && (this.pageOnUnload = l),
              S(f, 'pageOnShow', 'function') && (this.pageOnShow = f),
              S(h, 'pageOnHide', 'function') && (this.pageOnHide = h),
              S(p, 'onPageNotFound', 'function') && (this.onPageNotFound = p),
              S(d, 'onShareAppMessage', 'function') && (this.onShareAppMessage = d),
              S(g, 'onShareTimeline', 'function') && (this.onShareTimeline = g),
              S(v, 'onTabItemTap', 'function') && (this.onTabItemTap = v),
              S(y, 'wxNavigateToMiniProgram', 'function') && (this.wxNavigateToMiniProgram = y),
              S(m, 'triggerWxEvent', 'function') && (this.triggerWxEvent = m),
              S(O, 'onRouteChange', 'function') && (this.onRouteChange = O),
              S(n, 'enableTraceId', 'boolean') && (this.enableTraceId = n),
              S(a, 'traceIdFieldName', 'string') && (this.traceIdFieldName = a),
              S(o, 'throttleDelayTime', 'number') && (this.throttleDelayTime = o),
              S(b, 'maxDuplicateCount', 'number') && (this.maxDuplicateCount = b),
              P(r, 'filterXhrUrlRegExp', '[object RegExp]') && (this.filterXhrUrlRegExp = r),
              P(i, 'includeHttpUrlTraceIdRegExp', '[object RegExp]') &&
                (this.includeHttpUrlTraceIdRegExp = i);
          },
        },
      ]);
      return e;
    })(),
    eG = eH.options || (eH.options = new eV());
  var ez = {};
  var eQ = /*#__PURE__*/ (function () {
      function e() {
        a(this, e);
        this.beforeDataReport = null;
        this.backTrackerId = null;
        this.configReportXhr = null;
        this.configReportUrl = null;
        this.configReportWxRequest = null;
        this.useImgUpload = !1;
        this.apikey = '';
        this.trackKey = '';
        this.errorDsn = '';
        this.trackDsn = '';
        this.queue = new eK();
      }
      i(e, [
        {
          key: 'imgRequest',
          value: function e(e, t) {
            var n = function () {
              var n = new Image(),
                r = t.indexOf('?') === -1 ? '?' : '&';
              (n.src = ''
                .concat(t)
                .concat(r, 'data=')
                .concat(encodeURIComponent(JSON.stringify(e)))),
                (n = null);
            };
            this.queue.addFn(n);
          },
        },
        {
          key: 'getRecord',
          value: function e() {
            var e = eH.record;
            return e && eI.isArray(e) && e.length > 2 ? e : [];
          },
        },
        {
          key: 'getDeviceInfo',
          value: function e() {
            return eH.deviceInfo || {};
          },
        },
        {
          key: 'beforePost',
          value: function e(e) {
            return r(function () {
              var t, n, r;
              return y(this, function (a) {
                switch (a.label) {
                  case 0:
                    if ($(e)) {
                      t = W(e, this.apikey);
                      if (!t) return [2, !1];
                      e.errorId = t;
                    }
                    n = this.getTransportData(e);
                    r = typeof this.beforeDataReport == 'function';
                    if (!r) return [3, 2];
                    return [4, this.beforeDataReport(n)];
                  case 1:
                    r = ((n = a.sent()), !n);
                    a.label = 2;
                  case 2:
                    return [2, r ? !1 : n];
                }
              });
            }).call(this);
          },
        },
        {
          key: 'xhrPost',
          value: function e(e, t) {
            return r(function () {
              var n, r;
              return y(this, function (a) {
                n = this;
                r = function () {
                  var r = new XMLHttpRequest();
                  r.open('POST', t),
                    r.setRequestHeader('Content-Type', 'application/json;charset=UTF-8'),
                    (r.withCredentials = !0),
                    typeof n.configReportXhr == 'function' && n.configReportXhr(r, e),
                    console.log(e, 'result1'),
                    r.send(JSON.stringify(e));
                };
                this.queue.addFn(r);
                return [2];
              });
            }).call(this);
          },
        },
        {
          key: 'wxPost',
          value: function e(e, t) {
            return r(function () {
              var n, r;
              return y(this, function (a) {
                n = this;
                r = function () {
                  var r = { method: 'POST' };
                  if (typeof n.configReportWxRequest == 'function') {
                    var a = n.configReportWxRequest(e);
                    r = f({}, r, a);
                  }
                  (r = p(f({}, r), { data: JSON.stringify(e), url: t })), wx.request(r);
                };
                this.queue.addFn(r);
                return [2];
              });
            }).call(this);
          },
        },
        {
          key: 'getAuthInfo',
          value: function e() {
            var e = this.getTrackerId(),
              t = { trackerId: String(e), sdkVersion: ew, sdkName: eR };
            return (
              this.apikey && (t.apikey = this.apikey),
              this.trackKey && (t.trackKey = this.trackKey),
              t
            );
          },
        },
        {
          key: 'getApikey',
          value: function e() {
            return this.apikey;
          },
        },
        {
          key: 'getTrackKey',
          value: function e() {
            return this.trackKey;
          },
        },
        {
          key: 'getTrackerId',
          value: function e() {
            if (typeof this.backTrackerId == 'function') {
              var e = this.backTrackerId();
              if (typeof e == 'string' || typeof e == 'number') return e;
              eq.error(
                'trackerId:'
                  .concat(e, ' 期望 string 或 number 类型，但是传入类型为 ')
                  .concat(typeof e === 'undefined' ? 'undefined' : g(e)),
              );
            }
            return '';
          },
        },
        {
          key: 'getTransportData',
          value: function e(e) {
            return {
              authInfo: this.getAuthInfo(),
              breadcrumb: e$.getStack(),
              data: e,
              record: this.getRecord(),
              deviceInfo: this.getDeviceInfo(),
            };
          },
        },
        {
          key: 'isSdkTransportUrl',
          value: function e(e) {
            var t = !1;
            return (
              this.errorDsn && e.indexOf(this.errorDsn) !== -1 && (t = !0),
              this.trackDsn && e.indexOf(this.trackDsn) !== -1 && (t = !0),
              t
            );
          },
        },
        {
          key: 'bindOptions',
          value: function e() {
            var e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
            var t = e.dsn,
              n = e.beforeDataReport,
              r = e.apikey,
              a = e.configReportXhr,
              o = e.backTrackerId,
              i = e.trackDsn,
              c = e.trackKey,
              u = e.configReportUrl,
              s = e.useImgUpload,
              l = e.configReportWxRequest;
            S(r, 'apikey', 'string') && (this.apikey = r),
              S(c, 'trackKey', 'string') && (this.trackKey = c),
              S(t, 'dsn', 'string') && (this.errorDsn = t),
              S(i, 'trackDsn', 'string') && (this.trackDsn = i),
              S(s, 'useImgUpload', 'boolean') && (this.useImgUpload = s),
              S(n, 'beforeDataReport', 'function') && (this.beforeDataReport = n),
              S(a, 'configReportXhr', 'function') && (this.configReportXhr = a),
              S(o, 'backTrackerId', 'function') && (this.backTrackerId = o),
              S(u, 'configReportUrl', 'function') && (this.configReportUrl = u),
              S(l, 'configReportWxRequest', 'function') && (this.configReportWxRequest = l);
          },
        },
        {
          key: 'send',
          value: function e(e) {
            return r(function () {
              var t, r;
              return y(this, function (a) {
                switch (a.label) {
                  case 0:
                    t = '';
                    if ($(e)) {
                      if (((t = this.errorDsn), n(t))) {
                        eq.error('dsn为空，没有传入监控错误上报的dsn地址，请在init中传入');
                        return [2];
                      }
                    } else if (((t = this.trackDsn), n(t))) {
                      eq.error('trackDsn为空，没有传入埋点上报的dsn地址，请在init中传入');
                      return [2];
                    }
                    return [4, this.beforePost(e)];
                  case 1:
                    r = a.sent();
                    if (
                      (console.log(r, 'result1'),
                      !!r &&
                        !(
                          typeof this.configReportUrl == 'function' &&
                          ((t = this.configReportUrl(r, t)), !t)
                        ))
                    ) {
                      if (eC)
                        return [
                          2,
                          (console.log(r, 'result2'),
                          this.useImgUpload ? this.imgRequest(r, t) : this.xhrPost(r, t)),
                        ];
                      if (eU) return [2, this.wxPost(r, t)];
                    }
                    return [2];
                }
              });
            }).call(this);
          },
        },
      ]);
      return e;
    })(),
    eY = eH.transportData || (eH.transportData = new eQ());
  var eZ = { img: '图片', script: 'js脚本' };
  var e0 = {};
  var e1 = {
    handleHttp: function e(e, t) {
      var n = e.status === 0 || e.status === 400 || e.status > 401,
        r = G(e);
      e$.push({
        type: t,
        category: e$.getCategory(t),
        data: f({}, r),
        level: 'info',
        time: e.time,
      }),
        n &&
          (e$.push({
            type: t,
            category: e$.getCategory('Code Error'),
            data: f({}, r),
            level: 'error',
            time: e.time,
          }),
          console.log(r, 'result'),
          eY.send(r));
    },
    handleError: function e(e) {
      if (e.target.localName) {
        var n = z(e.target);
        return (
          e$.push({
            type: 'Resource',
            category: e$.getCategory('Resource'),
            data: n,
            level: 'error',
          }),
          eY.send(n)
        );
      }
      var r = e.message,
        a = e.filename,
        o = e.lineno,
        i = e.colno,
        c = e.error,
        u;
      c && t(c) && (u = H(c, 'normal')),
        u || (u = e1.handleNotErrorInstance(r, a, o, i)),
        (u.type = 'JAVASCRIPT_ERROR'),
        e$.push({
          type: 'Code Error',
          category: e$.getCategory('Code Error'),
          data: f({}, u),
          level: 'error',
        }),
        eY.send(u);
    },
    handleNotErrorInstance: function e(e, t, n, r) {
      var a = 'UNKNOWN',
        o = t || b(),
        i = e,
        c = e.match(e_);
      c[1] && ((a = c[1]), (i = c[2]));
      var u = { url: o, func: 'UNKNOWN_FUNCTION', args: 'UNKNOWN', line: n, col: r };
      return { url: o, name: a, message: i, level: 'normal', time: R(), stack: [u] };
    },
    handleHistory: function e(e) {
      var t = e.from,
        n = e.to,
        r = C(t),
        a = r.relative,
        o = C(n),
        i = o.relative;
      e$.push({
        type: 'Route',
        category: e$.getCategory('Route'),
        data: { from: a || '/', to: i || '/' },
        level: 'info',
      });
      var c = eG.onRouteChange;
      c && c(t, n);
    },
    handleHashchange: function e(e) {
      var t = e.oldURL,
        n = e.newURL,
        r = C(t),
        a = r.relative,
        o = C(n),
        i = o.relative;
      e$.push({
        type: 'Route',
        category: e$.getCategory('Route'),
        data: { from: a, to: i },
        level: 'info',
      });
      var c = eG.onRouteChange;
      c && c(a, i);
    },
    handleUnhandleRejection: function e(e) {
      var n = {
        type: 'PROMISE_ERROR',
        message: E(e.reason),
        url: b(),
        name: e.type,
        time: R(),
        level: 'low',
      };
      t(e.reason) && (n = f({}, n, H(e.reason, 'low'))),
        e$.push({
          type: 'Unhandledrejection',
          category: e$.getCategory('Unhandledrejection'),
          data: f({}, n),
          level: 'error',
        }),
        eY.send(n);
    },
  };
  var e2;
  e2 = b();
  return eO(ek);
})();
