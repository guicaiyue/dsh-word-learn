# 提示词模板：修一个 bug（含回归）

## 适用场景

用户报告"某个行为不对"：卡片不弹、学习页数据不对、发音没声、评分后间隔不对、接口报错。
不适用于新功能（用 `add-route.md` / `edit-frontend.md`）。
不确定是 bug 还是设计如此时，先查 `DESIGN.md` §9，再决定要不要改。

## 先读什么（别跳）

| 文件                        | 位置（按符号搜）                                 | 为什么                                   |
| --------------------------- | ------------------------------------------------ | ---------------------------------------- |
| 症状所在文件的开头注释      | 文件头                                           | 每个文件头都写了它为什么存在、踩过什么坑 |
| `README.md`                 | 「已实现」「接口」两节                           | 确认"正确行为"是什么                     |
| `DESIGN.md`                 | §9 风险                                          | 同症状很可能已经记录过根因               |
| `src/host/routes/shared.ts` | `safeSend` / `fail` / `readJson` / `unavailable` | 区分 400/404/500 是谁发的                |
| `src/host/index.ts`         | `apply` / `makeFence` / `registerRoute`          | 看栅栏、方法白名单、500 兜底的顺序       |
| `src/host/routes/{组}.ts`   | 相关 `registerXxxRoutes`                         | 看参数钳制与副作用排序                   |
| `CONVENTIONS.md`            | §3.5 错误处理、§5 路由契约、§9 测试纪律          | 判断"这是不是故意这么写的"               |

## 步骤

1. **先复现，写下最小复现路径**：一条命令、一次点击、一个请求体。
   不能复现就停下来，把"复现失败"和已尝试的输入写进交付说明，不要盲改。
2. **定位层**（三选一，别猜）：
   - **前端**（`src/client/**`）：判据是"网络面板有请求，但界面画错/没反应"；
   - **路由/编排**（`src/host/index.ts` 的栅栏 + `src/host/routes/*.ts`）：判据是"请求返回 4xx/5xx"；
   - **数据/算法**（`src/host/store/*.ts`、`src/host/schedule.ts`、`src/host/dict.ts`）：
     判据是"返回 200 但数据不对"。
3. **写一条会红的回归**（位置按层选）：
   - 路由/写库：`tests/integration/*.test.ts`（真实 `ctx` 桩 + 临时 `DSH_HOME`）；
   - 前端视图/交互：`tests/component/*.test.tsx`（渲染 `dist/client.js` 的真实组件）；
   - 宿主纯函数/契约：`tests/unit/*.test.mjs`；前端纯函数：`tests/features/*.test.mjs`。
     node:test 用 `assert`，vitest 用 `expect`；断言要精确到"哪个值错了"，先跑一次确认它是红的
     （把红的原因写进交付说明）。
4. **改最小面积**：只动导致错误的那个判断；不顺手重构、不批量改注释、不重排 import。
   如果根因是"两处逻辑不一致"，两处一起改，并在注释里写明另一处的位置。
5. **跑验证**（见下），红了就回第 4 步。
6. 在交付说明里写**根因**（为什么错）和**为什么之前没测到**（测试盲区在哪）。

## 硬约束

- 不许为了过测试改断言（除非断言本身写错了，要说明原断言错在哪）。
- 不许碰 `data/`、真实 `$DSH_HOME/dsh-word-learn/user.db`；写库测试必须
  `tests/integration/support/tmp-home.ts` 的 `createTempHome()`（带 canary）。
- 不许加 `eslint-disable`；不许改 `.dependency-cruiser.cjs` 放行环/跨边界。
- 不许改 `DESIGN.md` 的历史结论；不许引入新依赖；不许手改 `dist/**`、`lib/host/**`。
- 修前端要说明生效方式：`pnpm build`（或 `pnpm dev` 常驻）后平台 client-hmr 自动重载，
  不用刷新/重启；面板会重挂，学习页退回首页，重点侧栏「英语学习」。
- 修宿主（`src/host/**`）要说明：`pnpm build` 产出 `lib/host/**` 后**重挂插件**才生效。

## 必须执行的验证

```bash
pnpm build                         # 改了前端/宿主都先重建产物（vitest 读产物）
pnpm lint:fix
pnpm format
npx vitest run tests/component/xxx.test.tsx   # 先单跑，失败信息更短
npx vitest run tests/integration/xxx.test.ts
pnpm test:unit                     # node:test 那几层
pnpm verify                        # 唯一验收，必须绿
```

## 交付输出模板

```text
现象：{{复现路径 + 期望 vs 实际}}

根因：{{哪个文件/函数/判断错了，为什么}}

改动：
- {{文件}}（{{函数/符号}}）—— {{改了什么，为什么}}

回归：{{新断言在哪个文件、断言内容；修复前它是红的，报错是 ...}}

验证：pnpm verify → {{通过/失败 + 关键输出}}

剩余风险：{{没覆盖的分支 / 依赖外部服务的路径 / 需要真机确认的交互}}
```
