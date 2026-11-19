import type { AspectRatio, Tone, VideoMode } from './schemas';

export interface VideoModeInfo {
  mode: VideoMode;
  label: string;
  shortLabel: string;
  description: string;
  bestFor: string;
  durationSec: number;
  aspect: AspectRatio;
  useRealCapture: boolean;
  useGeneratedVisuals: boolean;
}

export const VIDEO_MODE_INFO: Record<VideoMode, VideoModeInfo> = {
  product_film: {
    mode: 'product_film',
    label: '产品宣传片',
    shortLabel: '宣传片',
    description: '用一条有叙事的短片讲清产品价值与关键能力。',
    bestFor: '官网首页、发布会、销售开场',
    durationSec: 45,
    aspect: '16:9',
    useRealCapture: true,
    useGeneratedVisuals: false,
  },
  release_video: {
    mode: 'release_video',
    label: '版本更新视频',
    shortLabel: '更新视频',
    description: '从已合并的 PR 与 Release 中提炼用户可感知的变化。',
    bestFor: 'Release Notes、更新公告、客户周报',
    durationSec: 30,
    aspect: '16:9',
    useRealCapture: true,
    useGeneratedVisuals: false,
  },
  tutorial: {
    mode: 'tutorial',
    label: '功能教程',
    shortLabel: '教程',
    description: '围绕一个功能，展示从进入到完成任务的完整操作。',
    bestFor: '帮助中心、Onboarding、客户成功',
    durationSec: 60,
    aspect: '16:9',
    useRealCapture: true,
    useGeneratedVisuals: false,
  },
  content_factory: {
    mode: 'content_factory',
    label: '持续内容',
    shortLabel: '内容工厂',
    description: '把同一个产品事实快速改编为适合社交渠道的短片。',
    bestFor: '社交媒体系列、活动物料、持续种草',
    durationSec: 30,
    aspect: '9:16',
    useRealCapture: true,
    useGeneratedVisuals: true,
  },
};

export const VIDEO_MODE_ORDER: VideoMode[] = [
  'release_video',
  'product_film',
  'tutorial',
  'content_factory',
];

export interface ToneInfo {
  tone: Tone;
  label: string;
  description: string;
}

export const TONE_INFO: Record<Tone, ToneInfo> = {
  confident: { tone: 'confident', label: '自信专业', description: '克制、有判断，适合 B2B 产品' },
  warm: { tone: 'warm', label: '轻松友好', description: '更像同事在讲解，降低理解门槛' },
  technical: { tone: 'technical', label: '技术克制', description: '重事实与操作，不夸张' },
  bold: { tone: 'bold', label: '热情有力', description: '节奏更快，适合社交渠道' },
};

export const TONE_ORDER: Tone[] = ['confident', 'warm', 'technical', 'bold'];

export const DEFAULT_BANNED_PHRASES = ['行业最强', '100% 准确', '彻底改变'];

export const DURATION_OPTIONS = [15, 30, 45, 60, 90];

export function modeDefaults(mode: VideoMode): VideoModeInfo {
  return VIDEO_MODE_INFO[mode];
}
