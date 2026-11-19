# AI Software Video Studio（ASVS）

一个前端优先、可完整走通的产品视频工作台：把可信的软件事实（功能、Claim、证据）变成可编辑、可生产、可审核的视频工程。

当前版本包含两部分：可交互的商业级前端原型，以及一个真实可运行的渲染切片。项目、知识、分镜、审核与导出数据会真实写入浏览器本地存储；GitHub 授权、AI 模型、录屏、配音与 Web 内导出仍是明确标注的模拟能力。渲染切片通过 CLI 把固定 Storyboard 用 Remotion 真实渲染成可播放的 30 秒 MP4，并输出 SHA256 回执与 ffprobe 校验结果（见 [docs/11](docs/11-RENDER-SLICE.md)）。

---

## 1. 现在可以做什么

- **六步入门**：从项目信息、接入方式、知识来源、品牌套件、演示环境到确定性初始化，生成可编辑的知识快照。
- **结构化知识中心**：功能、Claim、Evidence、PR / Release 时间线、待确认建议、重新验证与审核阻断。
- **四类视频模式**：版本更新、产品宣传、功能教程、社交短片，统一进入 Brief → Director → Storyboard → Editor。
- **有限但真实的 AI Director**：缩短时长、改语气 / 受众、调整顺序、重生成镜头、增删卖点、改写旁白；无法识别的指令会明确拒绝，不假装执行。
- **可编辑分镜与时间线**：拖拽 / 键盘排序、字幕与时长编辑、画面预览、播放头、撤销 / 重做、自动保存。
- **确定性生产监控**：8 步 DAG，支持成功、失败重试、人工审批 Gate、暂停 / 取消与 4× 加速；没有随机假进度。
- **有牙齿的审核**：证据过期、待验证声明、敏感信息、禁用表述、品牌缺失、生产版本不一致都会阻断或提醒。
- **真实文件导出**：工程 JSON 与 SRT 字幕通过 Blob 真实下载；`pnpm render:fixture` 用 Remotion 真实渲染 30 秒 MP4 并写回执 / 清单（CLI，不在 Web UI 内）；Web 内的 MP4 / WebM 仍只展示模拟任务状态。
- **品牌与设置**：品牌字标、主辅色、字体、视觉风格、片头 / CTA 实时预览；品牌变更会使已审核视频失效并需要重新审核。

---

## 2. 快速启动

### 环境

- Node.js **>= 22**（当前开发环境 Node 26）
- pnpm **10.18.3**（`corepack enable` 或全局安装 pnpm 10）
- Windows / macOS / Linux 均可

### 安装与运行

```bash
pnpm install
```

首次运行 Playwright 测试前安装 Chromium：

```bash
pnpm exec playwright install chromium
```

启动开发服务器：

```bash
pnpm dev
```

打开 <http://localhost:4200>。默认是深色模式；右上角可切换浅色模式。

### 构建与验证

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

也可以一次运行前半段质量门禁：

```bash
pnpm validate
```

生产构建产物输出到 `dist/apps/web-studio`。`pnpm build` 会在构建后执行 `bundle-budget.json` 中的体积预算，超限即失败。

### 真实渲染样片（CLI）

需要 `ffmpeg` / `ffprobe` 在 `PATH` 中，以及中日韩字体；首次运行 Remotion 会下载 Chrome Headless Shell 到 `node_modules/.remotion`。

```bash
pnpm render:fixture      # 渲染 30 秒黄金样片 → dist/render-worker/golden-30s
pnpm verify:render       # 独立复核 MP4 / manifest / receipt / ffprobe
```

输出包含 `golden-30s.mp4`、`receipt.json`（SHA256、时长、尺寸、fps、渲染器版本）与 `manifest.json`（输入 digest、逐场景 digest、素材哈希）。详见 [docs/11](docs/11-RENDER-SLICE.md)。

---

## 3. 页面与交互清单

| 页面 | 路由 | 关键交互 | 真实写入 |
| --- | --- | --- | --- |
| 工作台概览 | `/` | 项目切换、待办跳转、继续编辑、最近生产 / 审核入口 | 否（聚合读取） |
| 项目列表 | `/projects` | 搜索项目、进入项目、创建新项目 | 否 |
| 六步入门 | `/onboarding` | 4 种接入方式、模拟连接、校验、草稿恢复、初始化 | 是，创建项目与知识快照 |
| 项目总览 | `/projects/:projectId` | 知识健康度、视频列表、最近运行、待办 | 否 |
| 知识中心 | `/projects/:projectId/knowledge` | 功能筛选 / 搜索、编辑功能、接受 / 拒绝建议、重新验证、查看证据与时间线 | 是 |
| 项目视频库 | `/projects/:projectId/videos` | 阶段筛选、搜索、改名、删除、进入工程 | 是，改名 / 删除 |
| 视频策划向导 | `/projects/:projectId/videos/new` | 模式、目标、受众、功能、时长、画幅、语言、风格、模板 | 是，生成 Brief + 分镜 |
| 全部视频 | `/videos` | 跨项目筛选、搜索、按阶段过滤 | 否 |
| AI 导演 | `/videos/:videoId/director` | 自然语言修改、变更清单、快捷命令、脚本确认 | 是 |
| 分镜工作室 | `/videos/:videoId/storyboard` | 拖拽 / 上下移动、增删镜头、编辑字幕 / 时长 / 视觉、素材与审核状态 | 是 |
| 视频编辑器 | `/videos/:videoId/editor` | 播放 / 定位、时间线、字幕、画幅、模板、撤销 / 重做、快捷键 | 是 |
| 生产监控 | `/videos/:videoId/production` | 场景选择、启动、暂停 / 继续、取消、重试、审批 Gate、加速、日志 | 是，运行与视频阶段 |
| 审核与导出 | `/videos/:videoId/review` | 8 项检查、批准 / 退回、格式与分辨率、真实 JSON / SRT 下载、模拟 MP4 / WebM | 是，审核与导出记录 |
| 设置与品牌 | `/projects/:projectId/settings` | 品牌套件、项目信息、来源同步、重置演示数据 | 是 |
| 404 | 任意未知路径 | 回到概览 / 查看项目 | 否 |

全局交互：侧栏折叠、移动端抽屉、命令面板（`Ctrl/Cmd + K`）、主题切换、Demo 边界说明弹窗、Toast、页面级错误边界。

---

## 4. 推荐演示流程（约 8–10 分钟）

1. **工作台**：打开 `/`，查看 Lumen Analytics 的待审核视频、证据过期与待确认建议；点击卡片跳转，确认不是死数据。
2. **知识中心**：进入 `Lumen Analytics → 知识中心`，修改「实时协作看板」名称与摘要并保存；接受一条待确认建议；对过期 Claim 执行“重新验证”。刷新页面，确认修改仍在。
3. **创建视频**：从项目视频库点击“新建视频”，选择版本更新模式，勾选 2–3 个功能，设置 24 秒与 16:9，生成工程。
4. **AI 导演**：输入「把视频缩短到 20 秒」「把语气调得更轻松」「删除「AI 异常检测」卖点」，观察 Brief、镜头时长与变更清单同步；再输入「换成真人出镜」，确认导演明确说明无法执行。
5. **分镜工作室**：拖动或使用“上移 / 下移”调整镜头，修改某个镜头的字幕与时长，添加一个镜头；刷新后确认顺序和编辑保留。
6. **视频编辑器**：播放 / 点击时间线定位，修改字幕并观察预览；使用撤销 / 重做与 `Space`、方向键；切换画幅与模板，确认品牌色生效。
7. **生产监控**：启动“标准成功路径”并切到 4×；再启动“录制失败 → 重试”观察固定失败点与重试；最后体验“人工审批 Gate”的暂停与批准。
8. **审核与导出**：查看 8 项检查；批准当前版本；导出工程 JSON 与 SRT（真实下载），再选择 MP4 确认只出现模拟任务状态且没有下载文件。
9. **品牌与设置**：修改品牌主色并保存，确认已审核视频回到待修改 / 需要重新审核；在“演示数据”中重置，恢复初始 Lumen / Pulse 快照。
10. **边界说明**：点击顶栏 `Demo`，查看真实能力与模拟能力的完整清单；切换浅色模式并刷新确认偏好保留。

---

## 5. 架构与数据流

```text
apps/web-studio                 React + Vite + React Router 应用壳与路由
libs/domain                     Zod Schema、时间线、生产蓝图、渲染 IR、SRT / JSON 序列化
libs/render                     Remotion composition、主题与场景组件（纯函数、无网络）
libs/mock-data                  Lumen / Pulse 固定种子与模板
libs/mock-services              导演、知识、生产引擎、审核、导出、入门模拟服务
libs/state                      Zustand store、持久化与版本迁移、跨页面 action
libs/ui                         设计系统组件、ScenePreview、Dialog、Toast 等
libs/features/project-hub       工作台、项目、知识、视频库、设置、入门
libs/features/video-studio      向导、导演、分镜、编辑器
libs/features/production-suite  生产监控、审核导出
workers/render-worker           CLI：fixture → bundle → renderMedia → ffprobe → 回执 / 清单
```

依赖方向：`app → features/ui/state/domain`；`feature → ui/state/domain`；`state → domain/mock-services/mock-data`；`render → domain`；`render-worker → domain/render/mock-data`。ESLint 模块边界规则约束跨层引用。

数据流的核心原则：

- **知识是唯一事实源**。视频只保存 `featureId` / `claimIds` 引用，不复制事实。
- **Zustand 单一工作区快照**。业务数据持久化到 `asvs.studio.v1`，UI 偏好到 `asvs.ui.v1`，入门草稿到 `asvs.onboarding.v1`。
- **旧快照按版本迁移**。当前 `STUDIO_PERSIST_VERSION = 2`，v1 数据会补齐 `fps` / `revision` / `durationFrames` / `visual`；只有结构损坏才回退种子。
- **渲染输入是冻结快照**。`buildStoryboardV1` 把视频工程转成带 `fps`、`durationFrames`、`revision` 的 Storyboard，再由 `buildRenderInput` 过滤未引用素材；渲染组件只读这份输入，不访问网络或时钟。
- **渲染回执可独立复核**。MP4 的 SHA256、ffprobe 结果与输入 / 场景 / 素材 digest 同时写入 receipt 与 manifest，`pnpm verify:render` 会重新计算并比对。
- **所有列表选择器使用 `useShallow`**，避免 Zustand v5 返回新数组导致的重复渲染。
- **审核与生产均绑定当前工程版本**；工程修改后审核自动失效。
- **导出 JSON / SRT 使用真实 Blob**，不经过后端。

---

## 6. 模拟与真实的边界

### 真实能力（可实际验证）

| 能力 | 说明 |
| --- | --- |
| 项目 / 功能 / Claim / Evidence 数据编辑 | 跨页面同步，刷新后保留 |
| 视频策划、Brief、分镜、字幕、时长、顺序 | 真实写入 store，支持撤销 / 重做 |
| 时间驱动的模拟预览与播放头 | 基于镜头时长的本地时间轴，无真实视频解码 |
| AI Director 有限意图 | 本地确定性规则，真实修改工程并返回变更清单 |
| 生产 DAG 状态机 | 前端真实状态机；执行过程为模拟 |
| 审核检查、批准 / 退回、版本失效 | 真实规则与持久化 |
| 工程 JSON / SRT 下载 | 真实生成文件并通过浏览器下载 |
| CLI 真实渲染 | Remotion → 30 秒 MP4；ffprobe + 全片解码 + SHA256 回执（`pnpm render:fixture`） |
| 持久化迁移 | v1 工作区快照迁移到 v2，不丢数据；损坏数据才回退 |
| 品牌套件与主题 | 真实写入并影响所有预览 |
| 演示数据重置 | 真实恢复种子快照 |

### 明确模拟（不会伪造结果）

| 能力 | 当前实现 |
| --- | --- |
| GitHub OAuth / API / 仓库读取 / 代码扫描 | 本地确定性模拟连接与快照 |
| AI 模型调用 / Mastra / Agent 运行时 | 不请求外部模型，使用确定性意图解析 |
| 真实录屏、界面断言、Playwright 生产执行 | 生产步骤为模拟，不启动浏览器或录制；`real_demo` 场景是明确标注的占位 |
| 配音 / TTS | 只有文本与时间轴，不播放或生成音频；样片为静音视频 |
| Web 内 FFmpeg / Remotion / 服务端渲染 | Web UI 未接入；CLI `workers/render-worker` 已能真实渲染（见 §7 与 docs/11） |
| Web 内 MP4 / WebM 导出 | 仅任务状态与进度，不产生媒体文件；CLI 样片是真实文件 |
| 局部重渲染 / 转场 / 多画幅 | 未实现；当前每次全片渲染，仅 16:9 |
| 上传、对象存储、CDN、发布 / 审批流 | 未接入后端；渲染产物只落在本地 `dist/` |
| ATVG2 运行时 | 不在本阶段范围 |

所有 Demo 数据带有 `demo: true` 或界面 `Demo` / `模拟` 标识；`Demo` 弹窗集中列出真实与模拟能力。

---

## 7. 测试结果（2026-11-20）

> 以下数字均为 **`--skip-nx-cache` 真实重跑**得到，不是 Nx 缓存命中。CI 中同样禁用缓存。
> 本地实测（Windows 11，Node 26）：`pnpm test` 冷缓存约十几秒，
> `pnpm test:e2e` 三个项目共 **1.3 分钟**，`pnpm validate` 缓存命中约 4 秒。

### 单元测试（Vitest）

```bash
pnpm test --skip-nx-cache
```

- **10 个测试文件，81 个测试全部通过**
- 覆盖：时间线与分镜重排、Zod Schema 校验、SRT / 工程 JSON 序列化、生产引擎（成功 / 失败重试 / 审批 / 取消 / 暂停 / 速度）、AI 导演有限意图与未知指令、审核规则与版本失效、导出模拟与真实文件、Zustand 撤销 / 重做 / 持久化 / 品牌失效。
- 新增覆盖（Step 1）：渲染 IR 判别联合的接受 / 拒绝、Storyboard 帧数与素材过滤、非 16:9 拒绝、回执 / 清单 Schema、Remotion composition 元数据、ffprobe 帧率与容差校验、v1→v2 持久化迁移。
- 关键回归：`normalizeSceneOrder` 必须保留传入数组顺序，不得按旧 `order` 重排。

### 真实渲染（Step 1）

```bash
pnpm render:fixture
pnpm verify:render
```

- 输入：6 场景 / 900 帧 / 30 秒的固定 fixture；输出 h264 · 1920×1080 · 30fps · 30000ms。
- SHA256：`b1451bfbb7a62b6bdbcf7a666237cff44db7ff75b31cb0ea48251642326ccd8a`；大小 5.09 MiB。
- `verify:render` 重新计算 MP4 哈希并核对 manifest / receipt / ffprobe，全部一致；全片解码无错误。
- 抽帧检查 2s / 8s / 17s / 22s / 28s：标题、动效、占位、深色主题与 CTA 均正确留白，无越界。
- 详见 [docs/11](docs/11-RENDER-SLICE.md)。

### E2E（Playwright + Chromium）

```bash
pnpm test:e2e
```

- **32 个测试全部通过（1.3 分钟），桌面 1440×900 + 平板 768×1024 + 移动端 390×844**
- 覆盖：
  - 工作台加载、无运行时 console error
  - 六步入门完成初始化并落地知识中心
  - 知识功能改名后刷新仍保留
  - 分镜下移、顺序刷新后保留
  - 生产标准场景 4× 加速运行至 8/8 完成
  - 批准视频、真实下载工程 JSON / SRT、MP4 无下载
  - 项目改名、来源同步、重置演示数据闭环
  - 视频库阶段 / 关键词筛选
  - 命令面板跳转、404 页面、主题持久化、Demo 边界弹窗
  - 移动端抽屉导航、移动端命令面板、关键页面无横向溢出
  - 平板 768×1024：常驻侧栏而非抽屉、10 个关键页面无横向溢出、折叠侧栏可手动展开
  - axe（WCAG 2.1 A/AA）扫描 11 个页面状态 + 浅色主题关键页面，0 违规
  - `prefers-reduced-motion: reduce` 下动画 / 过渡被压缩，交互仍可用

> 平板测试在首次运行时发现并修复了一个真实缺陷：768–1179px 下 `isTablet` 强制折叠侧栏，
> 顶栏「展开侧栏」按钮因此完全无效。现在用户主动切换后会覆盖平板的默认折叠。

### 静态检查与构建

```bash
pnpm validate
pnpm build
```

- `lint`：11 个项目通过，0 error / 0 warning
- `typecheck`：11 个项目通过
- `lint:boundary-check`：故意写入 3 条跨层非法 import（`domain→state`、`ui→state`、`feature→mock-services`），
  要求 ESLint 的 `@nx/enforce-module-boundaries` **必须报错**；规则被删除或标签漂移时该脚本转为红灯
  （普通 `lint` 在这种情况下仍然全绿，所以需要这条反向验证）
- `build`：路由级懒加载 + `vendor-react` 拆包，构建后自动执行 bundle budget 检查
  - 初始 JS（entry + 静态依赖）：`728.1 kB` raw / `216.2 kB` gzip
  - Editor：额外 `68.9 kB` raw / `23.5 kB` gzip
  - Production：额外 `32.7 kB` raw / `13.4 kB` gzip
  - Review：额外 `28.9 kB` raw / `10.6 kB` gzip
  - 最大单 chunk：`376.6 kB` raw / `115.1 kB` gzip
  - 预算配置见 `bundle-budget.json`；任一预算超限会使 `pnpm build` 失败

### 已知未自动化覆盖

- 生产构建未单独跑 E2E（E2E 使用 Vite dev server）。
- 无视觉回归 / 截图对比测试。
- axe 扫描覆盖主要路由与命令面板；未逐一扫描每个弹窗 / Tab 的深层状态。

---

## 8. 已知缺口

1. **初始包仍偏大**：路由已拆分，但初始 chunk 仍包含整个 Zustand 工作区、种子数据与 mock-services（约 `216.2 kB` gzip）；进一步下沉需要在 action 内按需导入服务。
2. **品牌 CTA 不会重写既有片尾镜头**：更新品牌片尾 CTA 会更新项目品牌并使审核失效，但已有视频的 CTA 镜头文本不会自动改写，需要在 Editor 中手动调整。
3. **动态表单标签仍需逐项检查**：`Field` 已为直接子级的 `Input` / `Textarea` / `Select` 自动生成 `id` 与 `htmlFor`，主要页面 axe 扫描通过；包裹容器或自定义控件仍需在新增时手动关联。
4. **移动端侧栏无障碍不完整**：抽屉打开时未统一设置 `aria-hidden` / `inert`，焦点可能逸出到背景内容。
5. **面包屑使用视频 ID**：分镜 / 编辑器等页面的面包屑会显示 `vid_...`，而不是视频标题。
6. **预览依赖前台标签页**：`requestAnimationFrame` 在后台标签页会被节流，播放进度不会按真实时间推进；这是浏览器行为，未做 Web Worker 时钟兜底。
7. **生产运行只在页面打开时推进**：这是刻意设计，用于避免后台伪造进度；刷新后运行状态按已持久化快照恢复，不会在后台继续。
8. **模拟预览没有音频**：只有字幕与时间轴，没有真实配音；这是当前边界，不应被误解为成片。
9. **建议弹窗文案不够精确**：部分“接受建议会升级 Claim 状态”的说明可能高估实际状态变化，需要按建议类型细化。
10. **CI 只验证到本地命令等价物**：`.github/workflows/ci.yml` 已配置（`frozen-lockfile` → `nx affected` 的 lint/typecheck/test → boundary guard → build + budget → E2E → `render:fixture` + `verify:render`），但**尚未在任何 GitHub 远端上真实跑过**——仓库当前没有 `origin`。首次推送后需要确认：`nx affected` 的 base SHA 可得、Playwright 在 Linux 上可用、ffmpeg / CJK 字体 / Remotion Chrome 缓存可用、文档类 PR 确实不启动 E2E 与 render。
11. **渲染切片尚未接入 Web UI**：CLI 能产出真实 MP4，但浏览器内的导出仍是模拟状态；在队列、对象存储与任务状态打通前，不应让 UI 宣称已生成文件。
12. **渲染只支持 16:9、无音频、字体未打包**：竖屏需要单独布局；没有 TTS / 配乐；依赖系统 CJK 字体，跨机器字形可能不同。
13. **Remotion 许可**：个人或 ≤3 员工公司可免费使用；更大组织商用前需要公司许可。
14. **渲染耗时无基线**：单次全片渲染在本机约数分钟，尚未采集成功率与耗时分布。

---

## 9. 后续建议

1. **性能**：路由懒加载、`manualChunks` 与 bundle budget 已落地；下一步是把 mock-services / 种子数据从初始状态中按需加载，并对图表等重组件继续下沉。
2. **无障碍**：`Field` 已自动关联直接表单控件，axe 扫描已加入 E2E；下一步为移动端抽屉补 `inert` 与焦点回收，并补齐 `aria-describedby`。
3. **测试**：移动端（390×844）与平板（768×1024）项目、`prefers-reduced-motion` 与 axe 用例已加入；下一步是关键页面视觉快照。
4. **品牌传播**：品牌变更时提供“同步更新片尾 CTA”的可选操作，并在审核中显示差异，而不是只让审核失效。
5. **数据边界**：v1→v2 迁移已落地；下一步提供整个工作区的导入 / 导出与跨设备恢复，而不仅是单条视频工程 JSON。
6. **服务抽象**：把 `mock-services` 收敛到接口后接真实适配器：GitHub App、知识索引、Agent 运行时、渲染队列；在真实文件存在前，导出状态不得宣称完成。
7. **渲染工程化**：把 CLI 切片接入任务队列与对象存储，补音频、字体打包、渲染耗时与成功率基线；之后再考虑局部重渲染与转场。
8. **产品化**：项目级权限、审阅评论、版本对比、发布渠道与真实 CDN；这些都需要后端与明确的安全模型，不应在前端伪造。

---

## 10. 文档

- [产品愿景与策略](docs/01-PRODUCT-VISION-AND-STRATEGY.md)
- [产品需求 PRD](docs/02-PRODUCT-REQUIREMENTS-PRD.md)
- [系统架构与技术栈](docs/03-SYSTEM-ARCHITECTURE-AND-TECH-STACK.md)
- [Nx Monorepo 工程规范](docs/04-NX-MONOREPO-ENGINEERING-STANDARDS.md)
- [领域模型与契约](docs/05-DOMAIN-DATA-MODEL-AND-CONTRACTS.md)
- [Agent 工作流](docs/06-AGENT-WORKFLOWS-AND-ORCHESTRATION.md)
- [录屏、渲染与编辑器](docs/07-VIDEO-CAPTURE-RENDER-AND-EDITOR.md)
- [安全、证据与 ATVG2](docs/08-SECURITY-EVIDENCE-AND-ATVG2-INTEGRATION.md)
- [实施路线与验收](docs/09-IMPLEMENTATION-ROADMAP-AND-ACCEPTANCE.md)
- [下一阶段排期与迭代建议](docs/10-NEXT-PHASE-PLAN.md)
- [真实渲染切片（Step 1 验收记录）](docs/11-RENDER-SLICE.md)
- UX 文档：
  - [前端体验计划](docs/ux/FRONTEND-EXPERIENCE-PLAN.md)
  - [信息架构](docs/ux/INFORMATION-ARCHITECTURE.md)
  - [设计系统](docs/ux/DESIGN-SYSTEM.md)
  - [用户旅程](docs/ux/USER-JOURNEYS.md)
  - [Mock 数据策略](docs/ux/MOCK-DATA-STRATEGY.md)
  - [UX 验收清单](docs/ux/UX-ACCEPTANCE-CHECKLIST.md)

---

## 11. 目录速览

```text
apps/web-studio/
  src/               应用壳、路由、侧栏、顶栏、命令面板、Demo 弹窗
  e2e/               Playwright 配置、32 个桌面 / 移动端 / 平板 / 无障碍 / 动效用例
libs/
  domain/            时间线、Schema、生产蓝图、渲染 IR、序列化
  render/            Remotion composition、主题与场景组件
  mock-data/         固定演示数据
  mock-services/     确定性模拟服务
  state/             Zustand 工作区、UI 状态与持久化迁移
  ui/                设计系统与场景预览
  features/          三条产品线页面
workers/
  render-worker/     CLI 渲染 worker、黄金 fixture 与 ffprobe 校验
scripts/             bundle budget、边界反向验证、渲染产物复核
docs/                产品、架构与 UX 文档
```

---

**一句话总结**：这是一个把“可信软件事实 → 可审阅视频工程”完整走通的前端工作台，并用一个 CLI 渲染切片证明 Storyboard 能变成带 SHA256 回执的真实 MP4；它真实保存、真实校验、真实导出工程与字幕，同时诚实地说清楚哪些能力仍是模拟。
