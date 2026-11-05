# 提示词模板：新增/修改一条路由

## 适用场景

前端需要一个新接口，或已有接口要加参数/改响应。
目标：{{要提供的接口，例如"按档位统计已学词的复习正确率"}}。
先确认现有 22 条 API 里没有能用的（`src/host/routes/paths.ts` 是唯一清单）。

## 先读什么（别跳）

| 文件                              | 位置（按符号搜）                        | 为什么                                                             |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `src/host/routes/paths.ts`        | 全文                                    | 路径常量唯一出口，新路由先加常量；也是 22 条的权威清单             |
| `src/host/index.ts`               | `makeFence` / `registerRoute` / `apply` | 栅栏自动套、方法白名单、500 兜底；不要自己写鉴权                   |
| `src/host/routes/shared.ts`       | 全文                                    | `safeSend`/`fail`/`unavailable`/`isFalse`/`readJson` 的唯一出口    |
| `src/host/http.ts`                | 全文                                    | query/body 参数钳制的唯一入口（`intParam`/`strParam`/`clampInt`）  |
| `src/host/routes/study.ts`        | `registerStudyRoutes`（`/lookup`）      | 读操作的范例（解析 → 校验 → 调 service → send）                    |
| `src/host/routes/review.ts`       | `registerReviewRoutes`（`/grade`）      | 写操作的范例（钳制 + 先发响应再收尾副作用）                        |
| `src/host/routes/paths.ts` 的注释 | 文件头                                  | 为什么前端资源不再走路由（阶段 2 起由 `exports["./client"]` 加载） |
| `README.md`                       | 「接口」表                              | 新接口必须在这里登记（唯一对外清单）                               |
| `CONVENTIONS.md`                  | §5 路由契约、§6 数据访问                | 状态码/响应形状/入参钳制                                           |
| 对应 `src/host/*.ts`              | 文件头                                  | 业务逻辑应该加在已有 service 里，不是 handler 里                   |

## 步骤

1. **先定契约**（写进交付说明再动手）：
   - 方法与路径：写操作 `POST`，读操作 `GET`（或 `GET`+`POST` 兼容旧调用）；
   - 入参：名字、类型、取值范围、默认值、上限；
   - 成功响应：`{ ok: true, ... }` 的具体字段；
   - 失败：哪些算 400、哪些算 404、哪些是交互路径要 200 + `ok:false`。
2. **先写 service 层**：在 `src/host/<职责>.ts` 里加命名导出函数（输入输出都是普通对象，
   依赖以参数传入，方便假对象测试）；用户库写入进 `src/host/store/{words,review,settings}.ts`。
   给它补一条单测（`tests/unit/*.test.mjs` 或 `tests/integration/*.test.ts`）。
3. **注册路由**：路径常量加到 `src/host/routes/paths.ts` → 在所属领域的
   `src/host/routes/{study,review,ai,repair,annotate}.ts` 里
   `registerRoute({ kind: 'exact', path, methods, handler })`；新组才需要动
   `src/host/index.ts` 的挂载列表（并把 disposer 推进 `disposers`）。
   handler 只做：`readJson`/`URL` → 校验 + 钳制 → 调 service → `safeSend`。
4. **README 登记**：`/接口` 表加一行（方法 / 路径 / 说明 + 参数）。
5. **集成断言**：`tests/integration/routes.test.ts` 加一条（真实 `ctx` 桩 + 临时 `DSH_HOME` 真跑，
   不用重启宿主）；新领域可仿 `tests/integration/model-routes.test.ts` 单开文件。
6. **前端接线**：在调用点的 `API` 常量表加路径（划词卡在
   `src/client/features/wordcard/index.js`、标注在 `src/client/features/annotate/config.js`、
   学习页在 `src/client/plugin.js` 的常量/取数处），再写调用与失败分支。
7. 跑验证。

## 硬约束

- 不许绕过 `registerRoute` 直接 `ctx.webServer.register`；不许绕过 `makeFence`。
- 写操作必须显式 `methods: ['POST']`；不声明等于允许 GET 顺手写库。
- 所有外部输入必须钳制：数字走 `intParam(url, name, { fallback, min, max, floor })`
  （`src/host/http.ts`）或 body 的 `clampInt`，字符串 `strParam`/`slice`，布尔用 `isFalse()`，
  词输入过 `looksLikeWord`。
- 错误响应只给稳定 `code` + 一句中文人话；`err.message`（可能含绝对路径）只进 `console.warn`。
- 交互路径（用户正看着的请求）失败回 `200 + ok:false`，别用 5xx 触发重试。
- 已经发出的响应之后的副作用（入队/记账）必须自己吞错，不能二次写头。
- 不新增运行时依赖；不在 handler 里写 SQL 或 fetch。
- 改了路由要重建产物再跑集成测试：`pnpm build`（`pnpm verify` 已先 build；vitest 读 `lib/host/**`）。

## 必须执行的验证

```bash
pnpm build                         # 集成测试读 lib/host/** 编译产物
npx vitest run tests/integration/routes.test.ts   # 端到端：真实 ctx 桩 + 临时库
pnpm test:unit                     # 新 service 的单测
pnpm verify                        # 唯一验收
```

栅栏自检（宿主里）：`POST /dsh-word-learn/<新路由>` 未带可信头应返回 **401/403**，
返回 404/405 说明路由没挂上（见 README「开发」节「改哪一半、要不要重启」）。

## 交付输出模板

```text
新接口：{{METHOD}} {{path}} ? {{入参}}
响应：成功 {{字段}} / 失败 {{code 与状态码}}
业务位置：{{src/host/xxx.ts 的函数}}

改动：
- src/host/routes/paths.ts —— 新路径常量
- src/host/routes/{{组}}.ts —— 路由注册
- src/host/{{service}}.ts —— {{函数}}
- README.md「接口」表 —— 登记
- tests/integration/routes.test.ts —— {{断言}}
- src/client/{{file}}.js —— {{调用点}}

验证：pnpm verify → {{结果}}；栅栏自检 → {{401/403}}

剩余风险：{{未覆盖的入参组合 / 需要真机确认的前端分支}}
```
