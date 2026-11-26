# 12 · 真实录屏切片（Step 2 验收记录）

> 状态：**已执行**｜日期：2026-11-26｜分支：`feat/capture-slice`（工作区改动，尚未提交）
> 对应计划：[docs/10 §6](10-NEXT-PHASE-PLAN.md)（S2-1 ~ S2-6）
> 结论先说：`workers/browser-worker` 用已批准的 DemoPlan 驱动 Playwright 录制 web-studio 自身，20 步（11 条 UI 断言 + 9 条交互）全部通过后才写 `CaptureReceipt`；同一计划重复 3 次通过率 100%；录屏 MP4 已进入 Step 1 渲染管线，产出 30 秒成片，且 `manifest` 同时记录素材与录屏文件的 SHA256。**Web UI 内的生产与导出仍然是模拟**，本切片是独立 CLI worker。

---

## 1. 结论与证据

| 项 | 结果 |
|---|---|
| DemoPlan | `workers/browser-worker/plans/web-studio-tour.yaml` · `plan_web_studio_tour` · 20 步（11 条断言 + 9 条交互） |
| 审批摘要 | `104ce0164a41bedce12dc7c4ccbbfb7858fe7ca86e6ea0f144e996b3af4d2142` |
| 录制目标 | `http://localhost:4200`（production build，`vite preview`）· 1920×1080 · DPR 1 |
| 环境 | `zh-CN` · `Asia/Shanghai` · dark · 固定 `2026-11-20T12:00:00.000Z` |
| UI 断言 | **11/11 通过**；无断言或任一断言失败都不会生成回执 |
| 原始录屏 | `raw/capture.webm` · 3.76 MiB · VP9 · 19,600ms · 25fps |
| 成片片段 | `web-studio-tour.mp4` · 1920×1080 · 30fps · 17,967ms · h264 High |
| 片段 SHA256 | `6da634016a56042d5970b1309dd004e25d33cabcba608ac1ad39f7917eff6515` |
| 截图 / trace | 11 张 PNG · `trace.zip`（14,346 KiB） |
| 录屏回执 | `dist/browser-worker/web-studio-tour/capture-receipt.json` |
| 渲染输入 | `dist/browser-worker/web-studio-tour/captured-30s.json` |
| 镜头时长 | `3s 标题 + 18s real_demo + 4s 证据 + 3s 回执 + 2s CTA = 30s` |
| 重复执行 | 3/3 通过，通过率 **100%**（门槛 80%） |
| Allowlist 探针 | PASS：越界导航在发出请求前被拒绝，越界请求 0 条 |
| 独立复核 | `pnpm verify:capture` 重新计算哈希、核对回执 / 素材 / 渲染 fixture，全部一致 |
| 成片 | `dist/render-worker/captured-30s/captured-30s.mp4` · 3.52 MiB · 30,000ms · 900 帧 |
| 成片 SHA256 | `b88c448d36f7ffcb7148aca09466a6cf3627109c9f61ee8ae69b70d7b2eca0e8` |
| 渲染标识 | `job_render_captured_30s` / `artifact_captured_30s`（按 fixture 派生，不再复用 golden 标识） |
| 素材哈希（manifest） | `6da63401…7eff6515`，与录制片段逐字节一致 |

抽帧人工检查（3.5s / 6s / 9s / 13s / 15s / 17s / 20.5s）确认 `real_demo` 镜头完整覆盖：工作台、视频库筛选与搜索、审核落地页、分镜工作室、生产监控、审核与导出；1920×1080 录屏按严格 16:9 内框完整显示，web-studio 自身顶栏不被裁切；绿色 `真实录屏` 徽标独占一行、不压地址栏；底部字幕位于 `FooterStrip` 之上、不重叠；地址栏文案由 project source / Asset / Plan 元数据派生。

---

## 2. 数据流

```text
DemoPlan YAML（数据，不是代码）
  └─ parseDemoPlanFile()                 workers/browser-worker/src/plan.ts
        Zod 校验 action / selector / origin / fixture key
        SHA256(stableStringify(plan − approval)) = approvedPlanDigest
  └─ executeDemoPlan()                   workers/browser-worker/src/executor.ts
        reset fixture（清 localStorage、固定时钟、重载）
        安全 selector DSL → Playwright semantic locator
        每一步先断言；失败即停，写 failure-report + screenshot
  └─ Playwright recordVideo               raw/capture.webm（VP9）
  └─ planClip() + transcodeClip()        workers/browser-worker/src/media.ts
        从首个断言之后开始，ffmpeg 裁剪转码 → 1920×1080 / 30fps / h264
  └─ CaptureReceipt + Asset(media)       libs/domain/src/capture.ts
        assertions.failed 必须是 0，steps 必须全部 passed
  └─ captured-30s.json                   RenderFixtureV1 + media[]
  └─ workers/render-worker/src/media.ts  preparePublicDir()
        校验 fixture media ↔ Asset ↔ 文件哈希 / ffprobe 元数据
        复制到临时 public 目录，再哈希一次
  └─ Remotion Storyboard                  OffthreadVideo(staticFile(asset.media.src))
  └─ receipt + manifest                  manifest.assetHashes 记录 mediaSha256 / mediaSourceFile
```

「录屏 → 成片」链路是单向可追溯的：`CaptureReceipt` 记录片段哈希，`RenderFixtureV1.media` 记录源文件，渲染 `manifest` 再记录一次；`scripts/check-render-artifact.mjs` 会重新读取源文件并比对。

---

## 3. DemoPlan 是数据，不是脚本

计划只认识七个动作：`navigate` / `click` / `fill` / `press` / `wait_for` / `assert` / `capture`。未识别的动作、缺失的必填字段、多余字段都会在打开浏览器前被 Zod 拒绝。

selector 只允许语义前缀：

```text
role=button,name=Start
role=link,name="视频工程"     ← 双引号表示精确匹配
heading=视频库
label=搜索视频
placeholder=搜索…
testid=task-status-running
text=1 条结果
alt=产品截图
```

CSS、XPath、`nth-child`、`:has()`、`document.` / `window.` 一律拒绝；schema 与运行时共用同一份白名单（`CAPTURE_SELECTOR_PREFIXES` / `SAFE_ARIA_ROLES`）。schema 在**打开浏览器前**就校验非 `navigate` 步骤的 `target` 必须是受支持前缀，裸 CSS（`.btn` / `#submit`）与裸 XPath（`//button[1]`）连 `plan-digest` 都算不出来，运行时的 `parseSelector()` 再用同一函数复核一次。`role=` 只接受安全 ARIA role 列表，且只支持 `name=` 或 `level=`，额外参数会被拒绝。

**审批摘要**覆盖除 `approval` 外的整份计划。改任何一步、任何 origin、viewport 或 fixture，摘要都会变化，`loadApprovedDemoPlan()` 会拒绝执行。没有 `--skip-approval`。重新审批的流程是：修改计划 → `pnpm capture:plan-digest` → 人工审阅 → 把新摘要写回 `approval.approvedPlanDigest`。

fixture 的 key 也不允许出现 `password` / `secret` / `token` / `apiKey` / `privateKey` 一类名称；录屏日志不回显 fixture 值。

---

## 4. 断言优先

`captureReceiptV1Schema` 是成功路径的硬约束：

```ts
assertions: { total: int ≥ 1, passed: int ≥ 1, failed: literal 0 }
```

外加 superRefine：

- 所有 step 的 `status` 必须是 `passed`；
- Asset 必须 `mock: false` 且带 `media`；
- `asset.media.sha256` / 尺寸 / 时长必须与片段一致；
- 渲染 fixture 的 media 必须与 Asset 对齐。

因此「脚本正常退出」不等于成功：

- 计划里没有任何断言 → `capturePassed()` 返回 false；
- 任一断言失败 → 该 step `failed`，后续 step 标记 `skipped`；
- 出现越界网络请求 → 即使断言都过了也判失败。

失败路径不写 `CaptureReceipt`、`asset.json` 或 render fixture，而是写 `failure-report.json` + 失败截图（`*-FAILED.png`）+ trace + raw WebM，进程非 0 退出。

本次开发过程中真实触发过两次失败（selector 不唯一、link 名称不匹配）：两次都只生成 failure report 与截图，没有生成回执；修正计划后重新审批并重跑才通过。这条路径不是纸面设计。

---

## 5. 确定性

| 维度 | 做法 |
|---|---|
| 视口 / DPI | BrowserContext 固定 1920×1080、DPR 1，录屏尺寸同尺寸 |
| 语言 / 时区 / 配色 | `zh-CN` / `Asia/Shanghai` / `dark`，reducedMotion 固定 |
| 时间 | `page.clock.setFixedTime` 固定 `Date`，只影响相对时间文案，不冻结动画 |
| 数据 | 每次录屏前清空 localStorage / sessionStorage 并重载，使用同一份 seed |
| 构建 | 录制 `vite preview` 的 production build；dev server 的按需编译会在成片里留下 loading 画面 |
| 导航 | 计划全部使用应用内点击（侧边栏 / 工作区标签），避免整页重载造成黑屏与闪烁 |
| 裁剪 | 从首个断言之后 800ms 开始，避开录制起点的路由 loading 壳；`planClip()` 有单测 |
| 编码 | ffmpeg `-ss` 输入裁剪，libx264 crf 18、yuv420p、30fps、无音轨、faststart |

接受像素级差异，不比较截图像素；通过率与断言结果是结构化指标。

---

## 6. 安全边界

- **allowlist 是精确 origin**（不带路径）。导航前解析并检查；BrowserContext 网络路由再检查一次，未授权请求 `abort` 并记录。
- **越界探针** `plans/blocked-origin.yaml` 是已批准计划，第一条 `navigate` 指向 `https://example.invalid/`。`pnpm capture:safety` 用真实 Chromium 执行它，唯一可接受结果是「导航被 allowlist 拒绝」，并且 `blockedRequests` 为 0——请求根本没有发出去。
- `data:` / `blob:` / `about:` 只用于应用自身资源；`javascript:` 被拒绝。
- 计划与日志不包含凭据；fixture key 的敏感命名会被 schema 拒绝。
- service worker 在录制 context 中被禁用，避免缓存绕过网络守卫。

---

## 7. 与 Step 1 的衔接

`Asset` 增加可选的 `media`（`src` / MIME / 尺寸 / 时长 / SHA256 / `capturePlanId` / `captureReceiptRef`）。只有 `mock: false` 且带 `media` 的 Asset 才会被 `findRealCaptureAsset()` 认作真实素材；mock 条目即使 id 相同也不会被静默升级。

`RenderFixtureV1.media[]` 记录工作区相对路径和哈希。render worker 在打包前：

1. 拒绝 mock / media 不一致；
2. 校验 MIME、Asset 哈希、fixture 条目、文件存在与 SHA256；
3. ffprobe 校验尺寸与时长，防路径穿越；
4. 复制到临时 public 目录并再次哈希；
5. 拒绝没有被任何输入 Asset 引用的 media 条目。

渲染后 `manifest.assetHashes[]` 同时记录 `sha256`（合成素材摘要）、`mediaSha256`、`mediaSourceFile`、`mediaMimeType`；`pnpm verify:render:captured` 会重新读取源文件验证。

`RealDemoScene` 只有在真实素材存在时渲染 `OffthreadVideo`；否则回退到带 `REAL_DEMO / PLACEHOLDER` 水印的占位组件，绝不把 mock 画面伪装成真实录屏。

---

## 8. 复现

前置：Node >= 22、pnpm 10、`ffmpeg` / `ffprobe` 在 `PATH`、Playwright Chromium 已安装。

```bash
pnpm build                    # 产出 dist/apps/web-studio，供 vite preview 使用
pnpm capture:demo             # 执行已批准计划 → dist/browser-worker/web-studio-tour
pnpm verify:capture           # 重新哈希 + ffprobe + Asset / fixture 一致性
pnpm capture:safety           # docs/08 §9 用例 2：越界导航必须在请求前被拒绝
pnpm capture:repeat           # 3 次重复执行，通过率 < 80% 失败
pnpm render:captured          # 用真实片段渲染 30 秒成片
pnpm verify:render:captured   # 校验 MP4 / manifest / receipt / 素材哈希
```

本机观测耗时（Windows 11，production build 已构建）：单次录屏约 23–25s，3 次重复约 70s，Remotion 渲染约 2–3 分钟。

重算审批摘要：

```bash
pnpm capture:plan-digest
```

`--serve=dev` 可强制使用开发服务器（默认 `--serve=preview`）；`--no-serve` 要求目标地址已经就绪。

---

## 9. Exit Gate 对照

| Gate | 状态 | 证据 |
|---|---|---|
| 同一 DemoPlan 重复执行，记录通过率与失败原因分布 | ✅ | `dist/browser-worker/repeat/web-studio-tour-2026-11-26T14-12-27-839Z/repeat-report.json`：3/3，100%，门槛 80% |
| 每次失败都有 screenshot + trace | ✅ | 失败路径写 `failure-report.json` + `*-FAILED.png` + `trace.zip` + raw WebM；开发中两次真实失败均验证 |
| 断言失败 → 判失败（有专门测试） | ✅ | `outcome.test.ts`（零断言 / 断言失败 / 步骤失败）；`capture.test.ts` 回执 schema 拒绝 `failed > 0` |
| 录屏产物能进入 Step 1 渲染管线并产出成片 | ✅ | `pnpm render:captured` → 30,000ms / 900 帧 MP4；`verify:render:captured` 通过 |
| 访问非白名单域名被阻断（docs/08 §9 用例 2） | ✅ | `pnpm capture:safety`：PASS，越界请求 0 |
| 计划是数据，未识别 action / 危险 selector 被拒绝 | ✅ | `capture.test.ts`、`selector.test.ts`、`plan.test.ts` |
| CI 跑通 capture gate | ⚠️ 已配置，未在真实远端验证 | `.github/workflows/ci.yml` 的 `capture` job；仍受 S0-1（无 `origin`）阻塞 |

---

## 10. 已知边界

| 边界 | 说明 | 下一步 |
|---|---|---|
| 字体 | 依赖系统 CJK 字体；CI 安装 `fonts-noto-cjk`，未做字体子集化 | 视觉回归前固定字体包 |
| Web UI 仍是模拟 | 生产监控不启动 Playwright；录屏通过 CLI 触发 | Step 3 接后端任务队列 |
| 只录制自家 fixture | 只有 web-studio + 本地 seed，没有外部 staging / 登录态 | 外部环境需要账号隔离方案 |
| selector 走查成本 | 页面文案改名会让计划失败；这是有意的，失败会给出截图 | 计划变更必须重新审批 |
| 隐私 QA 未实现 | docs/07 §9 的敏感信息检查还没接入 | 接外部环境前必须补 |
| 产物只落本地 | `storageRef` 是工作区相对路径，无对象存储 / 队列 | Step 3 |
| 片段固定 16:9 | 与 Step 1 渲染一致；竖屏需要独立布局 | 后续 |
| CI 未远端验证 | 与 render gate 相同，仓库没有 `origin` | 首次推送后 |
