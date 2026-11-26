# 11 · 真实渲染切片（Step 1 验收记录）

> 状态：**已执行**｜日期：2026-11-20｜分支：`perf/route-splitting-budget-e2e`
> 对应计划：[docs/10 §5](10-NEXT-PHASE-PLAN.md)（S1-1 ~ S1-7）
> 结论先说：固定输入已产出可播放的 30 秒 MP4，ffprobe、全片解码与 SHA256 回执一致；**Web UI 内的导出仍然是模拟**，本切片是独立 CLI worker。

---

## 1. 结论与证据

| 项 | 结果 |
|---|---|
| 输入 | `workers/render-worker/fixtures/golden-30s.json`（6 场景 / 30 秒 / 30fps） |
| 输出 | `dist/render-worker/golden-30s/golden-30s.mp4` |
| 编码 / 规格 | h264 High · yuvj420p · 1920×1080 · 30fps · 30000ms · 900 帧 |
| 大小 | 5,336,788 bytes（5.09 MiB） |
| SHA256 | `b1451bfbb7a62b6bdbcf7a666237cff44db7ff75b31cb0ea48251642326ccd8a` |
| 渲染器 | Remotion `4.0.545` · composition `Storyboard` |
| 独立复核 | `pnpm verify:render` 重新计算 MP4 哈希、核对 manifest / receipt / ffprobe，全部一致 |
| 全片解码 | `ffmpeg -v error -i out.mp4 -f null -` 无错误输出 |

抽帧人工检查（2s / 8s / 17s / 22s / 28s）确认：大标题动效、真实录屏占位、深色主题与 CTA 画面均有正确留白、字标与页脚，没有越界或裁切。

覆盖范围说明：黄金样片包含 `motion_graphics`、`real_demo`、`cta` 三类镜头；`title` 与 `generated_visual` 组件已实现，但该 fixture 忠实于种子视频的镜头类型，未包含这两类。

---

## 2. 数据流

```text
VideoProject + KnowledgeSnapshot + BrandKit + Assets
  └─ buildStoryboardV1()            libs/domain/src/render.ts
       冻结 fps、每场景 durationFrames、revision、visual
  └─ buildRenderInputV1()           只保留被场景引用的 assets；拒绝非 16:9
  └─ RenderInputV1（JSON，可序列化）
  └─ workers/render-worker/src/render-fixture.ts
       bundle(libs/render/src/entry.tsx)
       selectComposition() → 与 Storyboard 核对 fps / 尺寸 / 总帧数
       renderMedia(h264, crf 18)
       ffmpeg 全片解码 + ffprobe
       ArtifactReceipt + RenderManifest
```

确定性约束：

- `libs/render` 内**没有**网络请求、`Date.now()`、随机数或外部字体加载；
- 所有尺寸由 `u(n) = n% × 1920` 推导，场景内容只来自 `RenderInputV1`；
- `stableStringify` 对 render input / storyboard / scene / asset 计算稳定 digest，写入 manifest；
- 分镜帧数由 `durationSec × fps` 派生，不信任可能过期的缓存值。

---

## 3. IR 与契约变更

| 变更 | 位置 | 兼容策略 |
|---|---|---|
| `Scene.visual` 判别联合（`title` / `cta` / `real_demo` / `motion_graphics` / `generated_visual`） | `libs/domain/src/schemas.ts` | 字段可选；旧 `visualType` 由 `deriveSceneVisual` 映射 |
| `Scene.revision`、`Scene.durationFrames` | 同上 | `revision` 默认 1；`durationFrames` 可选，渲染前派生 |
| `VideoProject.fps` | 同上 | 默认 30（`DEFAULT_VIDEO_FPS`） |
| `StoryboardV1` / `RenderInputV1` / `ArtifactReceiptV1` / `RenderManifestV1` | `libs/domain/src/render.ts` | 新契约；`RENDER_SCHEMA_VERSION = '1'` |

`ArtifactReceipt` 字段：`sha256`、`mimeType`、`byteSize`、`storageRef`、`durationMs`、`width`、`height`、`fps`、`rendererVersion`、`compositionId`、`createdAt`。
`RenderManifest` 额外记录：`renderInputDigest`、`storyboardDigest`、逐场景 `sceneDigests`、`assetHashes`、`renderProfile`、`ffprobe`。

---

## 4. 持久化迁移

- `STUDIO_PERSIST_VERSION = 2`，`persist` 使用 `migratePersistedStudioState(persisted, fromVersion)`。
- v1 → v2 补齐 `fps`、`revision`、`durationFrames`、`visual`；迁移幂等。
- 结构损坏时仍返回原值并由 `studioSnapshotSchema.parse` 安全回退种子，不会抛出到界面。
- `libs/state/src/studio-store.test.ts` 覆盖：v1 字段补齐、重复迁移不变、畸形输入不崩溃。

---

## 5. `real_demo` 占位策略

Step 1 不接真实录屏，但占位画面必须**视觉上不可冒充**：

- 线框浏览器窗口 + 骨架屏 + 斜向 hazard stripes；
- 巨型半透明 `MOCK` 水印；
- 中央虚线面板：`REAL_DEMO / PLACEHOLDER`、`未接入真实录屏`、`此画面为明确标注的占位，不会冒充真实产品录屏`；
- 顶部红色徽标 `未接入真实录屏 · 占位画面`；
- 页脚 `ASSET <id> · MOCK` 与 `STEP 2 · PLAYWRIGHT CAPTURE`。

`generated_visual` 同样带 `生成画面 · 模拟素材` 徽标与页脚说明。

---

## 6. 复现

前置条件：

- Node.js ≥ 22、pnpm 10.18.3；
- `ffmpeg` / `ffprobe` 在 `PATH` 中（CI 依赖 `ubuntu-latest` 预装版本，并用 `ffprobe -version` 显式检查）；
- 中日韩字体（CI 安装 `fonts-noto-cjk`；本地使用系统字体，字形可能略有差异）；
- 首次运行 Remotion 会下载 Chrome Headless Shell 到 `node_modules/.remotion`（CI 已缓存该目录）。

```bash
pnpm install
pnpm render:fixture      # 渲染并写 receipt.json / manifest.json
pnpm verify:render       # 独立复核 MP4、manifest、receipt、ffprobe
```

输出目录：`dist/render-worker/golden-30s/`（MP4、`receipt.json`、`manifest.json`）。

失败行为：bundle / composition 元数据核对 / renderMedia / 全片解码 / ffprobe 任一步失败都会以非 0 退出，不写成功回执。

CI：`.github/workflows/ci.yml` 的 `render` job 在受影响项目中包含 `render-worker` 时运行 `pnpm render:fixture && pnpm verify:render`，并上传 MP4 / manifest / receipt 作为 artifact。

---

## 7. 已知缺口与边界

| 缺口 | 说明 | 何时处理 |
|---|---|---|
| Web UI 未接渲染 | 浏览器内 MP4 / WebM 导出仍是模拟任务状态，不会产生文件 | Step 3 之后接队列 / 后端 |
| 仅 16:9 | `buildRenderInput` 明确拒绝非 16:9；竖屏需要单独布局 | Step 2 之后 |
| 无音频 | 没有 TTS、配乐或音轨；样片是静音视频 | 单独排期 |
| 字体未打包 | 依赖系统 CJK 字体，跨机器字形可能不同；未做字体子集化 | 视觉回归前 |
| 无转场 / 局部重渲染 | 按计划明确不做；当前每次全片渲染 | S1 稳定后评估 |
| 渲染耗时未记录基线 | 本机单次全片渲染约数分钟，尚未写入指标 | 接入 CI 后采集 |
| 单机、本地路径 | 无队列、对象存储、并发调度；`storageRef` 是本地相对路径 | Step 3 |
| Remotion 许可 | 个人 / ≤3 员工公司免费；更大组织需要公司许可 | 商用前确认 |
| CI 未在真实远端验证 | 仓库仍无 `origin`，S0-1 阻塞 | 首次推送后 |

---

## 8. 与 Step 2 的接口

- `real_demo` 场景已保留 `demoPlanId` / `assetId`；Step 2 产出真实录屏后，用真实素材替换占位组件即可。
- `Asset.mock = false` 的素材可直接进入同一 `RenderInputV1`；渲染管线不需要再改 IR。
- 录屏回执（CaptureReceipt）应与 asset hash 对应，并写入 `manifest.assetHashes`，形成「录屏 → 成片」的可追溯链。

**Step 2 已接入（2026-11-26）**：`RealDemoScene` 通过 `findRealCaptureAsset()` 读取 `mock:false` 且带 `media` 的 Asset，用 `OffthreadVideo` 播放真实片段；render worker 在打包前校验 `RenderFixtureV1.media` 的源文件、SHA256、尺寸与时长，并把 `mediaSha256` / `mediaSourceFile` 写入 `manifest.assetHashes`。实测成片见 `dist/render-worker/captured-30s/captured-30s.mp4`，完整记录见 [docs/12](12-CAPTURE-SLICE.md)。
