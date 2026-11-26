import type {
  Asset,
  Claim,
  ClaimStatus,
  DirectorChange,
  DirectorContext,
  DirectorResult,
  Feature,
  Project,
  Release,
  Scene,
  SceneVisualType,
  Tone,
  VideoBrief,
  VideoMode,
  VideoProject,
  VisualStyle,
} from '@asvs/domain';
import {
  MIN_SCENE_DURATION,
  TONE_INFO,
  VIDEO_MODE_INFO,
  orderedScenes,
  round1,
  totalDuration,
  truncate,
  videoProjectSchema,
  withTargetDuration,
} from '@asvs/domain';
import type { CreateVideoPlanInput, InterpretDirectorInput } from '@asvs/ports';
import { newId, nowIso } from './id';

export type { CreateVideoPlanInput, InterpretDirectorInput };

const TONE_LABEL: Record<Tone, string> = {
  confident: TONE_INFO.confident.label,
  warm: TONE_INFO.warm.label,
  technical: TONE_INFO.technical.label,
  bold: TONE_INFO.bold.label,
};

const STYLE_LABEL: Record<VisualStyle, string> = {
  editorial: '编辑叙事',
  product: '产品清晰',
  bold: '大胆冲击',
  minimal: '极简克制',
};

const TEMPLATE_LABEL: Record<string, string> = {
  tpl_signal: 'Signal',
  tpl_grid: 'Grid',
  tpl_bloom: 'Bloom',
  tpl_type: 'Type',
};

const LIMITATION_PATTERN = /预发布|验证中|待验证|提示|辅助|参考|限定|Beta|beta|确认/;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function firstSentence(text: string): string {
  const clean = text.trim();
  const match = clean.match(/^(.+?[。！？.!?])/);
  return (match?.[1] ?? clean).trim();
}

function claimForFeature(feature: Feature, claims: Claim[]): Claim | undefined {
  return claims.find((claim) => claim.id === feature.claimIds[0]);
}

function limitationText(status: ClaimStatus | 'missing'): string {
  switch (status) {
    case 'supported':
      return '（预发布能力，以实际环境为准）';
    case 'proposed':
      return '（能力待验证）';
    case 'stale':
      return '（证据已过期，需重新验证）';
    case 'rejected':
      return '（声明未通过验证）';
    case 'missing':
      return '（未关联已核验证据）';
    default:
      return '';
  }
}

function isDemoSafe(feature: Feature, claim?: Claim): boolean {
  return (
    Boolean(claim) &&
    claim?.status === 'verified' &&
    (feature.status === 'verified' || feature.status === 'deployed')
  );
}

function pickAssets(assets: Asset[], projectId: string) {
  const projectAssets = assets.filter((asset) => asset.projectId === projectId);
  return {
    captures: projectAssets.filter((asset) => asset.kind === 'capture'),
    motion:
      projectAssets.find((asset) => asset.kind === 'b-roll' && !asset.description.includes('生成')) ??
      projectAssets.find((asset) => asset.kind === 'b-roll'),
    generated:
      projectAssets.find((asset) => asset.description.includes('生成')) ??
      projectAssets.find((asset) => asset.kind === 'b-roll'),
  };
}

interface FeatureSceneArgs {
  order: number;
  feature: Feature;
  claim?: Claim;
  brief: VideoBrief;
  assets: Asset[];
  projectId: string;
  captureIndex: number;
  stepIndex?: number;
  stepCount?: number;
}

function buildFeatureScene({
  order,
  feature,
  claim,
  brief,
  assets,
  projectId,
  captureIndex,
  stepIndex,
  stepCount,
}: FeatureSceneArgs): Scene {
  const safeToDemo = isDemoSafe(feature, claim);
  const pools = pickAssets(assets, projectId);
  const capture =
    pools.captures.length > 0 ? pools.captures[captureIndex % pools.captures.length] : undefined;
  const motion = pools.motion;
  const visualType: SceneVisualType =
    safeToDemo && brief.useRealCapture && capture ? 'real_demo' : 'motion';
  const assetId = visualType === 'real_demo' ? capture?.id : motion?.id;
  const status = claim?.status ?? 'missing';

  let title = feature.name;
  let narration = firstSentence(feature.summary);
  let caption = claim?.statement ? truncate(claim.statement, 32) : truncate(feature.summary, 32);

  if (typeof stepIndex === 'number' && typeof stepCount === 'number') {
    const stepTitles = [`打开 ${feature.name}`, '完成关键操作', '确认结果'];
    const stepNarrations = [
      `从产品入口进入 ${feature.name}。`,
      firstSentence(feature.summary),
      '完成后确认结果，确保改动已经生效。',
    ];
    title = stepTitles[stepIndex] ?? feature.name;
    narration = stepNarrations[stepIndex] ?? narration;
    caption = `${stepIndex + 1}/${stepCount} · ${title}`;
  }

  if (!safeToDemo) {
    caption = `${caption}${limitationText(status)}`;
  }

  return {
    id: newId('scene'),
    order,
    revision: 1,
    title,
    intent: `展示功能：${feature.name}`,
    narration,
    caption,
    durationSec: 8,
    visualType,
    templateId: brief.templateId,
    featureId: feature.id,
    claimIds: feature.claimIds,
    assetId,
    status: 'draft',
    look: visualType === 'real_demo' ? 'warm' : 'clean',
    brightness: 1,
    vignette: visualType !== 'real_demo',
    notes: safeToDemo
      ? undefined
      : `关联 Claim 状态为 ${status}，发布前需要补齐证据或保留限定表述。`,
  };
}

function toneLead(tone: Tone): string {
  switch (tone) {
    case 'warm':
      return '如果你也在团队里做产品决策，';
    case 'technical':
      return '这次更新里，';
    case 'bold':
      return '先看重点。';
    default:
      return '';
  }
}

function titleSceneCopy(args: {
  mode: VideoMode;
  project: Project;
  brief: VideoBrief;
  release?: Release;
  feature?: Feature;
}): { title: string; narration: string; caption: string } {
  const { mode, project, brief, release, feature } = args;
  const lead = toneLead(brief.tone);
  if (mode === 'release_video') {
    return {
      title: release ? `${project.productName} ${release.version}` : `${project.productName} · 更新`,
      narration: `${lead}${
        release
          ? `${project.productName} ${release.version} 的主题是「${release.name}」。${release.highlight}`
          : brief.objective
      }`,
      caption: release ? `${release.version} · ${release.name}` : '这一版，有什么不同。',
    };
  }
  if (mode === 'tutorial') {
    return {
      title: `上手：${feature?.name ?? '一个关键功能'}`,
      narration: `${lead}用 ${Math.round(brief.durationSec)} 秒，完成一次真实的 ${
        feature?.name ?? '产品操作'
      }。`,
      caption: '从第一步开始。',
    };
  }
  if (mode === 'content_factory') {
    return {
      title: feature?.name ?? project.productName,
      narration: `${lead}${Math.round(brief.durationSec)} 秒，看懂 ${
        feature?.name ?? project.productName
      }。`,
      caption: '今天，讲一个具体的功能。',
    };
  }
  return {
    title: project.brand.intro || `${project.productName} · 让工作更清晰`,
    narration: `${lead}${truncate(project.brand.intro || project.description, 90)}`,
    caption: project.brand.outro || project.productName,
  };
}

function ctaSceneCopy(
  video: Pick<VideoProject, 'brief'>,
  project: Project,
): { title: string; narration: string; caption: string } {
  const cta = video.brief.cta || project.brand.outro || '现在就开始';
  return {
    title: cta,
    narration: `${cta}。`,
    caption: project.brand.outro || cta,
  };
}


/**
 * Compiles a brief into a deterministic, editable storyboard. Every scene keeps
 * a feature/claim reference; copy is derived from product facts, never invented
 * numbers or availability claims.
 */
export function createVideoPlan(input: CreateVideoPlanInput): VideoProject {
  const { project, brief, mode, features, claims, assets, release } = input;
  const selectedFeatures = brief.featureIds
    .map((id) => features.find((feature) => feature.id === id))
    .filter((feature): feature is Feature => Boolean(feature));

  if (selectedFeatures.length === 0) {
    throw new Error('至少选择一个功能才能生成视频策划。');
  }

  const timestamp = nowIso();
  const scenes: Scene[] = [];
  const pools = pickAssets(assets, project.id);
  const openingVisual = brief.useGeneratedVisuals ? 'generated' : 'motion';
  const titleCopy = titleSceneCopy({ mode, project, brief, release, feature: selectedFeatures[0] });
  scenes.push({
    id: newId('scene'),
    order: 0,
    revision: 1,
    title: titleCopy.title,
    intent: '建立注意力并提出本期视频的核心问题',
    narration: titleCopy.narration,
    caption: titleCopy.caption,
    durationSec: 6,
    visualType: 'title',
    templateId: brief.templateId,
    claimIds: [],
    assetId: openingVisual === 'generated' ? pools.generated?.id : pools.motion?.id,
    status: 'draft',
    look: 'cinematic',
    brightness: 1,
    vignette: true,
  });

  let limitations = 0;
  if (mode === 'tutorial') {
    const feature = selectedFeatures[0]!;
    const claim = claimForFeature(feature, claims);
    for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
      const scene = buildFeatureScene({
        order: scenes.length,
        feature,
        claim,
        brief,
        assets,
        projectId: project.id,
        captureIndex: 0,
        stepIndex,
        stepCount: 3,
      });
      if (!isDemoSafe(feature, claim)) limitations += 1;
      scenes.push(scene);
    }
  } else {
    selectedFeatures.forEach((feature, index) => {
      const claim = claimForFeature(feature, claims);
      const scene = buildFeatureScene({
        order: scenes.length,
        feature,
        claim,
        brief,
        assets,
        projectId: project.id,
        captureIndex: index,
      });
      if (!isDemoSafe(feature, claim)) limitations += 1;
      scenes.push(scene);
    });
  }

  const ctaCopy = ctaSceneCopy({ brief }, project);
  scenes.push({
    id: newId('scene'),
    order: scenes.length,
    revision: 1,
    title: ctaCopy.title,
    intent: '收束叙事并给出行动号召',
    narration: ctaCopy.narration,
    caption: ctaCopy.caption,
    durationSec: 4,
    visualType: 'cta',
    templateId: brief.templateId,
    claimIds: [],
    status: 'draft',
    look: 'clean',
    brightness: 1,
    vignette: true,
  });

  const minTotal = round1(scenes.length * MIN_SCENE_DURATION);
  const target = round1(Math.max(minTotal, Math.min(300, brief.durationSec)));
  const timedScenes = withTargetDuration(scenes, target);
  const actualDuration = totalDuration(timedScenes);
  const totalClaims = new Set(timedScenes.flatMap((scene) => scene.claimIds)).size;

  const video: VideoProject = {
    id: newId('vid'),
    projectId: project.id,
    title: input.videoTitle.trim() || `${project.productName} · ${VIDEO_MODE_INFO[mode].shortLabel}`,
    mode,
    stage: 'script_review',
    fps: 30,
    brief: { ...brief, durationSec: actualDuration },
    scenes: timedScenes,
    directorMessages: [
      {
        id: newId('dm'),
        role: 'assistant',
        text: `我已经根据 ${selectedFeatures.length} 个功能、${totalClaims} 条声明生成了 ${
          timedScenes.length
        } 个分镜，总时长 ${actualDuration} 秒。${
          limitations > 0
            ? `其中 ${limitations} 个镜头涉及尚未核验的声明，我已在字幕里保留限定表述。`
            : '所选声明都有已核验证据。'
        }你可以直接告诉我想缩短时长、换语气、调整顺序，或删除某个卖点。`,
        at: timestamp,
      },
    ],
    scriptVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    demo: true,
  };

  return videoProjectSchema.parse(video);
}

function normalizeVideo(video: VideoProject): VideoProject {
  const scenes = orderedScenes(video.scenes).map((scene, index) => ({ ...scene, order: index }));
  return {
    ...video,
    scenes,
    brief: { ...video.brief, durationSec: totalDuration(scenes) },
  };
}

function finalize(
  original: VideoProject,
  nextVideo: VideoProject,
  changes: DirectorChange[],
  reply: string,
  intent: string,
  recognized = true,
): DirectorResult {
  if (changes.length === 0) {
    return { intent, recognized, reply, changes: [], video: original };
  }
  const candidate = normalizeVideo({
    ...nextVideo,
    updatedAt: nowIso(),
    scriptVersion: original.scriptVersion + 1,
  });
  try {
    const video = videoProjectSchema.parse(candidate);
    return { intent, recognized, reply, changes, video };
  } catch (error) {
    console.error('Director produced an invalid project', error);
    return {
      intent,
      recognized: false,
      reply: '这次修改没有通过工程校验，我已保持视频原样。可以换一种说法，或改用更具体的操作。',
      changes: [],
      video: original,
    };
  }
}

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseOrdinalValue(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  return CN_DIGITS[raw] ?? null;
}

function parseSceneOrdinal(command: string): number | null {
  const match = command.match(/第\s*([0-9一二两三四五六七八九十]+)\s*(?:个)?\s*(?:镜头|分镜|场景)/);
  if (!match?.[1]) return null;
  return parseOrdinalValue(match[1]);
}

function parseFeatureOrdinal(command: string): number | null {
  const match = command.match(/第\s*([0-9一二两三四五六七八九十]+)\s*(?:个)?\s*(?:功能|卖点)/);
  if (!match?.[1]) return null;
  return parseOrdinalValue(match[1]);
}

function quotedSegments(command: string): string[] {
  return Array.from(command.matchAll(/[「『《“"]([^」』》”"]+)[」』》”"]/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function mentionedFeatures(command: string, features: Feature[]): Feature[] {
  const quoted = quotedSegments(command);
  return features
    .filter(
      (feature) =>
        command.includes(feature.name) ||
        quoted.some((segment) => segment.includes(feature.name) || feature.name.includes(segment)),
    )
    .sort((a, b) => {
      const ai = command.indexOf(a.name);
      const bi = command.indexOf(b.name);
      if (ai === -1 || bi === -1) return b.name.length - a.name.length;
      return ai - bi;
    });
}

function syncFeatureIds(brief: VideoBrief, scenes: Scene[]): string[] {
  const ordered: string[] = [];
  orderedScenes(scenes).forEach((scene) => {
    if (scene.featureId && !ordered.includes(scene.featureId)) ordered.push(scene.featureId);
  });
  brief.featureIds.forEach((id) => {
    if (!ordered.includes(id)) ordered.push(id);
  });
  return ordered;
}

function moveScenes(
  video: VideoProject,
  movingIds: Set<string>,
  target: 'opening' | 'end' | { featureId: string; position: 'before' | 'after' },
): VideoProject {
  const ordered = orderedScenes(video.scenes);
  const moving = ordered.filter((scene) => movingIds.has(scene.id));
  if (moving.length === 0) return video;
  const rest = ordered.filter((scene) => !movingIds.has(scene.id));
  let index = rest.length;

  if (target === 'opening') {
    index = rest[0]?.visualType === 'title' ? 1 : 0;
  } else if (target === 'end') {
    index = rest.length;
  } else {
    const targetIndices = rest
      .map((scene, sceneIndex) => (scene.featureId === target.featureId ? sceneIndex : -1))
      .filter((value) => value >= 0);
    if (targetIndices.length === 0) return video;
    index =
      target.position === 'before'
        ? targetIndices[0]!
        : targetIndices[targetIndices.length - 1]! + 1;
  }

  const nextScenes = [...rest.slice(0, index), ...moving, ...rest.slice(index)].map((scene, order) => ({
    ...scene,
    order,
  }));
  return {
    ...video,
    scenes: nextScenes,
    brief: { ...video.brief, featureIds: syncFeatureIds(video.brief, nextScenes) },
  };
}

function alternateScene(
  video: VideoProject,
  scene: Scene,
  feature: Feature | undefined,
  claim: Claim | undefined,
): { title: string; narration: string; caption: string } {
  const titleOptions: Record<SceneVisualType, string[]> = {
    real_demo: [
      feature?.name ?? scene.title,
      `${feature?.name ?? scene.title}，在真实界面里`,
      `一起看 ${feature?.name ?? scene.title}`,
    ],
    motion: [feature?.name ?? scene.title, '让变化被看见', '把复杂留在幕后'],
    generated: ['把想象留给画面', '概念氛围镜头', '光与结构之间'],
    title: ['问题，先被看见', '从一次真实的协作开始', '这一版，一起看见'],
    cta: [video.brief.cta || '现在就开始', '下一次，一起看见', '从今天开始'],
  };
  const narrationOptions: Record<SceneVisualType, string[]> = {
    real_demo: [
      claim?.statement ?? feature?.summary ?? scene.narration,
      feature ? `在真实界面中，${feature.name} 的每一步都能被看见。` : '在真实界面里，变化正在发生。',
      feature ? `不用想象，${feature.name} 就在界面里发生。` : scene.narration,
    ],
    motion: [
      claim?.statement ?? scene.narration,
      '变化不一定要大声，但要被看见。',
      '把复杂留在幕后，把清晰交给画面。',
    ],
    generated: [
      '这是一段概念氛围镜头，不用于证明产品界面。',
      '抽象视觉只负责情绪，不承载产品事实。',
      '让画面先呼吸一下。',
    ],
    title: [
      '问题先被看见，答案才有意义。',
      '一次更新，也可以是一段叙事。',
      '把注意力放回真正重要的事。',
    ],
    cta: [video.brief.cta || '现在就开始', '下一次，一起看见。', '从今天开始。'],
  };
  const baseCaption =
    scene.visualType === 'generated'
      ? '概念视觉 · 不构成产品证据'
      : claim?.statement
        ? truncate(claim.statement, 30)
        : truncate(feature?.summary ?? scene.caption, 30);
  const captionOptions = [
    baseCaption,
    feature ? `${feature.name} · 真实操作` : '把注意力放回真实的变化',
    scene.visualType === 'generated' ? '这段画面不证明产品能力' : '一起看见下一步',
  ];
  const seed = (video.scriptVersion + scene.order) % 3;
  const pick = (options: string[], offset = 0) => options[(seed + offset) % options.length] ?? options[0] ?? '';
  let title = pick(titleOptions[scene.visualType]);
  let narration = pick(narrationOptions[scene.visualType], 1);
  let caption = pick(captionOptions, 2);
  if (title === scene.title && narration === scene.narration) {
    title = pick(titleOptions[scene.visualType], 2);
    narration = pick(narrationOptions[scene.visualType], 0);
  }
  if (claim && claim.status !== 'verified') {
    caption = `${caption}${limitationText(claim.status)}`;
  }
  return { title, narration, caption };
}

function unknownResult(video: VideoProject, command: string): DirectorResult {
  return {
    intent: 'unknown',
    recognized: false,
    changes: [],
    video,
    reply: `我现在是确定性模拟导演，不会假装理解任意请求。无法从「${truncate(
      command,
      24,
    )}」中识别出可执行的修改。可以试试：「缩短到 30 秒」「把语气调得更轻松」「把受众改成开发者」「重新生成第 2 个分镜」「删除一个卖点」，或点击下面的快捷命令。`,
  };
}


/**
 * Deterministic intent resolution. Every recognized command mutates real project
 * data and returns a change list; unknown input is answered honestly.
 */
export function interpretDirectorCommand({
  command,
  video,
  context,
  focusSceneId,
}: InterpretDirectorInput): DirectorResult {
  const raw = command.trim();
  const lower = raw.toLowerCase();
  if (!raw) {
    return {
      intent: 'empty',
      recognized: false,
      reply: '告诉我你想改什么，或者点击下面的快捷命令。',
      changes: [],
      video,
    };
  }

  if (/^(帮助|help|你能做什么|怎么用|可以做什么)/.test(lower)) {
    return {
      intent: 'help',
      recognized: true,
      changes: [],
      video,
      reply:
        '我是模拟 AI 导演，可以真实修改这个视频工程：整体时长、单个镜头时长、语气、受众、功能/镜头顺序、单个分镜、旁白、卖点增删和视觉风格。每次修改都会更新 Brief、Storyboard 与 Editor，并返回变更清单。请一次说一件事；无法识别时我会直接说明，不会假装执行。',
    };
  }

  const ordered = orderedScenes(video.scenes);
  const selectedFeatures = video.brief.featureIds
    .map((id) => context.features.find((feature) => feature.id === id))
    .filter((feature): feature is Feature => Boolean(feature));
  const projectFeatures = context.features.filter((feature) => feature.projectId === video.projectId);

  // 1. Scene-level duration, e.g. 「把第 2 个镜头缩短到 4 秒」
  const sceneOrdinal = parseSceneOrdinal(raw);
  if (sceneOrdinal !== null && /\d/.test(raw) && /镜头|分镜|场景/.test(raw)) {
    const scene = ordered[sceneOrdinal - 1];
    if (!scene) {
      return unknownResult(video, raw);
    }
    const setMatch = raw.match(/(?:到|改成|调整为)\s*(\d+(?:\.\d+)?)\s*秒/);
    const deltaMatch = raw.match(/(缩短|减少|延长|增加)\s*(\d+(?:\.\d+)?)\s*秒/);
    let nextDuration: number | null = null;
    if (setMatch?.[1]) nextDuration = Number(setMatch[1]);
    else if (deltaMatch?.[2] && deltaMatch[1]) {
      const amount = Number(deltaMatch[2]);
      nextDuration = /缩短|减少/.test(deltaMatch[1])
        ? scene.durationSec - amount
        : scene.durationSec + amount;
    }
    if (nextDuration !== null && Number.isFinite(nextDuration)) {
      const clamped = round1(Math.max(MIN_SCENE_DURATION, Math.min(60, nextDuration)));
      const next = clone(video);
      const nextScene = next.scenes.find((item) => item.id === scene.id);
      if (nextScene) {
        nextScene.durationSec = clamped;
        nextScene.status = 'draft';
      }
      return finalize(
        video,
        next,
        [
          {
            field: `scene.${scene.id}.duration`,
            label: `镜头 ${sceneOrdinal} 时长`,
            from: `${scene.durationSec}s`,
            to: `${clamped}s`,
          },
        ],
        `已把第 ${sceneOrdinal} 个镜头调整为 ${clamped} 秒，视频总时长同步更新。该镜头审核状态回到草稿。`,
        'scene_duration',
      );
    }
  }

  // 2. Regenerate a scene
  if (/重新生成|重做|换一个|再来一版|regenerate/.test(lower) && /镜头|分镜|场景|画面/.test(raw)) {
    const targetScene =
      (sceneOrdinal !== null ? ordered[sceneOrdinal - 1] : undefined) ??
      (focusSceneId ? ordered.find((scene) => scene.id === focusSceneId) : undefined) ??
      ordered.find((scene) => Boolean(scene.featureId) && scene.visualType !== 'cta');
    if (!targetScene) {
      return unknownResult(video, raw);
    }
    const feature = projectFeatures.find((item) => item.id === targetScene.featureId);
    const claim = feature ? claimForFeature(feature, context.claims) : undefined;
    const copy = alternateScene(video, targetScene, feature, claim);
    const next = clone(video);
    const nextScene = next.scenes.find((item) => item.id === targetScene.id);
    if (!nextScene) return unknownResult(video, raw);
    const changes: DirectorChange[] = [];
    if (copy.title !== targetScene.title) {
      changes.push({
        field: `scene.${targetScene.id}.title`,
        label: `镜头 ${targetScene.order + 1} 标题`,
        from: targetScene.title,
        to: copy.title,
      });
    }
    if (copy.narration !== targetScene.narration) {
      changes.push({
        field: `scene.${targetScene.id}.narration`,
        label: `镜头 ${targetScene.order + 1} 旁白`,
        from: targetScene.narration,
        to: copy.narration,
      });
    }
    if (copy.caption !== targetScene.caption) {
      changes.push({
        field: `scene.${targetScene.id}.caption`,
        label: `镜头 ${targetScene.order + 1} 字幕`,
        from: targetScene.caption,
        to: copy.caption,
      });
    }
    nextScene.title = copy.title;
    nextScene.narration = copy.narration;
    nextScene.caption = copy.caption;
    nextScene.status = 'draft';
    return finalize(
      video,
      next,
      changes,
      `已重写第 ${targetScene.order + 1} 个分镜的标题、旁白与字幕，时长保持 ${
        targetScene.durationSec
      } 秒。该镜头审核状态回到草稿。`,
      'regenerate_scene',
    );
  }

  // 3. Delete a scene directly
  if (/删除|移除|去掉/.test(raw) && /镜头|分镜|场景/.test(raw) && sceneOrdinal !== null) {
    const scene = ordered[sceneOrdinal - 1];
    if (!scene) return unknownResult(video, raw);
    if (ordered.length <= 2) {
      return {
        intent: 'delete_scene',
        recognized: false,
        changes: [],
        video,
        reply: '视频至少需要保留 2 个分镜才能继续生产。可以修改这个镜头，或先添加一个新镜头。',
      };
    }
    const next = clone(video);
    next.scenes = ordered.filter((item) => item.id !== scene.id);
    return finalize(
      video,
      next,
      [{ field: 'scenes', label: '删除分镜', from: scene.title, to: '已移除' }],
      `已删除第 ${sceneOrdinal} 个分镜「${scene.title}」。剩余 ${ordered.length - 1} 个镜头，总时长已更新。`,
      'delete_scene',
    );
  }

  // 4. Delete / add selling points
  const mentioned = mentionedFeatures(raw, selectedFeatures);
  const mentionedAll = mentionedFeatures(raw, projectFeatures);
  const wantsDelete = /删除|去掉|移除|不要/.test(raw);
  const wantsAdd = /添加|加入|增加|补充|add/.test(raw);

  if (wantsDelete && (/卖点|功能/.test(raw) || mentioned.length > 0) && !/镜头|分镜|场景/.test(raw)) {
    const ordinal = parseFeatureOrdinal(raw);
    const target =
      mentioned[0] ??
      (ordinal !== null ? selectedFeatures[ordinal - 1] : undefined) ??
      mentionedAll[0];
    if (!target) {
      return {
        intent: 'delete_feature',
        recognized: false,
        changes: [],
        video,
        reply: `我没有确认要删除哪个卖点。当前视频包含：${selectedFeatures
          .map((feature) => `「${feature.name}」`)
          .join('、')}。可以说“删除「某个功能」卖点”。`,
      };
    }
    if (!video.brief.featureIds.includes(target.id)) {
      return {
        intent: 'delete_feature',
        recognized: false,
        changes: [],
        video,
        reply: `「${target.name}」目前不在这个视频的卖点里，因此没有可删除的镜头。`,
      };
    }
    if (selectedFeatures.length <= 1) {
      return {
        intent: 'delete_feature',
        recognized: false,
        changes: [],
        video,
        reply: '视频至少需要一个功能卖点才能继续生产。如果想去掉这个卖点，请先在知识中心选择另一个可用功能加入视频。',
      };
    }
    const removedScenes = ordered.filter((scene) => scene.featureId === target.id);
    const next = clone(video);
    next.scenes = ordered.filter((scene) => scene.featureId !== target.id);
    next.brief.featureIds = next.brief.featureIds.filter((id) => id !== target.id);
    const newDuration = totalDuration(next.scenes);
    return finalize(
      video,
      next,
      [
        { field: 'brief.featureIds', label: '移除卖点', from: target.name, to: '已从 Brief 移除' },
        {
          field: 'scenes',
          label: '移除分镜',
          from: `${removedScenes.length} 个镜头`,
          to: '已从 Storyboard 移除',
        },
        {
          field: 'brief.durationSec',
          label: '总时长',
          from: `${video.brief.durationSec}s`,
          to: `${newDuration}s`,
        },
      ],
      `已从 Brief 和 Storyboard 中移除「${target.name}」卖点，共删除 ${removedScenes.length} 个镜头。视频现在为 ${newDuration} 秒；Editor 时间线已同步。`,
      'delete_feature',
    );
  }

  if (wantsAdd && (/卖点|功能/.test(raw) || mentionedAll.length > 0)) {
    if (video.mode === 'tutorial') {
      return {
        intent: 'add_feature',
        recognized: false,
        changes: [],
        video,
        reply: '教程模式围绕一个功能展开，不能直接在视频里加入第二个卖点。可以新建一条宣传片或版本视频来介绍多个功能。',
      };
    }
    const ordinal = parseFeatureOrdinal(raw);
    const target =
      mentionedAll.find((feature) => !video.brief.featureIds.includes(feature.id)) ??
      (ordinal !== null
        ? projectFeatures.filter((feature) => !video.brief.featureIds.includes(feature.id))[ordinal - 1]
        : undefined);
    if (!target) {
      const available = projectFeatures.filter((feature) => !video.brief.featureIds.includes(feature.id));
      return {
        intent: 'add_feature',
        recognized: false,
        changes: [],
        video,
        reply:
          available.length === 0
            ? '这个项目的所有功能都已经在视频里了。可以先去知识中心分析更多功能。'
            : `没有找到要加入的功能。当前未使用的功能有：${available
                .map((feature) => `「${feature.name}」`)
                .join('、')}。`,
      };
    }
    const claim = claimForFeature(target, context.claims);
    const newScene = buildFeatureScene({
      order: 99,
      feature: target,
      claim,
      brief: video.brief,
      assets: context.assets,
      projectId: video.projectId,
      captureIndex: ordered.length,
    });
    const next = clone(video);
    const ctaIndex = next.scenes.findIndex((scene) => scene.visualType === 'cta');
    const insertAt = ctaIndex >= 0 ? ctaIndex : next.scenes.length;
    next.scenes.splice(insertAt, 0, newScene);
    next.scenes = next.scenes.map((scene, order) => ({ ...scene, order }));
    next.brief.featureIds = [...next.brief.featureIds, target.id];
    const newDuration = totalDuration(next.scenes);
    const limitation = isDemoSafe(target, claim) ? '' : ' 该功能当前没有已核验证据，我已保留限定表述。';
    return finalize(
      video,
      next,
      [
        { field: 'brief.featureIds', label: '新增卖点', from: '未使用', to: target.name },
        { field: 'scenes', label: '新增分镜', from: `${ordered.length} 个`, to: `${next.scenes.length} 个` },
        {
          field: 'brief.durationSec',
          label: '总时长',
          from: `${video.brief.durationSec}s`,
          to: `${newDuration}s`,
        },
      ],
      `已加入「${target.name}」卖点，并新增一个镜头，视频延长到 ${newDuration} 秒。${limitation}`,
      'add_feature',
    );
  }

  // 5. Reorder features / demo footage
  const hasMove = /提前|放到|移到|挪到|放在|最前|开头|之后|后面|前面/.test(raw);
  if (hasMove) {
    if (/录屏|演示画面|真实画面|录制/.test(raw)) {
      const demoScene = ordered.find((scene) => scene.visualType === 'real_demo');
      if (!demoScene) {
        return {
          intent: 'reorder',
          recognized: false,
          changes: [],
          video,
          reply: '当前视频里没有真实录屏分镜，无法把录屏提前。可以先在 Storyboard 中把某个镜头切换为“录屏演示”。',
        };
      }
      const toEnd = /最后|结尾/.test(raw);
      const moved = moveScenes(
        video,
        new Set([demoScene.id]),
        toEnd ? 'end' : 'opening',
      );
      if (moved.scenes[0]?.id === video.scenes[0]?.id && moved.scenes.every((scene, index) => scene.id === ordered[index]?.id)) {
        return {
          intent: 'reorder',
          recognized: true,
          changes: [],
          video,
          reply: '录屏演示已经在开场位置附近，顺序没有变化。',
        };
      }
      return finalize(
        video,
        moved,
        [
          {
            field: 'scenes.order',
            label: '分镜顺序',
            from: demoScene.title,
            to: toEnd ? '移到结尾' : '移到开场标题之后',
          },
          {
            field: 'brief.featureIds',
            label: '功能顺序',
            from: selectedFeatures.map((feature) => feature.name).join(' → '),
            to: moved.brief.featureIds
              .map((id) => projectFeatures.find((feature) => feature.id === id)?.name)
              .filter(Boolean)
              .join(' → '),
          },
        ],
        `已把「${demoScene.title}」${
          toEnd ? '移到结尾' : '移到开场标题之后'
        }。镜头编号已重排，总时长不变。`,
        'reorder',
      );
    }

    const mentionedForMove = mentionedFeatures(raw, selectedFeatures);
    const ordinalFeature = parseFeatureOrdinal(raw);
    const fromFeature =
      mentionedForMove[0] ??
      (ordinalFeature !== null ? selectedFeatures[ordinalFeature - 1] : undefined) ??
      (mentionedFeatures(raw, projectFeatures).length === 1 && /最前|开头|提前/.test(raw)
        ? mentionedFeatures(raw, projectFeatures)[0]
        : undefined);
    const toFeature = mentionedForMove[1];
    if (fromFeature) {
      let moved: VideoProject | null = null;
      const movingIds = new Set(
        ordered.filter((scene) => scene.featureId === fromFeature.id).map((scene) => scene.id),
      );
      if (movingIds.size === 0) {
        return {
          intent: 'reorder',
          recognized: false,
          changes: [],
          video,
          reply: `「${fromFeature.name}」没有关联镜头，无法调整顺序。`,
        };
      }
      if (toFeature && toFeature.id !== fromFeature.id) {
        moved = moveScenes(video, movingIds, {
          featureId: toFeature.id,
          position: /后面|之后/.test(raw) ? 'after' : 'before',
        });
      } else if (/最前|开头|提前|之前|前面/.test(raw)) {
        moved = moveScenes(video, movingIds, 'opening');
      } else if (/最后|结尾/.test(raw)) {
        moved = moveScenes(video, movingIds, 'end');
      }
      if (moved) {
        const unchanged = moved.scenes.every((scene, index) => scene.id === ordered[index]?.id);
        if (unchanged) {
          return {
            intent: 'reorder',
            recognized: true,
            changes: [],
            video,
            reply: '这个功能已经在这个位置，镜头顺序没有变化。',
          };
        }
        return finalize(
          video,
          moved,
          [
            {
              field: 'scenes.order',
              label: '分镜顺序',
              from: '原顺序',
              to: toFeature
                ? `${fromFeature.name} → ${toFeature.name} ${/后面|之后/.test(raw) ? '之后' : '之前'}`
                : `${fromFeature.name} ${/最后|结尾/.test(raw) ? '移至结尾' : '提前'}`,
            },
            {
              field: 'brief.featureIds',
              label: '功能顺序',
              from: selectedFeatures.map((feature) => feature.name).join(' → '),
              to: moved.brief.featureIds
                .map((id) => projectFeatures.find((feature) => feature.id === id)?.name)
                .filter(Boolean)
                .join(' → '),
            },
          ],
          `已调整「${fromFeature.name}」的镜头位置。镜头编号与功能顺序同步更新，总时长不变。`,
          'reorder',
        );
      }
    }
  }

  // 6. Whole-video duration
  const durationIntent = /时长|秒|缩短|精简|短一点|太长|延长|长一点|节奏|shorten|longer|trim/.test(lower);
  if (durationIntent) {
    const explicitMatch = raw.match(/(\d{1,3})\s*(?:秒|s\b)/);
    const explicit = explicitMatch?.[1] ? Number(explicitMatch[1]) : null;
    const shorten = /缩短|精简|短一点|太长|节奏更快|shorten|trim/.test(lower);
    const extend = /延长|长一点|更长|longer/.test(lower);
    if (explicit !== null || shorten || extend) {
      const minTotal = round1(ordered.length * MIN_SCENE_DURATION);
      let target = explicit ?? (shorten ? video.brief.durationSec * 0.8 : video.brief.durationSec * 1.2);
      target = round1(Math.max(minTotal, Math.min(180, target)));
      if (Math.abs(target - video.brief.durationSec) < 0.2) {
        return {
          intent: 'duration',
          recognized: true,
          changes: [],
          video,
          reply: `当前视频已经是 ${video.brief.durationSec} 秒。${
            target === minTotal ? `受 ${ordered.length} 个镜头的最小时长限制，无法再缩短。` : ''
          }`,
        };
      }
      const next = clone(video);
      next.scenes = withTargetDuration(next.scenes, target);
      const actual = totalDuration(next.scenes);
      return finalize(
        video,
        next,
        [
          {
            field: 'brief.durationSec',
            label: '视频时长',
            from: `${video.brief.durationSec}s`,
            to: `${actual}s`,
          },
          {
            field: 'scenes.durationSec',
            label: '镜头时长',
            from: '原比例',
            to: `${next.scenes.length} 个镜头已按比例重排`,
          },
        ],
        `视频时长从 ${video.brief.durationSec} 秒调整为 ${actual} 秒，${
          next.scenes.length
        } 个镜头按原节奏比例重排。${
          explicit !== null && actual !== explicit
            ? `（受最小时长限制，无法精确到 ${explicit} 秒。）`
            : ''
        }`,
        'duration',
      );
    }
  }

  // 7. Visual style / template
  if (/风格|模板|视觉|template|style/.test(lower)) {
    const mappings: Array<{
      pattern: RegExp;
      style: VisualStyle;
      templateId: string;
    }> = [
      { pattern: /极简|干净|minimal/, style: 'minimal', templateId: 'tpl_grid' },
      { pattern: /杂志|编辑|叙事|质感|editorial/, style: 'editorial', templateId: 'tpl_signal' },
      { pattern: /大胆|冲击|醒目|社交|tiktok|bold|竖屏/, style: 'bold', templateId: 'tpl_type' },
      { pattern: /温暖|柔和|光环|bloom|品牌/, style: 'product', templateId: 'tpl_bloom' },
      { pattern: /科技|产品|清晰|grid|演示/, style: 'product', templateId: 'tpl_grid' },
    ];
    const mapping = mappings.find((item) => item.pattern.test(lower));
    if (!mapping) {
      return {
        intent: 'style',
        recognized: false,
        changes: [],
        video,
        reply:
          '我可以切换这几种视觉风格：极简（Grid）、编辑叙事（Signal）、大胆社交（Type）、柔和品牌（Bloom）。可以说“把风格换成极简”。',
      };
    }
    const next = clone(video);
    next.brief.style = mapping.style;
    next.brief.templateId = mapping.templateId;
    next.scenes = next.scenes.map((scene) => ({ ...scene, templateId: mapping.templateId }));
    return finalize(
      video,
      next,
      [
        {
          field: 'brief.style',
          label: '视觉风格',
          from: STYLE_LABEL[video.brief.style],
          to: STYLE_LABEL[mapping.style],
        },
        {
          field: 'brief.templateId',
          label: '视频模板',
          from: TEMPLATE_LABEL[video.brief.templateId] ?? video.brief.templateId,
          to: TEMPLATE_LABEL[mapping.templateId] ?? mapping.templateId,
        },
        {
          field: 'scenes.templateId',
          label: '分镜模板',
          from: '原模板',
          to: `${next.scenes.length} 个镜头已应用`,
        },
      ],
      `已切换为「${STYLE_LABEL[mapping.style]}」风格，并应用 ${
        TEMPLATE_LABEL[mapping.templateId] ?? mapping.templateId
      } 模板到全部分镜。预览会立即变化。`,
      'style',
    );
  }

  // 8. Tone
  const toneMatches: Array<{ tone: Tone; pattern: RegExp }> = [
    { tone: 'technical', pattern: /克制|严谨|收敛|技术|冷静|客观/ },
    { tone: 'warm', pattern: /轻松|友好|温暖|亲切|柔和/ },
    { tone: 'bold', pattern: /热情|大胆|有冲击|活泼|燃/ },
    { tone: 'confident', pattern: /自信|专业|稳重|坚定/ },
  ];
  const hasToneWord = /语气|口吻|tone|说法/.test(lower);
  const toneMatch = toneMatches.find((item) => item.pattern.test(lower));
  if (hasToneWord || toneMatch) {
    if (!toneMatch) {
      return {
        intent: 'tone',
        recognized: false,
        changes: [],
        video,
        reply: '可以把语气调整为：自信专业、轻松友好、技术克制、热情有力。比如“把语气调得更轻松”。',
      };
    }
    const next = clone(video);
    next.brief.tone = toneMatch.tone;
    const changes: DirectorChange[] = [
      {
        field: 'brief.tone',
        label: '视频语气',
        from: TONE_LABEL[video.brief.tone],
        to: TONE_LABEL[toneMatch.tone],
      },
    ];
    const opening = withOrdered(next.scenes)[0];
    if (opening) {
      const rewritten =
        toneMatch.tone === 'technical'
          ? `这次更新里，${selectedFeatures[0]?.name ?? '产品的变化'}的能力边界、操作方式与证据状态，一次说清。`
          : toneMatch.tone === 'warm'
            ? `如果你也在用 ${selectedFeatures[0]?.name ?? '这个产品'}，这次更新会让你少一点来回确认。`
            : toneMatch.tone === 'bold'
              ? '先看重点。这次更新，有几个变化值得你马上试试。'
              : `${selectedFeatures[0]?.name ?? '这次更新'}，是这一版最值得被看见的变化。`;
      changes.push({
        field: `scene.${opening.id}.narration`,
        label: `镜头 1 旁白`,
        from: opening.narration,
        to: rewritten,
      });
      opening.narration = rewritten;
    }
    const ctaScene = next.scenes.find((scene) => scene.visualType === 'cta');
    if (ctaScene) {
      const cta = video.brief.cta || '现在就开始';
      const rewritten =
        toneMatch.tone === 'technical'
          ? `更多细节与限定条件见产品文档。${cta}。`
          : toneMatch.tone === 'warm'
            ? `如果这符合你的工作方式，${cta}。`
            : toneMatch.tone === 'bold'
              ? `现在就${cta}。`
              : `${cta}。`;
      if (rewritten !== ctaScene.narration) {
        changes.push({
          field: `scene.${ctaScene.id}.narration`,
          label: 'CTA 旁白',
          from: ctaScene.narration,
          to: rewritten,
        });
        ctaScene.narration = rewritten;
      }
    }
    if (toneMatch.tone === 'technical' || /克制|收敛/.test(lower)) {
      let limitedCount = 0;
      next.scenes.forEach((scene) => {
        if (!scene.featureId) return;
        const feature = projectFeatures.find((item) => item.id === scene.featureId);
        const claim = feature ? claimForFeature(feature, context.claims) : undefined;
        if (!claim || claim.status === 'verified') return;
        if (LIMITATION_PATTERN.test(scene.caption)) return;
        const from = scene.caption;
        scene.caption = `${scene.caption}${limitationText(claim.status)}`;
        scene.notes = '导演补充：该声明尚未核验，需保留限定表述。';
        changes.push({
          field: `scene.${scene.id}.caption`,
          label: `镜头 ${scene.order + 1} 字幕`,
          from,
          to: scene.caption,
        });
        limitedCount += 1;
      });
      if (limitedCount > 0) {
        return finalize(
          video,
          next,
          changes,
          `已把语气调整为「${TONE_LABEL[toneMatch.tone]}」，开场与 CTA 同步改写，并为 ${limitedCount} 个未核验声明补充了限定表述。`,
          'tone',
        );
      }
    }
    return finalize(
      video,
      next,
      changes,
      `已把语气调整为「${TONE_LABEL[toneMatch.tone]}」，开场与结尾旁白已同步改写。证据未核验的镜头仍需保留限定。`,
      'tone',
    );
  }

  // 9. Audience
  if (/受众|受众群|面向|audience|给谁看/.test(lower)) {
    const audienceMap: Array<{ pattern: RegExp; audience: string }> = [
      { pattern: /开发者|工程师|developer/, audience: '开发者与平台团队' },
      { pattern: /产品经理|pm\b|产品负责人/, audience: '产品经理与产品负责人' },
      { pattern: /市场|运营|内容/, audience: '市场与内容团队' },
      { pattern: /管理者|老板|决策者|负责人/, audience: '业务决策者' },
      { pattern: /销售|售前/, audience: '销售与售前团队' },
      { pattern: /新用户|新手|首次/, audience: '首次使用产品的用户' },
      { pattern: /数据|分析师/, audience: '数据分析师与业务负责人' },
    ];
    let audience = audienceMap.find((item) => item.pattern.test(lower))?.audience;
    if (!audience) {
      const extracted =
        raw.match(/(?:受众|观众|用户)(?:改成|改为|换成|是|为)?[「『"]?([^」』"。，,]{2,20})/) ??
        raw.match(/面向([^，。]{2,20})/);
      audience = extracted?.[1]?.trim();
    }
    if (!audience) {
      return {
        intent: 'audience',
        recognized: false,
        changes: [],
        video,
        reply: '想改成哪一类受众？例如“把受众改成开发者”“面向产品负责人”“给新用户看”。',
      };
    }
    const next = clone(video);
    next.brief.audience = audience;
    const changes: DirectorChange[] = [
      { field: 'brief.audience', label: '目标受众', from: video.brief.audience, to: audience },
    ];
    const opening = withOrdered(next.scenes)[0];
    if (opening) {
      const rewritten = `${audience}，这次更新值得你花 ${Math.round(
        video.brief.durationSec,
      )} 秒。最重要的变化都在这里。`;
      changes.push({
        field: `scene.${opening.id}.narration`,
        label: '镜头 1 旁白',
        from: opening.narration,
        to: rewritten,
      });
      opening.narration = rewritten;
    }
    return finalize(
      video,
      next,
      changes,
      `已把目标受众调整为「${audience}」，开场旁白同步改写。建议再检查一下镜头 4 这类带限定条件的表述。`,
      'audience',
    );
  }

  // 10. Rewrite narration
  if (/改写旁白|重写旁白|换一种说法|旁白.*(改|重写)|rewrite narration/.test(lower)) {
    const all = /全部|所有/.test(raw);
    const targets = all
      ? ordered
      : [
          (sceneOrdinal !== null ? ordered[sceneOrdinal - 1] : undefined) ??
            (focusSceneId ? ordered.find((scene) => scene.id === focusSceneId) : undefined) ??
            ordered.find((scene) => Boolean(scene.featureId) && scene.visualType !== 'cta') ??
            ordered[0],
        ].filter((scene): scene is Scene => Boolean(scene));
    if (targets.length === 0) return unknownResult(video, raw);
    const next = clone(video);
    const changes: DirectorChange[] = [];
    targets.forEach((targetScene) => {
      const nextScene = next.scenes.find((item) => item.id === targetScene.id);
      if (!nextScene) return;
      const feature = projectFeatures.find((item) => item.id === targetScene.featureId);
      const claim = feature ? claimForFeature(feature, context.claims) : undefined;
      const copy = alternateScene(video, targetScene, feature, claim);
      if (copy.narration === targetScene.narration) return;
      changes.push({
        field: `scene.${targetScene.id}.narration`,
        label: `镜头 ${targetScene.order + 1} 旁白`,
        from: targetScene.narration,
        to: copy.narration,
      });
      nextScene.narration = copy.narration;
      nextScene.status = 'draft';
    });
    return finalize(
      video,
      next,
      changes,
      targets.length === 1
        ? '已改写当前镜头的旁白。字幕没有自动改动，避免超出安全区；你可以在 Storyboard 里单独调整。'
        : `已改写 ${changes.length} 个镜头的旁白，字幕未自动改动。`,
      'narration',
    );
  }

  return unknownResult(video, raw);
}

function withOrdered(scenes: Scene[]): Scene[] {
  return orderedScenes(scenes);
}

export function directorQuickCommands(video: VideoProject, features: Feature[]): string[] {
  const selected = video.brief.featureIds
    .map((id) => features.find((feature) => feature.id === id))
    .filter((feature): feature is Feature => Boolean(feature));
  const commands: string[] = [];
  commands.push(video.brief.durationSec > 34 ? '缩短到 30 秒' : '延长到 45 秒');
  commands.push(
    video.brief.tone === 'confident' ? '把语气调得更轻松' : '把语气调得更自信',
  );
  commands.push('把受众改成开发者');
  if (video.scenes.some((scene) => scene.visualType === 'real_demo')) {
    commands.push('把录屏演示提前');
  }
  commands.push('重新生成第 2 个分镜');
  if (selected.length > 1) {
    commands.push(`删除「${selected[selected.length - 1]!.name}」卖点`);
  }
  commands.push('把风格换成极简');
  return commands.slice(0, 6);
}
