# Mock 数据与模拟服务策略

> 目标：今天用可替换的 Mock 层验证完整体验；未来接入真实 API 时，尽量不改页面与领域状态。

## 1. 边界与标识

| 层 | 本阶段实现 | 明确标识 |
|---|---|---|
| 外部连接 | 模拟 GitHub / 文档 / 演示环境连接 | 连接器卡片 `模拟连接`；项目内 `Demo 数据` |
| 知识分析 | 种子快照 + 模板生成的新项目知识 | 知识页来源均标记 `Demo 仓库 / 模拟分析` |
| AI Director | 规则意图解析 | 对话区 `模拟导演`、能力边界提示 |
| 生产 | 确定性状态机 | 运行页 `模拟执行` + 场景选择器 |
| 视频画面 | DOM/CSS/SVG 实时预览 | 预览角标 `模拟预览` |
| 导出 | MP4/WebM 状态模拟；JSON/SRT 真实文件 | 导出任务 `模拟导出（不生成 MP4）` |
| 持久化 | localStorage | 数据重置入口 |

所有 Demo 数据携带领域字段 `demo: true`；UI 不靠文案猜测数据真假。

## 2. 领域模型（核心）

```ts
Project { id, name, productName, description, website, stage,
  brand: BrandKit, sources: SourceConnection[],
  defaultAspect, defaultLanguage, createdAt, updatedAt, demo }

Feature { id, projectId, name, summary, category, status,
  confidence, userConfirmed, sourceRefs[], claimIds[], prIds[],
  demoRoute, updatedAt, tags[], demo }

Claim { id, projectId, featureId, statement, audience, status,
  evidenceIds[], verification? { environment, appVersion, verifiedAt },
  demo }

Evidence { id, projectId, kind: source|test|runtime|release|human,
  title, detail, ref, status: valid|stale|missing, capturedAt, demo }

PullRequest / Release / KnowledgeSuggestion
VideoProject { id, projectId, title, mode, stage, brief, scenes[],
  scriptVersion, createdAt, updatedAt, review?, exports[], demo }
Scene { id, order, title, intent, narration, caption, durationSec,
  visualType, templateId, featureId?, claimIds[], assetId?,
  status: draft|approved|review, notes? }
ProductionRun { id, videoId, projectId, scenario, status, steps[],
  logs[], startedAt, elapsedMs, approval, failure? }
ExportRecord { id, videoId, format, aspect, resolution, status, progress, note }
```

`Feature.status` 与 `Claim.status` 分开：源码存在不等于已部署，部署不等于已验证，验证不等于可公开宣传。审核以 Claim 为准。

## 3. 演示项目：Lumen Analytics（虚构）

**定位**：面向 SaaS 团队的产品数据协作平台。首页、项目卡、品牌、缩略图均使用此虚构产品。

| 功能 | 状态 | Claim | 证据 | 用途 |
|---|---|---|---|---|
| 实时协作看板 | verified / deployed | 团队可同时编辑同一看板 | PR #482、E2E 测试、预发布录屏 | 主宣传卖点（已核验） |
| AI 异常检测 | supported | AI 自动标记指标异常 | PR #498、模型评估文档 | 次卖点（待补充验证） |
| 一键分享报告 | verified / deployed | 30 秒生成可分享报告 | PR #475、运行时证据 | 展示 / 教程 |
| 自定义漏斗分析 | verified | 拖拽创建多步漏斗 | PR #455、测试证据 | 功能教程 |
| 数据源连接器 | implemented | 支持 12 种数据源 | 源码、文档 | 说明能力范围，避免量化宣传 |
| 移动端深色模式 | stale | 移动端支持深色模式 | 过期运行时证据 | 演示证据阻断 |

- 模拟 PR：#455、#461（内部重构，不建议宣传）、#475、#482、#498；模拟 Release v2.8.0 / v2.7.2。
- 待确认建议：把 #498 关联为"AI 异常检测"的新证据；将"移动端深色模式"标记为需重新验证。
- 资产：3 段模拟录屏、2 个动效模板、1 个生成视觉；全部为本地渲染的图形，不含真实客户数据。
- 视频工程：`Lumen 2.8 · 从数据到行动`（30 秒，review 阶段，用于 Dashboard 待办与跨页验证）；另有 1 个草稿。
- 生产记录：一条已完成的运行 + 一条失败后重试成功的运行（用于 Dashboard 最近生产）。

第二个项目 **Pulse CRM**（虚构，蓝紫色品牌，仅 2 个功能、无视频）用于验证项目切换、空状态与多项目首页。

## 4. 服务接口

页面不直接生成 mock 数据。所有业务操作通过 `libs/mock-services` 暴露的服务：

```ts
OnboardingService {
  connectSource(kind, input): Promise<SourceConnection>
  generateKnowledge(projectDraft): Promise<{ features, claims, evidence, suggestions }>
  simulateFailure(kind): ConnectionResult
}

DirectorService {
  createPlan(brief, project): VideoProject
  interpret(command, video): DirectorResult {
    reply, changes: Change[], patch: Partial<VideoProject>
  }
  regenerateScene(video, sceneId): Scene
}

ProductionEngine {
  createRun(video, scenario): ProductionRun
  tick(run, deltaMs): ProductionRun       // 纯函数式推进
  pause(run) / resume(run) / cancel(run)
  approve(run) / retry(run, stepId)
}

ReviewService {
  evaluate(video, features, claims, evidence): ReviewCheck[]
  applyDecision(videoId, decision, note)
}

ExportService {
  createJob(video, config): ExportRecord
  tickJob(job, deltaMs): ExportRecord
  buildProjectJson(video, project): string
  buildSrt(video): string
}

KnowledgeService {
  updateFeature(patch)
  reverifyClaim(claimId): { claim, evidence }
  resolveSuggestion(id, action)
}
```

实现方式：同步纯函数 + 人工延迟（`delay(ms)`）模拟网络。UI 的 loading 状态由页面 / Store 管理。服务不得访问 DOM、路由或 UI Store。

### 确定性原则

- 不使用 `Math.random()` 决定业务结果。
- 生产步骤、失败点、日志文本由 `scenario` 决定。
- 时长缩放使用比例分配，容忍取整误差并通过最后一镜补齐总时长。
- 新实体 ID 允许使用 `crypto.randomUUID()`（不影响结果可重复性），种子数据 ID 固定。
- 所有服务输入输出经过 Zod 校验（关键契约），校验失败显式抛错而不是静默降级。

## 5. 状态与持久化

```text
mock-services (纯逻辑)
      ↑
studio-store (Zustand, persist)
  ├─ entities: projects / features / claims / evidence / PRs / releases /
  │            suggestions / assets / templates / videos / runs / exports / activity
  ├─ actions: 业务命令，调用 service，再提交状态
  └─ storage: localStorage key `asvs.studio.v1`，version 迁移
ui-store (Zustand, persist 偏好)
  └─ theme / sidebar / demo-info-open
```

- 领域 Store 是唯一事实源；页面通过 selector 派生数据，不复制实体到本地 state（表单草稿除外）。
- 撤销 / 重做：`studio-store` 维护每个视频的内存快照（最多 30 步），编辑动作通过 `editVideo` 统一记录；不持久化历史。
- 持久化失败或版本不匹配：清理损坏存储，回退种子数据并提示。
- `resetDemo()`：清空 localStorage 并重新加载种子；不触达任何外部资源。

## 6. 模拟场景清单

| 场景 | 入口 | 结果 |
|---|---|---|
| GitHub 连接成功 | Onboarding 接入方式 | 3 秒进度 → 只读 Demo 仓库 + 4 个来源 |
| GitHub 连接失败 | Onboarding 的错误演示按钮 | 明确错误 + 重试，不阻塞其他来源 |
| 知识同步 | Knowledge「重新分析」 | 2 秒进度 → 新增 1 条待确认建议；不改已有事实 |
| 新项目知识生成 | Onboarding 完成 | 根据接入方式生成 3–5 个功能与低置信度 Claim |
| Director 缩短时长 | 聊天 / 快捷命令 | 按比例重分配镜头；总时长与 Brief 一致 |
| Director 删除卖点 | 聊天 / 卖点面板 | 相关分镜移除；可撤销 |
| Director 未知指令 | 聊天 | 说明模拟能力边界 + 建议命令 |
| 生产标准成功 | Production | 8 步全部成功，约 28 秒（可加速） |
| 录屏失败重试 | Production 场景 | 第 5 步失败 → 重试成功 → 完成 |
| 审批 Gate | Production 场景 | 第 5 步后暂停等待批准；批准后继续 |
| 审核阻断（stale claim） | 选择过期功能 | Review 通过按钮禁用；重新验证后通过 |
| 模拟 MP4 导出 | Review | 进度 → 完成，标注未生成文件 |
| 工程 JSON / SRT 下载 | Review | 真实 Blob 下载；文件名含视频 ID |
| 重置演示数据 | Settings / Demo 面板 | 全部状态回到种子并刷新 |

## 7. 与真实后端的替换路径

- 页面只依赖领域类型与 Store action；`studio-store` 的 action 签名即应用服务契约。
- 接入真实 API 时，替换 `mock-services` 为 HTTP client，保留相同返回类型；Store 的 loading / error 分支已存在。
- 生产引擎保留在服务端时，前端改为轮询 / SSE 更新运行快照；`ProductionStep` 视图无需重写。
- Director 换成真实 Agent 时，保持"命令 → 结构化变更 + 影响摘要"的返回契约；聊天不再直接拼文本。
- 导出 MP4 真实化时，`ExportRecord` 增加真实 artifact URL 与 hash；模拟标识由 `simulated` 字段控制。
- 知识模型接入真实快照后，`demo` 字段移除；UI 的 Demo 徽标由数据驱动自动消失。

**不得依赖**：页面不得直接导入 `mock-data` 种子，不得读取 localStorage 原始结构，不得在组件内写业务规则。

## 8. 测试数据重置与一致性守则

- 种子数据必须能通过 `seed` 一次性构造，重复初始化结果一致。
- 任何新功能必须同时更新：领域类型、Zod Schema、seed、服务、测试。
- 跨页面数据只增不改副本；若必须复制（例如场景标题），在审核与导出中标明事实快照来源。
- 所有模拟延迟集中在服务层，页面不得散落 `setTimeout` 伪造业务延迟（播放与生产 tick 除外）。
