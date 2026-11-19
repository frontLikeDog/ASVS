import type { BrandKit, OnboardingDraft } from '@asvs/domain';

export const DEFAULT_BRAND: BrandKit = {
  logoText: '',
  logoMark: 'spark',
  primary: '#D7F36A',
  secondary: '#8B9DFF',
  fontPair: 'grotesk',
  style: 'editorial',
  intro: '',
  outro: '',
};

export const BRAND_PRESETS = [
  { name: 'Lumen 珊瑚', primary: '#FF7A59', secondary: '#F5C9A8' },
  { name: 'Pulse 星蓝', primary: '#7C9CFF', secondary: '#B9C8FF' },
  { name: 'Studio 青柠', primary: '#D7F36A', secondary: '#8B9DFF' },
  { name: 'Violet 紫罗兰', primary: '#A78BFA', secondary: '#E9D5FF' },
];

export function defaultOnboardingDraft(): OnboardingDraft {
  return {
    name: '',
    productName: '',
    description: '',
    website: '',
    methods: ['github'],
    githubRepo: '',
    branch: 'main',
    demoUrl: '',
    docs: [],
    resetStrategy: 'fixture',
    brand: { ...DEFAULT_BRAND },
    defaultAspect: '16:9',
    defaultLanguage: 'zh-CN',
    templateId: 'tpl_signal',
    connections: {},
  };
}

export function cloneDraft(draft: OnboardingDraft): OnboardingDraft {
  return JSON.parse(JSON.stringify(draft)) as OnboardingDraft;
}

export function docsFromDraft(draft: OnboardingDraft): string[] {
  return draft.docs.map((doc) => doc.trim()).filter(Boolean);
}
