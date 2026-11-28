# 15 · Demo Planner 与 Gate 2 真实录屏切片（Step 5C 验收记录）

> 状态：**已执行**｜日期：2026-11-28｜分支：`claude/demo-planner-gate2-capture-2f705e`（基线 `main` @ `44e9c4a`）
> 对应计划：docs/09 WP-14、docs/06 §5（可恢复执行 / 审批 Gate）、docs/08 §3 + §9（SSRF 防护、审批安全用例）、docs/07 §7（DemoPlan）
> 结论先说：`real_demo` 镜头不再只能用 5A 的占位素材。`plan_demo` 用**规则模板**（无 LLM）从 4D 已核验的 Feature / Claim 生成确定性的 `DemoPlanDraftV1`，运行停在 Gate 2；审批把 `runId + approvalId + approvedPlanDigest + policyVersion` 写进 SQLite 并跨进程存活。批准后**隔离子进程**拉起 `workers/browser-worker`，只有全部 UI 断言通过才把真实片段（`mock: false` + SHA256 + `CaptureReceiptV1`）回填进冻结渲染输入，再由 5B 的旁白 / SRT / Remotion 产出「真实录屏 + 真实旁白 + 同步字幕」的成片。录屏失败**绝不伪造回执**：`failure-report.json`、失败 PNG 与 `trace.zip` 作为可下载产物进入 Web 证据面板。

---

## 1. 结论与证据

`pnpm gate2:verify`（`apps/api/src/scripts/verify-capture-orchestration.ts`）不 mock 录屏与渲染：它建临时 SQLite 与工作区，用真实 `CaptureProcessExecutor` 拉起真实 Chromium 录屏 18 秒，再用真实 `RenderProcessExecutor` 跑 Remotion，然后逐项校验磁盘字节。

| 项 | 结果 |
|---|---|
| DAG | 9 步：`freeze_input → verify_claims → plan_demo → capture_demo → prepare_media → synthesize_voice → generate_subtitles → render_video → register_artifacts` |
| Gate 2 挂起 | `plan_demo` 完成、`capture_demo` 仍为 `pending`；磁盘上**没有任何录屏文件** |
| 审批绑定 | 缺 `subjectDigest` → **409 `approval_subject_missing`**；摘要过期 → **409 `approval_subject_mismatch`**，运行仍停在 Gate 2 |
| 重启存活 | API 进程重启后仍停在 `awaiting_approval`，`approvalId` 与 `planDigest` 逐字节不变 |
| 第 2 层防篡改 | 审批后修改计划 → **`capture_plan_tampered`**，Chromium **从未启动**，零产物 |
| 第 3 层防篡改 | worker 复算摘要与批准值不一致 → **`capture_plan_tampered`**，零浏览器启动、无回执 |
| 真实录屏 | 3/3 断言通过，`CaptureReceiptV1` 落盘，clip SHA256 `57bdd598ed7f…` |
| 回填 | `asset.media = input.capture = run.capture = 回执 = capture_clip 登记行`，五方一致，`mock: false`，占位素材被替换 |
| 产物 | `capture_clip` · `capture_receipt` · 3 张 `capture_screenshot` 全部可下载 |
| 成片 | 1280×720 · h264 + aac · 13,483 ms · mean **−24.1 dB**（非静音） |
| manifest | 记录真实素材哈希，与录屏回执逐字节一致；合成音轨诚实标注 `internal-deterministic-test-only` / `test-voice-zh` |
| SRT | 2 条，独立校验通过，与成片时长匹配 |
| 下载复验 | 录屏片段下载字节 SHA256 与回执一致 |
| 断言失败 | **`capture_assertion_failed`**，绝不写回执 |
| 失败证据 | `capture_failure_report` + 2 张 `capture_screenshot` + `capture_trace` 全部登记；结构化 `captureFailure`（code / failedStepId / 断言失败数 / 截图 ID）供 Web 面板 |
| 零回归 | `capture.enabled=false` 时 `plan_demo` / `capture_demo` **创建即 skipped**（5A/5B 行为不变） |
| 验收项 | **19/19 断言通过** |
| 耗时 | 74.7 秒（一次真实 Chromium 录屏 + 一次真实 Remotion 渲染 + 全部校验） |

浏览器侧另有 `apps/web-studio/e2e/capture-gate2-real-flow.spec.ts`（4 条，全过），它对着**测试专用 fixture API**（`e2e-fixture-api.ts` 注入确定性的 capture / render 双桩）驱动真实 UI。双桩只替换「驱动 Chromium 约 20 秒」与「跑 Remotion 约 3 分钟」这两段；运行停在 Gate 2、审批携带页面显示的摘要、片段回填、产物逐字节复验、失败留证据——这些服务端保证都是真的。**真实子进程路径由 `pnpm gate2:verify`（CI capture 作业）与 `pnpm capture:demo` 证明。**

产物目录布局（在 5B 基础上新增标注 ◇）：

```text
<artifactDir>/workspaces/<workspaceId>/runs/<runId>/
  demo-plan.json            ◇ Gate 2 草稿（不含 approval 块）
  demo-plan-digest.txt      ◇ 审批绑定的摘要
  capture-request.json      ◇ 原始 capture 选项
  capture-job-input.json    ◇ 交给子进程的任务信封（含 plan + approval）
  capture/
    capture-receipt.json    ◇ 只在全部断言通过时写
    <assetId>.mp4           ◇ 真实片段（已裁剪到 18 s）
    screenshots/*.png       ◇ 每个断言一张
    trace.zip               ◇ Playwright trace
    failure-report.json     ✗ 仅失败时写；同时产出失败截图与 trace
    job-result.json         ◇ 子进程 ASVS_EVENT 结果
  input.json                ◇ capture_demo 回填命中后的溯源块（synthesize_voice 重写时保留）
  narration.json / subtitles.srt / artifacts/*（5B 不变）
```

---

## 2. 数据流

```text
浏览器（生产页 capture 面板）
  └─ POST /v1/workspaces/:ws/orchestration/runs
        { capture: { enabled, template?, baseUrl?, resetStrategy? } }
        │
        ▼
SQLite v7（新增 orchestration_approvals）
  └─ plan_demo：DemoPlannerService.plan()
        规则模板（web_studio_tour / web_studio_knowledge_claim /
                  web_studio_route_focus / custom）
        输入：4D 已核验 Feature / Claim + 项目路由 + 服务端 allowlist
        产出：DemoPlanDraftV1（数据不是脚本）→ planDigest = sha256(stableStringify(plan − approval))
        写 demo-plan.json / demo-plan-digest.txt，登记 pending 审批
        → 运行停在 awaiting_approval，**不启动浏览器**
        │
        ▼  POST …/runs/:id/approve { approvalId, subjectDigest }
  第 1 层：API 重新推导 planDigest，必须同时等于 demoPlan.planDigest 与 ledger.subjectDigest
  （否则 409 approval_subject_missing / approval_subject_mismatch）
  （PUT …/runs/:id/demo-plan 编辑 → 旧审批 superseded + 新 approvalId + 新摘要）
        │
        ▼
  └─ capture_demo：第 2 层复检 DB 审批
        CaptureProcessExecutor → 子进程 workers/browser-worker（绝不静态 import）
        worker 内第 3 层：独立重算摘要 === approval.approvedPlanDigest，否则 capture_plan_tampered
        Playwright：origin allowlist → 每个 selectors 语义 DSL → 每条断言
        │  全部通过 → CaptureReceiptV1 + clip + 截图 + trace
        │  任一失败 → failure-report.json + 失败截图 + trace，**无回执**
        ▼
  backfillCapture：只把通过的片段写进冻结 input.json（mock:false + sha256 + clipDurationMs）
        → prepare_media / synthesize_voice / generate_subtitles / render_video / register_artifacts（5B 链路）
```

### 2.1 DemoPlan 是数据不是脚本

- 7 种声明式动作：`navigate` / `click` / `fill` / `press` / `assert` / `wait` / `capture`。
- selector 只允许语义前缀 `role|heading|label|placeholder|testid|text|alt`；**CSS、XPath、任意脚本在打开浏览器前即被拒绝**。
- 每个模板至少一条 `assert`（schema 层强制），因为「录屏证明卖点」的全部意义在于断言可核验。
- `fixtures` 键名命中 `password|token|secret|credential|authorization|cookie|api[-_]?key` 即拒绝；`accountRef` 只是引用，不是凭证。
- 摘要覆盖 `plan − approval`，所以附加审批块绝不会改变它验的字节——这正是「审批绑定的是计划内容」的含义。

### 2.2 三层防篡改

| 层 | 位置 | 拒绝方式 |
|---|---|---|
| 1 · API | `orchestrator.approveRun` | `approval_subject_missing`（未带摘要）/ `approval_subject_mismatch`（摘要不符）→ 409 |
| 2 · 编排器 | `orchestrator.captureDemo` | 查 DB 审批台账；摘要或 ID 不符 → `capture_plan_tampered`，**不 spawn** |
| 3 · worker | `workers/browser-worker/src/capture-job.ts` | 独立解析 plan 并复算摘要；不等 → `capture_plan_tampered`，**不 launch Chromium** |

### 2.3 SSRF 与 origin allowlist

- 服务端 `ASVS_CAPTURE_ALLOWED_ORIGINS`（默认 `http://localhost:4200`）必须是计划 origin 的超集；不在其中 → 400 `capture_origin_not_allowed`。
- `baseUrl` 只接受 `http(s)`；计划内 `allowedOrigins` 也必须被服务端 allowlist 覆盖，否则 `capture_invalid_plan`。
- worker 运行时另有导航拦截：任何越界请求都记进 `blockedRequests` 并作为失败证据留在 `failure-report.json` 里。

---

## 3. 契约与数据库变更

| 变更 | 位置 | 兼容策略 |
|---|---|---|
| `DemoPlanDraftV1` / `DemoPlanV1` / `DemoStepV1` / `DemoPlanRiskSummaryV1` | `libs/domain/src/capture.ts`（扩展） | 在 5A/Step 2 契约上新增 `demo-planner` 产物；旧 `web-studio-tour.yaml` 断言逐字节未改 |
| `DemoPlanTemplateId` / `DemoPlanDraft` 生成器 | `libs/domain/src/demo-planner.ts`（新） | 纯函数，无网络、无 LLM；同输入逐字节同输出 |
| `computeDemoPlanDigest` / `canonicalDemoPlanJson` / `stableStringify` | `libs/domain/src/canonical.ts`（新）、`capture.ts` | 只依赖 WebCrypto，浏览器 / API / worker 三端同值 |
| `CaptureReceiptV1` / `CaptureFailureV1` / `CaptureJobInputV1` | `libs/domain/src/capture.ts` | 新契约；`mock: false` 是「真实录屏」的唯一标记 |
| `RenderInputV1.capture?` | `libs/domain/src/render.ts` | **可选**：不带 capture 的运行完全不出现该字段 |
| `CreateOrchestrationRunRequest.capture?` | `libs/ports/src/orchestration-client.ts` | **可选**：省略或 `enabled=false` → 两步创建即 `skipped` |
| `ORCHESTRATION_STEPS` 从 7 步扩到 9 步 | `libs/domain/src/orchestration.ts` | `plan_demo` / `capture_demo` 未请求时**创建即标 skipped**，DAG 仍完整 |
| SQLite `user_version` v6 → v7 | `apps/api/src/db/database.ts` | 只新增 `orchestration_approvals` 表与索引；旧数据保留（`database-v7.test.ts`） |
| `orchestrationApprovalStore` | `apps/api/src/db/orchestration-approval-store.ts`（新） | append-only 台账；`createPending` 记录 `supersedes` |

`CaptureJobExecutorPort` / `RenderJobExecutorPort`（`libs/ports/src/orchestration.ts`）是子进程边界：API 只持有端口，真实实现 `CaptureProcessExecutor` 用 `spawn` 拉起 worker 并解析 `ASVS_EVENT` JSONL；测试注入双桩。

---

## 4. 故障与安全矩阵（19 项验收 + 浏览器侧）

`pnpm gate2:verify` 的断言逐条对应计划 §6 的强制场景：

| # | 场景 | 断言 |
|---|---|---|
| 1 | 计划生成 | 规则驱动计划落盘并挂起 Gate 2（断言数 ≥ 1，风险摘要存在） |
| 2 | 挂起即静止 | `plan_demo` 完成、`capture_demo` pending，磁盘零录屏文件 |
| 3 | 缺摘要 | 409 `approval_subject_missing` |
| 4 | 摘要不符 | 409 `approval_subject_mismatch`，运行仍在 Gate 2 |
| 5 | 重启存活 | 进程重启后 approvalId + planDigest 不变 |
| 6 | 第 2 层篡改 | 审批后改计划 → `capture_plan_tampered`，零产物 |
| 7 | 第 3 层篡改 | worker 复算不符 → `capture_plan_tampered`，零浏览器启动 |
| 8 | 真实录屏 | 全部断言通过并写回执 |
| 9 | 回填 | `mock:false` + 五方 SHA256 一致，占位素材被替换 |
| 10 | 产物登记 | clip / receipt / 截图可下载 |
| 11 | 成片 | 16:9 h264 + aac 且旁白非静音 |
| 12 | manifest | 素材哈希与回执逐字节一致 |
| 13 | 音轨诚实 | 明确标注合成测试音色 |
| 14 | SRT | 独立校验通过且时长相符 |
| 15 | 下载复验 | 片段下载哈希与回执一致 |
| 16 | 断言失败 | `capture_assertion_failed`，绝不伪造回执 |
| 17 | 失败证据 | report + PNG + trace 全部登记 |
| 18 | 结构化失败 | `captureFailure` 供 Web 面板 |
| 19 | 零回归 | 未请求录屏时两步创建即 skipped |

浏览器侧（`capture-gate2-real-flow.spec.ts`，4 条）：

| 场景 | 断言 |
|---|---|
| 正常流 | Gate 2 卡片可见 → 批准 → 「真实录屏已回填」→「已出片」→ 服务端产物 / 哈希 / 下载头（`x-content-sha256`、`nosniff`）逐项核对 |
| 计划编辑 | `修改计划` → `resetStrategy: none` → 保存 → 摘要变化、审批重回 `pending`；**旧摘要批准 → 409 `approval_subject_mismatch`** |
| 录屏失败 | `真实录屏失败 · capture_assertion_failed`、失败步骤 `dashboard-ready`、失败现场截图；服务端无 receipt / clip / video_mp4 |
| 未启用录屏 | 两步显示「已跳过」、Gate 2 卡片不存在、服务端事件说明原因 |

单元 / 集成层另有覆盖：

| 测试 | 覆盖 |
|---|---|
| `libs/domain/src/demo-planner.test.ts` | 四个模板确定性、语义选择器、无凭证、每模板 ≥ 1 断言、摘要稳定性 |
| `libs/domain/src/capture.test.ts` | DemoPlan schema、禁用 CSS/XPath、风险摘要、回执 schema |
| `apps/api/src/orchestration/orchestrator-capture.test.ts`（11 用例） | 三层防篡改、回填、失败不留回执、旁白重写保留溯源块 |
| `apps/api/src/routes/orchestration-capture.test.ts` | 路由层 409 / 400、`no_real_demo_scenes` fail-closed |
| `apps/api/src/db/database-v7.test.ts` | v6→v7 迁移只加表、旧数据保留 |
| `workers/browser-worker/src/capture-job.test.ts` | worker 第 3 层摘要复算与拒绝启动 |
| `libs/features/production-suite/src/server-orchestration.test.ts` | 九步 DAG、skipped 展示、checkpoint 标签 |

---

## 5. 修复的真实产品缺陷（本切片一路验收挖出来的）

这三个都不是测试问题，而是**只有走完真实验收路径才会暴露的产品 bug**：

1. **`storageRefBase` 错位**（上一轮记录）：worker 写的 `storageRef` 相对仓库根，编排器按 `artifactDir` 解析，导致登记产物找不到文件。修复：`resolveAllowedPath` 同时以 `artifactDir` 与 `mediaRoot` 为基准解析相对引用，绝对路径仍必须落在其中之一。
2. **`synthesize_voice` 抹掉录屏溯源**：该步骤用固定键集重写 `input.json`，静默丢掉 `capture_demo` 写入的 `capture` 块——成片就无法再证明「这段素材来自哪份批准的计划」。修复：`readFrozenInput` 保留 `capture?` 并原样写回；新增回归用例（`orchestrator-capture.test.ts`「旁白启用时 synthesize_voice 重写 input.json 仍保留录屏溯源块」）。**此前的 10 个用例全部以 `narration: { enabled: false }` 运行，所以从未触发；这正是「假执行器单测覆盖不到真链路」的典型。**
3. **CORS 预检拒绝 `PUT`**：`@fastify/cors` 默认 `methods: 'GET,HEAD,POST'`，于是浏览器在发出请求前就拒绝了 **`PUT /v1/workspaces/:id`（同步保存）与 `PUT /runs/:runId/demo-plan`（Gate 2 计划编辑）**——两者都是真实浏览器写入，在真实部署里同样会失败。修复：显式声明 `methods: ['GET','HEAD','POST','PUT']`，并新增 `apps/api/src/app.test.ts`「CORS 预检允许 PUT」用例把契约钉死。

---

## 6. 验证记录（2026-11-28）

| 命令 | 结果 |
|---|---|
| `pnpm lint:boundary-check` | 4/4 跨层探针按预期拒绝 |
| `pnpm exec nx run-many -t lint typecheck test` | 15 个项目通过；**56 个测试文件 / 497 个用例**（domain 153 · api 209 · mock-services 31 · browser-worker 29 · adapters-http 26 · render-worker 23 · state 16 · render 3）。`Rule` 告警均为既有，无 error |
| `pnpm gate2:verify` | **19/19 通过**（见 §1） |
| `pnpm export:verify` | **20/20 通过**（5B / Gate 3 零回归；SRT 9 条 · 36,480 ms · −21.1 dB） |
| `pnpm capture:demo` | 11/11 断言通过 · 18,000 ms · 1920×1080 · 4.05 MiB WebM |
| `pnpm verify:capture` | 回执 / 录屏 / trace / 截图 / 渲染 fixture 一致 |
| `pnpm capture:safety` | 越界 origin 被 allowlist 拒绝，零越界请求 |
| `pnpm capture:repeat` | 3/3 = 100%（门槛 80%） |
| `pnpm render:captured && pnpm verify:render:captured` | 成片与 manifest / receipt 一致 |
| `pnpm build && pnpm budget` | 初始 **229.3 kB** gzip（预算 230 / 790）· Editor 24（30 / 95）· Production **22.6**（24 / 70）· Review 15.8（22 / 65）· 最大 chunk 128（160 / 500）。全部达标 |
| `pnpm test:e2e` | **49/49 通过（2.4 分钟）**：桌面 / 平板 / 移动三项目；新增 `capture-gate2-real-flow.spec.ts` 4 条 |

> **首屏预算只剩 0.7 kB 余量**（229.3 / 230）。Gate 2 面板经由 `React.lazy` 加载，`demo-planner.ts` 不进初始包——这是本切片最容易失守的地方，任何新的同步 import 都可能直接击穿预算。

---

## 7. Web 接入

| 页面 | 行为 |
|---|---|
| 生产监控 · `ServerOrchestrationPanel` | 新增 capture 面板：开关、模板 `Select`（四模板）、`baseUrl`、重置策略；未配置录屏时禁用并说明服务端会 fail-closed；DAG 始终显示九步，未请求的两步明确「已跳过」 |
| 生产监控 · `Gate2ApprovalPanel`（`React.lazy`） | 挂起时显示计划摘要、风险徽章与依据、声明式步骤表（`目标 · 断言`，绝不渲染原始 CSS）、审批备注；「批准 Gate 2 并启动录屏」携带页面显示的 `planDigest`；「修改计划」→ 模板 / baseUrl / 重置策略 → 服务端重算摘要并作废旧审批；「驳回计划」是终态 |
| 成功态 | 「真实录屏已回填到渲染输入」+「已出片」+ 真实素材标注（`全部真实录屏`）；片段 / 回执可下载，下载前用 WebCrypto 逐字节校验 SHA256 |
| 失败态 | `真实录屏失败 · <code>`、失败步骤、断言失败数、发生时间、越界请求；失败现场 PNG 内联预览（`nosniff`，仅 PNG 内联）；`failure-report.json`、失败截图与 `trace.zip` 均可下载 |
| 零回归 | 未请求录屏时 Gate 2 卡片不挂载，DAG 显示两步「已跳过」，事件写明原因 |

---

## 8. 复现

```powershell
pnpm exec nx run-many -t lint typecheck test
pnpm gate2:verify                # 真实 Chromium 录屏 + 真实 Remotion 渲染（19 项）
pnpm export:verify               # 5B / Gate 3 零回归（20 项）
pnpm capture:demo; pnpm verify:capture
pnpm capture:safety; pnpm capture:repeat
pnpm build; pnpm budget
pnpm test:e2e
```

`ASVS_KEEP_VERIFY_DIR=1` 保留临时数据库与全部录屏 / 成片产物供人工检查。录屏需要本机可用 Chromium（Playwright 已安装）与已构建的 `web-studio`（`pnpm build`）；`pnpm gate2:verify` 默认用确定性测试音色，无需任何外部凭证。

---

## 9. 明确未做（5C 边界）

- **不做 LLM Demo Planner**（5E）：本切片的计划完全由规则模板生成，确定性可复现。
- **不做隐私 QA**（5D）：录屏画面里可能出现真实数据，脱敏与遮罩留给 5D。
- **不做增量 / 局部重渲染**（5F）：每次仍渲染全片。
- **不做多环境 / 多视口矩阵**：只按计划里的单一 viewport 录制。
- **不做录制过程的人工干预**：批准之后要么全部断言通过，要么失败重来；没有「跳过这条断言」按钮，也不该有。
- **不改 `libs/render` / `workers/render-worker` / `studio-store`**：模拟 DAG、渲染内核与前端状态均未触碰。
- **未改 Step 2 资产**：`web-studio-tour.yaml` 的断言与页面标题 / 导航文案逐字节未变。
- 无鉴权、无租户隔离、单写入者 SQLite；录屏仍在本机拉起浏览器，无远程浏览器农场。

---

## 10. 关联文档

- [docs/05 领域模型](05-DOMAIN-DATA-MODEL-AND-CONTRACTS.md)：`CaptureReceiptV1`、`RenderInputV1`
- [docs/06 Agent 工作流](06-AGENT-WORKFLOWS-AND-ORCHESTRATION.md)：§5 可恢复执行、三个审批 Gate
- [docs/07 录屏与渲染](07-VIDEO-CAPTURE-RENDER-AND-EDITOR.md)：DemoPlan、Remotion 合成
- [docs/08 安全](08-SECURITY-EVIDENCE-AND-ATVG2-INTEGRATION.md)：§3 SSRF 防护、§9 审批安全用例
- [docs/12 录屏切片](12-CAPTURE-SLICE.md) / [docs/13 编排切片](13-ORCHESTRATION-SLICE.md) / [docs/14 配音与交付包切片](14-AUDIO-EXPORT-SLICE.md)：本切片复用的 worker、编排与产物格式
- [docs/10 下一阶段计划](10-NEXT-PHASE-PLAN.md)：§7C 切片状态
