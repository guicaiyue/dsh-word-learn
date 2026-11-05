# ADR-0007：开发回路与生效方式（改一行看到效果）

- 状态：提议（等待用户批准；已实测的部分标注证据）
- 日期：2026-11-05
- 相关：ADR-0001、ADR-0002、ADR-0006

## 背景

零构建时前端「改完硬刷新即可」，宿主「追加 profile patch 注释触发 HMR 重挂」。构建化后必须给出同样短、且不依赖自研 loader 的回路。已实测的平台事实：

1. **客户端 HMR 自动生效**（2026-11-05 实测）：`touch assets/dashboard.js` 后 4 秒内，浏览器控制台网络出现新的 `/plugins/??dsh-word-learn/client.js&rev=<新 hash>` 请求，学习页自动重新挂载（dashboard 接口重新请求）。机制：`@deepseek-ai/dsh-client-hmr` 的宿主半每 500ms `stat` 客户端产物（mtime/ctime/size），变化即 `clientModules.rebuilt(id)` → SSE `/plugins/events` → 浏览器半 `entries.reload(id, rev)`。**不需要刷新页面、不需要改 profile、不需要重启 dsh。**
2. **宿主重挂**：往 profile `cordis.patch.yml` 追加一行注释即可重排 profile 并换掉链接包里改动过的模块（约 6–8s，Horon #194 实测）。这是运维手段，必须成对还原。
3. `__DSH_BOOT__.entries` 是「激活时的清单快照」；HMR 后它可能仍是旧 rev，**不能用它判断客户端是否已重载**，应看 `/plugins/events` 或控制台网络里新的 `rev`。

## 决策

### 日常回路

```bash
pnpm dev        # tsdown --watch（客户端）+ tsc -w（宿主，阶段 3 起）
```

| 改动位置                                      | 看到效果的方式                                                                                             | 预期时延                          | 需要重启 dsh                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------- |
| `src/client/**`                               | `tsdown --watch` 重写 `dist/client.js` → 平台 client-hmr 自动重载并重跑 `apply`                            | < 2s（watch ~300ms + 轮询 500ms） | 否                           |
| `src/host/**`（阶段 1–2 的 `lib/**`）         | `tsc -w` 重写 `dist/host/` → `pnpm hmr`（脚本：备份 profile patch → 追加一行注释 → 6s 后 sha256 校验还原） | 6–10s                             | 否                           |
| `src/shared/**`                               | 同上（两侧都会重建）                                                                                       | < 10s                             | 否                           |
| `dsh.client` / `exports['./client']` 结构变化 | 重挂后仍不生效才重启                                                                                       | —                                 | **可能一次**（平台否定缓存） |
| `locale/*.json`                               | 重挂 + 页面刷新                                                                                            | ~8s                               | 否                           |
| `data/ecdict.db`                              | 重挂（dict 在 open 时读）                                                                                  | ~8s                               | 否                           |

### 验收（每阶段/每次提交前）

1. `pnpm verify`：build → typecheck → lint → format → deps → test → coverage → artifact；**全绿且输出贴进交付说明**。
2. 真机清单（用 `bsk` 工具，证据落盘到 `.scratch/evidence/<阶段>/`）：
   - `__DSH_BOOT__.entries` 含 `dsh-word-learn`，`rev` 与 `dist/client.js` 实际一致（通过 `/plugins/??...&rev=` 请求确认）；
   - 普通刷新 ×5 无白屏、无 `slot entry crashed`；
   - 硬刷新一次；
   - 划词卡片（选词/整句/代码块/收藏/发音）；
   - 学习页四 tab（学习/词汇/数据/设置），每 tab 至少一条交互；
   - 标注（对话正文 token、悬停卡、流式追加）；
   - 连续两次 HMR 重载后，划词只弹一张卡（监听未叠加）；
   - console 0 error（允许 node:sqlite 实验性警告，出现在宿主侧）。
3. 证据格式：截图 + 一段 JSON（boot entry、globals 长度、style 标签长度、console 计数）+ 命令与时间戳。

### 回滚

- 单个 feature 回滚：revert 对应子 commit，`pnpm build`，HMR 自动生效。
- 整个阶段回滚：`git revert <stage-commit>`（或 `git reset --hard phase-N`），`pnpm build && pnpm verify`，重挂插件。
- 回到零构建形态：把 `exports['./client']` 指回 `assets/dashboard.js`（阶段 2 删除前有效），重挂插件。

## 后果

- 前端开发不再需要「硬刷新 + 重新激活插件」，比现状更快；`assets/` 的 mtime 路由与「client 快照」概念全部消失。
- 宿主开发从「改完直接重挂」变为「等 tsc 产物 + 重挂」（多 <1s），换来类型安全；阶段 3 前宿主仍是 `.mjs`，回路不变。
- `pnpm hmr` 脚本必须做 profile patch 的备份/还原与 sha256 校验，禁止留下 probe 行（红线）。
- 真机验收依赖运行中的 DSH Web 与 bsk 浏览器会话；CI 不跑这一层。

## 备选方案

| 方案                       | 结论                                                    |
| -------------------------- | ------------------------------------------------------- |
| 只 `pnpm build` + 手动刷新 | 可行但慢，且丢失平台自带 HMR；作为兜底                  |
| 自建 dev server / vite HMR | 与 DSH 客户端运行时无关，且平台已提供模块级 HMR；不采用 |
| 每次重启 dsh               | 成本 20s+ 且打断会话；只作为最后手段                    |
