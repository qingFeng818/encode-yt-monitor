// 本仓库未安装 eslint-config-encode，这里退化为空规则集，
// 保证 eslint / encode-fe-lint 能正常加载配置。
// 文件名必须是 .cjs：根 package.json 是 "type": "module"，
// 写成 .js 会被当成 ESM，eslint（CJS loader）require 时会报 ERR_REQUIRE_ESM。
module.exports = {};

