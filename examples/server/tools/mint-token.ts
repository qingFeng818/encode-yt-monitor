import { loadConfig } from '../config';
import { signToken } from '../core/token';

/**
 * ============================================================================
 * 生成测试用 token（HS256），配合采集 / 查询接口联调用
 * ============================================================================
 *
 * 用法：
 *   npx ts-node examples/server/tools/mint-token.ts --sub=user_1 --ttl=7200 --scope=collect
 *
 * 参数：
 *   --sub   用户 id，落到 token 的 sub，最终变成 events.user_id 与 'u_…' 访客 id（默认 demo_user）
 *   --ttl   有效期（秒），最小 60，默认 7200（2 小时）
 *   --scope 自定义声明，本 demo 不校验，仅用于演示「可以带自定义字段」（默认 collect）
 *
 * 注意：签名密钥来自 TOKEN_SECRET（与服务的配置同源），所以
 * **必须在与服务相同的环境变量下运行**，否则签出来的 token 服务端验不过（reason=bad-signature）。
 *
 * 拿到 token 后：
 *   curl -H "Authorization: Bearer <token>" http://localhost:2021/api/stats/overview
 *   curl "http://localhost:2021/pv/upload?token=<token>" -H "content-type: application/json" -d '...'
 *   （图片上报只能走 query：img.src 带不了 header）
 */
function readArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const matched = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : fallback;
}

const config = loadConfig();
const sub = readArg('sub', 'demo_user');
// 最小 60s：避免手误传 --ttl=1 得到一个立刻过期的 token（排查起来很浪费时间）
const ttl = Math.max(60, Number(readArg('ttl', '7200')) || 7200);

const token = signToken(
  // iss 只在配置了 TOKEN_ISSUER 时才有值；此时服务端会校验它
  { sub, iss: config.tokenIssuer, scope: readArg('scope', 'collect') },
  config.tokenSecret,
  ttl,
);

console.log('sub :', sub);
console.log('ttl :', `${ttl}s`);
console.log('token:');
console.log(token);
