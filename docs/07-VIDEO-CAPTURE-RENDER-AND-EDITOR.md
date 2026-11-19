# 07 · 真实录屏、视频合成与编辑器设计

> Draft v0.1｜视觉原则：真实 UI 展示功能，程序化动效提升表达，生成式视觉只作明确标识的辅助。

## 1. 三种视觉素材

1. **Real Demo**：Playwright 操作真实 staging 软件，录制浏览器画面；保留 trace、截图、步骤断言、环境版本。
2. **Motion Graphics**：Remotion 生成品牌开场、标题、功能卡、流程图、数据可视化、CTA。
3. **Generated Visual**：可选图像/视频模型生成抽象概念镜头；不得用于证明真实 UI 或真实效果。

镜头 IR 显式标记视觉来源；审核界面可以追溯原始素材。

## 2. 自动录屏流水线

```text
DemoPlan approved
  → allocate isolated browser + test account
  → verify allowlisted origin + environment version
  → reset fixture / seed demo data
  → execute steps with deterministic locators
  → assert expected UI state
  → record video + screenshots + trace
  → upload immutable artifacts + hashes
  → redact / inspect sensitive content
  → return CaptureReceipt
```

**稳定性规则**：优先 role/label/test-id 定位，避免脆弱 CSS nth-child；所有等待基于 UI 状态而非固定 sleep；每步设置超时；失败保存 screenshot/trace；演示数据需可重置；测试账号不可与生产账号混用。

录屏可能受到浏览器窗口尺寸、DPI、字体、动画时序影响。固定 viewport、设备缩放、时区、语言、字体包和动画策略。录制素材必须有实际成功的 assertions，不能只根据脚本结束码认定成功。

## 3. DemoPlan 示例

```yaml
schemaVersion: '1'
environment: staging
allowedOrigins:
  - https://staging.example.invalid
resetStrategy: fixture
steps:
  - action: navigate
    target: /projects/demo
  - action: assert
    target: 'role=heading,name=Demo Project'
  - action: click
    target: 'role=button,name=Create Task'
  - action: fill
    target: 'testid=task-title'
    valueRef: fixture.taskTitle
  - action: click
    target: 'role=button,name=Start'
  - action: assert
    target: 'testid=task-status-running'
  - action: capture
    target: 'scene-parallel-tasks'
```

以上为**演示语法草案**，执行器需要实现安全的 selector 解析器；不是可直接运行的 Playwright 代码。`example.invalid` 是占位域名。

## 4. Remotion 合成设计

- `Composition` 接收 `StoryboardV1`、BrandKit、Assets、Narration、RenderProfile。
- 每个 Scene 独立组件，输入纯数据；禁止在 React render 中进行网络请求、随机外部副作用。
- 时间线统一帧数，`fps` 与总时长冻结；字幕基于词/句级时间戳映射到帧。
- 视觉模板版本化，保持预览和服务端渲染一致。
- 导出 manifest 包含 compositionId、sceneDigests、assetHashes、renderProfile、rendererVersion。

## 5. 编辑器 MVP

**布局**：左侧分镜列表/素材；中间视频预览；右侧 Scene 属性；下方简化时间线。首版支持分镜顺序、时长、旁白、字幕、画面类型、素材替换、裁切/聚焦、模板和转场；不做无限轨道的通用 NLE。

**交互**：

- 点击镜头查看 Claim、Evidence、DemoPlan、素材来源。
- 修改文案时提示 TTS 失效，但不自动重录画面。
- 修改 UI 录屏计划时仅重录相关 Scene。
- 支持 Undo/Redo（前端命令日志）和持久化 Scene Revision。
- 编辑前显示影响分析：“将重新生成配音和镜头 3，其他镜头复用”。

## 6. 渲染策略

1. 编辑时使用低分辨率代理素材/预览。
2. 需要更新的 Scene 独立渲染为中间片段（保证音视频参数一致）。
3. 未变化的片段复用缓存。
4. 最终通过 FFmpeg 拼接/编码/混音，或由 Remotion 完整渲染（两种路径必须做画面与时间轴一致性测试）。
5. 对 16:9、9:16、1:1 分别定义 layout；竖屏不是简单裁切横屏。

**重要**：局部片段拼接会涉及转场跨镜头、音频连续性、字幕跨边界、编解码关键帧。首版可先实现全片渲染正确性，再通过基准验证逐步引入局部渲染；不能先承诺无损拼接。

## 7. 音频与字幕

TTS 供应商通过 `SpeechPort` 抽象；保存音频 hash、语音 ID、语言、许可信息。支持用户修改发音、停顿和语速。字幕生成 SRT/VTT，并进行时间轴与画面一致性校验。背景音乐必须有明确可商用授权，记录来源和许可范围。

## 8. 输出配置

| Profile | 比例 | 常见用途 | 要点 |
|---|---|---|---|
| Landscape | 16:9 | 官网、演示、长视频 | 保留完整 UI |
| Portrait | 9:16 | 短视频平台 | 焦点跟随、重新排版 |
| Square | 1:1 | 社交媒体 | 标题安全区、主体居中 |

实际编码参数（分辨率、码率、FPS、音频采样率）应根据目标平台与成本测试确定，写入 RenderProfile，不硬编码在业务逻辑中。

## 9. 质量门禁

**技术 QA**：文件存在、可解码、非黑屏/静帧异常、分辨率、时长、音频峰值、字幕时间轴、音画同步。  
**事实 QA**：Claim 证据完整、演示 assertions 通过、录屏来源可追溯。  
**隐私 QA**：检测可能出现的邮箱、token、客户信息，必要时人工复核。  
**内容 QA**：错字、配音读音、画面节奏、品牌一致性、CTA。

不能仅用一个 LLM 评分替代这些检查。

## 10. Fixture 与黄金样片

维护至少 3 套测试场景：登录后创建任务、并行任务状态展示、表格筛选/导出。每套 fixture 有稳定页面、测试数据、预期 assertions、参考截图、30 秒黄金样片；允许像素差异但应比较结构化指标与人工审核结果。

## 11. 成本与性能

记录每次录屏的浏览器启动时间、步骤耗时、失败率；渲染的 CPU/RSS/GPU、帧率、输出大小；TTS 与生成式素材费用。使用缓存、并发上限、任务优先级、超时和预算阻断，避免失控重试。

**关联文档**：02、03、05、06、08。
