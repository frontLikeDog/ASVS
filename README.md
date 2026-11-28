# AI Software Video Studio（ASVS）

一个前端优先、可完整走通的产品视频工作台：把可信的软件事实（功能、Claim、证据）变成可编辑、可生产、可审核的视频工程。

当前版本包含三部分：可交互的商业级前端原型、真实可运行的渲染切片，以及真实可运行的录屏切片。项目、知识、分镜、审核与导出数据会真实写入浏览器本地存储；AI 模型、浏览器内的配音预览与 Web 内导出仍是明确标注的模拟能力。渲染切片通过 CLI 把固定 Storyboard 用 Remotion 真实渲染成可播放的 30 秒 MP4，并输出 SHA256 回执与 ffprobe 校验结果（见 [docs/11](docs/11-RENDER-SLICE.md)）。录屏切片用已批准的 DemoPlan 驱动 Playwright 录制 web-studio 自身，断言全部通过后才写回执，并把真实片段接回渲染管线（见 [docs/12](docs/12-CAPTURE-SLICE.md)）。服务端编排切片把生产运行迁到 SQLite 队列 + 独立 worker 子进程：崩溃或 API 重启后按 checkpoint 续跑，审核页可下载真实 MP4（见 [docs/13](docs/13-ORCHESTRATION-SLICE.md)）。配音与交付包切片把成片升级为可交付包：真实旁白音轨（H.264 + AAC）、同步 SRT，以及 Gate 3 审核通过后的 MP4 + SRT + manifest 下载与 SHA256 回执（见 [docs/14](docs/14-AUDIO-EXPORT-SLICE.md)）。

---

## 1. 现在可以做什么

- **六步入门**：从项目信息、接入方式、知识来源、品牌套件、演示环境到确定性初始化，生成可编辑的知识快照。
- **结构化知识中心**：功能、Claim、Evidence、PR / Release 时间线、待确认建议、重新验证与审核阻断。
- **四类视频模式**：版本更新、产品宣传、功能教程、社交短片，统一进入 Brief → Director → Storyboard → Editor。
- **有限但真实的 AI Director**：缩短时长、改语气 / 受众、调整顺序、重生成镜头、增删卖点、改写旁白；无法识别的指令会明确拒绝，不假装执行。
- **可编辑分镜与时间线**：拖拽 / 键盘排序、字幕与时长编辑、画面预览、播放头、撤销 / 重做、自动保存。
- **确定性生产监控**：8 步 DAG，支持成功、失败重试、人工审批 Gate、暂停 / 取消与 4× 加速；没有随机假进度。
- **有牙齿的审核**：证据过期、待验证声明、敏感信息、禁用表述、品牌缺失、生产版本不一致都会阻断或提醒。
- **真实文件导出**：工程 JSON 与 SRT 字幕通过 Blob 真实下载；`pnpm render:fixture` 用 Remotion 真实渲染 30 秒 MP4 并写回执 / 清单（CLI，不在 Web UI 内）；服务端模式开启旁白后，审核页可下载带 AAC 音轨的 MP4 + SRT + manifest 交付包（SHA256 校验）；Web 内的 MP4 / WebM 仍只展示模拟任务状态。
- **品牌与设置**：品牌字标、主辅色、字体、视觉风格、片头 / CTA 实时预览；品牌变更会使已审核视频失效并需要重新审核。

---

## 2. 快速启动

### 环境

- Node.js **>= 22.13**（`node:sqlite` 从 22.13 起无需 `--experimental-sqlite`；当前开发环境 Node 26）
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

### 真实 GitHub 只读连接与知识索引（CLI）

需要 GitHub App 的只读安装凭证。把 `apps/api/.env.example` 复制为 `apps/api/.env.local`（已 gitignore），填入 `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` / `GITHUB_DEFAULT_REPO`。**不要提交 `.env.local` 或 `.pem`。**

```bash
pnpm github:verify      # 只读连接验收：列 PR / 文件 / Release / README + AC-01 写操作阻断探针
pnpm index:benchmark    # 冷扫描 → 同提交热扫描 → 对照冷扫描，并断言增量复用
```

`index:benchmark` 会对真实仓库拉取文件树、为每个可索引文件计算 SHA256，并生成不可变快照。热扫描复用父快照中 blob sha 未变的文件：不重下、不重解析，`fetchedFiles = 0`。不配置凭证时这些脚本会明确失败，不会伪造结果。

### 真实渲染样片（CLI）

需要 `ffmpeg` / `ffprobe` 在 `PATH` 中，以及中日韩字体；首次运行 Remotion 会下载 Chrome Headless Shell 到 `node_modules/.remotion`。

```bash
pnpm render:fixture      # 渲染 30 秒黄金样片 → dist/render-worker/golden-30s
pnpm verify:render       # 独立复核 MP4 / manifest / receipt / ffprobe
```

输出包含 `golden-30s.mp4`、`receipt.json`（SHA256、时长、尺寸、fps、渲染器版本）与 `manifest.json`（输入 digest、逐场景 digest、素材哈希）。详见 [docs/11](docs/11-RENDER-SLICE.md)。

### 真实录屏样片（CLI）

需要先构建 web-studio（录屏使用 production build + `vite preview`，避免 dev server 的按需编译出现在画面里），并安装 Playwright Chromium：

```bash
pnpm build
pnpm capture:demo       # 执行已批准 DemoPlan → dist/browser-worker/web-studio-tour
pnpm verify:capture     # 重新哈希、ffprobe、回执 / 素材 / fixture 一致性
pnpm capture:safety     # 越界 origin 必须在请求前被拒绝
pnpm capture:repeat     # 3 次重复执行，通过率低于 80% 失败
pnpm render:captured    # 用真实片段渲染 30 秒成片
pnpm verify:render:captured
```

DemoPlan 是 YAML 数据而不是脚本：只支持 `navigate` / `click` / `fill` / `press` / `wait_for` / `assert` / `capture`，selector 只能使用 role / label / heading / testid / text 等语义前缀。任何计划修改都会让审批摘要失效，必须重新审阅。只有全部 UI 断言通过才写 `CaptureReceipt`；失败会留下截图、trace、raw WebM 与 `failure-report.json`。详见 [docs/12](docs/12-CAPTURE-SLICE.md)。

### 服务端编排验收（AC-06）

```bash
pnpm orchestration:verify   # 真实 worker 被 SIGKILL → API 重启 → 按 checkpoint 续跑 → ffprobe + SHA256
```

脚本建临时 SQLite 与工作区，用真实 `RenderProcessExecutor` 拉起 `workers/render-worker`，在 `bundle_ready` 后杀掉子进程与「API」，再启动新实例完成恢复；随后验证重试耗尽、声明阻断、非 16:9 拒绝、取消与非法迁移。设置 `ASVS_KEEP_VERIFY_DIR=1` 可保留产物。详见 [docs/13](docs/13-ORCHESTRATION-SLICE.md)。

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
10. **工作区同步 / 备份（可选）**：先运行 `pnpm dev:api`，在 `设置 → 演示数据` 启用同步；打开第二个浏览器或隐身窗口，用同一工作区 ID 确认看到同一份数据。也可导出工作区 JSON，在全新浏览器中导入恢复。
11. **边界说明**：点击顶栏 `Demo`，查看真实能力与模拟能力的完整清单；切换浅色模式并刷新确认偏好保留。

---

## 5. 架构与数据流

```text
apps/web-studio                 React + Vite + React Router 应用壳与路由
apps/api                        Fastify + node:sqlite：工作区 GET/PUT、运行状态、导出
libs/domain                     Zod Schema、时间线、生产蓝图、渲染 IR、SRT / JSON 序列化、工作区版本迁移
libs/ports                      服务与持久化接口（知识、录屏、导演、导出、时钟、工作区仓库）
libs/adapters-http              浏览器端 HTTP 工作区仓库（fetch）
libs/render                     Remotion composition、主题与场景组件（纯函数、无网络）
libs/mock-data                  Lumen / Pulse 固定种子与模板
libs/mock-services              导演、知识、生产引擎、审核、导出、入门模拟服务（实现 libs/ports）
libs/state                      Zustand store、持久化与版本迁移、跨页面 action、同步状态
libs/ui                         设计系统组件、ScenePreview、Dialog、Toast 等
libs/features/project-hub       工作台、项目、知识、视频库、设置、入门
libs/features/video-studio      向导、导演、分镜、编辑器
libs/features/production-suite  生产监控、审核导出
workers/render-worker           CLI：fixture → bundle → renderMedia → ffprobe → 回执 / 清单
workers/browser-worker          CLI：DemoPlan → Playwright 录屏 / 断言 / allowlist → 回执 / 渲染输入
```

依赖方向：`app → features/ui/state/domain/ports/adapters`；`feature → ui/state/domain/ports`；`state → domain/ports/mock-services/mock-data`；`api → domain/ports/adapters`；`render → domain`；`render-worker / browser-worker → domain/render/mock-data/ports`。ESLint 模块边界规则约束跨层引用，`type:api` 不允许依赖 React 应用、Zustand store 或 feature。

数据流的核心原则：

- **知识是唯一事实源**。视频只保存 `featureId` / `claimIds` 引用，不复制事实。
- **Zustand 单一工作区快照**。业务数据持久化到 `asvs.studio.v1`，UI 偏好到 `asvs.ui.v1`，入门草稿到 `asvs.onboarding.v1`，同步配置到 `asvs.workspace-sync.v1`。
- **旧快照按版本迁移**。当前 `STUDIO_SNAPSHOT_VERSION = 2`，v1 数据会补齐 `fps` / `revision` / `durationFrames` / `visual`；浏览器持久化、API 读取与导入导出共用 `migrateStudioSnapshot`，只有结构损坏才回退种子。
- **默认本地，同步可选**。未启用同步时仍是纯浏览器 localStorage；启用后完整快照经 `/api` 代理写入本机 Fastify + SQLite，以 `revision` 做乐观并发控制，冲突时要求拉取或覆盖。
- **整工作区可备份**。设置页导出 `asvs.workspace` JSON 信封（13 个数组），在全新浏览器导入会先迁移、再校验、最后替换；媒体文件与 UI 偏好不在其中。
- **渲染输入是冻结快照**。`buildStoryboardV1` 把视频工程转成带 `fps`、`durationFrames`、`revision` 的 Storyboard，再由 `buildRenderInput` 过滤未引用素材；渲染组件只读这份输入，不访问网络或时钟。
- **渲染回执可独立复核**。MP4 的 SHA256、ffprobe 结果与输入 / 场景 / 素材 digest 同时写入 receipt 与 manifest，`pnpm verify:render` 会重新计算并比对。
- **所有列表选择器使用 `useShallow`**，避免 Zustand v5 返回新数组导致的重复渲染。
- **审核与生产均绑定当前工程版本**；工程修改后审核自动失效。
- **浏览器内导出 JSON / SRT 使用真实 Blob**（草稿，不经过服务端校验）；服务端 Gate 3 交付包是经过 SHA256 校验的真实文件；Web 内的 MP4 导出仍是模拟任务。

---

## 6. 模拟与真实的边界

### 真实能力（可实际验证）

| 能力 | 说明 |
| --- | --- |
| 项目 / 功能 / Claim / Evidence 数据编辑 | 跨页面同步，刷新后保留 |
| 只读 GitHub App 接入、增量索引与 PR 发现（Web UI） | 通过本机 `apps/api`（4A/4B/4C）接入真实只读仓库：支持 Onboarding / 设置页双入口绑定与 AC-01 写保护探针、增量快照与 AC-09 过期传播、PR 变更分类与 AC-02 内部变更过滤、显式推广进功能目录、AC-03 核验录入与 append-only 审计、审核页按 `Claim.eligibility` 硬守门 |
| 视频策划、Brief、分镜、字幕、时长、顺序 | 真实写入 store，支持撤销 / 重做 |
| 时间驱动的模拟预览与播放头 | 基于镜头时长的本地时间轴，无真实视频解码 |
| AI Director 有限意图 | 本地确定性规则，真实修改工程并返回变更清单 |
| 生产 DAG 状态机 | 前端真实状态机；执行过程为模拟 |
| 审核检查、批准 / 退回、版本失效 | 真实规则与持久化；接入真实仓库后按 `Claim.eligibility` 与 AC-09 上游变更自动失效 |
| 工程 JSON / SRT 下载 | 真实生成文件并通过浏览器下载 |
| 工作区同步与备份 | 可选启用本机 Fastify + SQLite；两个浏览器实例共享同一工作区；完整工作区 JSON 可导出、导入到全新浏览器 |
| 工作区版本迁移 | v1 快照与 Zustand 备份迁移到 v2；API 读取旧行时升级；数据库迁移保留运行记录 |
| CLI 真实渲染 | Remotion → 30 秒 MP4；ffprobe + 全片解码 + SHA256 回执（`pnpm render:fixture`） |
| CLI 真实录屏 | Playwright 执行已批准 DemoPlan（20 步：11 条断言 + 9 条交互），断言 11/11 通过后写 `CaptureReceipt`；重复 3 次通过率 100%；真实片段进入渲染管线（`pnpm capture:demo`） |
| 服务端真实渲染与崩溃恢复 | 生产页启用工作区同步后可「启动服务端渲染」：SQLite 任务队列 + 独立 `render-worker` 子进程产出真实 16:9 MP4，关闭页面后继续；`SIGKILL` / API 重启按 checkpoint 续跑；审核页可下载经 SHA256 校验的 MP4 与 manifest（`pnpm orchestration:verify`，见 [docs/13](docs/13-ORCHESTRATION-SLICE.md)） |
| 配音、SRT 与 Gate 3 交付包 | 生产页可开启旁白（TTS 音色 / 语速 / 溢出策略）：服务端合成旁白、把旁白混入 MP4（H.264 + AAC 48kHz）、按冻结帧时间轴生成 SRT；同一文本重跑命中内容寻址缓存，**不重复计费**。审核通过（Gate 3）后可生成交付包并下载 MP4 + SRT + manifest，下载前校验 SHA256（`pnpm export:verify`，20 项断言；见 [docs/14](docs/14-AUDIO-EXPORT-SLICE.md)）。离线确定性音色全程标注 `测试合成音轨 · 非真人配音` |
| 品牌套件与主题 | 真实写入并影响所有预览 |
| 演示数据重置 | 真实恢复种子快照 |

### 明确模拟（不会伪造结果）

| 能力 | 当前实现 |
| --- | --- |
| 演示项目来源同步 / 未配置凭证降级 | 内置 `demo: true` 演示项目（如 `Lumen Analytics`）与无源码 AC-08 文档入门仍使用本地确定性模拟；未在 `apps/api/.env.local` 配置 GitHub App 凭证时，真实接入诚实提示 503，绝不伪造已连接状态 |
| AI 模型调用 / Mastra / Agent 运行时 | 不请求外部模型，使用确定性意图解析与确定性 PR 分类规则 |
| Web UI 内的录屏 / 生产执行 | 生产监控的「模拟 DAG」仍是浏览器内模拟，不启动浏览器或录制；服务端模式走真实的 SQLite 队列 + 子进程渲染，但只有 5 个编排步骤（不含录屏步骤）；真实录屏只能通过 CLI `pnpm capture:demo` 触发 |
| 配音 / TTS（浏览器内） | 浏览器预览与 Web 内导出仍只有文本与时间轴，不播放或生成音频；**服务端模式**已能合成旁白并产出带 AAC 音轨的 MP4。离线确定性测试音色（`ASVS_TTS_PROVIDER=deterministic_test`）明确标注 `测试合成音轨 · 非真人配音`；未配置 TTS 时服务端 fail-closed（503），绝不静默降级为无声 |
| Web 内 FFmpeg / Remotion / 服务端渲染 | Web UI 只发起任务与展示产物，Worker 在服务端；CLI `workers/render-worker` 与 `apps/api` 编排器均已能真实渲染（见 §7、docs/11、docs/13） |
| Web 内 MP4 / WebM 导出 | 仅任务状态与进度，不产生媒体文件；CLI 样片是真实文件 |
| 局部重渲染 / 转场 / 多画幅 | 未实现；当前每次全片渲染，仅 16:9 |
| 上传、对象存储、CDN、发布 / 审批流 | 未接入；渲染产物只落在本地 `dist/` |
| 云端账号 / 多租户 / 权限 | 工作区 API 只监听本机，没有登录、租户隔离或成员权限 |
| 服务端推进生产运行 | 服务端模式已由 SQLite 队列与独立 worker 推进（5A）；**模拟 DAG 仍由当前页面驱动**，关闭页面后只有服务端模式的任务继续 |
| 工作区媒体备份 | 导出 JSON 只含元数据；`Asset.media` 指向相对路径，跨设备恢复后媒体可能缺失 |
| ATVG2 运行时 | 不在本阶段范围 |

所有 Demo 数据带有 `demo: true` 或界面 `Demo` / `模拟` 标识；`Demo` 弹窗集中列出真实与模拟能力。

---

## 7. 测试结果（2026-11-20）

> 以下数字均为 **`--skip-nx-cache` 真实重跑**得到，不是 Nx 缓存命中。CI 中同样禁用缓存。
> 本地实测（Windows 11，Node 26）：`pnpm test` 冷缓存约十几秒，
> `pnpm test:e2e` 三个项目共 **1.3 分钟**，`pnpm validate` 缓存命中约 4 秒。

### 单元测试（Vitest）

```bash
pnpm exec nx run-many -t test --skip-nx-cache
```

- **37 个测试文件，286 个测试全部通过**（2026-11-27 `--skip-nx-cache` 重跑：domain 95、api 108、mock-services 31、browser-worker 24、state 13、adapters-http 7、render-worker 5、render 3）
- 覆盖：时间线与分镜重排、Zod Schema 校验、SRT / 工程 JSON 序列化、生产引擎（成功 / 失败重试 / 审批 / 取消 / 暂停 / 速度）、AI 导演有限意图与未知指令、审核规则与版本失效、导出模拟与真实文件、Zustand 撤销 / 重做 / 持久化 / 品牌失效。
- 新增覆盖（Step 1）：渲染 IR 判别联合的接受 / 拒绝、Storyboard 帧数与素材过滤、非 16:9 拒绝、回执 / 清单 Schema、Remotion composition 元数据、ffprobe 帧率与容差校验、v1→v2 持久化迁移。
- 新增覆盖（Step 2）：DemoPlan schema（未知 action、零断言、危险 selector、approval digest）、精确 origin allowlist、断言优先判定、回执不变量、素材媒体 schema、片段起点 / 时长规划。
- 新增覆盖（Step 3）：工作区信封 / 导出导入往返、v1 裸快照与 Zustand 备份迁移、未来版本拒绝、HTTP 仓库 404/409/错误映射、Fastify 路由与乐观并发（13 个 API / 数据库用例）、SQLite v1→v2 迁移保留运行记录、跨工作区相同 run id。
- 新增覆盖（Step 4D）：`knowledge-projection.ts`（AC-02 不可推广硬阻断、幂等同步、AC-09 Scene `review` 与已批准视频 `changes_requested` 失效）、`HttpGitHubKnowledgeClient`（12 端口方法、超时与 404/503 错误映射）、`review-service.ts` 按 `Claim.eligibility` 硬守门（阻断未核验生产运行态与绝对上线表述）、Zustand 4D 投影闭环单测。
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

### 真实录屏（Step 2）

```bash
pnpm build
pnpm capture:demo
pnpm verify:capture
pnpm capture:safety
pnpm capture:repeat
pnpm render:captured
pnpm verify:render:captured
```

- 计划：`plan_web_studio_tour`，审批摘要 `104ce016…4d2142`；20 步（11 条 UI 断言 + 9 条交互），11/11 通过。
- 片段：h264 · 1920×1080 · 30fps · 17,967ms；SHA256 `6da63401…7eff6515`。
- 重复执行 3/3 通过（100%，门槛 80%）；越界 origin 探针 PASS，越界请求 0。
- 真实片段进入 Step 1：成片 `captured-30s.mp4`（30,000ms / 900 帧，`real_demo` 镜头 18s 完整播完巡览），manifest 记录 `mediaSha256` 与源文件，复核一致；成片 SHA256 `b88c448d…7b2eca0e8`。
- 详见 [docs/12](docs/12-CAPTURE-SLICE.md)。

### 工作区同步与迁移（Step 3）

```bash
pnpm dev:api      # Fastify + SQLite，127.0.0.1:4300
pnpm dev:stack    # 同时启动 API 与 web-studio
pnpm validate
```

- API：12 个路由 / 数据库集成用例 + 1 个 SQLite 迁移用例；覆盖创建、读取、双客户端可见、409 冲突、非法数据不写入、v1 读取升级、导出、跨工作区相同 run id。
- 迁移：`STUDIO_SNAPSHOT_VERSION = 2` 的 v1→v2 迁移同时用于浏览器持久化、API 读取与导入；SQLite `PRAGMA user_version` v1→v2 保留运行记录并改为 `(workspace_id, id)` 复合主键。
- 浏览器：设置 → 演示数据可启用同步、拉取、上传、断开、导出 / 导入工作区；两个独立 browser context 通过同一工作区 ID 看到同一份数据，导出文件可在全新 context 导入。
- 设计记录：[ADR-001 Fastify](docs/adr/ADR-001-api-framework-fastify.md)、[ADR-008 SQLite](docs/adr/ADR-008-sqlite-workspace-storage.md)。

### 增量知识索引（Step 4B）

```bash
pnpm dev:api            # 需要 apps/api/.env.local 中的只读 GitHub App 凭证
pnpm index:benchmark    # 真实仓库冷扫描 → 热扫描 → 对照冷扫描
```

- 契约：`KnowledgeSnapshotV1`（`libs/domain`）+ `KnowledgeIndexPort`（`libs/ports`）；快照只追加，永不覆写。
- 路由：`POST /v1/github/repos/:owner/:repo/index`（`branch` / `forceCold`）、`GET …/snapshots`、`GET …/snapshots/:snapshotId`；未配置 GitHub 时索引请求返回 503。
- 复用判据：父快照中 blob sha 未变的文件直接复用上一份提取结果，不重新下载、不重新解析；下载后才判定为二进制/超大的文件也会记录 skip（含 blob sha），热扫描同样不再重下。
- 持久化：SQLite `knowledge_snapshots` 表，`PRAGMA user_version` v2→v3 迁移保留既有工作区与 `production_runs`；快照按 repo + branch 索引，用于挑选增量父快照。
- 实测（`frontLikeDog/livenotes` @ `78bb6a68`，322 个可索引文件 / 109 个跳过）：冷扫描 37.9 s、357 次 blob 下载；同提交热扫描 1.7 s、**0 次下载**、复用 322，`sourceDigests` 与冷扫描逐字节一致（约 21×）。
- 测试：57 个 API / 领域用例，新增覆盖冷扫描 digest、单文件增量复用（断言只读取该文件）、删除清理、forceCold、跨分支不复用、二进制/超大/敏感/路径穿越跳过、v2→v3 迁移保留数据、路由 503/400/404/201 与 SQLite 往返。
- 边界：只有 blob sha 完全相同的文件才复用，重命名视为删除+新增；AST 级解析、跨文件引用图、Web UI 接入（4D）尚未开始。

### PR 变更发现与发布守门（Step 4C）

```bash
pnpm discovery:verify   # 增量索引 → 发现 PR → 确定性分类 → 绑定证据 → 过期传播
```

- 契约：`PRChangeCandidateV1` / `ClaimCandidateV1` / `VerificationContextV1` / `EvidenceRefV1`（`libs/domain`）+ `PRDiscoveryPort`（`libs/ports`）；发布资格只由纯函数 `evaluateClaimPublishability` 推导。
- 路由：`POST /v1/github/repos/:owner/:repo/discover`（未配置 GitHub → 503，成功 → 201）、`GET …/candidates`、`GET …/candidates/:candidateId`、`POST …/claims/:claimId/verify`、`GET …/claims/:claimId/verifications`、`POST …/candidates/refresh-staleness`。
- 分类（无 LLM）：Conventional 前缀 + 标签 + 文件路径分类 + 纯重命名识别 + 4B 快照路由/入口点信号；`refactor:`、纯重命名、仅测试/CI/构建/配置变更一律 `internal_non_promotable`，自由标题与纯文档变更转 `ambiguous_needs_review`，两者都**不产出 Claim**（AC-02）。
- 发布守门（AC-03）：已合并但未命中 Release、无运行态证据 → `blocked_unverified`，明确禁止「已上线」；只有 Release → 只能表述「随 Release 发布」；非生产运行态 → 必须标注环境；生产运行态 + 人工批准才 `publishable`。人工驳回 → `blocked_rejected`。人工核验必带 `decision`（可选 `actor`），`verifiedAt` 严格校验 ISO-8601 且禁止未来时间。
- 过期传播（AC-09）：全量扫描仓库候选；新快照中引用文件的 SHA256 变化或文件被删除 → 源码证据与 Claim 自动 `stale` / `blocked_stale`；源码指纹变更或已过期后重新 `discover` 不会复活旧批准，必须针对新代码重新核验。
- 持久化：SQLite `user_version` v3→v4；`pr_change_candidates` 每 repo+PR 一行（源码指纹与文案均未变时保留已录入证据），`claim_verifications` 只追加不修改，核验录入与候选更新在同一事务内提交。
- 实测（`frontLikeDog/livenotes` @ `96f90e90`）：增量索引 `mode=incremental total=328 reused=328`（无新增下载）；3 个真实 PR 中 2 个 `feat` 判为用户可感知新功能，2 条 Claim 全部 `blocked_unverified`（未部署声明被阻断）；1 个 `refactor` 判为内部变更且 0 Claim（真实验证 AC-02）；过期扫描 0 变更（证据刚绑定到同一快照）。
- 边界：Release 只接受 `targetCommitish` 精确匹配或正文显式 `#PR`；不解析 PR 正文、不接外部模型；`deployed=true` 不等于生产可用。

### Web Studio 真实知识端到端闭环（Step 4D）

```bash
pnpm test:e2e           # 含真实 Fastify + SQLite 夹具 API 驱动的 4D E2E 闭环
pnpm github:verify      # 真仓只读与 AC-01 写保护探针（frontLikeDog/livenotes）
pnpm discovery:verify   # 真仓索引 → PR 发现 → AC-02 / AC-03 / AC-09 验收
```

- 接入与投影：`GitHubKnowledgeClientPort`（`libs/ports`）+ 惰性加载的 `HttpGitHubKnowledgeClient`（`libs/adapters-http`，15s/180s 超时与 Zod 校验）+ 纯领域投影 `knowledge-projection.ts`（`libs/domain`）+ `github-knowledge-actions.ts`（`libs/state`，保持初始包不劣化）。
- UI 闭环：Onboarding 与 `设置 → 来源与同步` 支持真实只读 GitHub App 绑定与 AC-01 探针（保留 AC-08 无源码仅文档路径）；知识中心「PR 变更发现」支持增量索引、PR 发现、AC-02 内部变更隔离（只进时间线不进目录）、显式写入功能目录、`test`/`runtime`/`release`/`human` 核验录入与 append-only 审计、AC-09 过期刷新；视频向导与审核页按 `Claim.eligibility` 硬守门。
- 真仓与夹具验证：本地真实仓库 `frontLikeDog/livenotes` `@ 4ac866aac799` 复核 AC-01 写阻断（HTTP 403）、4 条 PR 中 3 个 `feat` 判为 `blocked_unverified`、1 个 `refactor` 判为内部变更；Playwright 由仅测试使用的 `apps/api/src/scripts/e2e-fixture-api.ts` 跑通「503 诚实降级」「AC-08 无源码入门」「AC-01/02/03/09 审核通过后因上游提交变动自动失效」全部 3 条用例。

### E2E（Playwright + Chromium）

```bash
pnpm test:e2e
```

- **38 个测试全部通过（1.9 分钟），桌面 1440×900 + 平板 768×1024 + 移动端 390×844**
- 覆盖：
  - 工作台加载、无运行时 console error
  - 六步入门完成初始化并落地知识中心
  - 知识功能改名后刷新仍保留
  - 分镜下移、顺序刷新后保留
  - 生产标准场景 4× 加速运行至 8/8 完成
  - 批准视频、真实下载工程 JSON / SRT、MP4 无下载
  - 项目改名、来源同步、重置演示数据闭环
  - **两个独立浏览器上下文通过 SQLite API 看到同一工作区**
  - **工作区 JSON 导出后在全新浏览器导入恢复**
  - 视频库阶段 / 关键词筛选
  - 命令面板跳转、404 页面、主题持久化、Demo 边界弹窗
  - 移动端抽屉导航、移动端命令面板、关键页面无横向溢出
  - 平板 768×1024：常驻侧栏而非抽屉、10 个关键页面无横向溢出、折叠侧栏可手动展开
  - axe（WCAG 2.1 A/AA）扫描 12 个页面状态（含 `?tab=discovery`）+ 浅色主题关键页面，0 违规
  - `prefers-reduced-motion: reduce` 下动画 / 过渡被压缩，交互仍可用
  - Step 4D 真实知识闭环（`knowledge-real-flow.spec.ts`）：未配置 GitHub 凭证时诚实提示 503、AC-08 无源码仅文档完成入门、真实只读接入 → 增量索引 → PR 发现（AC-02 过滤 `refactor`）→ 核验与审计（AC-03）→ 审核通过 → 上游变更过期自动失效（AC-09）

> 平板测试在首次运行时发现并修复了一个真实缺陷：768–1179px 下 `isTablet` 强制折叠侧栏，
> 顶栏「展开侧栏」按钮因此完全无效。现在用户主动切换后会覆盖平板的默认折叠。

### 静态检查与构建

```bash
pnpm validate
pnpm build
```

- `lint`：15 个项目通过（仅剩既有 warning，0 error）
- `typecheck`：15 个项目通过
- `lint:boundary-check`：故意写入 4 条跨层非法 import（`domain→state`、`ui→state`、`api→state`、`feature→mock-services`），
  要求 ESLint 的 `@nx/enforce-module-boundaries` **必须报错**；规则被删除或标签漂移时该脚本转为红灯
  （普通 `lint` 在这种情况下仍然全绿，所以需要这条反向验证）
- Nx 项目图补齐 `implicitDependencies`（domain / ports / adapters-http / state / features / workers），
  `nx affected` 会同时带出依赖项目，而不是只跑改动文件所在项目
- `build`：路由级懒加载 + `vendor-react` 拆包，构建后自动执行 bundle budget 检查
  - 初始 JS（entry + 静态依赖）：`758.8 kB` raw / `226 kB` gzip（预算 `230 kB` gzip）
  - Editor：额外 `69.7 kB` raw / `24.1 kB` gzip
  - Production：额外 `33.4 kB` raw / `13.7 kB` gzip
  - Review：额外 `30.5 kB` raw / `11.2 kB` gzip
  - 最大单 chunk：`407 kB` raw / `124.8 kB` gzip（预算 `160 kB` gzip）
  - GitHub 知识动作按路由拆分（`14.75 kB` raw / `5.46 kB` gzip），HTTP 知识适配器与工作区同步控制器按需动态加载
  - 预算配置见 `bundle-budget.json`；任一预算超限会使 `pnpm build` 失败

### 已知未自动化覆盖

- 生产构建未单独跑 E2E（E2E 使用 Vite dev server）。
- 无视觉回归 / 截图对比测试。
- axe 扫描覆盖主要路由与命令面板；未逐一扫描每个弹窗 / Tab 的深层状态。

---

## 8. 已知缺口

1. **初始包仍偏大**：路由已拆分，但初始 chunk 仍包含整个 Zustand 工作区、种子数据与 mock-services（约 `226 kB` gzip，预算 230 kB）；进一步下沉需要在 action 内按需导入服务。
2. **品牌 CTA 不会重写既有片尾镜头**：更新品牌片尾 CTA 会更新项目品牌并使审核失效，但已有视频的 CTA 镜头文本不会自动改写，需要在 Editor 中手动调整。
3. **动态表单标签仍需逐项检查**：`Field` 已为直接子级的 `Input` / `Textarea` / `Select` 自动生成 `id` 与 `htmlFor`，主要页面 axe 扫描通过；包裹容器或自定义控件仍需在新增时手动关联。
4. **移动端侧栏无障碍不完整**：抽屉打开时未统一设置 `aria-hidden` / `inert`，焦点可能逸出到背景内容。
5. **面包屑使用视频 ID**：分镜 / 编辑器等页面的面包屑会显示 `vid_...`，而不是视频标题。
6. **预览依赖前台标签页**：`requestAnimationFrame` 在后台标签页会被节流，播放进度不会按真实时间推进；这是浏览器行为，未做 Web Worker 时钟兜底。
7. **模拟 DAG 只在页面打开时推进**：这是刻意设计，用于避免后台伪造进度；刷新后运行状态按已持久化快照恢复，不会在后台继续。服务端模式（5A）的任务由 SQLite 队列推进，与模拟 DAG 并存。
8. **浏览器内模拟预览没有音频**：编辑器预览只有字幕与时间轴，不播放旁白；真实音轨只存在于服务端渲染出的 MP4（5B），预览不应被误解为成片。
9. **建议弹窗文案不够精确**：部分“接受建议会升级 Claim 状态”的说明可能高估实际状态变化，需要按建议类型细化。
10. **CI 覆盖范围**：`.github/workflows/ci.yml` 的 `validate` / `build` / `e2e`（含 API webServer）/ `render` / `capture` 均已在 GitHub Actions Linux runner 跑通；仍未覆盖文档类 PR 跳门禁的回归验证。
11. **渲染切片与 Web UI 的边界**：服务端模式可从生产页启动真实渲染，开启旁白时产出带 AAC 音轨的 MP4 + SRT，审核通过后在审核页下载 Gate 3 交付包（MP4 + SRT + manifest，均校验 SHA256）；但「模拟 DAG」、浏览器预览与 Web 内 MP4 / WebM 导出仍是模拟状态，两者在 UI 上分别标注。
12. **渲染只支持 16:9，无 BGM、字体未打包**：竖屏需要单独布局；旁白只支持单轨纯语音（无背景音乐 / ducking），词级卡拉 OK 字幕与多语言未实现；依赖系统 CJK 字体，跨机器字形可能不同。未配置 TTS 时服务端 fail-closed（503），不会静默产出无声成片。
13. **Remotion 许可**：个人或 ≤3 员工公司可免费使用；更大组织商用前需要公司许可。
14. **渲染耗时无基线**：单次全片渲染在本机约数分钟，尚未采集成功率与耗时分布。
15. **工作区 API 无鉴权 / 租户隔离**：默认只监听 `127.0.0.1`，CORS 只允许本地 4200；不能直接暴露到公网。
16. **SQLite 单写入者**：没有多实例并发、租户字段或按实体审计；多实例部署前需要 PostgreSQL 或串行化层。
17. **工作区备份不含媒体**：导出只有元数据；`Asset.media` 是相对路径，跨设备恢复后 MP4 / 截图可能缺失，需另行拷贝。
18. **导入会整体替换**：不做实体级合并；导入前会迁移与 Schema 校验，但成功后当前工作区与撤销历史被覆盖。
19. **服务端编排仍为单实例**：租约以「其他实例即孤儿」回收，适配单 API 进程 + 单 SQLite 文件；多实例部署前需要真正的租约表或 PostgreSQL。服务端模式仅监听本机，无鉴权。

---

## 9. 后续建议

1. **性能**：路由懒加载、`manualChunks` 与 bundle budget 已落地；下一步是把 mock-services / 种子数据从初始状态中按需加载，并对图表等重组件继续下沉。
2. **无障碍**：`Field` 已自动关联直接表单控件，axe 扫描已加入 E2E；下一步为移动端抽屉补 `inert` 与焦点回收，并补齐 `aria-describedby`。
3. **测试**：移动端（390×844）与平板（768×1024）项目、`prefers-reduced-motion` 与 axe 用例已加入；下一步是关键页面视觉快照。
4. **品牌传播**：品牌变更时提供“同步更新片尾 CTA”的可选操作，并在审核中显示差异，而不是只让审核失效。
5. **数据边界**：v1→v2 迁移、整工作区导入 / 导出与可选 SQLite 同步已落地；下一步是鉴权 / 租户隔离、媒体随备份迁移，以及把运行调度搬到服务端。
6. **服务抽象**：`mock-services` 已收敛到 `libs/ports` 接口；下一步接真实适配器：GitHub App、知识索引、Agent 运行时、渲染队列；在真实文件存在前，导出状态不得宣称完成。
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
- [ADR-001 API 框架：Fastify](docs/adr/ADR-001-api-framework-fastify.md)
- [ADR-008 工作区存储：SQLite](docs/adr/ADR-008-sqlite-workspace-storage.md)
- [下一阶段排期与迭代建议](docs/10-NEXT-PHASE-PLAN.md)
- [真实渲染切片（Step 1 验收记录）](docs/11-RENDER-SLICE.md)
- [真实录屏切片（Step 2 验收记录）](docs/12-CAPTURE-SLICE.md)
- [服务端编排切片（Step 5A 验收记录）](docs/13-ORCHESTRATION-SLICE.md)
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
  e2e/               Playwright 配置、38 个桌面 / 移动端 / 平板 / 无障碍 / 动效 / 真实知识闭环用例
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
  browser-worker/    CLI 录屏 worker、DemoPlan 执行器、安全探针与回执校验
scripts/             bundle budget、边界反向验证、渲染产物复核
docs/                产品、架构与 UX 文档
```

---

**一句话总结**：这是一个把“可信软件事实 → 可审阅视频工程”完整走通的前端工作台，并用一个 CLI 渲染切片证明 Storyboard 能变成带 SHA256 回执的真实 MP4；它真实保存、真实校验、真实导出工程与字幕，同时诚实地说清楚哪些能力仍是模拟。
