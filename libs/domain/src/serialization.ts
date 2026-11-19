import { formatSrtTime, formatTimecode } from './format';
import type { Claim, Evidence, Feature, Project, VideoProject } from './schemas';
import { orderedScenes, sceneStartTimes, totalDuration } from './timeline';

export function buildSrt(video: VideoProject): string {
  const scenes = orderedScenes(video.scenes);
  const starts = sceneStartTimes(scenes);
  return scenes
    .map((scene, index) => {
      const start = starts[index] ?? 0;
      const end = start + scene.durationSec;
      const text = (scene.caption || scene.narration || scene.title).trim() || scene.title;
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n`;
    })
    .join('\n');
}

export interface ProjectExportInput {
  video: VideoProject;
  project: Project;
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  exportedAt?: string;
}

export function buildProjectExport(input: ProjectExportInput): string {
  const { video, project, features, claims, evidence } = input;
  const relatedFeatures = features.filter(
    (feature) =>
      video.brief.featureIds.includes(feature.id) ||
      video.scenes.some((scene) => scene.featureId === feature.id),
  );
  const relatedClaims = claims.filter((claim) => relatedFeatures.some((feature) => feature.id === claim.featureId));
  const relatedEvidence = evidence.filter((item) => relatedClaims.some((claim) => claim.id === item.claimId));

  return JSON.stringify(
    {
      schemaVersion: '1',
      kind: 'asvs.video-project',
      exportedAt: input.exportedAt ?? new Date().toISOString(),
      notice:
        '本文件是前端模拟阶段真实导出的视频工程数据，不包含真实渲染媒体。用于验证工程可保存、可重建。',
      product: {
        id: project.id,
        name: project.name,
        productName: project.productName,
        description: project.description,
        website: project.website,
        brand: project.brand,
        demo: project.demo,
      },
      video: {
        id: video.id,
        title: video.title,
        mode: video.mode,
        stage: video.stage,
        brief: video.brief,
        scenes: orderedScenes(video.scenes),
        scriptVersion: video.scriptVersion,
        totalDurationSec: totalDuration(video.scenes),
        review: video.review,
        producedAt: video.producedAt,
      },
      knowledgeSnapshot: {
        features: relatedFeatures,
        claims: relatedClaims,
        evidence: relatedEvidence,
      },
      production: {
        lastRunAt: video.producedAt,
        note: '生产运行为确定性模拟，不包含真实录屏或渲染文件。',
      },
    },
    null,
    2,
  );
}

export function exportFileBase(video: VideoProject): string {
  return `asvs-${video.id}-${formatTimecode(totalDuration(video.scenes)).replace(':', 'm')}s`;
}

export function buildExportFileName(video: VideoProject, extension: string): string {
  return `${exportFileBase(video)}.${extension}`;
}
