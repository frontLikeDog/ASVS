import type { AspectRatio, ExportFormat, ExportRecord, VideoProject } from '@asvs/domain';
import { buildExportFileName } from '@asvs/domain';
import type { ExportConfig } from '@asvs/ports';
import { newId, nowIso } from './id';

export type { ExportConfig };

export function isSimulatedMedia(format: ExportFormat): boolean {
  return format === 'mp4' || format === 'webm';
}

export function createExportRecord(input: {
  video: VideoProject;
  config: ExportConfig;
}): ExportRecord {
  const { video, config } = input;
  const simulated = isSimulatedMedia(config.format);
  const immediate = !simulated;
  return {
    id: newId('exp'),
    projectId: video.projectId,
    videoId: video.id,
    format: config.format,
    aspect: config.aspect,
    resolution: config.resolution,
    status: immediate ? 'completed' : 'processing',
    progress: immediate ? 100 : 0,
    simulated,
    note: simulated
      ? '模拟导出：仅演示任务状态，不生成真实媒体文件。'
      : config.format === 'json'
        ? '真实下载 · 视频工程 JSON'
        : '真实下载 · 字幕时间轴',
    fileName: immediate ? buildExportFileName(video, config.format) : undefined,
    createdAt: nowIso(),
  };
}

/** Simulated media export progresses only while the review page is open. */
export function tickExportRecord(record: ExportRecord, deltaMs: number): ExportRecord {
  if (record.status !== 'processing' || !record.simulated) return record;
  const durationMs = 6000;
  const nextProgress = Math.min(100, record.progress + (Math.min(deltaMs, 500) / durationMs) * 100);
  if (nextProgress >= 100) {
    return {
      ...record,
      status: 'completed',
      progress: 100,
      note: '模拟导出完成 · 未生成 MP4/WebM 文件；可下载工程 JSON 与 SRT。',
    };
  }
  return { ...record, progress: Math.round(nextProgress * 10) / 10 };
}

export function exportFormatLabel(format: ExportFormat): string {
  switch (format) {
    case 'mp4':
      return 'MP4';
    case 'webm':
      return 'WebM';
    case 'json':
      return '工程 JSON';
    case 'srt':
      return '字幕 SRT';
  }
}
