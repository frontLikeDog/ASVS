# 16 · 独立 QA 与录屏隐私守门切片（Step 5D / WP-16 / AC-07）

> 状态：**已执行**｜日期：2026-11-29｜分支：`claude/qa-privacy-gate-28558f`（基线 `main` @ `e22a086`，Step 5C 合并后）
> 对应规范：docs/02（AC-07 / AC-10）、docs/06（§1–§3）、docs/07（§2 / §9）、docs/08（§6 / §9 用例 8）、docs/09（WP-16）
> 结论先说：编排 DAG 从 9 步扩到 **11 步**，新增 `qa_capture`（录屏后、TTS/渲染前）与 `qa_final`（渲染后、`register_artifacts` 前）两个**独立门禁**。它们由 `QaRunnerPort` 之后的 `IndependentQaRunner` 执行，产出绑定全部产物哈希的 `QaReportV1`。AC-07 的真链路已经闭合：**真实 `trace.zip`、真实 PNG `tEXt` 中的密钥、真实 ffmpeg 抽帧、真实 Tesseract OCR** 都会让运行以 `qa_privacy_blocked` 终止，`POST /exports` 与前端「批准视频」双端硬阻断；报告、SQLite、HTTP 响应与前端 DOM **只出现 `matchRedacted` 与 `matchSha256`**，绝不回显明文。因隐私命中的证据帧在作为 `qa_evidence_frame` 登记前，**服务端先用 `ffmpeg` 叠加 `boxblur + drawbox` 脱敏**。

---

## 1. 结论与证据

`pnpm qa:verify`（`apps/api/src/scripts/verify-qa-privacy.ts`）不是 mock：它建临时 SQLite，用**真实 `Orchestrator`** 跑两次 QA 阶段，用**真实 `ffmpeg`/`ffprobe`** 生成与探测视频，用**自己写的 ZIP writer** 生成结构合法的 Playwright `trace.zip`，用真实 PNG `tEXt` 块写入密钥字节，用真实 `boxblur` 脱敏证据帧。只有「渲染 worker」与「浏览器 worker」是双桩——但它们写出的是**真正经 ffmpeg 编码的媒体**。

| 项 | 结果 |
|---|---|
| DAG | 11 步：`freeze_input → verify_claims → plan_demo → capture_demo → qa_capture → prepare_media → synthesize_voice → generate_subtitles → render_video → qa_final → register_artifacts` |
| 早拦截 | `qa_capture` 命中隐私 → `synthesize_voice` / `render_video` 仍为 `pending`，0 次 TTS、0 个 MP4 |
| 成功链路 | 干净录屏 + 旁白 + 渲染 → `qa_capture` / `qa_final` 均 `succeeded`，`verdict` ∈ {`pass`, `pass_with_warnings`}，0 blocker |
| Trace 扫描 | 成功运行登记 `capture_trace`；`coverage.scannedTraceEntries > 0`、`scannedScreenshots > 0`、`scannedCaptureFrames > 0` |
| AC-07 Trace 阻断 | 真实 `trace.zip` 含 `Authorization: Bearer eyJ…` 与 `alice.secret@corp.internal` → `qa_privacy_blocked`，`retryable=false` |
| 反向泄密 | `qa-capture-report.json`、`GET /latest-qa-report`、事件日志、前端 HTML 全文均不含明文 token / 邮箱；只含 `a***@corp.internal` 一类掩码与 SHA256 |
| PNG `tEXt` 阻断 | 真实 PNG 文本块写入 GitHub PAT → 命中并阻断（不依赖 OCR，逐块读 PNG 文本） |
| 真实 OCR | `tesseract_cli` 可用时：#8 截图 OCR、#9 录屏帧 OCR 全过；不可用时明确 **SKIPPED**（绝不假装通过） |
| 证据帧脱敏 | `qa_evidence_frame` 经 `?inline=1` 可下载，带 `X-Content-Type-Options: nosniff`；其 SHA256 **不等于**原始帧，证明已做脱敏 |
| SRT / 文案 | `capture.enabled=false` 且字幕含邮箱 → `qa_final` 命中 `subtitle_srt` / `scene_text` 并阻断，不登记 `video_mp4` |
| 技术 QA | 第 2 镜 1.5s 纯黑 → `technical.black_frame` blocker 且定位到 `sceneId` / `timestampMs`；全程静止 7s 的 clip → `technical.freeze_frame` |
| Fail-closed | `ASVS_QA_OCR_PROVIDER=unconfigured` 且存在真实帧 → `qa_ocr_unavailable` 阻断，绝不 `pass` |
| Gate 3 可见性 | 被阻断运行的 `latest-qa-report` 仍返回 `200` + 完整定位报告与证据帧 |
| Gate 3 防绕过 | 视频已 `approved` 但运行被 QA 阻断 → `POST /exports` **409** |
| 报告防篡改 | 篡改 `qa-final-report.json` 1 字节 → `GET` 返回 `409 qa_report_tampered`，导出 `409 export_hash_mismatch` |
| 零回归 | `capture/narration` 关闭时 5 个步骤创建即 `skipped`，`qa_final` 仍执行并通过 |
| 验收项 | `pnpm qa:verify` **16 通过 / 0 失败 / 2 跳过（本机无 tesseract）**；CI 安装 `tesseract-ocr` 后 #8/#9 真实执行 |

浏览器侧另有 `apps/web-studio/e2e/qa-gate3-real-flow.spec.ts`（4 条，全过），对着测试专用 fixture API 注入确定性的 QA 双桩驱动真实 UI。

---

## 2. 数据流

```text
POST …/orchestration/runs
  │
  ▼
freeze_input → verify_claims → plan_demo          （5C 不变）
  │
CaptureProcessExecutor（真实 Chromium）
  ▼
capture_demo ──► capture_clip / capture_receipt / capture_screenshot / capture_trace（5D 补登成功态 trace）
  │
  ▼
qa_capture  ── 独立扫描：技术（解码/probe/黑屏/静帧）+ 隐私（帧/截图/trace/SRT/文案/计划值）
  │            └─ 任一 blocker → run 终态失败（qa_privacy_blocked / qa_technical_blocked / qa_ocr_unavailable），
  │               synthesize_voice / render_video 不启动；报告与证据帧照常落盘（可审核、可定位）
  ▼
prepare_media → synthesize_voice → generate_subtitles → render_video（5B/5C 不变）
  │
  ▼
qa_final    ── 技术（黑屏 / real_demo 镜头静帧 / 音轨 / 音画同步）+ 事实（claim / provenance）
  │            + 内容（禁用词 / 旁白字幕 / 合成音标注 / 品牌）+ 隐私（成片帧 / 字幕 / 文案）
  │            └─ blocker → run 失败，register_artifacts 不执行，不会出现 video_mp4
  ▼
register_artifacts → Gate 3（POST /exports：审批 + 运行 + scriptVersion + 4 个文件 SHA + **qa_final 报告 SHA = 第 5 道门**）
```

---

## 3. SQLite v8 与报告契约

- `PRAGMA user_version` 7 → **8**，只追加 `qa_reports` 表；v1–v7 迁移字节未改。升级保留全部旧表数据（`database-v8.test.ts`）。
- `QaReportStore`：`upsert({ report, reportArtifactId?, reportSha256 })`、`getByRun(ws, runId, stage)`、`getLatest(ws, videoId)`。
- `libs/domain/src/qa.ts` 只放**契约**（Zod `superRefine` 拒绝不自洽报告：verdict 与 findings 冲突、blocker 计数不符、证据帧缺 `sha256`）。它**不被 `orchestration.ts` 的运行时 schema 整块引入**——`orchestration.ts` 只挂 10 行 `qaRunSummaryV1Schema`；`scripts/check-bundle-budget.mjs` 新增一条断言：初始包里**不得出现**字符串 `asvs.qa-report`。
- 隐私正则规则库与扫描逻辑全部在 `apps/api/src/qa/`，`libs/domain` 零依赖、浏览器安全（无 `node:crypto` / `node:fs` / `node:zlib`）。

### 3.1 证据帧的脱敏顺序（红线 3）

```text
原始帧（ffmpeg 抽帧或断言截图）
  └─ 命中隐私规则？
       ├─ 否 → 不入 qa_evidence（隐私 QA 不为「没有命中」留证据）
       └─ 是 → ffmpeg -vf "boxblur=18:3,drawbox=x=0:y=0:w=iw:h=ih:color=red@0.8:t=8"
                → 输出 qa/evidence/qa_evidence_frame-*.png
                → 登记 artifact kind=qa_evidence_frame（metadata.redacted=true）
                → Finding 只带 matchRedacted + matchSha256 + 本帧 artifactId
```

---

## 4. AC-07 规则表（`apps/api/src/qa/privacy-scanner.ts`）

| ruleId | 模式 | 备注 |
|---|---|---|
| `privacy.email_address` | RFC 5322 简化 | 支持 `PRIVACY_ALLOWLIST_DOMAINS` 显式豁免测试域名，默认零豁免 |
| `privacy.bearer_token` | `Bearer <token>` | 头部 / trace / DOM 均扫 |
| `privacy.github_token` | `ghp_` / `gho_` / `ghs_` / `ghu_` / `github_pat_` | |
| `privacy.api_key` | `sk-` / `sk-proj-` / `AKIA…` 等 | |
| `privacy.jwt` | 三段 base64url | |
| `privacy.private_key` | `-----BEGIN … PRIVATE KEY-----` | |
| `privacy.credit_card` | 13–19 位 + **Luhn 校验** | 仅 Luhn 通过才报 |
| `privacy.sensitive_id` | 中国身份证 18 位 + **校验位** | |
| `privacy.allowlisted_domain`（info） | 域名在显式白名单 | 只提示，不阻断 |

每条命中**当场**算 `matchRedacted`（保留首尾各 1–2 字符）与 `matchSha256`，原始值不进入任何下游对象。

---

## 5. 修复的真实产品缺陷（本切片验收挖出来的）

1. **`planClipFrameTimes` 抽帧端点越界**（`apps/api/src/qa/frame-extractor.ts`）：原来取 `durationMs - 1`，`ffmpeg -ss` 落在最后一帧 PTS 之后时 `-frames:v 1` **不产出任何帧**，runner 报 `technical.execution_error`——干净录屏会被自己的 QA 判失败。修复：端点固定留 100 ms 余量，并保留首/尾两个探针（抽稀只抽中间）。配 5 条单测。
2. **回执路径约定混用**（`verify-qa-privacy.ts` 侧暴露）：receipt 的 `file` 字段是 **outDir 相对**，而 `media.sourceFile` 是**仓库相对 POSIX**。混用会让 `path.join(outDir, file)` 全部落空，`registerCaptureArtifacts` 静默跳过——`scannedScreenshots` / `scannedTraceEntries` 归零，运行却「看起来干净」。
3. **`fact.capture_provenance` 只读 `visual.assetId`**（`apps/api/src/qa/fact-content-qa.ts`）：`buildStoryboardV1` 把素材放在 `assetIds`，而 Gate 2 回填的持久化镜头只有裸 `{type:'real_demo'}`。结果**每一次真实录屏都被误报「缺少素材绑定」**——happy path 上的假告警，会让审核员学会忽略溯源检查。修复：按渲染器同样的顺序解析（`assetIds` → `visual.assetId`）；`scene-mapper.ts` 同步。配 9 条单测。
4. **QA 双桩未设置 `verdict`**（`e2e-fixture-api.ts`）：schema 的 `superRefine` 拒绝不自洽报告，E2E 报 `qa_execution_failed`。修复：`verdict` 由 findings 推导，双桩与真实 runner 同一规则。
5. **5D 的 Gate 5 让既有「导出就绪」种子失效**（`e2e-fixture-api.ts`）：`seedExportReadyRun` 不写 `qa_final` 报告，`export:verify` 对应的 E2E 被 409。修复：种子写一份真实绑定 `inputDigest/mp4Sha/srtSha/manifestSha` 的报告并登记 `qa_report` 产物；断言文件种类 4 → 5。
6. **Gate 2 的演示确实是静的**（`verify-capture-orchestration.ts`）：AC-07 技术 QA 正确地把 5C 的三段「assert + 7 s dwell」判为 `technical.freeze_frame`。这是**真阳性**——修复是把演示改成真实操作（命令面板逐字过滤、视频库搜索 / 阶段筛选、进入视频工作区切分镜），而不是放宽阈值。

---

## 6. 验证记录（2026-11-29）

| 命令 | 结果 |
|---|---|
| `pnpm qa:verify` | **16 通过 · 0 失败 · 2 跳过 · 15.1 s**（#8/#9 本机无 tesseract，见 §6.2） |
| `pnpm gate2:verify` | **19/19 通过**（真实 Chromium 录屏 8/8 断言 · clip `87aa131a…` · 成片 1280×720 h264+aac 13,483 ms −24.1 dB） |
| `pnpm export:verify` | **20/20 通过**（11 步 DAG · 交付包 5 个文件含 `qa_report` · MP4 36,480 ms −21.1 dB · 二次运行 `providerCalls=0`） |
| `pnpm orchestration:verify` | **23/23 通过**（5A 崩溃恢复零回归；`qa_final` 在恢复后的实例上真实执行） |
| `pnpm render:fixture && pnpm verify:render` | 通过；静音黄金样片 SHA256 仍为 `b1451bfb…26ccd8a`（渲染内核零改动） |
| `pnpm lint:boundary-check` | 4/4 跨层探针按预期拒绝 |
| `nx run-many -t lint typecheck test --skip-nx-cache` | 15 个项目 · **66 个测试文件 / 579 个用例**全绿；`0 errors`，仅既有 `no-unused-vars` 警告 |
| `pnpm build && pnpm budget` | 初始 **229.6 kB** gzip（预算 230 / 790）· Editor 24.2（30 / 95）· Production **23.2**（24 / 70）· Review **17.3**（22 / 65）· 最大 chunk 128.2（160 / 500）。全部达标 |
| `pnpm test:e2e` | **53/53 通过（2.8 分钟）**：`chromium` 47 · `mobile-chromium` 3 · `tablet-chromium` 3；新增 `qa-gate3-real-flow.spec.ts` 4 条 |

> **首屏预算只剩 0.4 kB 余量**（229.6 / 230）。5D 的 QA schema 被挡在懒加载 chunk 之外（`check-bundle-budget.mjs` 断言初始包不含 `asvs.qa-report`），任何新的同步 import 都可能直接击穿预算。

### 6.2 无 Tesseract 时的诚实边界

本机没有安装 Tesseract（用户明确选择「先不装，跳过真实 OCR」）。`qa:verify` 因此：

- 以 `ASVS_QA_OCR_PROVIDER=deterministic_test` 运行，**报告里 `coverage.ocrSynthetic = true`**；
- #8（截图真实 OCR）与 #9（录屏帧真实 OCR）标记为 **SKIPPED** 并写明原因，**绝不记为通过**；
- 其余 16 项（trace / PNG 文本块 / ffmpeg 抽帧 / 黑屏 / 静帧 / 脱敏证据帧 / 双端导出闸门 / 报告防篡改）全部以真实字节执行；
- CI 的 capture 作业安装 `tesseract-ocr` 并设置 `ASVS_VERIFY_EXPORT_DIR`，#8/#9 在 CI 真实执行、证据随 `dist/qa-verify/**` 上传。

---

## 7. Web 接入

| 页面 | 行为 |
|---|---|
| 生产监控 · `ServerOrchestrationPanel` | DAG 自动显示 11 步；`qa_*` 失败时失败 Callout 增加「到审核页查看独立 QA 报告与定位 →」 |
| 审核页 · `QaReportPanel`（`React.lazy`） | 独立于 `getLatestVideoArtifact` 拉取最新报告（**即使最新运行被 QA 阻断也展示**）；按镜头分组：时间点 / 帧号 / 来源中文标签 / `stepId` / `traceEntryPath`；`matchRedacted` 等宽展示；`qa_evidence_frame` 内联缩略图（`nosniff`）与放大 `Dialog`；「定位到第 N 镜」→ `/editor?scene=<sceneId>`；「去生产监控重录」→ `/production`；「去知识中心核验」→ `/knowledge` |
| 审核页 · 导出闸门 | QA 未通过时「批准视频」「生成交付包」均禁用，并显示「等待 QA 通过」/「独立 QA 已阻断：修复后重新运行」 |
| 离线降级 | 未连接服务端时诚实提示「当前未连接服务端独立 QA」，本地模拟审核流程不变 |

---

## 8. 复现

```powershell
pnpm lint:boundary-check
pnpm exec nx run-many -t lint typecheck test --skip-nx-cache
pnpm qa:verify
pnpm gate2:verify
pnpm export:verify
pnpm render:fixture; pnpm verify:render
pnpm build; pnpm budget
pnpm test:e2e
```

安装 Tesseract（`winget install UB-Mannheim.TesseractOCR` / `apt-get install tesseract-ocr`）后重跑 `pnpm qa:verify`，#8/#9 会从 SKIPPED 变为真实执行。设置 `ASVS_VERIFY_EXPORT_DIR` 可保留全部 QA 产物（报告、脱敏证据帧、trace）供人工检查。

---

## 9. 明确未做（5D 边界）

- **不做 LLM 质量打分 / 视觉大模型审核**（留待 5E）。
- **不做自动视频打码重编码**：5D 的闭环是「扫描 → 证据帧打码 → 阻断 → 引导重录/编辑」。
- **不做增量 / 局部重渲染**（留待 5F）。
- **未改 `libs/render` / `workers/render-worker` / `libs/state/src/studio-store.ts`**。
- **未改 Step 2 资产**：`workers/browser-worker/plans/web-studio-tour.yaml` 逐字节未变。
- 无登录、无多租户、无云对象存储。

---

## 10. 关联文档

- [docs/02 产品需求](02-PRODUCT-REQUIREMENTS-PRD.md)：AC-07 / AC-10
- [docs/06 Agent 工作流](06-AGENT-WORKFLOWS-AND-ORCHESTRATION.md)：Independent QA 节点与 Gate 3
- [docs/07 录屏、渲染与编辑器](07-VIDEO-CAPTURE-RENDER-AND-EDITOR.md)：§2 录屏脱敏、§9 四维质量门禁
- [docs/08 安全与证据](08-SECURITY-EVIDENCE-AND-ATVG2-INTEGRATION.md)：§6 数据治理、§9 安全用例 8
- [docs/09 实施路线](09-IMPLEMENTATION-ROADMAP-AND-ACCEPTANCE.md)：WP-16
- [docs/10 下一阶段计划](10-NEXT-PHASE-PLAN.md)：§7D 切片状态
- [docs/15 Gate 2 切片](15-CAPTURE-GATE2-SLICE.md)：本切片复用的录屏链路
