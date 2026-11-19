import type { VideoTemplate } from '@asvs/domain';

export const VIDEO_TEMPLATES: VideoTemplate[] = [
  {
    id: 'tpl_signal',
    name: 'Signal',
    description: '编辑部式排版，克制留白与大字标题，适合发布与观点型视频。',
    surface: 'paper',
    layout: 'editorial',
  },
  {
    id: 'tpl_grid',
    name: 'Grid',
    description: '产品界面优先，信息清晰，适合功能演示与教程。',
    surface: 'ink',
    layout: 'product',
  },
  {
    id: 'tpl_bloom',
    name: 'Bloom',
    description: '柔和品牌光影与慢节奏，适合宣传片和品牌故事。',
    surface: 'tint',
    layout: 'soft',
  },
  {
    id: 'tpl_type',
    name: 'Type',
    description: '强节奏大字与色块，适合竖屏社交短片。',
    surface: 'brand',
    layout: 'kinetic',
  },
];

export const TEMPLATE_IDS = VIDEO_TEMPLATES.map((template) => template.id);
