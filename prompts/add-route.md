# 提示词模板：新增/修改一条路由

## 适用场景

前端需要一个新接口，或已有接口要加参数/改响应。
目标：{{要提供的接口，例如"按档位统计已学词的复习正确率"}}。

## 先读什么（别跳）

| 文件                    | 位置                               | 为什么                                                          |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `lib/routes/paths.mjs`  | 全文                               | 路径常量唯一出口，新路由先加常量                                |
| `lib/index.js`          | `makeFence` / `registerRoute`      | 栅栏自动套、方法白名单、500 兜底；不要自己写鉴权                |
| `lib/routes/shared.mjs` | 全文                               | `safeSend`/`fail`/`unavailable`/`isFalse`/`readJson` 的唯一出口 |
| `lib/http.mjs`          | 全文                               | query 参数钳制的唯一入口（`intParam`/`strParam`）               |
| `lib/routes/study.mjs`  | `registerStudyRoutes`（`/lookup`） | 读操作的范例（解析 → 校验 → 调 service → send）                 |
| `lib/routes/review.mjs` | `registerReviewRoutes`（`/grade`） | 写操作的范例（钳制 + 先发响应再收尾副作用）                     |
| `README.md`             | 接口表                             | 新接口必须在这里登记                                            |
| `CONVENTIONS.md`        | §5 路由契约、§6 数据访问           | 状态码/响应形状/入参钳制                                        |
| 对应 `lib/*.mjs`        | 文件头 1–40                        | 业务逻辑应该加在已有 service 里，不是 handler 里                |

## 步骤

1. **先定契约**（写进交付说明再动手）：
   - 方法与路径：写操作 `POST`，读操作 `GET`（或 `GET`+`POST` 兼容旧调用）；
   - 入参：名字、类型、取值范围、默认值、上限；
   - 成功响应：`{ ok: true, ... }` 的具体字段；
   - 失败：哪些算 400、哪些算 404、哪些是交互路径要 200 + `ok:false`。
2. **先写 service 层**：在 `lib/<职责>.mjs` 里加命名导出函数（输入输出都是普通对象，
   依赖以参数传入，方便假对象测试）；给它补一条 `tests/` 单测。
3. **注册路由**：路径常量加到 `lib/routes/paths.mjs` → 在所属领域的 `lib/routes/{组}.mjs`
   （assets/study/review/ai/repair/annotate）里 `registerRoute({ kind: 'exact', path, methods, handler })`；
   新组才需要动 `lib/index.js` 的挂载列表。
   handler 只做：`readJson`/`URL` → 校验 + 钳制（数字参数 `intParam`、字符串 `strParam`/`slice`）→ 调 service → `safeSend`。
4. **README 登记**：`/接口` 表加一行（方法 / 路径 / 说明 + 参数）。
5. **端到端断言**：`scripts/test-routes.mjs` 加一条（它用桩 ctx 真跑路由，不用重启宿主）。
6. **前端接线**：在对应 `assets/*.js` 的 `API` 常量表加路径，再写调用与失败分支。
7. 跑验证。

## 硬约束

- 不许绕过 `registerRoute` 直接 `ctx.webServer.register`。
- 写操作必须显式 `methods: ['POST']`；不声明等于允许 GET 顺手写库。
- 所有外部输入必须钳制：数字走 `intParam(url, name, { fallback, min, max, floor })`（`lib/http.mjs`），
  字符串 `strParam`/`slice`，布尔用 `isFalse()`，词输入过 `looksLikeWord`。
- 错误响应只给稳定 `code` + 一句中文人话；`err.message`（可能含绝对路径）只进 `console.warn`。
- 交互路径（用户正看着的请求）失败回 `200 + ok:false`，别用 5xx 触发重试。
- 已经发出的响应之后的副作用（入队/记账）必须自己吞错，不能二次写头。
- 不新增运行时依赖；不在 handler 里写 SQL 或 fetch。

## 必须执行的验证

```bash
pnpm lint                      # 新文件若超 400 行会直接报 max-lines
node scripts/test-routes.mjs   # 端到端：桩 ctx + 桩 req/res
pnpm test:unit                 # 新 service 的单测
pnpm verify                    # 唯一验收
```

栅栏自检（宿主里）：`POST /dsh-word-learn/<新路由>` 未带可信头应返回 **401/403**，
返回 404/405 说明路由没挂上（见 README「改了 lib/ 怎么不重启就生效」）。

## 交付输出模板

```text
新接口：{{METHOD}} {{path}} ? {{入参}}
响应：成功 {{字段}} / 失败 {{code 与状态码}}
业务位置：{{lib/xxx.mjs 的函数}}

改动：
- lib/routes/paths.mjs —— 新路径常量
- lib/routes/{{组}}.mjs —— 路由注册
- lib/{{service}}.mjs —— {{函数}}
- README.md:{{行区}} —— 接口表登记
- scripts/test-routes.mjs:{{行区}} —— {{断言}}
- assets/{{file}}.js:{{行区}} —— {{调用点}}

验证：pnpm verify → {{结果}}；栅栏自检 → {{401/403}}

剩余风险：{{未覆盖的入参组合 / 需要真机确认的前端分支}}
```
