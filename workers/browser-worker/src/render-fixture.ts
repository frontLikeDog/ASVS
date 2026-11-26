import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  renderFixtureV1Schema,
  type Asset,
  type Project,
  type RenderFixtureV1,
  type Scene,
  type VideoProject,
} from '@asvs/domain';
import type { VideoProbe } from './media';
import { storageRefFor } from './paths';

const FPS = 30;
const TOTAL_SECONDS = 30;
/**
 * The approved tour runs dashboard → video library → review landing →
 * storyboard → production monitoring → review/export, and the recorded clip is
 * ~18s. The real_demo scene must cover the whole clip (otherwise the tail of
 * the tour is silently cut off); the four surrounding scenes are compressed to
 * keep the film at 30s.
 */
const REAL_DEMO_SECONDS = 18;
const TITLE_SECONDS = 3;
const EVIDENCE_SECONDS = 4;
const DAG_SECONDS = 3;
const CTA_SECONDS = 2;

const ASVS_PROJECT: Project = {
  id: 'proj_asvs_studio',
  name: 'ASVS Studio',
  productName: 'AI Software Video Studio',
  description:
    '把可信的软件事实变成可编辑、可生产、可审核的视频工程。这条样片的画面来自 web-studio 自身。',
  website: 'https://asvs.demo.invalid',
  stage: 'active',
  brand: {
    logoText: 'ASVS',
    logoMark: 'orbit',
    primary: '#E8A44C',
    secondary: '#7C8798',
    fontPair: 'grotesk',
    style: 'editorial',
    intro: '从真实软件事实，到可审阅的视频',
    outro: 'asvs.demo.invalid · 在本地走通一次真实闭环',
  },
  sources: [
    {
      id: 'src_asvs_local',
      kind: 'website',
      name: 'localhost:4200',
      detail: '本地 web-studio · Playwright 真实录屏',
      status: 'connected',
      scope: 'allowlist: http://localhost:4200',
      demo: false,
    },
  ],
  defaultAspect: '16:9',
  defaultLanguage: 'zh-CN',
  templateId: 'tpl_grid',
  analysisCount: 0,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  demo: false,
};

function scene(input: {
  id: string;
  order: number;
  durationSec: number;
  title: string;
  intent: string;
  narration: string;
  caption: string;
  visual?: Scene['visual'];
  visualType: Scene['visualType'];
  assetId?: string;
  cards?: Array<{ label: string; value: string }>;
  vignette?: boolean;
}): Scene {
  return {
    id: input.id,
    order: input.order,
    revision: 1,
    title: input.title,
    intent: input.intent,
    narration: input.narration,
    caption: input.caption,
    durationSec: input.durationSec,
    durationFrames: Math.round(input.durationSec * FPS),
    visualType: input.visualType,
    visual:
      input.visual ??
      (input.cards
        ? {
            type: 'motion_graphics',
            templateId: 'tpl_grid',
            props: { cards: input.cards },
          }
        : { type: 'title' }),
    templateId: 'tpl_grid',
    claimIds: [],
    ...(input.assetId ? { assetId: input.assetId } : {}),
    status: 'approved',
    look: 'cinematic',
    brightness: 1,
    vignette: input.vignette ?? true,
  };
}

export interface CaptureFixtureInput {
  planId: string;
  planDigest: string;
  assetId: string;
  assetName: string;
  assetDescription: string;
  assetPalette: [string, string];
  clip: VideoProbe;
  clipSha256: string;
  clipFile: string;
  receiptFile: string;
  createdAt: string;
}

export function buildAsset({
  planId,
  assetId,
  assetName,
  assetDescription,
  assetPalette,
  clip,
  clipSha256,
  receiptFile,
}: CaptureFixtureInput): Asset {
  return {
    id: assetId,
    projectId: ASVS_PROJECT.id,
    name: assetName,
    kind: 'capture',
    durationSec: Math.round((clip.durationMs / 1000) * 1000) / 1000,
    description: assetDescription,
    palette: assetPalette,
    mock: false,
    media: {
      src: `captures/${assetId}.mp4`,
      mimeType: 'video/mp4',
      width: clip.width,
      height: clip.height,
      durationMs: clip.durationMs,
      sha256: clipSha256,
      capturePlanId: planId,
      captureReceiptRef: storageRefFor(receiptFile),
    },
  };
}

export function captureDurationSeconds(clip: VideoProbe): number {
  return Math.round((clip.durationMs / 1000) * 1000) / 1000;
}

export function assertClipLongEnough(
  clip: VideoProbe,
  minimumMs = (REAL_DEMO_SECONDS - 1) * 1000,
): void {
  if (clip.durationMs < minimumMs) {
    throw new Error(
      `录屏片段过短：${clip.durationMs}ms，真实镜头需要约 ${REAL_DEMO_SECONDS}s。请增加 DemoPlan 中的 dwellMs 或 clipDurationMs。`,
    );
  }
}

export function buildCaptureRenderFixture(
  input: CaptureFixtureInput & { asset: Asset; mediaSha256: string },
): RenderFixtureV1 {
  const duration = captureDurationSeconds(input.clip);
  // Every frame of the clip must fit inside the scene; a clip that overruns
  // means the tour tail (e.g. review/export) would never reach the film.
  const clipFrames = Math.ceil((input.clip.durationMs / 1000) * FPS);
  if (clipFrames > REAL_DEMO_SECONDS * FPS) {
    throw new Error(
      `录屏片段 ${duration}s（${clipFrames} 帧）超过 real_demo 镜头的 ${REAL_DEMO_SECONDS}s；请同步调整镜头时长分配。`,
    );
  }

  const scenes: Scene[] = [
    scene({
      id: 'scene_asvs_title',
      order: 0,
      durationSec: TITLE_SECONDS,
      title: '真实界面，真实操作',
      intent: '说明这条样片的画面来自一次真实的浏览器录制，而不是生成式画面。',
      narration: '这一次，画面不是生成的，而是一段真实的产品操作。',
      caption: '真实界面，真实操作。',
      visual: { type: 'title' },
      visualType: 'title',
    }),
    scene({
      id: 'scene_asvs_real_demo',
      order: 1,
      durationSec: REAL_DEMO_SECONDS,
      title: 'web-studio · 一次真实的界面巡览',
      intent:
        '播放 Step 2 录制的真实画面：工作台、视频库筛选、分镜工作室、生产监控与审核导出。',
      narration:
        'Playwright 按已批准的 DemoPlan 操作 web-studio；每个停靠点都先通过 UI 断言，才被写进回执。',
      caption: '工作台、视频库、分镜、生产监控与审核导出，来自同一次 Playwright 录屏。',
      visual: {
        type: 'real_demo',
        demoPlanId: input.planId,
        assetId: input.assetId,
      },
      visualType: 'real_demo',
      assetId: input.assetId,
    }),
    scene({
      id: 'scene_asvs_evidence',
      order: 2,
      durationSec: EVIDENCE_SECONDS,
      title: '每条字幕，都能回到证据',
      intent: '把知识快照、声明与分镜放在同一条可追溯链上。',
      narration: '知识、脚本、分镜与生产运行，共用同一份数据。',
      caption: '知识、脚本与分镜，共用同一份数据。',
      visualType: 'motion',
      cards: [
        { label: '知识快照', value: 'v2.8.0' },
        { label: '已核验声明', value: '3 / 3' },
        { label: '镜头', value: '6' },
      ],
    }),
    scene({
      id: 'scene_asvs_dag',
      order: 3,
      durationSec: DAG_SECONDS,
      title: '断言通过，才写回执',
      intent: '强调录屏、渲染与回执都是确定性步骤，失败会留下截图与 trace。',
      narration: '录屏、渲染与回执都是确定性步骤；断言失败，就不存在成功回执。',
      caption: '断言通过，才写回执。',
      visualType: 'motion',
      cards: [
        { label: '录制', value: 'ASSERTED' },
        { label: '渲染', value: 'MP4' },
        { label: '回执', value: 'SHA256' },
      ],
    }),
    scene({
      id: 'scene_asvs_cta',
      order: 4,
      durationSec: CTA_SECONDS,
      title: '让真实成为默认',
      intent: '收束到产品主张：真实素材优先，模拟能力必须明确标注。',
      narration: '让真实成为默认，让每一个模拟都无处藏身。',
      caption: '让真实成为默认。',
      visual: { type: 'cta' },
      visualType: 'cta',
    }),
  ];

  const total = scenes.reduce((sum, item) => sum + item.durationSec, 0);
  if (total !== TOTAL_SECONDS) {
    throw new Error(`样片总时长应为 ${TOTAL_SECONDS}s，实际 ${total}s`);
  }

  const video: VideoProject = {
    id: 'vid_asvs_capture',
    projectId: ASVS_PROJECT.id,
    title: 'ASVS · 真实录屏切片',
    mode: 'tutorial',
    stage: 'approved',
    fps: FPS,
    brief: {
      objective:
        '用同一条渲染管线，把 Step 2 录制的真实 web-studio 操作接入 Step 1 的 30 秒样片。',
      audience: '产品、工程与内容团队',
      featureIds: [],
      durationSec: TOTAL_SECONDS,
      aspect: '16:9',
      language: 'zh-CN',
      tone: 'technical',
      style: 'editorial',
      templateId: 'tpl_grid',
      useRealCapture: true,
      useGeneratedVisuals: false,
      cta: '把真实产品过程，变成可审阅的视频。',
      bannedPhrases: ['行业最强', '100% 准确', '完全自动'],
    },
    scenes,
    directorMessages: [],
    scriptVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    review: { status: 'approved', decidedAt: input.createdAt },
    demo: false,
  };

  const fixture = renderFixtureV1Schema.parse({
    schemaVersion: '1',
    kind: 'asvs.render-fixture',
    note: 'Step 2 真实录屏样片：real_demo 镜头播放 browser-worker 录制的 web-studio 真实画面。',
    generatedFrom: `browser-worker · ${input.planId} · ${input.planDigest}`,
    video,
    project: ASVS_PROJECT,
    features: [],
    assets: [input.asset],
    media: [
      {
        assetId: input.assetId,
        sourceFile: storageRefFor(input.clipFile),
        sha256: input.mediaSha256,
        mimeType: 'video/mp4',
        width: input.clip.width,
        height: input.clip.height,
        durationMs: input.clip.durationMs,
      },
    ],
  });

  return fixture;
}

export function writeCaptureRenderFixture(
  outDir: string,
  fixture: RenderFixtureV1,
): { file: string; relativeFile: string } {
  const file = path.join(outDir, 'captured-30s.json');
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return { file, relativeFile: storageRefFor(file) };
}
