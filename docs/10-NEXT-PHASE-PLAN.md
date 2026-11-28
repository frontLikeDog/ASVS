# 10 · 下一阶段排期与迭代建议

> 状态：建议稿 v1.0｜日期：2026-11-19｜基线提交：`09cd2d6`（`perf/route-splitting-budget-e2e`）
> 文档性质：**建议**，不是承诺。所有工期为单人全职的粗略估算，实际以证据推进 Gate。
> 前置条件：前端体验阶段已验收（见 README §7、docs/ux/UX-ACCEPTANCE-CHECKLIST.md）。

---

## 1. 这一阶段要回答的问题

前端原型已经把「可信软件事实 → 可审阅视频工程」这条产品流程走通，并且诚实地标明了模拟边界。
下一阶段不再围绕界面，而是围绕三个**尚未被任何证据支撑的核心假设**：

| # | 假设 | 当前状态 | 失败后果 |
|---|---|---|---|
| H1 | `StoryboardV1` 能被确定性渲染成可播放的 MP4 | **已有证据**（2026-11-20，2026-11-27 扩展到配音）：`libs/render` + `workers/render-worker` 产出 30 秒 MP4；5B 起服务端成片含真实旁白音轨（H.264 + AAC）与同步 SRT，见 [docs/11](11-RENDER-SLICE.md) / [docs/14](14-AUDIO-EXPORT-SLICE.md)。基线提交时为零实现 | 产品核心价值不成立，需重新选型 |
| H2 | Playwright 能在真实 UI 上稳定录屏，且「断言通过」比「脚本退出码 0」更可信 | **已有证据**（2026-11-26）：`workers/browser-worker` 按已批准 DemoPlan 录制 `web-studio`（11/11 断言、3/3 重复通过率 100%）并接入渲染成片，见 [docs/12](12-CAPTURE-SLICE.md) | 演示素材只能靠手工，产品退化为普通编辑器 |
| H3 | 前端状态可迁移到真实后端而不大规模返工 | **零实现**：无 `apps/api`，无接口抽象，`mock-services` 被 Store 直接调用 | 后期返工成本超过重写 |

本阶段的排期原则：**先降低最大不确定性，再补工程护栏，最后才扩展功能**。前端不再作为主要投入方向。

---

## 2. 现状盘点（已验证事实）

以下均为在基线提交上实际检查得到的事实，不是文档描述。

### 2.1 工程护栏

| 项 | 实测 | 影响 |
|---|---|---|
| `git remote -v` | **空**，无远端 | `perf/route-splitting-budget-e2e` 领先 `main` 1 个提交，尚未合并、无 PR |
| `.github/` | **不存在** | 无 CI；docs/04 §7 要求的 `frozen-lockfile` + `affected` 门槛未落地 |
| `pnpm test` | 8 个项目**全部命中 Nx 缓存** | 「57 个测试通过」在当前 HEAD 上未被真实重跑验证 |
| `apps/` | 只有 `web-studio` | 无 `apps/api`；docs/03 的模块化单体尚未起头 |
| Playwright 项目 | `chromium` + `mobile-chromium`（390×844） | 平板 768 仍为人工抽查（README 已知缺口 §7） |
| 跨层 import 拦截 | ESLint 规则已配置（`eslint.config.mjs` 的 `@nx/enforce-module-boundaries`） | 但**没有一条测试证明它真的会失败** |

### 2.2 领域模型与渲染 IR 的差距

docs/05 设计的 `VideoSceneV1` 与仓库中的 `sceneSchema`（`libs/domain/src/schemas.ts:313`）存在结构性差异：

| docs/05 设计 | 仓库实现 | 差距 |
|---|---|---|
| `visual: { type: 'real_demo', demoPlanId } \| { type: 'motion_graphics', templateId, props } \| { type: 'generated_visual', assetId }` | `visualType: 'real_demo' \| 'motion' \| 'generated' \| 'title' \| 'cta'`（扁平枚举） | 无判别联合、无 `props`、无 `demoPlanId` |
| `durationFrames` + `fps` | `durationSec: number` | 无帧概念；Remotion 需要帧 |
| `revision: number` | 无 | 无法表达 Scene Revision，docs/07 §5 的「局部失效」缺少载体 |
| `claimIds`（有） | `claimIds: string[]`（有） | 一致 |

**结论**：直接接 Remotion 会卡在 IR 上。第 1 步必须包含一次 schema 变更，且这是一次**破坏性变更**，需要迁移链（见 2.3）。

> 执行注记（2026-11-20）：S1-1 已按兼容策略落地——`visual` / `durationFrames` 可选，`revision` / `fps` 有默认值，旧 `visualType` 由 `deriveSceneVisual` 映射；因此现有页面无需一次性重写。详见 [docs/11](11-RENDER-SLICE.md) §3。

### 2.3 持久化

`libs/state/src/studio-store.ts:1040` 使用 `persist`：

```ts
name: 'asvs.studio.v1',
version: 1,
merge: (persisted, current) => { /* studioSnapshotSchema.parse 失败则回退种子 */ }
```

这是「校验失败即**丢弃整个工作区**」，不是迁移。一旦第 1 步改动 `sceneSchema`，所有已存在的本地工作区都会被清空。真实用户数据之前必须换成显式迁移链。

> 执行注记（2026-11-20）：S1-6 已落地 `STUDIO_PERSIST_VERSION = 2` 与 `migratePersistedStudioState`；v1 快照补齐字段后继续可用，只有结构损坏才回退种子。见 [docs/11](11-RENDER-SLICE.md) §4。

### 2.4 前端性能（已不再是瓶颈）

| 指标 | 当前值 | 预算 |
|---|---|---|
| 初始 JS | 722.6 kB raw / 214.8 kB gzip | 790 / 230 gzip |
| Editor 增量 | 68.9 kB / 23.5 kB gzip | 95 / 30 |
| Production 增量 | 32.7 kB / 13.4 kB gzip | 70 / 24 |
| Review 增量 | 28.9 kB / 10.6 kB gzip | 65 / 22 |

全部有 7%–30% 余量。README §8 提到的「把 mock-services 从初始包下沉」收益有限，且与第 3 步的接口抽象方向冲突——**建议推迟到接口抽象之后再做**，届时是自然结果而非专项优化。

---

## 3. 路线总览

```text
Step 0  工程护栏            [1–2 天]   → Exit: CI 绿，PR 合并，故意越界会红
Step 1  真实渲染切片        [2 周]     → Exit: 固定输入产出可播放 30 秒 MP4 + 回执
Step 2  真实录屏            [2 周]     → Exit: 同一 DemoPlan 重复执行通过率可测
Step 3  最薄后端 + 接口抽象 [1.5 周]   → Exit: Store 只依赖接口，数据可跨设备恢复
Step 4  真实知识源          [3–4 周]   → Exit: 真实 PR → Claim → 视频候选闭环
Step 5A 服务端编排底座      [已完成]    → Exit: SIGKILL 可恢复的真实 MP4（无音轨）
Step 5B 配音与交付包        [已完成]    → Exit: 带旁白音轨的 MP4 + SRT + Gate 3 导出包
```

| 阶段 | 估算 | 核心交付 | Exit Gate | 主要风险 |
|---|---|---|---|---|
| **Step 0** 护栏 | 1–2 天 | CI、PR、边界测试、平板视口 | CI 在 PR 上全绿 | 无（纯收益） |
| **Step 1** 渲染切片 | 2 周 | `libs/render` + `workers/render-worker` + 首个 MP4 | 固定 fixture 产出可播放 MP4，SHA256/时长/分辨率已记录 | IR 改造范围失控；过早做局部重渲染 |
| **Step 2** 录屏 | 2 周 | `workers/browser-worker` + DemoPlan 执行器 | 重复执行通过率、trace、失败截图齐全 | 环境不稳定；locator 脆弱 |
| **Step 3** 后端与接口 | 1.5 周 | `apps/api`（最小）+ port 抽象 + 迁移链 | 数据跨设备恢复；schema 变更不丢数据 | 过早做完整后端导致返工 |
| **Step 4** 真实知识源 | 3–4 周 | GitHub App 只读 + 增量索引 | 真实 PR 完整闭环 | 功能发现准确率不足 |

依赖关系：Step 0 无依赖；Step 1 → Step 2（录屏素材需要能合成成片才有意义）；Step 3 可与 Step 2 并行；
Step 4 依赖 Step 3 的后端。

---

## 4. Step 0 · 工程护栏（本周，1–2 天）

**目标**：让「本机能过」变成「任何人任何机器都能过」，为后续所有真实化改动提供回归保护。

### 工作项

| ID | 任务 | 涉及位置 | 验收 |
|---|---|---|---|
| S0-1 | 配置 `origin` 并推送；为 `perf/route-splitting-budget-e2e` 开 PR | git | PR 可见，diff 仅含该分支 1 个提交 |
| S0-2 | GitHub Actions：`pnpm install --frozen-lockfile` → `pnpm validate` → `pnpm build` → `pnpm test:e2e` | `.github/workflows/ci.yml` | 在 PR 上跑通；`frozen-lockfile` 不报错 |
| S0-3 | 用 `nx affected` 替代全量（缓存 + 受影响范围） | 同上，参考 docs/04 §7 | 仅改 `README.md` 的 PR 不触发 e2e |
| S0-4 | 新增一条**故意的跨层 import** 测试，证明 `enforce-module-boundaries` 会失败 | 独立 `lint:boundary-check` 脚本 | 脚本退出码非 0，CI 里以 `!` 预期失败 |
| S0-5 | Playwright 增加 `tablet-chromium` 项目（768×1024） | `apps/web-studio/e2e/playwright.config.ts` | 至少 `mobile.spec.ts` 的溢出断言在 768 下通过 |
| S0-6 | 真实重跑一次测试，确认非缓存结果 | `pnpm test --skip-nx-cache` | 57 个测试实际通过；把真实耗时写进 README §7 |

### 风险

- **没有**。这一阶段成本最低、收益最高。S0-6 尤其必要：README §7 的「57 个测试通过」目前只有缓存佐证。

### 执行状态（2026-11-19）

| ID | 状态 | 证据 |
|---|---|---|
| S0-1 | ⛔ **未完成** | 本机无 `origin`，`gh` 未登录。需要用户提供远端仓库并授权。 |
| S0-2 | ✅ 已配置，⚠️ 未在真实远端验证 | `.github/workflows/ci.yml`：`frozen-lockfile` → `nx affected`（lint/typecheck/test）→ boundary guard → build+budget → E2E；`ci` 聚合 job 用于分支保护 |
| S0-3 | ✅ 已实现，⚠️ 未在真实远端验证 | `affected` job 输出 `code` / `e2e` 两个开关；本地以注入 `nx` 结果验证：`[]` → 两个下游 job 均跳过，`["domain"]` → 两者均运行 |
| S0-4 | ✅ 完成 | `scripts/check-boundary-guard.mjs`（`pnpm lint:boundary-check`）：3 条非法 import 必须被拒；把规则改成 `off` 后脚本确实转红（已实测） |
| S0-5 | ✅ 完成 | `tablet-chromium`（768×1024）3 个用例全过；**并发现一个真实缺陷**：768–1179px 下侧栏折叠被强制，顶栏按钮无效，已修复 |
| S0-6 | ✅ 完成 | `pnpm test --skip-nx-cache`：7 文件 / 57 测试真实通过，冷缓存约 12 秒；E2E 32 个用例约 2 分钟 |

**Exit Gate 距离**：代码侧全部就绪，唯一缺口是 S0-1 需要远端仓库。
在真实 PR 上跑通 CI（G0-2 的「在 PR 上跑通」）之前，不能宣称 Step 0 完成。

> 更新（2026-11-26）：远端仓库 `origin`（`frontLikeDog/ASVS`）已配置；PR #1（`b7f75a1`）与 PR #2（`2324d55`）已在 GitHub Actions 跑通并合并到 `main`，Step 0 Exit Gate 已闭环。

---

## 5. Step 1 · 真实渲染切片（2 周，P0 核心）

**目标**：证明 `StoryboardV1` 能确定性渲染成可播放的 30 秒 MP4。这是产品的**最大未验证假设**。

对应 docs/09 的 WP-01 / WP-04。

### 工作项

| ID | 任务 | 涉及位置 | 验收 |
|---|---|---|---|
| S1-1 | **IR 升级**：`Scene` 增加 `visual` 判别联合、`durationFrames`、`revision`；`VideoProject` 增加 `fps` | `libs/domain/src/schemas.ts` | Zod 拒绝非法联合；`timeline.ts` 全部测试通过；迁移链见 S1-6 |
| S1-2 | 新建 `libs/render`：Remotion `Composition` 接收 `StoryboardV1` + BrandKit + Assets | `libs/render/src` | 组件为纯函数式，render 内无网络请求 / 无随机 |
| S1-3 | 三种 Scene 组件：`title` / `motion` / `cta`（`real_demo` 在 Step 2 接入，先用占位图 + 明确水印） | `libs/render/src/scenes` | `real_demo` 占位必须**视觉上不可冒充**真实录屏（docs/01 §5「真实优先」） |
| S1-4 | 新建 `workers/render-worker`：调用 Remotion renderer → 输出 MP4 → `ffprobe` 校验 | `workers/render-worker/src` | 失败必须非 0 退出；产物写 manifest |
| S1-5 | `ArtifactReceipt`：记录 `sha256`、`durationMs`、`width`、`height`、`fps`、`rendererVersion`、`compositionId` | `libs/domain`（契约） | 与 docs/03 §5 / docs/07 §4 的 manifest 字段一致 |
| S1-6 | **持久化迁移链**：`persist` 从「校验失败即丢弃」改为按 `version` 逐步迁移 | `libs/state/src/studio-store.ts` | v1 数据可迁到 v2；损坏数据仍安全回退 |
| S1-7 | 30 秒 fixture 黄金样片 + 校验脚本 | `workers/render-worker` | `pnpm nx run render-worker:render-fixture` 产出 MP4 并打印回执 |

### 明确不做

- **不做局部重渲染 / 片段拼接**。docs/07 §6 已明确：「首版可先实现全片渲染正确性，再通过基准验证逐步引入局部渲染；不能先承诺无损拼接。」
- **不做转场**。转场会引入跨镜头时间轴与关键帧问题，延后到 S1 稳定之后。
- **不做多画幅布局**。竖屏不是裁切横屏（docs/07 §6），需要单独设计；本阶段只做 16:9。

### Exit Gate

```text
固定输入 → 可播放 MP4
ffprobe 报告：编码 / 时长 / 分辨率 / fps 与 Storyboard 一致
SHA256 已记录进 manifest
非法 Schema 输入被拒绝（有测试）
持续集成里跑通 render-fixture
```

### 风险

| 风险 | 信号 | 应对 |
|---|---|---|
| IR 改造扩散到所有页面 | `sceneSchema` 改动触发 20+ 文件编译失败 | 先在 `domain` 加兼容字段并补默认值，页面逐页迁移，不一次性重写 |
| Remotion 版本与 React 19 不兼容 | 装包即报 peer 冲突 | 先做 30 分钟 spike（单独目录），确认后再进 monorepo |
| 用占位图冒充演示 | 审核页看不出 `real_demo` 是假的 | 占位必须带「未接入真实录屏」水印；`Asset.mock` 字段已在 `schemas.ts:246` 等候 |

### 执行状态（2026-11-20）

| ID | 状态 | 证据 |
|---|---|---|
| S1-1 | ✅ 完成 | `libs/domain/src/schemas.ts`：`sceneVisualSchema` 判别联合、`revision`、`durationFrames`、`VideoProject.fps`；`render.test.ts` 覆盖联合接受 / 拒绝与非法 `visualType` |
| S1-2 | ✅ 完成 | `libs/render`：`StoryboardComposition` 只消费 `RenderInputV1`，无网络 / 随机 / 时钟；`calculateStoryboardMetadata` 为纯函数并有单测 |
| S1-3 | ✅ 完成 | `title` / `motion_graphics` / `cta` / `generated_visual` / `real_demo` 五种组件；占位含 `MOCK`、hazard stripes、`未接入真实录屏`、`PLACEHOLDER` 与红色徽标 |
| S1-4 | ✅ 完成 | `workers/render-worker/src/render-fixture.ts`：bundle → `selectComposition` 元数据核对 → `renderMedia` → 全片解码 + ffprobe；任一步失败非 0 退出并写 manifest |
| S1-5 | ✅ 完成 | `libs/domain/src/render.ts`：`artifactReceiptV1Schema` / `renderManifestV1Schema`，含 sha256、时长、尺寸、fps、rendererVersion、compositionId |
| S1-6 | ✅ 完成 | `studio-store.ts`：`STUDIO_PERSIST_VERSION = 2` + `migratePersistedStudioState`；3 个迁移测试（补齐字段、幂等、畸形输入不崩溃） |
| S1-7 | ✅ 完成 | `workers/render-worker/fixtures/golden-30s.json`（6 场景 / 900 帧 / 30 秒）+ `pnpm render:fixture` + `pnpm verify:render` |

**Exit Gate 核对**

| Gate | 状态 | 证据 |
|---|---|---|
| 固定输入 → 可播放 MP4 | ✅ | `dist/render-worker/golden-30s/golden-30s.mp4`，5.09 MiB，可完整解码 |
| ffprobe 编码 / 时长 / 分辨率 / fps 一致 | ✅ | h264 · 1920×1080 · 30fps · 30000ms · 900 帧 |
| SHA256 记录进 manifest | ✅ | `b1451bfb…26ccd8a`；`pnpm verify:render` 独立复核一致 |
| 非法 Schema 被测试拒绝 | ✅ | `libs/domain/src/render.test.ts` 13 个用例 + `studio-store.test.ts` 迁移用例 |
| CI 跑通 render-fixture | ✅ | `.github/workflows/ci.yml` 的 `render` job 已随 PR #2（`993334b` / `2324d55`）在 GitHub Actions 跑通并合并 |

完整验收记录、复现步骤与边界见 [docs/11](11-RENDER-SLICE.md)。

---

## 6. Step 2 · 真实录屏（2 周，对应 WP-02 / WP-03）

**目标**：证明 Playwright 能在受控环境下稳定录制真实 UI，且成功判定基于断言而非退出码。

### 工作项

| ID | 任务 | 验收 |
|---|---|---|
| S2-1 | 新建 `workers/browser-worker`：Playwright Chromium + 固定 viewport / DPI / 时区 / 语言 / 字体 | 同一 DemoPlan 重复执行，画面结构一致 |
| S2-2 | DemoPlan 执行器：解析 docs/07 §3 的 YAML 草案为安全步骤（**不是**执行任意 Playwright 代码） | 未识别的 action 明确拒绝 |
| S2-3 | 域名 allowlist + 账号隔离 + 每步超时 + 失败保存 screenshot/trace | 访问非白名单域名被阻断（docs/08 §9 用例 2） |
| S2-4 | **断言优先**：只有 UI 断言通过才写 `CaptureReceipt` | 断言失败时即使脚本正常结束也必须判失败 |
| S2-5 | 夹具重置策略：录屏前重置 seed 数据 | 连续两次录屏结果可比较 |
| S2-6 | 录制产物（webm + trace + 截图）接入 `Asset`，`mock: false` | Step 1 的渲染管线能消费真实素材 |

### 目标环境

优先录制 **自家 `web-studio`**（它有确定性 seed 与 Playwright 基础设施，是天然 fixture），
再考虑接外部 staging。docs/09 §8 的原则是：环境不稳定时先做 fixture app，不阻塞视频引擎验证。

### Exit Gate

```text
同一 DemoPlan 连续执行 N 次，记录通过率与失败原因分布
每次失败都有 screenshot + trace
断言失败 → 判失败（有专门测试）
录屏产物能进入 Step 1 的渲染管线并产出成片
```

### 风险

| 风险 | 信号 | 应对 |
|---|---|---|
| locator 脆弱 | 通过率低于 ~80% | 只用 role / label / test-id，禁止 nth-child（docs/07 §2） |
| 录屏漂移 | 同一计划两次画面不同 | 固定全部环境变量；接受像素差异，比较结构化指标 |
| 敏感信息入镜 | 截图里出现 token / 邮箱 | 接入 docs/07 §9 的隐私 QA 检查 |

### 执行状态（2026-11-26）

| ID | 状态 | 证据 |
|---|---|---|
| S2-1 | ✅ 完成 | `workers/browser-worker`：固定 1920×1080 / DPR 1 / zh-CN / Asia/Shanghai / dark / 固定时钟；production build + `vite preview` 录制 |
| S2-2 | ✅ 完成 | `capture.ts` 的 DemoPlan schema + `executor.ts`；未识别 action、CSS / XPath / nth / JS selector 在打开浏览器前被拒绝，`capture.test.ts` / `selector.test.ts` 覆盖 |
| S2-3 | ✅ 完成 | `allowlist.ts` 精确 origin，导航前与网络路由双层检查；`plans/blocked-origin.yaml` + `pnpm capture:safety` 实测越界请求 0；失败写 screenshot + trace |
| S2-4 | ✅ 完成 | `captureReceiptV1Schema` 强制 `assertions.failed = 0` 且全部 step passed；`outcome.test.ts` 证明零断言 / 断言失败 / 步骤失败都判失败 |
| S2-5 | ✅ 完成 | `resetFixture()` 清 storage + 固定时钟 + 重载；`pnpm capture:repeat` 3/3 通过（100%） |
| S2-6 | ✅ 完成 | `Asset.mock:false` + `media`；`RealDemoScene` 用 `OffthreadVideo` 播放，未接入时回退占位；`pnpm render:captured` 产出 30 秒成片 |

**Exit Gate 核对**

| Gate | 状态 | 证据 |
|---|---|---|
| 同一 DemoPlan 重复执行，记录通过率与失败原因分布 | ✅ | 3/3 = 100%（门槛 80%），`repeat-report.json` |
| 每次失败都有 screenshot + trace | ✅ | 失败路径写 `failure-report.json` + `*-FAILED.png` + `trace.zip`；开发中两次真实失败已验证 |
| 断言失败 → 判失败（有专门测试） | ✅ | `outcome.test.ts` + `capture.test.ts` 的回执不变量 |
| 录屏产物能进入 Step 1 的渲染管线并产出成片 | ✅ | `dist/render-worker/captured-30s/captured-30s.mp4`，30,000ms / 900 帧，manifest 记录 `mediaSha256` |
| CI 跑通 capture gate | ⏳ 待 PR #3 CI 验证 | `.github/workflows/ci.yml` 的 `capture` job 已配置，待 `feat/capture-slice` PR 在 GitHub Actions 跑通 |

完整验收记录、复现步骤与边界见 [docs/12](12-CAPTURE-SLICE.md)。

---

## 7. Step 3 · 最薄后端与接口抽象（1.5 周，可与 Step 2 并行）

**目标**：把「只能存在一个浏览器里」变成「可以跨设备、可以迁移」，同时**不**引入完整后端架构。

### 为什么不是完整后端

docs/03 设计的是模块化单体 + 队列 + 对象存储 + Postgres。一次性建全，会与 Step 1/2 的 IR 变更互相踩踏。
本阶段只解决三个**已经造成实际损坏**的问题：

1. localStorage 快照无迁移（2.3）
2. 生产运行只在页面打开时推进（README §8 缺口 7）
3. 数据无法跨设备 / 无法备份

### 工作项

| ID | 任务 | 验收 |
|---|---|---|
| S3-1 | 按 docs/08 §8 的 port 定义接口（`ProductKnowledgePort` / `DemoExecutionPort` / `EvidenceVerificationPort`） | `mock-services` 成为其中一个实现，Store 只依赖接口 |
| S3-2 | `apps/api` 最小实现：只有 `GET/PUT /v1/workspaces/:id` + 生产运行状态 | 两个浏览器实例看到同一工作区 |
| S3-3 | 存储选型：**先 SQLite 或单表 JSONB**，不上对象存储 | 有 ADR 决议记录（实际为 [ADR-008](adr/ADR-008-sqlite-workspace-storage.md)；ADR-003 保留给对象存储） |
| S3-4 | 迁移链落地（与 S1-6 合并） | 真实迁移用例：v1 → v2 不丢数据 |
| S3-5 | 工作区整体导入 / 导出（不只单条视频工程 JSON） | 导出后可导入到全新浏览器 |

### Exit Gate

```text
Store 里不再出现对 mock-services 具体函数的直接调用（只有接口）
schema 变更一次，已有数据仍在
工作区可导出、可导入、可跨设备恢复
```

### 风险

| 风险 | 信号 | 应对 |
|---|---|---|
| 过早抽象 | 接口数量膨胀，实现只有 mock 一个 | 只抽已经确定要换的（知识、录屏、渲染）；AI / TTS 等延后 |
| 后端拖慢前端 | Step 1/2 被阻塞 | S3 与 S2 并行，且 S3-1 的接口改动**不**触碰页面 |

### 执行状态（2026-11-27）

| ID | 状态 | 证据 |
|---|---|---|
| S3-1 | ✅ 完成 | 新增 `libs/ports`：`ProductKnowledgePort` / `DemoExecutionPort` / `EvidenceVerificationPort`，并把现有服务层拆成 `OnboardingPort` / `DirectorPort` / `MediaExportPort` / `StudioClock` / `WorkspaceRepository` / `ProductionRunRepository`。`mock-services` 通过 `mockStudioServices` 实现 `StudioServices`；`studio-store` 与 `ui-store` 只经 `getStudioServices()` 访问，不再直接调用具体 mock 函数。端口范围比 docs/08 §8 的三个更大，是因为 Store 实际调用了知识、录屏、导演、导出、时钟等多类能力；不抽象这些就无法满足 Exit Gate。 |
| S3-2 | ✅ 完成 | `apps/api`（Fastify 5）：`GET/PUT /v1/workspaces/:id`、`GET /v1/workspaces/:id/export`、`GET /v1/workspaces/:id/production-runs` 与 `/:runId`。Web 端 `workspace-sync` 控制器动态加载，设置页可选启用；Playwright `workspace-sync.spec.ts` 用两个独立 browser context 验证同一工作区：A 改名 → 服务器落库 → B 打开即读到。⚠️ 生产运行仍由页面推进，API 只保存/返回状态；本轮没有把运行调度搬到服务端。 |
| S3-3 | ✅ 完成 | [ADR-001](adr/ADR-001-api-framework-fastify.md)（Fastify）与 [ADR-008](adr/ADR-008-sqlite-workspace-storage.md)（SQLite）。docs/10 原文的「ADR-003」与 docs/03 已预留给对象存储的编号冲突，因此 SQLite 记为 ADR-008。 |
| S3-4 | ✅ 完成 | `libs/domain/src/workspace.ts` 统一 `STUDIO_SNAPSHOT_VERSION = 2` 与 `migrateStudioSnapshot`，浏览器持久化、API 读取、导入导出共用同一条链；SQLite 用 `PRAGMA user_version` 执行 v1→v2 迁移。测试：v1 裸快照 / Zustand `{state,version}` 备份补齐 `fps/revision/durationFrames/visual`，未来版本拒绝，损坏 JSON 拒绝；`apps/api/src/db/database.test.ts` 证明 v1 运行记录迁移后仍在。 |
| S3-5 | ✅ 完成 | 设置页「工作区备份」导出完整 `asvs.workspace` 信封（13 个数组，不含媒体与 UI 偏好），并可导入到全新浏览器；Playwright `workspace-sync.spec.ts` 的真实下载 + 新 context 导入验证恢复。同步开启时导入后会作为本地修改自动上传。 |

**Exit Gate 核对**

| Gate | 状态 | 证据 |
|---|---|---|
| Store 里不再直接调用 mock-services 具体函数 | ✅ | `libs/state/src/studio-store.ts`、`ui-store.ts` 经 `services()` / `StudioClock`；`services.ts` 是唯一的默认 mock 注入点 |
| schema 变更一次，已有数据仍在 | ✅ | `workspace.test.ts`（v1→v2、Zustand 备份、损坏拒绝）+ `database.test.ts`（v1→v2 数据库迁移）+ `app.test.ts`（读取时升级并写回） |
| 工作区可导出、可导入、可跨设备恢复 | ✅ | 设置页导出 / 导入；E2E 在新 context 导入后刷新仍保留；API 双 context 同步 |
| 两个浏览器实例看到同一工作区 | ✅ | `apps/web-studio/e2e/workspace-sync.spec.ts`：两个独立 browser context，A 改名后 B 读取到同一名称 |

**验证记录**

- `pnpm exec nx run-many -t lint typecheck test --skip-nx-cache`：15 个项目通过。
- `pnpm exec vitest run`：21 个测试文件 / 151 个测试通过（含 API 12 + 数据库迁移 1）。
- `pnpm test:e2e`：34 个测试通过（新增 2 个工作区同步 / 备份用例）。
- `pnpm build`：初始 221.5 kB gzip（预算 230 kB），工作区同步控制器单独成 chunk（6.68 kB raw）。
- 未验证：CI 仍未在真实远端跑过；`node:sqlite` 在 CI Node 22 的实际运行只由本地 Node 26 与文档版本推断。

**Step 3 边界**

- 没有登录、鉴权或多租户隔离；API 默认只监听 `127.0.0.1`，CORS 只允许本地 4200。
- 单写入者 SQLite；多实例部署前必须换 PostgreSQL 或增加串行化层。
- 媒体二进制不进入工作区备份；跨设备恢复后 `Asset.media` 路径可能失效，UI 已明确提示。
- 服务端不校验生产运行状态迁移，也不推进运行；`docs/05` §27 的「状态迁移只能由应用服务修改」尚未在 API 落地。
- Zod 默认剥离未知字段；未来客户端新增字段若未升级 schema，保存时会被丢弃。

> 更新（2026-11-27）：上述第 4 条缺口已由 Step 5A 关闭——运行状态迁移与推进已迁到服务端 SQLite 队列与独立 worker 子进程，见 §7A / [docs/13](13-ORCHESTRATION-SLICE.md)。

---

## 7A. Step 5A · 服务端编排底座与崩溃恢复（WP-03 / AC-06）

**目标**：生产运行从「浏览器定时器」搬到「服务端持久化任务队列」，崩溃可恢复，且审核页能下载真实 MP4。

### 工作项

| ID | 任务 | 验收 |
|---|---|---|
| S5A-1 | SQLite v5：`orchestration_runs / _jobs / _checkpoints / _artifacts / _events`（不复用 `production_runs`） | 迁移测试通过；旧表不受影响 |
| S5A-2 | `libs/domain/src/orchestration.ts` 纯状态机契约 + `libs/ports` 服务/执行器端口 | 非法迁移在类型层与运行时都拒绝 |
| S5A-3 | `Orchestrator`：`BEGIN IMMEDIATE` 租约、attempt 自增、checkpoint、终态保护 | 单测覆盖幂等、崩溃重试、耗尽、取消、声明阻断 |
| S5A-4 | `RenderProcessExecutor`：`spawn(process.execPath, ['--import', tsxUrl, worker, …], {shell:false})` + JSONL | `apps/api` 不 import `workers/render-worker`（边界守卫） |
| S5A-5 | HTTP 路由：创建/列表/详情/取消/重试/批准/下载 + `latest-video-artifact` | 409 非法迁移、404、ETag=sha256、路径穿越拒绝 |
| S5A-6 | Web：生产页服务端面板 + 审核页真实产物面板，动态加载适配器 | 首屏预算不劣化；未连接时诚实降级，模拟 DAG 不变 |
| S5A-7 | `pnpm orchestration:verify`：真实 SIGKILL + API 重启 + ffprobe + SHA256 | 23 项断言全过 |

### Exit Gate

```text
关闭页面 / 刷新后运行继续（状态在 SQLite，不在浏览器）
真实 worker 被 SIGKILL 后，新 API 进程按 checkpoint 续跑并产出 MP4
连续崩溃到 maxAttempts → failed / worker_crash_exhausted
非 16:9 与声明阻断在启动 worker 之前被拒绝
审核页可下载经 SHA256 校验的真实 MP4，且明确标注「无音轨」
```

### 执行状态（2026-11-27）

| ID | 状态 | 证据 |
|---|---|---|
| S5A-1 | ✅ | `apps/api/src/db/database.ts` v5 + `database-v5.test.ts`（5 用例） |
| S5A-2 | ✅ | `libs/domain/src/orchestration.ts`（状态机、`ORCHESTRATION_STEPS`、`renderJobInputV1Schema`、worker 事件协议）+ `libs/ports/src/orchestration.ts` |
| S5A-3 | ✅ | `apps/api/src/orchestration/orchestrator.ts` + `orchestrator.test.ts`（15 用例） |
| S5A-4 | ✅ | `apps/api/src/orchestration/render-process-executor.ts`；`--import` 使用 `file://` URL（Windows 裸路径会被当作 `d:` 协议，实测修复） |
| S5A-5 | ✅ | `apps/api/src/routes/orchestration.ts` + `orchestration.test.ts`（8 用例） |
| S5A-6 | ✅ | `libs/features/production-suite/src/server-orchestration{,-panel}.tsx`、`review-artifact-panel.tsx`；`libs/state/src/orchestration.ts` 动态 `import('@asvs/adapters-http')` |
| S5A-7 | ✅ | `apps/api/src/scripts/verify-orchestration.ts`：23/23 通过，产出 1920×1080 · h264 · 30fps · 6000ms · 无音轨 MP4（264,088 bytes），SHA256 `ad5c52e4…c89c0722` |

**验证记录**：`pnpm lint:boundary-check` 4/4；`nx run-many -t lint typecheck test --skip-nx-cache` 15 项目 / 352 测试全绿；`pnpm test:e2e` 42/42（新增 4 条）；`pnpm build` 初始 227.2 kB gzip（预算 230），Production 19.2 / Review 15.0 kB；`pnpm render:fixture && pnpm verify:render` 复现 docs/11 的 SHA256。详见 [docs/13](13-ORCHESTRATION-SLICE.md) §1 / §7。

**Step 5A 边界**：不做 TTS / 配音 / SRT；不接服务端驱动的 Playwright；未实现隐私 QA、LLM AI Director、局部重渲染；无 Redis / BullMQ / PostgreSQL / 对象存储；无批准不自动发布。

---

## 7B. Step 5B · 配音、SRT 与 Gate 3 交付包（WP-03 / AC-10）

**目标**：把 5A 的静音 MP4 变成**可交付的成片包**——真实旁白音轨、与冻结帧时间轴一致的服务端 SRT、以及绑定 Gate 3 的 MP4 + SRT + manifest 下载与 SHA256 回执。

### 工作项

| ID | 任务 | 验收 |
|---|---|---|
| S5B-1 | `SpeechPort` 抽象 + OpenAI 兼容适配器 + 离线确定性测试适配器 | 401 不重试且不泄露密钥；429/5xx 有限重试；未配置时 fail-closed |
| S5B-2 | `SpeechService`：provider 输出统一归一化为 WAV `pcm_s16le` 48 kHz，内容寻址缓存（`provider/model/voice/language/speed/text`） | 相同输入重跑 **0 次 provider 调用**；篡改/缺失的缓存文件被驱逐重生 |
| S5B-3 | 编排器新增 `synthesize_voice` / `generate_subtitles`（5 步 → 7 步） | 旁白关闭时创建即标 skipped；未配置 TTS 时创建运行 503，绝不静默降级 |
| S5B-4 | 时长策略：`extend_scene`（延长溢出镜头，不截断、不跨镜头）/ `fail_on_overflow` | 溢出镜头被延长，其余镜头帧数不变；不一致时有结构化错误 |
| S5B-5 | 服务端 SRT 生成 + 独立解析器校验 | 序号连续、单调、无重叠、不超视频总长；非法 SRT 阻断运行与导出 |
| S5B-6 | 渲染 worker：`prepareAudioDir` 复验 WAV、`<Audio staticFile>`、AAC 编码、ffprobe + volumedetect | 音轨非静音且音画时长一致；静音 fixture 零回归 |
| S5B-7 | SQLite v6：`speech_cache` + `export_bundles` | 只新增表，旧数据保留 |
| S5B-8 | Gate 3 导出：未审批 / 脚本变更 / 产物篡改 / 缺产物 → 409；导出包绑定三个哈希与 `scriptVersion` | 四类 409 均有测试 |
| S5B-9 | Web：生产页旁白面板、审核页 Gate 3 交付面板（逐文件 SHA256 校验后下载）、合成音色诚实标注 | 首屏与路由预算不劣化；浏览器内导出明确标为草稿 |
| S5B-10 | `pnpm export:verify` 验收脚本 + `audio-export-real-flow.spec.ts` E2E | 20 项断言全过；E2E 覆盖 409 / 交付包下载 |

### Exit Gate

```text
服务端 MP4 含真实旁白音轨（H.264 + AAC），ffprobe 音画时长一致且非静音
同一输入重跑不重复调用 TTS（内容寻址缓存 0 次 provider 调用）
旁白溢出只延长对应镜头，绝不截断、绝不跨镜头；SRT 不超视频总长
SRT 经独立解析器校验（单调、无重叠、序号连续）；非法 SRT 绝不放行导出
Gate 3 未通过 / 脚本版本变化 / 产物被篡改时导出返回 409
审核页可下载 MP4 + SRT + manifest，下载前校验 SHA256
离线测试音轨全程标注「测试合成音轨 · 非真人配音」，绝不伪装商用配音
```

### 执行状态（2026-11-27）

| ID | 状态 | 证据 |
|---|---|---|
| S5B-1 | ✅ | `libs/ports/src/speech.ts`、`apps/api/src/speech/openai-compatible-adapter.ts`（+11 用例）、`deterministic-test-adapter.ts` |
| S5B-2 | ✅ | `apps/api/src/speech/speech-service.ts` + `normalize-audio.ts` + `speech-cache-store.ts`（14 用例） |
| S5B-3 | ✅ | `apps/api/src/orchestration/orchestrator.ts`：`synthesizeVoice` / `generateSubtitles`，`ORCHESTRATION_STEPS` 7 步 |
| S5B-4 | ✅ | `libs/domain/src/narration.ts`：`reconcileStoryboardWithNarration` / `NarrationOverflowError` |
| S5B-5 | ✅ | `libs/domain/src/srt.ts`（生成 + `parseAndValidateSrt` 独立解析器）、`format.ts` 毫秒进位修复 |
| S5B-6 | ✅ | `workers/render-worker/src/media.ts` `prepareAudioDir`、`libs/render/src/storyboard-composition.tsx` `<Audio>`、`ffprobe.ts` 音频探测 |
| S5B-7 | ✅ | `apps/api/src/db/database.ts` v6 + `database-v6.test.ts`（5 用例）、`export-bundle-store.ts` |
| S5B-8 | ✅ | `orchestrator-narration.test.ts`：未审批 → `export_not_approved`、脚本变更 → `export_stale`、篡改 → `export_hash_mismatch` |
| S5B-9 | ✅ | `server-orchestration-panel.tsx` 旁白面板、`review-artifact-panel.tsx` Gate 3 交付面板、`downloadVerifiedArtifact` |
| S5B-10 | ✅ | `pnpm export:verify` 20/20；`audio-export-real-flow.spec.ts` 3 条 |

**验证记录**：`nx run-many -t lint typecheck test --skip-nx-cache` 15 项目 / 50 文件 / 434 用例全绿；`pnpm export:verify` 20/20（MP4 36,480 ms · h264+aac · −21.1 dB · SRT 9 条；二次运行 `providerCalls=0`）；`pnpm render:fixture` 静音黄金样片 SHA256 仍为 `b1451bfb…26ccd8a`；`pnpm build && pnpm budget` 初始 228 kB / Production 21.2 kB / Review 17.1 kB gzip，全部达标；`pnpm test:e2e` 45/45 通过。详见 [docs/14](14-AUDIO-EXPORT-SLICE.md) §7。

**Step 5B 边界**：不做 BGM / ducking；不做多语言、多画幅；不做词级卡拉 OK 字幕；不做单镜头局部重渲染；不做服务端驱动 Playwright / 隐私 QA / LLM Director；导出包仍在本地 `data/artifacts`，无对象存储 / CDN / 签名 URL。

---

## 8. Step 4 · 真实知识源（3–4 周，对应 WP-10 / WP-11）

**目标**：把 README 里「GitHub OAuth / API / 仓库读取是本地确定性模拟」换成真实只读连接。

### 工作项

| ID | 任务 | 验收 |
|---|---|---|
| S4-1 | GitHub App 安装授权（只读 PR / Release / 文件） | 能列 PR；不能写仓库（docs/02 AC-01） |
| S4-2 | 增量索引：git + ripgrep + AST，产出 `KnowledgeSnapshot` + `sourceDigests` | 冷/热扫描基准已记录 |
| S4-3 | PR → 用户可感知变更候选（docs/02 Flow A） | 纯重构 PR 不产出新功能候选（AC-02） |
| S4-4 | 证据板结：Claim 绑定 `VerificationContext`（commitSha / environment / verifiedAt） | 已合并未部署标记「待验证」（AC-03） |
| S4-5 | **先做用户验证**：5–8 位目标用户可用性测试 | 结论决定继续投索引还是投录屏 |

### 执行状态（2026-11-27）

| 切片 | 状态 | 证据 |
|---|---|---|
| 4A · 只读 GitHub App | ✅ 完成 | `GitHubAppReadOnlyClient` 严格 `GET`，写权限 fail-closed，`redactSecrets` 脱敏；`pnpm github:verify` 对 `frontLikeDog/livenotes` 实测通过。 |
| 4B · 增量索引与快照 | ✅ 完成 | `KnowledgeSnapshotV1` + `KnowledgeIndexPort`；GitHub tree/commit 只读读取；SHA256 `sourceDigests` 与按 blob sha 复用的增量扫描。**真实基准**（`frontLikeDog/livenotes` @ `78bb6a68`，322 个可索引文件）：冷扫描 37.9 s / 下载 357 个 blob → 同提交热扫描 1.7 s / **0 次下载** / 复用 322；`sourceDigests` 完全一致，约 21× 加速。SQLite `user_version` v2→v3 保留工作区与 `production_runs`。 |
| 4C · PR 变更候选 | ✅ 完成（2026-11-27） | `PRDiscoveryPort` + 确定性分类器（无 LLM）；AC-02 / AC-03 / AC-09 均有纯函数守门与测试；SQLite v3→v4；`pnpm discovery:verify` 对 `frontLikeDog/livenotes` @ `96f90e90` 实测 3 个真实 PR：2 个 `feat` → 2 条 Claim 全部 `blocked_unverified`（阻止「已上线」），1 个 `refactor` → `internal_non_promotable` 且 0 Claim（真实验证 AC-02）。 |
| 4D · Web UI | ✅ 完成（2026-11-27） | `GitHubKnowledgeClientPort` / `HttpGitHubKnowledgeClient` + 纯投影层 `knowledge-projection.ts` + 惰性加载 `github-knowledge-actions.ts`；打通 Onboarding & 设置页双入口只读 GitHub 接入与 AC-01 写保护探针、知识中心「PR 变更发现」页签与显式推广、AC-03 核验录入与 append-only 审计、视频向导与审核页按 `Claim.eligibility` 硬守门、AC-09 过期传播及 Scene `review` / 视频 `changes_requested` 自动失效；Playwright `knowledge-real-flow.spec.ts` + `a11y.spec.ts`（38/38 通过）、`capture:demo` + `verify:capture`（11/11 通过）、`pnpm build` 初始包 `226 kB` gzip（预算 `230 kB`）。 |

**4B 边界（已实现 vs 未实现）**

- 已实现：`POST /v1/github/repos/:owner/:repo/index`（`branch` / `forceCold`）、`GET …/snapshots`、`GET …/snapshots/:snapshotId`；快照只追加、不覆写。
- 已实现：Python / TypeScript / JavaScript / Markdown 的轻量结构信号（章节、`def`/`class`/路由装饰器、导出符号、入口点）；其他文本文件仍记录 digest、大小与行数。
- 未实现：AST 级解析、跨文件引用图、ripgrep/本地 git 克隆；当前完全走 GitHub 只读 API，因此冷扫描耗时主要是网络（357 次取文件）。若要压冷扫描成本，下一步是单次 tarball/`git archive` 下载，而不是 Rust 化。
- 未实现：增量复用只认 **完全相同的 blob sha**；文件重命名会被当作「删除 + 新增」。4C 的分类器已能在 PR 文件层面识别纯重命名并判为内部变更，但索引层仍未跨重命名复用提取结果。
- 未实现：Web 端调用这些接口（4D）；`libs/state` 仍走 mock 知识服务。

**4C 边界（已实现 vs 未实现）**

- 已实现：`libs/domain/src/pr-discovery.ts` 的 `PRChangeCandidateV1` / `ClaimCandidateV1` / `VerificationContextV1` / `EvidenceRefV1`，以及两条纯守门函数：`evaluateClaimPublishability`（发布资格）与 `propagateSnapshotStaleness`（AC-09 传播）。
- 已实现：`libs/ports/src/pr-discovery.ts` 的 `PRDiscoveryPort`（analyze / list / get / recordVerification / listVerifications / refreshStaleness）。
- 已实现路由：`POST /v1/github/repos/:owner/:repo/discover`（未配置 GitHub → 503；成功 → 201）、`GET …/candidates`、`GET …/candidates/:candidateId`、`POST …/claims/:claimId/verify`、`GET …/claims/:claimId/verifications`、`POST …/candidates/refresh-staleness`（无快照 → 404）。
- 已实现：确定性规则只使用 Conventional 前缀、标签、文件路径分类（界面 / 源码 / 测试 / CI / 构建 / 配置 / 文档）、纯重命名识别、4B 快照的路由符号 / 入口点 / 文档章节，以及 Release 的两种显式关联（`targetCommitish` 恰为合并提交，或正文显式 `#<PR>`）。
- AC-02：`internal_non_promotable` 与 `ambiguous_needs_review` 一律 `promotable=false` 且 `claims=[]`，由 Zod `superRefine` 硬性约束；夹具覆盖 refactor 前缀、纯重命名、feat 但只改测试、内部标签、自由标题。
- AC-03：初始 Claim 只有源码证据时固定 `deployed=false` / `blocked_unverified`；随后按证据逐级放行——只有发布证据 → `needs_qualification`（只能表述「随 Release 发布」）；非生产运行态 → `needs_qualification`（必须标注环境）；生产运行态但缺人工批准 → `blocked_unverified`；生产运行态 + 人工批准 → `publishable`。人工驳回 → `blocked_rejected`，最新人工决定生效。
- AC-09：全量扫描仓库候选（不受列表 100 条分页上限影响），只对绑定了 `filePath + sourceDigest` 的源码证据做比对；最新快照中文件被修改或删除即标 `stale`，同时把 Claim 置为 `stale` / `blocked_stale`。未绑定指纹的证据不会被误判。
- 持久化：SQLite `user_version` v3→v4，新增 `pr_change_candidates`（每 repo+PR 一行，重新分析为 upsert）与 `claim_verifications`（append-only 审计，与候选更新在同一事务内提交）；既有 workspaces / production_runs / knowledge_snapshots 原样保留。
- 已实现：`pnpm discovery:verify [--repo owner/name] [--branch main] [--limit N] [--no-index]`，对真实仓库索引 → 发现 → 过期传播，并打印真实样本形态覆盖率。
- 未实现（有意）：外部 LLM / 语义理解；PR 正文/评论解析；`/commits/:sha/pulls` 关联（端口未暴露）；自动把候选写入 `libs/state` 工作区（4D）；自动批准或自动发布。
- 未实现：候选重新分析时，只有 Claim 文案、提交与源码文件指纹均未变化且原状态未过期才会保留此前录入的 test / runtime / release / human 证据；文案、提交或任一源码指纹变化会丢弃旧批准（批准绑定具体文本与代码快照，完整历史留在 `claim_verifications`）。
- 已知限制：`deployed=true` 只代表存在 Release 或真实环境运行态证据，不等于「生产可用」；「已上线」表述仍要求 `environmentId=production` 与人工批准同时成立。
- 测试：`pnpm exec vitest run apps/api libs/domain` 21 个文件 / 198 个用例通过，覆盖 AC-02 / AC-03 / AC-09（含重发现防绕过、>100 候选全量过期、跨时区时间排序、未来时间拒绝、50 条证据上限保活、事务回滚）、v3→v4 迁移保留数据、路由 503/400/404/201/200 与 SQLite 往返。

**4D 边界（已实现 vs 未实现）**

- 已实现（端口与适配器）：`libs/ports/src/github-knowledge-client.ts`（`GitHubKnowledgeClientPort`，12 个只读/索引/发现/核验/过期方法）；`libs/adapters-http/src/http-github-knowledge-client.ts`（`HttpGitHubKnowledgeClient`，默认 15s / 长操作 180s 超时，响应全量 Zod 校验，`KnowledgeHttpError` 状态码映射）。
- 已实现（领域投影与守门）：`libs/domain/src/knowledge-projection.ts` 的确定性投影函数（`promoteCandidateToKnowledge` 对非可推广候选执行 AC-02 硬阻断；`reconcileCandidatesIntoSnapshot` 幂等同步且在 AC-09 源码变化时同步标旧 Workspace Feature / Claim / Evidence、引用 Scene 标为 `review`、已批准视频退回 `changes_requested`）；`libs/mock-services/src/review-service.ts` 与 `director-service.ts` 改为优先依据 `Claim.eligibility` 硬守门，封堵 `production_runtime_pending_approval` 等未核验路径通过限定词绕过审核的缺口。
- 已实现（状态隔离与包预算）：`libs/state/src/github-knowledge.ts` 经动态 `import('@asvs/adapters-http')` 懒加载 HTTP 客户端；`libs/state/src/github-knowledge-actions.ts` 独立于 `studio-store.ts`，避免把 `knowledge-projection` 拉入初始 JS chunk，使 `initial` 保持 `226 kB` gzip（预算 `230 kB`）。
- 已实现（Web UI 双入口与端到端闭环）：Onboarding 新增可选真实只读 GitHub 接入模式（仍保留 AC-08 无源码仅文档路径）；Settings → 来源与同步支持绑定/切换真实仓库、AC-01 写保护探针、4B 快照历史、冷/热增量索引、PR 发现与 AC-09 过期刷新；知识中心新增「PR 变更发现」页签，显式推广候选至功能目录，支持按证据类型录入 `test`/`runtime`/`release`/`human` 核验与查看 append-only 审计记录；视频向导与审核页展示 `ClaimEligibilityBadge` 与真实 `commitSha`/`environmentId`/`releaseTag`。
- 已实现（E2E 与真仓验证）：`apps/api/src/scripts/e2e-fixture-api.ts`（仅测试进程在 `127.0.0.1` 临时端口运行，不改动 `apps/api` 生产源码）驱动 `knowledge-real-flow.spec.ts`（503 降级、AC-08 无源码入门、AC-01/02/03/09 全链路闭环）；`a11y.spec.ts` 补齐 `?tab=discovery` axe 扫描；`pnpm github:verify` 与 `pnpm discovery:verify` 对 `frontLikeDog/livenotes` `@ 4ac866aac799` 实测通过（AC-01 HTTP 403；4 条 PR 中 3 个 `feat` 全部 `blocked_unverified`、1 个 `refactor` 判为 `internal_non_promotable`）。
- 未实现（有意与既有边界）：Web UI 内生产监控、浏览器录屏调度、MP4 导出与 AI 导演仍为确定性本地模拟（不接外部 LLM / TTS / Web 端 Remotion 渲染队列）；内置演示项目（`proj_lumen`、`proj_pulse`，`demo: true`）保持本地 mock 同步；未运行或未配置 GitHub 凭证的 `apps/api` 严格返回 503 降级提示；仍无登录、多租户隔离与自动批准/自动发布；`S4-5`（5–8 位目标用户可用性测试）尚待开展。
- 本阶段整体验证结果（2026-11-27）：`pnpm lint:boundary-check` 通过（0 违规，4 条反向探针全拒）；`pnpm exec nx run-many -t lint typecheck test --skip-nx-cache` 15 个项目全绿（Vitest **37 个文件 / 286 个用例**通过）；`pnpm build` 全部 bundle budget 达标；`pnpm test:e2e` **38/38 通过**；`pnpm capture:demo` + `pnpm verify:capture` **11/11 通过**。

### 为什么最后做

docs/01 §10 列着一条尚未回答的问题：

> 仅 UI 接入的用户能接受怎样的功能发现准确率？

以及 docs/ux §10 推荐后续第 1 条：**先与 5–8 位目标用户做可用性测试**。
如果答案偏向「用户主要想要持续更新视频」而非「自动发现功能」，那么投在索引上的 3–4 周应改为投在录屏稳定性与模板质量上。**S4-5 应该在 S4-1 之前完成。**

### 风险

| 风险 | 信号 | 应对 |
|---|---|---|
| 功能发现准确率不足 | 用户频繁驳回候选 | 保留「仅 UI 接入」路径（docs/02 US-01 / AC-08） |
| 索引性能不足 | 大数据同步超时 | 先 Node + git/rg 测基准，**不**提前 Rust 化（docs/03 §3） |
| 权限过宽 | 申请了写权限 | 只读安装；审计记录权限范围（docs/08 §2） |

---

## 9. 明确不做（本阶段）

| 事项 | 原因 | 何时重新评估 |
|---|---|---|
| 继续压缩初始 bundle | 214.8 / 230 gzip，余量充足；下沉 mock-services 与 Step 3 接口抽象方向冲突 | Step 3 完成后，作为自然结果 |
| Rust 化索引 | docs/03 §3 / docs/09 §9：无基准不迁移 | S4-2 出现明确性能瓶颈后 |
| 多轨时间线 / 完整 NLE | docs/ux §10：按真实使用频率决定，不按竞品清单扩张 | 有真实编辑需求数据后 |
| 自动发布 / CDN | docs/02 §5：第一版不内置自动发布，需要明确安全模型 | Step 3/4 之后，且有租户与审计 |
| 桌面应用录制 | docs/01 §9：前期 Web SaaS 优先 | P4 |
| ATVG2 深度集成 | docs/08 §7：Standalone 模式必须先行 | P4 |
| 移动端侧栏 `inert` / 焦点回收 | 是 README §8 的真实缺口，但不阻塞任何一条假设 | 可与任意阶段并行的小修（0.5 天） |

---

## 10. 如果只有两周

只做 **Step 0 全量 + Step 1 的 S1-1 / S1-2 / S1-7**（IR 升级 + Remotion Composition + 固定 fixture 出第一个 MP4）。

理由：

- Step 0 是工程底线，成本 1–2 天，无风险；
- H1 是整个产品唯一还没有任何证据支撑的核心假设。一旦证明 Storyboard → MP4 走得通，
  后续所有排期才有意义；如果走不通（schema 需要大改、Remotion 方案要换），**越早发现越好**；
- 这两项都不依赖真实环境、不依赖外部授权、不依赖后端，是最纯粹的「先降低不确定性」。

---

## 11. 里程碑与检查点

| 检查点 | 时间 | 判定 | 不通过时 |
|---|---|---|---|
| M0 CI 绿 | 第 1 周末 | Step 0 Exit Gate | 不进入 Step 1 |
| M1 首个 MP4 | 第 3 周末 | Step 1 Exit Gate | 重估技术选型（Remotion → 纯 FFmpeg） |
| M2 录屏通过率 | 第 5 周末 | Step 2 Exit Gate | 退回 fixture app 方案，不接外部环境 |
| M3 数据可迁移 | 第 5 周末（并行） | Step 3 Exit Gate | 延后后端，先保 IR 稳定 |
| M4 用户验证 | 第 5–6 周 | S4-5 完成 | **暂停 Step 4**，按结论重新分配 |

每个检查点按 docs/09 §11 的评审模板出记录，不得把计划描述为完成。

---

## 12. 指标（本阶段应建立基线）

docs/01 §7 的北极星指标需要真实后端才能度量；本阶段先建立**可测量的技术基线**：

| 指标 | 采集点 | 目标方向 |
|---|---|---|
| 渲染成功率 / 平均渲染耗时 | S1-4 | 成功率 ≥ 95%，耗时建立基线 |
| 录屏断言通过率 | S2-4 | ≥ 80%（fixture 环境） |
| 录屏单次耗时 / 失败原因分布 | S2-3 | 建立基线 |
| Schema 迁移成功率 | S1-6 / S3-4 | 100%，零数据丢失 |
| CI 平均时长 | S0-2 | 建立基线 |
| 初始 JS gzip | 已有 | **不再劣化**（守住 230 kB 预算） |

---

## 13. 待决问题（需要产品负责人决定）

1. **第一条样片选题**：docs/09 §8 建议选「已部署到可重置 staging、可通过 UI 复现」的功能。是继续用 `web-studio` 自身作为 fixture，还是接一个真实 staging？
2. **S4-5 用户验证的时机**：是在 Step 1 完成后立刻做（用视频效果去访谈），还是等 Step 2 有真实录屏后再做？
3. ~~**Step 3 的存储选型**：SQLite（本地优先）vs 单表 Postgres JSONB（云优先）。~~ 已决定 SQLite（[ADR-008](adr/ADR-008-sqlite-workspace-storage.md)）；API 框架已决定 Fastify（[ADR-001](adr/ADR-001-api-framework-fastify.md)）。
4. **IR 破坏性变更策略**：`sceneSchema` 改为判别联合时，是否接受「清空已有演示数据」？（当前 `persist` 行为就是清空；若要保留，S1-6 必须先于 S1-1 完成。）
5. **是否接受 AI Director 仍是确定性规则**：Step 1–4 都不包含真实 LLM 接入。若产品演示需要真实 AI，需单独排期。

---

## 14. 关联文档

- [产品愿景与策略](01-PRODUCT-VISION-AND-STRATEGY.md)：北极星指标、四个产品模式
- [产品需求 PRD](02-PRODUCT-REQUIREMENTS-PRD.md)：AC-01 ~ AC-10 验收用例
- [系统架构与技术栈](03-SYSTEM-ARCHITECTURE-AND-TECH-STACK.md)：模块化单体、队列、可靠性设计
- [Nx Monorepo 工程规范](04-NX-MONOREPO-ENGINEERING-STANDARDS.md)：CI 门槛（§7）、测试分层（§8）
- [领域模型与契约](05-DOMAIN-DATA-MODEL-AND-CONTRACTS.md)：`StoryboardV1` / `VideoSceneV1` / `JobEnvelopeV1`
- [Agent 工作流](06-AGENT-WORKFLOWS-AND-ORCHESTRATION.md)：三个审批 Gate、可恢复执行
- [录屏、渲染与编辑器](07-VIDEO-CAPTURE-RENDER-AND-EDITOR.md)：DemoPlan、Remotion 合成、质量门禁
- [安全、证据与 ATVG2](08-SECURITY-EVIDENCE-AND-ATVG2-INTEGRATION.md)：端口定义（§8）、安全验收用例（§9）
- [实施路线与验收](09-IMPLEMENTATION-ROADMAP-AND-ACCEPTANCE.md)：WP-00 ~ WP-17、评审模板
- [真实渲染切片](11-RENDER-SLICE.md) / [真实录屏切片](12-CAPTURE-SLICE.md) / [服务端编排切片](13-ORCHESTRATION-SLICE.md) / [配音与交付包切片](14-AUDIO-EXPORT-SLICE.md)：已执行的验收记录

---

**一句话总结**：前端已经不再承压；下一阶段的全部价值在于用最小成本证明「Storyboard 能变成真视频」和「Playwright 能稳定录到真画面」，其余能力都可以在这两条之后按证据决定投入。
