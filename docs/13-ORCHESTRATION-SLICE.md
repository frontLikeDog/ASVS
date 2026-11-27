# 13 · 服务端编排切片（Step 5A 验收记录）

> 状态：**已执行**｜日期：2026-11-27｜分支：`claude/interesting-neumann-9276b4`
> 对应计划：docs/09 WP-03 / AC-06、docs/06 §5（可恢复执行）、docs/05 §4（`JobEnvelopeV1`）
> 结论先说：生产运行的状态与执行已从浏览器定时器迁到 **SQLite 持久化任务队列 + 独立 worker 子进程**。真实 `render-worker` 被 `SIGKILL` 后，重启的「API 进程」按 `bundle_ready` checkpoint 续跑并产出 6 秒真实 MP4；ffprobe、SHA256、回执、清单、数据库登记行五方一致。**审核页仍不提供配音与 SRT**（5B），Web 内的模拟 DAG 未被替换。

---

## 1. 结论与证据

`pnpm orchestration:verify`（`apps/api/src/scripts/verify-orchestration.ts`）不使用任何 fake executor：它建临时 SQLite 与工作区，用真实 `RenderProcessExecutor` 拉起 `workers/render-worker`，在 `bundle_ready` 后 150ms `SIGKILL`，随后硬停第一个 Orchestrator、用同一数据库文件启动第二个 Orchestrator 完成恢复。

| 项 | 结果 |
|---|---|
| MP4 | `<tmp>/artifacts/workspaces/ws_orchestration_verify/runs/<run>/artifacts/<run>.mp4` |
| 规格 | h264 · 1920×1080 · 30fps · 6000ms / 180 帧 · **无音轨**（`nb_streams=1`） |
| 大小 | 264,088 bytes |
| SHA256 | `ad5c52e494a9e31714593e9a528ab65f831d7f494126d85c919ad335c89c0722` |
| 一致性 | 与 `receipt.json`、`manifest.json`、`orchestration_artifacts.sha256` 一致 |
| 首次真实渲染 | 第 1 次尝试在 `bundle_ready` 后被 SIGKILL，MP4 不存在 |
| 恢复 | 第 2 次尝试被硬停的 API 留下孤儿租约；新实例写入 `heartbeat_lost`，第 3 次尝试命中 `bundle_ready`，跳过 Remotion 打包完成渲染 |
| 验收项 | **23/23 断言通过**（见 §5） |
| 耗时 | 首次运行含 Remotion 浏览器外壳下载（123 MB）；缓存后整轮 **13.9 秒** |

产物目录布局：

```text
<artifactDir>/workspaces/<workspaceId>/runs/<runId>/
  input.json                冻结的 RenderInputV1 + digest
  claims-check.json         verify_claims 的阻断/警告记录
  media-manifest.json       prepare_media 的真实素材与占位标记
  render-job-input.json     RenderJobInputV1（含 jobDigest）
  render-checkpoint.json    worker 侧断点文件（jobDigest 绑定）
  artifacts/
    <runId>.mp4
    receipt.json
    manifest.json
    .bundle/  .public/      成功后删除；崩溃时保留以便续跑
```

---

## 2. 数据流

```text
浏览器（生产页 / 审核页）
  └─ POST /v1/workspaces/:ws/orchestration/runs   idempotencyKey 去重 → 201 / 200
        │
        ▼
SQLite v5（orchestration_runs / _jobs / _checkpoints / _artifacts / _events）
  └─ Orchestrator.pump()                         apps/api/src/orchestration/orchestrator.ts
        leaseJob()  BEGIN IMMEDIATE，attempt += 1
        freeze_input → verify_claims → prepare_media → render_video → register_artifacts
        │
        └─ render_video：RenderProcessExecutor
              spawn(process.execPath, ['--import', file://…/tsx/dist/loader.mjs, render-job.ts, …], { shell:false })
              stdout JSONL：ASVS_EVENT heartbeat / progress / checkpoint / completed / failed
              onCheckpoint → 立即写 orchestration_checkpoints + job.last_checkpoint_phase
        │
        ▼
register_artifacts：回执/清单 Schema、SHA256、字节数、jobId、16:9 全部复核后登记三行
  └─ GET …/artifacts/:id   ETag = sha256，Content-Disposition，路径穿越拒绝
```

关键不变量：

- **子进程隔离**：`apps/api` 不 import `workers/render-worker`（Nx `type:api` 约束），只通过 `RenderJobInputV1` 文件 + JSONL 协议交互；worker 入口以路径字符串传给 `spawn`。
- **状态唯一权威**：所有 run/job 迁移先落库再产生副作用；`completeStep` / `failRun` 对终态运行直接返回，取消后迟到的完成不会覆盖 `cancelled`。
- **事务边界**：`BEGIN IMMEDIATE` 只包住单条状态变更；渲染、哈希、文件 I/O 都在事务外。
- **错误分类**：崩溃（信号 / 无 `failed` 事件）可重试；`claims_blocked`、`aspect_not_supported`、`invalid_input` 为确定性错误，直接终态。

---

## 3. 数据库 v5

新增表全部前缀 `orchestration_`，**没有复用** `production_runs`（模拟 DAG 的历史表）：

| 表 | 关键约束 |
|---|---|
| `orchestration_runs` | `UNIQUE(workspace_id, idempotency_key)`；索引 `(workspace_id, video_id, created_at DESC)`、`(status, created_at)` |
| `orchestration_jobs` | `UNIQUE(run_id, step_key)`；`attempt / max_attempts / lease_owner / lease_expires_at / worker_pid / last_checkpoint_phase` |
| `orchestration_checkpoints` | `UNIQUE(run_id, step_key, phase)`；重放刷新 payload |
| `orchestration_artifacts` | `kind ∈ {video_mp4, render_manifest, artifact_receipt}`；`sha256`、`storage_ref` |
| `orchestration_events` | 自增 `id`，`event_type ∈ {state_change, checkpoint, heartbeat_lost, worker_crash, retry, cancel, approval, log}` |

迁移测试 `database-v5.test.ts` 覆盖新表存在、唯一键生效、旧表不受影响。

---

## 4. 崩溃恢复与租约

| 场景 | 机制 |
|---|---|
| worker 被 `SIGKILL` | 执行器返回 `crashed: true`；`handleStepFailure` 写 `worker_crash` 事件、job → `retryable`，沿用同一 run 重试 |
| API 重启 | `start()` 调 `recoverOrphanedLeases()`：凡租约属其他实例或已过期的 job 记 `heartbeat_lost` 并释放；`leaseJob` 再次自增 `attempt` |
| 重试上限 | `attempt > maxAttempts` → `failRun(..., 'worker_crash_exhausted')`；job 计数在租约时自增，崩溃循环必然耗尽 |
| 续跑点 | worker 读 `render-checkpoint.json`：`video_rendered` 且回执仍匹配 → 只复核；`bundle_ready` 且 `.bundle/index.html` 存在 → 跳过 webpack；否则从头 |
| 失败不删现场 | `.bundle` / `.public` 仅在 `verified_receipt` 之后清理，崩溃后保留 |
| 输入绑定 | `jobDigest` 覆盖 `{jobId, artifactId, input, media}`；checkpoint 的 digest 不同立即弃用，防跨任务污染 |
| 取消 | `abortRequested` + executor.abort()（Windows `taskkill /T /F`，POSIX SIGTERM→2s 后 SIGKILL）；迟到的完成/failure 不覆盖终态 |

---

## 5. 强制故障场景

`pnpm orchestration:verify` 的 23 项断言逐条对应计划要求：

| # | 场景 | 断言 |
|---|---|---|
| 1 | 重复投递 | 同一 `idempotencyKey` 第二次 POST `created=false` 且返回同一 run |
| 2–3 | SIGKILL 恢复 | 真实 worker pid 被杀；`bundle_ready` checkpoint 已落库 |
| 4–5 | 崩溃后自动重试 / 硬停 | attempt=2 已租约并再次拉起真实 worker；硬停后 run 仍 `running`、租约仍属旧实例 |
| 6–9 | API 重启 | 新实例 `heartbeat_lost` 回收租约；run `succeeded`；attempt=3；日志出现「命中 bundle_ready checkpoint」 |
| 10–14 | 产物 | 三类产物登记；文件存在；SHA256 五方一致；ffprobe 16:9/h264/无音轨；时长与清单一致 |
| 15 | 非 16:9 | `createRun` 抛 400 `aspect_not_supported`，executor 调用数 **0** |
| 16 | 声明阻断 | run `failed / claims_blocked`，executor 调用数 **0** |
| 17 | 重试耗尽 | `maxAttempts=2` 连崩 → `failed / worker_crash_exhausted` |
| 18–20 | 取消与非法迁移 | failed→queued 重试成功；queued→cancelled 成功；retry 已取消运行 → 409；cancel 已成功运行 → 409 |
| 21 | 篡改输入 | 真实 worker CLI 对错误 `jobDigest` 非 0 退出并报 `jobDigest` |
| 22 | 渲染中取消 | 真实 worker 已启动后取消 → run `cancelled`，无产物，不再自动重试 |
| 23 | 幂等键 | （同 1） |

「API 重启时不丢弃正在进行的渲染」由 4–9 的组合证明：旧进程在新 worker 渲染途中被 `stop()`，新实例从数据库恢复，而非依赖任何进程内状态。

---

## 6. Web 接入（诚实降级）

| 页面 | 行为 |
|---|---|
| 生产监控 `ServerOrchestrationPanel` | 未连接工作区 / API 不可达时显示 Callout 并明确说明「下面仍可使用浏览器内模拟 DAG」；连接后提供「启动服务端渲染」，展示五步 DAG、attempt、checkpoint 徽标、事件日志、失败码、Gate 批准、取消/重试/下载 |
| 审核 `ReviewArtifactPanel` | 只读展示最新成功 run 的 MP4 与 manifest；下载前用 WebCrypto 校验 SHA256 再落盘；无产物时明确说明「导出记录里的 MP4/WebM 仍是模拟任务状态」 |
| 格式标注 | 两处均标注 `16:9 · H.264 · 无音轨（5B 接入配音与 SRT）` |

首屏预算：客户端通过 `libs/state/src/orchestration.ts` **动态** `import('@asvs/adapters-http')`，初始 chunk 不新增静态依赖（见 §7 预算数字）。

---

## 7. 预算与回归

| 项 | 结果 |
|---|---|
| 初始 JS gzip | **227.2 kB**（预算 230 kB；4D 基线 226 kB，+1.2 kB） |
| Production 路由增量 | **19.2 kB gzip / 50.5 kB raw**（预算 24 / 70） |
| Review 路由增量 | **15.0 kB gzip / 40.9 kB raw**（预算 22 / 65） |
| Editor 路由增量 | 24.0 kB gzip / 69.7 kB raw（预算 30 / 95） |
| 最大 chunk | 125.9 kB gzip（预算 160） |
| 单测 / 集成 | `nx run-many -t lint typecheck test --skip-nx-cache`：**15 个项目全绿**，44 个文件 / **352 个测试通过**（API 16 文件 / 136 用例） |
| 既有 E2E | 全部保留；`pnpm test:e2e` **42/42 通过（2.1 分钟）**，其中新增 4 条 |
| 新增 E2E | `orchestration-real-flow.spec.ts`（4 条）：未连接降级 + 模拟 DAG 可用、连接后入口与恢复策略、审核页无产物提示、health `orchestrationReady` 与跨工作区 404 |
| 模拟 DAG | 未替换，`production.spec.ts` / `review.spec.ts` 断言不变 |
| 渲染回归 | `pnpm render:fixture` 再次产出与 docs/11 相同的 SHA256 `b1451bfb…26ccd8a`；`pnpm verify:render` 一致 |

---

## 8. 明确未做（5B 及以后）

- TTS / 配音 / SRT 字幕轨（MP4 明确无音轨）
- 服务端驱动 Playwright / Demo Planner（`awaiting_approval` 与 `/approve` 仅预留，未接 Gate）
- 隐私 QA、LLM AI Director
- 局部重渲染 / FFmpeg 片段拼接
- Redis / BullMQ / PostgreSQL / 对象存储
- 未经批准的自动发布

---

## 9. 复现

```powershell
pnpm lint:boundary-check
pnpm exec nx run-many -t lint typecheck test --skip-nx-cache
pnpm orchestration:verify        # 真实 SIGKILL + ffprobe + SHA256
pnpm build; pnpm budget
pnpm test:e2e
pnpm render:fixture; pnpm verify:render
```

设置 `ASVS_KEEP_VERIFY_DIR=1` 可保留临时数据库与 MP4 供人工检查。首次运行会下载 Remotion headless Chrome（约 123 MB，缓存于 `node_modules/.remotion`）。

---

## 10. 关联文档

- [docs/05 领域模型](05-DOMAIN-DATA-MODEL-AND-CONTRACTS.md)：`JobEnvelopeV1`、`ArtifactReceiptV1`
- [docs/06 Agent 工作流](06-AGENT-WORKFLOWS-AND-ORCHESTRATION.md)：§5 可恢复执行、Gate
- [docs/07 渲染](07-VIDEO-CAPTURE-RENDER-AND-EDITOR.md)：`RenderManifestV1`、ffprobe 门禁
- [docs/11 渲染切片](11-RENDER-SLICE.md) / [docs/12 录屏切片](12-CAPTURE-SLICE.md)：本切片复用的 worker 与产物格式
- [ADR-008 SQLite](adr/ADR-008-sqlite-workspace-storage.md)：本地优先存储决策
