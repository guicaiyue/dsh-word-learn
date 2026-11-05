# ADR-0006：发布与 CI —— dist 不入库，npm publish + GitHub Release tarball

- 状态：提议（等待用户批准）
- 日期：2026-11-05
- 相关：ADR-0001、ADR-0002、ADR-0005

## 背景

仓库已上 GitHub（`git@github.com:guicaiyue/dsh-word-learn.git`），当前没有 CI、没有发布流程、`dist/` 概念不存在。构建化后必须回答：产物是否入库、怎么版本化、用户/本机怎么安装、CI 跑什么。

## 决策

1. **`dist/` 不入库**（`.gitignore`）。源码仓库只含 `src/`、测试、文档、`data/ecdict.db`、`locale/`、`cordis.patch.yml`。
2. **产物发布两条腿**：
   - `npm publish`（主）：`files` 含 `dist`、`data`、`locale`、`cordis.patch.yml`、`icon.svg`、`README.md`；`prepublishOnly: pnpm verify`；`--provenance`（GitHub Actions OIDC）。
   - GitHub Release（备）：tag `vX.Y.Z` 时 `npm pack` 生成 tarball + sha256 一起挂到 Release；无 npm token 时也能分发。
3. **版本化**：changesets + conventional commits（`feat:` 次版本、`fix:` 修订、`!`/`BREAKING CHANGE` 主版本）；`CHANGELOG.md` 由 changesets 生成。
4. **CI（GitHub Actions）**：
   - `ci.yml`：push/PR → Node 24 + pnpm（frozen lockfile）→ `pnpm verify`（build/type/lint/deps/test/coverage/artifact/pack）→ 上传 coverage 与 build 产物。
   - `release.yml`：tag `v*` → 复用 verify → `npm publish`（需仓库 secret `NPM_TOKEN`）→ `npm pack` + `gh release create` 附 tarball/sha256。
   - 缓存：pnpm store；不缓存 `dist`（每次重建，保证产物契约在干净环境验证）。
5. **本地安装（本机 profile 现状）**：profile 用 `link:D:/projects/blog/dsh-plugins/dsh-word-learn`。link 安装**不会**运行包的 build 脚本，因此：
   - clone/拉取后必须先 `pnpm install && pnpm build`（README/AGENTS 第一行写明）；
   - `pnpm dev` 常驻 watch，避免忘记构建；
   - `exports['./client']` 指向 `dist/client.js`，缺失时 DSH 激活会明确报错（平台原文 `run pnpm run build before launch`），不会静默坏掉。
6. **发布产物校验**：`npm pack --dry-run --json` 断言文件清单包含 `dist/client.js`、`dist/client.js.map`、`dist/host/index.js`、`data/ecdict.db`、`locale/zh.json`、`locale/en.json`、`cordis.patch.yml`，且不含 `src/`、`tests/`、`node_modules/`。

## 后果

- 贡献者/未来的 AI 改完必须 `pnpm build` 才能真机验证；这一点写进 AGENTS「三条命令」。
- `data/ecdict.db` 14.4MB 继续入库（开箱可用），npm tarball 会包含它；可接受（ECDICT 是 MIT，已注明来源）。
- CI 无法跑真浏览器验收（需要运行中的 DSH 与鉴权）；真机验收仍是阶段交付的人工/Agent 步骤，E2E 作为本地可选命令。
- 首次发布需要用户提供 npm token；不提供时 Release tarball 仍可用。

## 备选方案

| 方案                          | 结论                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| dist 入库（像 dsh-armory）    | 仓库可读性差、每次构建产生噪音 diff、review 被产物淹没；不采用 |
| 只发 GitHub Release，不发 npm | 可作为降级；但 DSH 插件生态以 npm 安装为主，主路径仍选 npm     |
| 用 GitHub Packages            | 需要额外 registry 配置，对 DSH 用户不友好；不采用              |

## 复审条件

- 若 npm 发布遇到包名/权限问题，切到「Release tarball + 文档安装」；ADR 记录切换原因。
