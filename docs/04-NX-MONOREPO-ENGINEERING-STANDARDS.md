# 04 · Nx + pnpm Monorepo 工程规范

> Draft v0.1｜这是**新工作区的落地规范**。命令按 Nx/pnpm 当前主流 CLI 设计；初始化时需以实际安装版本核验参数与生成器行为，锁定版本后更新本文。

## 1. 目标

建立一个可由人类和 Coding Agent 安全协作的 Monorepo：边界清晰、项目图可见、affected CI、可缓存任务、可重复构建、Worker 独立部署、禁止跨应用私有依赖。

## 2. 环境约定

- Node.js：选定当前受支持的 **LTS** 版本，写入 `.node-version`/Volta 配置；不使用不受支持的旧版本。
- pnpm：使用 Corepack 管理，`package.json#packageManager` 固定**精确版本**。
- Nx：固定 Nx 与官方插件兼容版本；不写 `latest` 进入生产锁文件。
- TypeScript：开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`（视第三方兼容逐步开启）。
- 开发环境：Windows + Codespaces 均需支持；shell 命令应避免 POSIX-only 假设，CI 以 Linux 为标准。
- 包管理：只允许 pnpm；提交 `pnpm-lock.yaml`；禁止多个 lockfile。

## 3. 推荐目录结构

```text
ai-software-video-studio/
├─ apps/
│  ├─ web/                    # React Studio
│  └─ api/                    # HTTP API / auth / orchestration
├─ workers/
│  ├─ knowledge-worker/       # Git/rg/AST 索引
│  ├─ browser-worker/         # Playwright/Chromium
│  ├─ ai-worker/              # LLM/TTS/visual generation
│  └─ render-worker/          # Remotion/FFmpeg
├─ libs/
│  ├─ contracts/              # DTO、Zod schema、events
│  ├─ domain-project/
│  ├─ domain-knowledge/
│  ├─ domain-video/
│  ├─ domain-production/
│  ├─ application/
│  ├─ ports/
│  ├─ adapters-github/
│  ├─ adapters-storage/
│  ├─ adapters-atvg2/         # 可选
│  ├─ video-ir/
│  ├─ remotion-compositions/
│  ├─ ui-components/
│  └─ observability/
├─ tools/
│  ├─ scripts/
│  └─ benchmarks/
├─ infra/
│  ├─ docker/
│  └─ compose/
├─ docs/                      # 本套文档
├─ .github/workflows/
├─ nx.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ package.json
```

## 4. 初始化步骤（在新空目录执行）

```bash
corepack enable
# 使用已选定并固定版本的 pnpm；不要无审查地追最新版本
pnpm dlx create-nx-workspace@<PINNED_NX_VERSION> . --preset=apps --pm=pnpm --nxCloud=skip
pnpm add -D @nx/js@<SAME_NX_VERSION> @nx/node@<SAME_NX_VERSION> @nx/react@<SAME_NX_VERSION>
```

`<...>` 是必须由初始化工程师替换的版本占位符，不可原样执行。若当前 Nx CLI 不接受 `.`、`--preset=apps` 或 `--nxCloud=skip`，先运行 `pnpm dlx create-nx-workspace@<version> --help`，使用同等语义的交互式初始化。**先核对版本与插件兼容矩阵，再生成 apps 和 libs。**

生成器示例（先用 `pnpm nx list @nx/react`、`pnpm nx g @nx/react:application --help` 核实）：

```bash
pnpm nx g @nx/react:application apps/web
pnpm nx g @nx/node:application apps/api
pnpm nx g @nx/js:library libs/contracts
pnpm nx graph
pnpm nx show projects
```

如果插件版本的路径参数与示例不同，以当前 CLI help 为准，不要在未检查输出时批量生成。

## 5. Nx 项目边界标签

所有项目必须标注 `type` 与 `scope`，例如：

```json
{
  "name": "domain-video",
  "tags": ["type:domain", "scope:video", "runtime:universal"]
}
```

建议标签：

- `type:app | api | worker | domain | application | port | adapter | ui | contract | tooling`
- `scope:project | knowledge | video | production | shared | integration`
- `runtime:browser | node | universal | native`

约束：domain 只依赖 domain/contract；adapter 可以依赖 port/contract/domain；UI 不得依赖 node/native；API 不得 import Worker 私有模块，也不得依赖 React 应用、Zustand store 或 feature；ATVG2 adapter 不得被 domain 依赖。使用 Nx ESLint module-boundaries 规则在 CI 强制执行；配置语法以安装的 `@nx/eslint` 版本核验。

## 6. 根级配置示意

`pnpm-workspace.yaml`：

```yaml
packages:
  - 'apps/*'
  - 'workers/*'
  - 'libs/*'
  - 'tools/*'
```

`nx.json` 关键原则（示意，不代替初始化生成文件）：

```json
{
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "sharedGlobals": ["{workspaceRoot}/tsconfig.base.json", "{workspaceRoot}/pnpm-lock.yaml"],
    "production": ["default", "!{projectRoot}/**/*.spec.ts", "!{projectRoot}/**/*.test.ts"]
  },
  "targetDefaults": {
    "build": { "dependsOn": ["^build"], "inputs": ["production", "^production"], "cache": true },
    "lint": { "cache": true },
    "test": { "cache": true },
    "typecheck": { "cache": true }
  }
}
```

注意：含外部模型调用、浏览器录制、时间戳、真实密钥或动态环境的任务**不得盲目开启 Nx 缓存**。只有输入、环境和输出可定义且可重复的任务才可缓存；渲染缓存需显式包含模板、字体引用、媒体 hash、FFmpeg/Remotion 版本。

## 7. 必须存在的 Targets

每个可执行项目：`build`、`lint`、`typecheck`、`test`；Worker 额外 `docker-build`、`smoke`；视频引擎额外 `render-fixture`；浏览器 Worker 额外 `demo-fixture`；仓库额外 `e2e`、`bench`。Target 名称与 executor 在生成时明确记录。

本地常用命令：

```bash
pnpm nx graph
pnpm nx show projects
pnpm nx run-many -t lint typecheck test
pnpm nx affected -t lint typecheck test build --base=origin/main --head=HEAD
pnpm nx run render-worker:render-fixture
```

CI 中确保 base SHA 可获取；浅克隆会导致 affected 范围错误。对发布构建使用 lockfile 冻结安装 `pnpm install --frozen-lockfile`。

## 8. 测试分层

- 单元测试：domain 规则、IR schema、时间线计算、hash。
- 契约测试：API、Job Envelope、adapter 的版本兼容。
- 集成测试：PostgreSQL、对象存储、队列、GitHub mock。
- E2E：测试应用演示、录屏、渲染、导出。
- 故障注入：Worker crash、超时、重复投递、失联、磁盘满。
- 基准：Git 增量索引、60 秒渲染、峰值 RSS。

CI 最小门槛：格式、lint、typecheck、unit、contract、受影响 build；合并前关键 E2E；定期完整 E2E 与基准回归。

## 9. Coding Agent 工作规范（强制）

1. **先读** 01–09 文档、`nx graph`、相关代码和现有测试。
2. **先解释问题**：用产品经理能理解的话描述目标、影响范围、备选方案与风险。
3. **先给计划**：列明将改动的 Nx projects、文件、测试、验收证据；架构/依赖变化先请求批准。
4. **小步提交**：单任务聚焦一个可验证交付；禁止顺手大重构。
5. **不得伪造**：未执行的测试不能写成通过；未生成的视频不能称为已生成。
6. **输出证据**：命令、退出码、测试报告、构建产物路径、截图/视频 hash。
7. **尊重边界**：不得绕开 lint、禁用测试、把 Worker 逻辑塞进 API。
8. **遇到不确定**：提出清晰问题；不得擅自扩大产品范围。

## 10. 首次工程任务验收

- `pnpm install --frozen-lockfile` 成功；
- `pnpm nx graph` 正常显示 apps/workers/libs；
- 每个核心项目可 lint/typecheck/test/build；
- module boundaries 故意违规时 CI 能失败；
- API/Worker 之间通过版本化契约传输一个模拟 Job；
- README 提供 Windows 与 Codespaces 的启动方式；
- 不包含真实密钥、无效占位路径或未核验的“已完成”标记。

**关联文档**：03、05、06、09。
