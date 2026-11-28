# 14 · 配音与交付包切片（Step 5B 验收记录）

> 状态：**已执行**｜日期：2026-11-27｜分支：`claude/narration-srt-delivery-2a73cf`
> 对应计划：docs/09 WP-03 / AC-10、docs/06 §5（可恢复执行 + 故障测试）、docs/07 §7（渲染与字幕）
> 结论先说：5A 的静音 MP4 已经变成**可交付的成片包**——真实旁白音轨（H.264 + AAC 48 kHz）、与冻结帧时间轴一致的服务端 SRT、以及绑定 Gate 3 的导出包（MP4 + SRT + manifest.json + receipt.json，四个文件均带 SHA256 回执）。重复运行不重复计费；未配置 TTS 时 fail-closed，绝不静默降级为无声；离线测试音轨全程诚实标注。

---

## 1. 结论与证据

`pnpm export:verify`（`apps/api/src/scripts/verify-audio-export.ts`）不 mock 渲染：它建临时 SQLite 与工作区，用真实 `SpeechService`（`deterministic_test` 音色）+ 真实 `RenderProcessExecutor` 拉起 `workers/render-worker`，让一段刻意超长的旁白触发 `extend_scene`，然后逐项校验磁盘上的字节。

| 项 | 结果 |
|---|---|
| 运行 | 7 步全部 `succeeded`：`freeze_input → verify_claims → prepare_media → synthesize_voice → generate_subtitles → render_video → register_artifacts` |
| 旁白片段 | 2 段（intro / outro），`narration.json` 记录 `synthetic: true`、许可 `internal-deterministic-test-only` |
| 溢出策略 | intro 旁白约 33,095 ms，把原本 12 s（360 帧）的镜头延长到 **1,004 帧**；outro 保持 **90 帧** 不变；语音从未被截断，也未跨镜头 |
| MP4 | h264 + **aac** · 1920×1080 · 36,480 ms（延长后的时间轴） |
| 音画一致 | 音频流时长与视频流时长相差 ≤ 500 ms |
| 非静音 | `volumedetect` mean_volume **−21.1 dB**（门限 > −90 dB） · 48 kHz · 2ch |
| SHA256 | `4cae7b55483fda24cb2633b98710fd2e21c443eca71df8d0f92b73e8ba1d74c7`；MP4 文件 = receipt = manifest = `orchestration_artifacts` 登记行，五方一致；不同次运行逐字节可复现 |
| SRT | 9 条字幕 · 785 B；独立解析器复查：序号连续、时间单调、无重叠、最后一条不超视频总长 |
| 缓存 | 相同输入第二次运行：`providerCalls=0`、`cacheHits=2`（不重复计费） |
| Gate 3 | 未通过 Gate 3 的视频导出被 **409 `export_not_approved`** 拒绝 |
| 导出包 | 如 `exportbundle_8af2b2d77ef54ad6b8fa5583` · 4 个文件（MP4 / SRT / manifest / receipt）· `scriptVersion` 绑定 · 记录 `videoDurationMs` / `audioDurationMs` / 旁白溯源（包 ID 每次运行新生成，哈希绑定运行） |
| 下载复验 | 四个文件重新哈希与导出包一致；下载后的 MP4 仍有音轨，下载后的 SRT 仍通过独立校验 |
| 验收项 | **20/20 断言通过**（见 §6） |
| 耗时 | 61.3 秒（`pnpm export:verify` 全流程：两次 Remotion 渲染 + 全部校验；缓存命中只省 TTS，不省重编码） |

> 本机使用确定性测试音色（`ASVS_TTS_PROVIDER=deterministic_test`），因为它**离线、可复现、且诚实标注** `synthetic: true`。真实商用音色需要配置 `openai_compatible` 的 `ASVS_TTS_API_URL` / `ASVS_TTS_API_KEY`；凭证永不入库、永不写入日志或响应体。

产物目录布局（在 5A 基础上新增标注 ◇）：

```text
<artifactDir>/workspaces/<workspaceId>/runs/<runId>/
  input.json                冻结的 RenderInputV1；◇ synthesize_voice 后重写为「延长后的 storyboard + narration」
  claims-check.json
  media-manifest.json
  ◇ narration.json          片段、缓存键、providerCalls / cacheHits、许可、synthetic、timingPolicy、adjustments
  ◇ subtitles.srt           服务端生成并经独立校验的 SRT
  render-job-input.json     ◇ 增加 audio[] / subtitlesPath / timingAdjustments[]
  render-checkpoint.json
  artifacts/
    <runId>.mp4             ◇ 含 AAC 音轨
    receipt.json
    manifest.json           ◇ ffprobe.audio / narration / subtitles
```

`data/artifacts/tts/<cacheKey>.wav`（或 `ASVS_ARTIFACT_DIR` 下）保存归一化后的旁白音频；`speech_cache` 表记录其哈希与元数据。

---

## 2. 数据流

```text
浏览器（生产页旁白面板）
  └─ POST /v1/workspaces/:ws/orchestration/runs
        { narration: { enabled, voiceId?, speed, timingPolicy } }   ← 写入 narration-request.json
        │
        ▼
SQLite v6（新增 speech_cache / export_bundles）
  └─ synthesize_voice：SpeechService.synthesizeNarration()
        每个镜头 → cacheKey = sha256(stableJson({provider, model, voiceId, language, speed, text}))
        命中：重新哈希磁盘 WAV，不符即驱逐重生；未命中：SpeechPort.synthesize → ffmpeg 归一化 → 写缓存
        reconcileStoryboardWithNarration()  → 延长溢出镜头，或在 fail_on_overflow 下抛出
        重写 input.json（storyboard 延长 + narration clips），重算 digest
  └─ generate_subtitles：buildSrtFromTimeline(frozen storyboard, clips)
        → parseAndValidateSrt()（独立解析器）→ 写盘 → **重新读取磁盘字节再校验一次**
  └─ render_video：RenderProcessExecutor（5A 不变）
        worker：prepareAudioDir() 复制并复验 WAV → <Audio staticFile(clip.src)> → AAC 编码
        ffprobe 复核音频流 + volumedetect → manifest.narration / manifest.subtitles
  └─ register_artifacts：登记 video_mp4 / subtitles_srt / render_manifest / artifact_receipt
        │
        ▼
GET/POST …/orchestration/exports（Gate 3 守门）
  └─ 校验：video.stage ∈ {approved, exported} ∧ review.status === approved
           ∧ storyboard.briefRevisionId 与当前 scriptVersion 一致（否则 export_stale）
           ∧ 四个产物重新哈希与登记行一致（否则 export_hash_mismatch）
  └─ 写入 export_bundles（MP4/SRT/manifest 三个哈希 + scriptVersion）
GET …/artifacts/:id/download   ETag = sha256
```

### 2.1 旁白时间对齐

- 每个镜头一个 `<Sequence>`（场景边界）+ 内层 `<Sequence from={startOffsetFrames}>`（默认 150 ms 前导静音，避免语音贴住硬切）。
- `reconcileStoryboardWithNarration` 用 `ceil((startOffsetMs + durationMs + tailPadMs) / 1000 × fps)` 计算所需帧数；不够就延长**该镜头**，`tailPadMs` 默认 200 ms。
- 延长时间写入 `narration.json.adjustments`，随渲染任务进入 `manifest.narration.adjustments`，并参与 `jobDigest`。
- `fail_on_overflow` 不截断、不延展，直接以 `narration_overflow` 终态失败（确定性错误，不重试）。

### 2.2 SRT 与冻结帧时间轴

- 字幕窗口取冻结 `storyboard` 的累计帧数换算的毫秒，而不是编辑器的 `durationSec`——所以字幕描述的正是渲染出的那个文件。
- 有旁白时，字幕窗口缩到语音区间 `[sceneStart + startOffsetMs, min(sceneEnd, +durationMs)]`；多条字幕按字符数加权分配。
- 超过 24 字的句子优先按句号切分，单句过长则硬换行，**不丢字**。
- `parseAndValidateSrt` 是不信任生成器的独立解析器：序号必须从 1 连续；时间戳 `HH:MM:SS,mmm` 且 mm/ss ≤ 59、mmm ≤ 999；`start < end`；相邻条目不重叠；最后一条 ≤ 视频总长 + 250 ms 容差。任一不满足 → `subtitle_invalid`，运行失败，导出永不放行。

---

## 3. 契约与数据库变更

| 变更 | 位置 | 兼容策略 |
|---|---|---|
| `NarrationClipV1` / `NarrationInputV1` / `SpeechVoiceProfile` / `SubtitleCueV1` | `libs/domain/src/narration.ts` | 新契约；`NarrationClipV1` 带 `cacheKey`、`sha256`、`license`、`synthetic` |
| `RenderInputV1.narration?` | `libs/domain/src/render.ts` | **可选**：5A/Step 1 的静音 fixture 无需迁移；存在时才挂 `<Audio>` |
| `RenderAudioAssetV1` / `RenderFixtureV1.audio[]` | 同上 | 默认 `[]`；静音 fixture 继续有效 |
| `RenderManifestV1.ffprobe.audio?` / `.narration?` / `.subtitles?` | 同上 | 全部可选；只有真正带音轨/字幕时才出现 |
| `ExportBundleV1` / `ExportBundleDetailV1` | `libs/domain/src/orchestration.ts` | 新契约；`scriptVersion`、三个 SHA256、`files[]`、`narration?` |
| `ORCHESTRATION_STEPS` 从 5 步扩到 7 步 | `libs/domain/src/orchestration.ts` | 新增 `synthesize_voice` / `generate_subtitles`；关闭旁白时**创建即标 skipped**，不偷偷跳过 |
| SQLite `user_version` v5 → v6 | `apps/api/src/db/database.ts` | 只新增 `speech_cache`、`export_bundles` 两张表与索引；既有表原样保留（`database-v6.test.ts` 验证） |
| `exportBundleStore` | `apps/api/src/db/export-bundle-store.ts` | 列表/读取按 `workspace_id + video_id + created_at DESC` |

`SpeechPort`（`libs/ports/src/speech.ts`）是唯一的外部边界：`synthesize()` 返回原始字节 + 溯源（provider / model / voiceId / license / synthetic），归一化、哈希、缓存都在其上的 `SpeechService` 完成。凭证只存在于适配器的 `Authorization` 头。

---

## 4. 语音适配与故障策略

| 场景 | 行为 | 证据 |
|---|---|---|
| 未配置 / `ASVS_TTS_PROVIDER` 为空 | `isConfigured() === false`；创建运行即 **503**（`tts_not_configured`），不会静默降级为无声 | `orchestration.test.ts`「旁白请求在 TTS 未配置时返回 503」 |
| 401 / 403 | `auth_failed`，**不重试**；文案只提示检查 `ASVS_TTS_API_KEY`，不含密钥 | `openai-compatible-adapter.test.ts` |
| 429 | 按 `Retry-After`（或指数退避 + 抖动）重试，最多 `maxRetries` 次；耗尽后为可重试错误，**已缓存的片段直接复用** | 同上 |
| 5xx / 超时 / 网络失败 | 可重试，受同一重试预算约束 | 同上 |
| 返回空字节 | 视为可重试的 provider 错误 | 同上 |
| 缓存文件被篡改 / 缺失 | 驱逐并重新合成，绝不渲染哈希不符的字节 | `speech-service.test.ts` |
| 进程并发相同请求 | `inFlight` 去重，只发一次 provider 调用 | `speech-service.test.ts` |
| 响应体 / 日志 | `redactSecrets()` 截断 300 字符并脱敏；密钥永不出现在错误文案、日志或 `/v1/health` | `routes/orchestration.test.ts`「health … 不泄露凭证」 |

音频归一化（`apps/api/src/speech/normalize-audio.ts`）：provider 输出（mp3 / wav / opus / pcm）统一转成 **WAV `pcm_s16le` 48 kHz 单声道**，再用 ffprobe 复核编码 / 采样率 / 声道；写缓存采用「先写临时文件再 rename」，崩溃不会留下半截文件。

音色诚实性：

- `deterministic_test` 适配器**只能**通过显式 `ASVS_TTS_PROVIDER=deterministic_test` 启用，且永远返回 `synthetic: true`；
- 清单、导出包、生产页与审核页均显示 **`测试合成音轨 · 非真人配音`**；
- E2E 的 fixture API 自己 seed 的 MP4 是带 `usingPlaceholder` / `seeded` 标记的占位文件，从不冒充真实成片（真实音轨证明只来自 `pnpm export:verify`）。

---

## 5. 渲染 worker 的音轨处理

- `prepareAudioDir()`：路径必须位于 `public/audio`，复制前复验 `sha256`，ffprobe 复核时长（±50 ms）/ 采样率 / 声道，复制后再哈希一次——校验与渲染之间换文件无法进入成片。
- `<Audio src={staticFile(clip.src)}>` 只出现在 `libs/render/src/storyboard-composition.tsx`；`libs/render` **没有**网络请求，也不读外链音频。
- 编码：`renderMedia({ codec: 'h264', audioCodec: 'aac', audioBitrate: '192k' })`。
- 渲染后 ffprobe 断言：存在音频流、codec = `aac`、采样率 48 kHz、声道数一致、A/V 时长差 ≤ 500 ms；`ffmpeg volumedetect` 证明非静音。任一不满足 → 非 0 退出，不写回执。
- 静音回归：没有 `narration` 的 5A / Step 1 fixture 不挂 `<Audio>`，`expectAudio` 分支关闭，`ffprobe.audio` 保持缺省——`pnpm render:fixture && pnpm verify:render` 的黄金样片 SHA256 不变（见 §7 验证记录）。

---

## 6. 强制故障场景（20 项验收）

`pnpm export:verify` 的断言逐条对应计划要求：

| # | 场景 | 断言 |
|---|---|---|
| 1 | 七个步骤 | 全部 `succeeded`，且步骤数为 7 |
| 2 | 诚实标注 | `narration.json` 有 2 段、`synthetic === true`，许可可读 |
| 3 | 溢出不截断 | intro 片段时长 > 12,000 ms |
| 4 | 只延长溢出镜头 | 冻结 storyboard：intro > 360 帧，outro === 90 帧 |
| 5 | SRT 登记 | `subtitles_srt` 产物存在，SHA256 与磁盘一致 |
| 6 | 编码 | ffprobe：视频 `h264`、音频 `aac` |
| 7 | 音画一致 | 音频流与视频流时长差 ≤ 500 ms |
| 8 | 非静音 | mean_volume > −90 dB |
| 9 | 四方哈希 | 文件 = receipt = manifest = 登记行 |
| 10 | 清单溯源 | `manifest.narration` 含许可、`synthetic`、`timingPolicy` |
| 11 | SRT 独立校验 | 独立解析器：序号连续、单调、无重叠、不超时长 |
| 12 | 不重复计费 | 第二次相同运行：`providerCalls === 0`、`cacheHits === 2` |
| 13 | Gate 3 | 未审批视频导出 → 409 `export_not_approved` |
| 14 | 导出包文件 | 4 个文件，含 `video_mp4` 与 `subtitles_srt` |
| 15 | 版本绑定 | `runId` 与 `scriptVersion` 与运行一致 |
| 16 | 时长与溯源 | 导出包记录 `videoDurationMs` / `audioDurationMs` / `synthetic` |
| 17 | 下载复验 | 四个文件字节数与 SHA256 与导出包一致 |
| 18 | 下载可用 | 下载的 MP4 仍有音轨；下载的 SRT 仍通过独立校验 |
| 19 | 可查询 | `listExportBundles` 能列出该包 |
| 20 | 回归 | （§7 的 lint / typecheck / test / E2E / 渲染预算矩阵） |

单元 / 集成层另有覆盖（不依赖 Remotion 的部分）：

| 测试 | 覆盖 |
|---|---|
| `libs/domain/src/format.test.ts` | `formatSrtTimeFromMs` 的毫秒进位（2.9996 s → `00:00:03,000`，跨分 / 时进位、负数夹取） |
| `libs/domain/src/srt.test.ts` | 生成 / 解析往返、序号跳号、重叠、越界、BOM、`start ≥ end`、超时长 |
| `apps/api/src/speech/speech-service.test.ts` | 缓存命中、键包含全部字段、篡改驱逐、丢失重生、48 kHz 单声道 |
| `apps/api/src/speech/openai-compatible-adapter.test.ts` | 401 不重试、429 重试与 `Retry-After`、耗尽、空响应、超时、取消、凭证不外泄 |
| `apps/api/src/orchestration/orchestrator-narration.test.ts` | 7 步推进、extend_scene、缓存 0 次调用、Gate 3 四类 409（未审批 / 脚本变更 / 篡改 / 无产物） |
| `apps/api/src/db/database-v6.test.ts` | v5→v6 迁移只加表、旧数据保留 |
| `libs/adapters-http/src/http-orchestration-client.test.ts` | 导出创建 / 列表 / 409 透传 / 健康检查 |
| `apps/api/src/orchestration/orchestrator.test.ts` | 取消落在「标记 running 之后、渲染启动之前」的窗口时，绝不留下无人终止的渲染进程（5B 顺带修复的竞态） |

---

## 7. 验证记录（2026-11-27）

| 命令 | 结果 |
|---|---|
| `pnpm exec nx run-many -t lint typecheck test --skip-nx-cache` | 15 个项目通过；**50 个测试文件 / 434 个用例**（domain 136 · api 182 · mock-services 31 · browser-worker 24 · render-worker 23 · adapters-http 19 · state 16 · render 3 …） |
| `pnpm export:verify` | **20/20 通过**（见 §1） |
| `pnpm render:fixture && pnpm verify:render` | 静音黄金样片 SHA256 与 docs/11 一致，零回归 |
| `pnpm build && pnpm budget` | 初始 **228 kB** gzip（预算 230；5A 227.2）· Production **21.2 kB**（预算 24；5A 19.2）· Review **17.1 kB**（预算 22；5A 15.0）· 最大 chunk 126.7 kB（预算 160）。全部达标 |
| `pnpm test:e2e` | **45/45 通过（2.0 分钟）**：桌面 / 平板 / 移动三个项目；新增 `audio-export-real-flow.spec.ts` 3 条，`orchestration-real-flow.spec.ts` 断言更新为含音轨格式 |
| `pnpm lint:boundary-check` | 4/4 探针按预期 |

---

## 8. Web 接入

| 页面 | 行为 |
|---|---|
| 生产监控 `ServerOrchestrationPanel` | 新增旁白面板：开关（`合成旁白音轨（TTS）`）、音色 `Input`、语速 `Select`（0.85–1.2）、溢出策略 `Select`（`extend_scene` / `fail_on_overflow`）；合成音色显示 `测试合成音轨 · 非真人配音`；TTS 未配置时禁用启动按钮并说明「服务端会拒绝创建运行（503），不会静默降级为无声」；关闭旁白时警告会得到无声 MP4 且导出为 `export_incomplete`。产物区新增音轨 / 响度 / 字幕事实与 SRT 下载 |
| 审核 `ReviewArtifactPanel`（Gate 3 交付面板） | 未通过 Gate 3 时明确说明「服务端会以 409 拒绝导出」；通过后可「生成交付包」，逐文件下载 MP4 / SRT / manifest.json 并在下载前用 WebCrypto 校验 SHA256；显示旁白溯源与合成标注 |
| 浏览器内导出 | 明确标注「浏览器内导出（草稿）」「这些文件不经过服务端校验；正式交付请使用上方 Gate 3 交付包」 |
| 格式标注 | 有音轨 `16:9 · H.264 + AAC 48kHz · 含旁白音轨`；无音轨 `16:9 · H.264 · 无音轨` |
| 首屏预算 | 适配器仍经 `libs/state/src/orchestration.ts` 动态 `import('@asvs/adapters-http')`；Production / Review 路由独立 chunk |

---

## 9. 复现

```powershell
pnpm exec nx run-many -t lint typecheck test --skip-nx-cache
pnpm export:verify               # 真实旁白 + AAC + SRT + Gate 3 导出（20 项）
pnpm render:fixture; pnpm verify:render   # 静音黄金样片零回归
pnpm build; pnpm budget
pnpm test:e2e
```

`ASVS_KEEP_VERIFY_DIR=1` 保留临时数据库与 MP4 / SRT / manifest 供人工检查。`pnpm export:verify` 默认使用确定性测试音色，不需要任何外部凭证；真实音色在 `apps/api/.env.local` 配置 `ASVS_TTS_PROVIDER=openai_compatible` + `ASVS_TTS_API_URL` + `ASVS_TTS_API_KEY`。

---

## 10. 明确未做（5B 边界）

- 背景音乐、ducking、音量自动化（只做旁白单轨）。
- 多语言 / 多画幅：只支持 16:9 与工作区语言对应的 zh-CN / en-US 音色。
- 词级卡拉 OK 字幕（只做句级 SRT）。
- 单镜头局部重渲染 / 片段拼接（渲染仍为全片）。
- 服务端驱动 Playwright、隐私 QA、LLM AI Director（5C / 5D / 5E）。
- 真实商用音色的试听与人工挑选 UI；当前只用服务端默认音色或用户输入的 voiceId。
- 导出包的对象存储 / CDN / 签名 URL：文件仍落在本机 `data/artifacts`，下载走本机 API。
- 无鉴权、无租户隔离、单写入者 SQLite（沿用 5A 边界）。

---

## 11. 关联文档

- [docs/05 领域模型](05-DOMAIN-DATA-MODEL-AND-CONTRACTS.md)：`ArtifactReceiptV1`、`RenderManifestV1`
- [docs/06 Agent 工作流](06-AGENT-WORKFLOWS-AND-ORCHESTRATION.md)：§5 可恢复执行、故障测试
- [docs/07 渲染](07-VIDEO-CAPTURE-RENDER-AND-EDITOR.md)：§7 旁白与字幕、ffprobe 门禁
- [docs/11 渲染切片](11-RENDER-SLICE.md) / [docs/12 录屏切片](12-CAPTURE-SLICE.md) / [docs/13 服务端编排切片](13-ORCHESTRATION-SLICE.md)：本切片复用的 worker、编排与产物格式
- [docs/10 下一阶段计划](10-NEXT-PHASE-PLAN.md)：§7B 切片状态
