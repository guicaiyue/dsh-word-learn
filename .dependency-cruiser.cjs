// 依赖图门禁（ADR-0005）：替代原先 134 行正则版 check-cycles.mjs。
//
// 为什么换：正则只匹配 import，真实仓库漏了 6 条 `export ... from` 边，还硬编码只扫
// lib/；dependency-cruiser 认得 TS/别名/动态 import/require，15/15 形态检出，且更快。
//
// 这里的规则只做三件**能对应真实缺陷**的事：环、分层方向、客户端不碰 Node 内建。
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'import 环会让模块初始化顺序不可预测（浏览器侧尤其致命）',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'host-no-client',
      comment: '宿主侧不能 import 浏览器产物：那是经典 script，Node 里没有 window',
      severity: 'error',
      from: { path: '^lib/' },
      to: { path: '^(assets|src/client)/' },
    },
    {
      name: 'client-no-host',
      comment: '浏览器侧不能 import 宿主代码：node:* / node:sqlite 在浏览器不存在',
      severity: 'error',
      from: { path: '^(assets|src/client)/' },
      to: { path: '^(lib|src/host)/' },
    },
    {
      name: 'client-no-node-builtin',
      comment: '客户端产物里出现 node: 内建 = 运行期必炸（且 DSH 模块表里没有）',
      severity: 'error',
      from: { path: '^(assets|src/client)/' },
      to: { path: '^node:' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|^dist/|\\.scratch)' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
