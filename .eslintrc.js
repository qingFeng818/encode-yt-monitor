// 本仓库未安装 eslint-config-encode，这里退化为空规则集，
// 保证 eslint / encode-fe-lint 能正常加载配置（写成 CommonJS，避免 ESM 语法被解析成 { __esModule } 而报错）
module.exports = {};

