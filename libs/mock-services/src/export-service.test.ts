import { describe, expect, it } from 'vitest';
import type { Scene, VideoProject } from '@asvs/domain';
import {
  createExportRecord,
  exportFormatLabel,
  isSimulatedMedia,
  tickExportRecord,
} from './export-service';

const scene: Scene = {
  id: 'a',
  order: 0,
  revision: 1,
  title: '镜头',
  intent: '',
  narration: '旁白',
  caption: '字幕',
  durationSec: 12,
  visualType: 'motion',
  templateId: 'tpl_grid',
  claimIds: [],
  status: 'draft',
  look: 'clean',
  brightness: 1,
  vignette: false,
};

const video: VideoProject = {
  id: 'vid_export',
  projectId: 'proj_export',
  title: '导出测试',
  mode: 'release_video',
  stage: 'approved',
  fps: 30,
  brief: {
    objective: '',
    audience: '',
    featureIds: ['feat_a'],
    durationSec: 12,
    aspect: '16:9',
    language: 'zh-CN',
    tone: 'confident',
    style: 'editorial',
    templateId: 'tpl_signal',
    useRealCapture: false,
    useGeneratedVisuals: false,
    cta: '',
    bannedPhrases: [],
  },
  scenes: [scene],
  directorMessages: [],
  scriptVersion: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  demo: true,
};

describe('模拟媒体判定', () => {
  it('只有 mp4 / webm 被视为模拟媒体', () => {
    expect(isSimulatedMedia('mp4')).toBe(true);
    expect(isSimulatedMedia('webm')).toBe(true);
    expect(isSimulatedMedia('json')).toBe(false);
    expect(isSimulatedMedia('srt')).toBe(false);
  });

  it('格式标签保持准确', () => {
    expect(exportFormatLabel('mp4')).toBe('MP4');
    expect(exportFormatLabel('json')).toBe('工程 JSON');
    expect(exportFormatLabel('srt')).toBe('字幕 SRT');
  });
});

describe('createExportRecord', () => {
  it('JSON / SRT 立即完成并标记为真实文件', () => {
    const record = createExportRecord({
      video,
      config: { format: 'json', aspect: '16:9', resolution: '1920×1080' },
    });

    expect(record.status).toBe('completed');
    expect(record.progress).toBe(100);
    expect(record.simulated).toBe(false);
    expect(record.fileName).toBe('asvs-vid_export-00m12s.json');
    expect(record.note).toContain('真实下载');
  });

  it('MP4 是模拟导出，不生成文件名', () => {
    const record = createExportRecord({
      video,
      config: { format: 'mp4', aspect: '9:16', resolution: '1080×1920' },
    });

    expect(record.status).toBe('processing');
    expect(record.simulated).toBe(true);
    expect(record.fileName).toBeUndefined();
    expect(record.note).toContain('不生成真实媒体文件');
  });
});

describe('tickExportRecord', () => {
  it('模拟导出按时间推进，完成后明确说明未生成媒体', () => {
    let record = createExportRecord({
      video,
      config: { format: 'webm', aspect: '16:9', resolution: '1920×1080' },
    });

    record = tickExportRecord(record, 500);
    expect(record.progress).toBeGreaterThan(0);
    expect(record.status).toBe('processing');

    for (let index = 0; index < 20; index += 1) {
      record = tickExportRecord(record, 500);
    }

    expect(record.status).toBe('completed');
    expect(record.progress).toBe(100);
    expect(record.note).toContain('未生成 MP4/WebM 文件');
  });

  it('真实文件记录不会被 tick 修改', () => {
    const record = createExportRecord({
      video,
      config: { format: 'srt', aspect: '16:9', resolution: '原始' },
    });
    expect(tickExportRecord(record, 500)).toBe(record);
  });
});
