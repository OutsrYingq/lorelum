# 官网部署工作流（Cloudflare Workers + GitHub Actions）

> **适用范围**：`apps/site`（Lorelum 官网：Landing + Docs）。
> **线上地址**：https://lorelum.com
> **部署目标**：Cloudflare **Workers**（项目名 `lorelum`），自动部署走 **GitHub Actions**（`.github/workflows/deploy-site.yml`，带路径过滤），手动部署走 `wrangler deploy` 直传。
> **更新日期**：2026-09-09

## 1. 部署形态（先搞清楚再动手）

`apps/site` 用官方 `@cloudflare/vite-plugin`（SSR Worker 模式）构建：

- `bun run build:site` 产出 `apps/site/dist/`（`dist/client` 静态资源 + `dist/server` Worker）
- `wrangler.jsonc` 的 `main` 指向 `@tanstack/react-start/server-entry`
- Cloudflare 后台项目类型是 **Worker**（不是 Pages）；线上地址 `https://lorelum.com` 由后台为 Worker 绑定的自定义域提供

**常见误区**：本项目不走 Cloudflare Pages，也不再用 Workers Builds 的 Git 集成自动构建。自动部署由 GitHub Actions 触发（公开仓库免费），Cloudflare 端只接收 `wrangler deploy` 直传。

## 2. 两种上线方式

| 方式 | 触发 | 成本 | 适用场景 |
|---|---|---|---|
| **自动部署** | push 到 `main` 且改动命中 `apps/site/**`、`bun.lock`、`package.json` | GitHub Actions（公开仓库免费） | 正式发布 |
| **手动直传** | 本地 `bun run build:site && bun run deploy:site` | 无 | 日常迭代看线上效果 |

自动部署的路径过滤是 GitHub 原生能力（`on.push.paths`）；Workers Builds 没有等价功能（截至 2026-09：后台构建设置与 wrangler schema 均无路径过滤项），这是自动部署从 Cloudflare 端迁到 GitHub Actions 的原因。改 `packages/*` 等站点无关路径不会触发任何部署。

## 3. 日常迭代工作流（推荐，零配额消耗）

改版期间**不需要每次 push 触发构建**，全部在本地完成：

```bash
# 1) 本地开发（vite dev，含 Worker 运行时模拟）
bun install
bun run --filter @lorelum/site dev          # http://localhost:3000

# 2) 类型检查
bun run --filter @lorelum/site typecheck

# 3) 验证生产产物
bun run build:site                          # 产出 apps/site/dist
cd apps/site && bun run preview             # vite preview 预览产物
# 或验证 Worker 运行时：
cd apps/site && npx wrangler dev --port 8788

# 4) 想看线上效果 → 手动直传（不经过 Workers Builds，零配额）
bun run build:site && bun run deploy:site
```

手动直传会立即更新线上站点（`lorelum.com`）；改动请先在本地验证（第 3 步），确认后再发布。

## 4. 成本说明

- 自动部署跑在 **GitHub Actions**：公开仓库免费，无分钟数顾虑。
- Workers Builds（Cloudflare 端构建）的 Git 集成已断开（见 §5），不再产生构建分钟消耗；免费档 3,000 build 分钟/月 的配额因此与本部署流程无关。
- 手动直传同 §2，不消耗任何配额。

## 5. 自动部署现状（GitHub Actions）

自动部署由 `.github/workflows/deploy-site.yml` 驱动：

| 项 | 值 | 说明 |
|---|---|---|
| 触发 | push 到 `main` | 仅当改动命中 `apps/site/**`、`bun.lock`、`package.json` |
| 手动触发 | `workflow_dispatch` | GitHub 页面 Actions → Deploy site → Run workflow，可跳过路径过滤强制重部署 |
| 并发控制 | `concurrency: deploy-site` + `cancel-in-progress` | 连续 push 时旧部署取消，最新 commit 胜出 |
| 认证 | GitHub `production` Environment secrets：`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Token 为 Cloudflare 后台创建的专用 deploy token |

> 2026-09-09 之前自动部署走 Workers Builds Git 集成，任何 push 到 `main`（无论是否涉及站点）都会触发 Cloudflare 端构建。因 Workers Builds 不支持路径过滤，改为 GitHub Actions 方案，并在 Cloudflare 后台断开了 `lorelum` Worker 的 Git 集成（Settings → Build → Git repository → Manage → 断开），避免双路径重复部署。

### 调整方式

- **改触发路径**：编辑 `deploy-site.yml` 的 `on.push.paths`。
- **需要 Cloudflare 端自动构建时**：重新在后台连接 Git 仓库即可，但建议先停用本 workflow，避免两边同时部署。
- **强制重部署**：Actions → Deploy site → Run workflow（不受路径过滤限制）。

## 6. 正式发布（Go Live）

```bash
# 在 feature 分支完成开发、验证后合并到 main
git checkout main && git merge feat/xxx
git push origin main        # 改动命中路径过滤时，GitHub Actions 自动构建 + 部署
```

未命中路径过滤但需要重部署时，用 Actions 页面的 `workflow_dispatch` 手动触发，或本地直传：

```bash
bun run build:site && bun run deploy:site
```

## 7. 相关命令速查

（均在仓库根目录，见根 `package.json`）

| 命令 | 作用 |
|---|---|
| `bun run build:site` | 构建 `apps/site` → `apps/site/dist/` |
| `bun run deploy:site` | `cd apps/site && npx wrangler deploy`（手动直传线上站点） |
| `bun run versions:site` | `cd apps/site && npx wrangler versions upload`（上传非生产版本，不切流量） |

## 8. 已知问题 / 排障

- **自动部署没触发**：确认 push 的是 `main` 且改动命中 `on.push.paths`；到仓库 **Actions → Deploy site** 查看运行记录（被路径过滤跳过的 push 不会产生任何 run）。
- **认证失败（Authentication error）**：检查 repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 是否有效；Token 在 Cloudflare 后台 My Profile → API Tokens 管理。
- **需要跳过某次 push 的部署**：commit message 里加 `[skip ci]`（GitHub Actions 原生支持，会同时跳过 CI）。
- **配额查询**：自动部署跑 GitHub Actions（公开仓库免费）；Cloudflare 端构建历史在 Workers & Pages → `lorelum` → Deployments。

## 关联

- `docs/research/tanstack-fumadocs-spike.md` — 技术选型 spike 结论
- `apps/site/README.md` — 站点开发说明
