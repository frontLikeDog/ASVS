import type { ProductionStep, RunScenario } from './schemas';

export interface ProductionStepBlueprint {
  key: string;
  name: string;
  description: string;
  durationMs: number;
  dependsOn: string[];
  requiresApproval?: boolean;
}

/**
 * Deterministic pipeline definition shared by the monitor, the engine and seed data.
 * Durations are simulated execution time, not measured worker time.
 */
export const PRODUCTION_STEP_BLUEPRINTS: ProductionStepBlueprint[] = [
  {
    key: 'knowledge',
    name: '对齐产品知识',
    description: '读取冻结的知识快照，确认功能目录与当前工程一致',
    durationMs: 2600,
    dependsOn: [],
  },
  {
    key: 'claims',
    name: '核对功能声明',
    description: '检查每个对外 Claim 的证据状态与限定条件',
    durationMs: 2400,
    dependsOn: ['knowledge'],
  },
  {
    key: 'script',
    name: '生成解说脚本',
    description: '根据已确认的 Brief 与分镜生成旁白与字幕',
    durationMs: 3600,
    dependsOn: ['claims'],
  },
  {
    key: 'storyboard',
    name: '规划分镜节奏',
    description: '计算镜头时长、转场与素材需求',
    durationMs: 2800,
    dependsOn: ['script'],
  },
  {
    key: 'capture',
    name: '录制软件操作',
    description: '在受控演示环境中执行步骤并校验界面状态',
    durationMs: 6200,
    dependsOn: ['storyboard'],
    requiresApproval: true,
  },
  {
    key: 'voice',
    name: '生成配音轨道',
    description: '按镜头生成模拟配音文本与时间轴',
    durationMs: 4200,
    dependsOn: ['storyboard'],
  },
  {
    key: 'compose',
    name: '合成画面与字幕',
    description: '将录屏、品牌动效与字幕组合为视频工程预览',
    durationMs: 5000,
    dependsOn: ['capture', 'voice'],
  },
  {
    key: 'qa',
    name: '质量检查',
    description: '检查画面、字幕与声明证据的一致性',
    durationMs: 3000,
    dependsOn: ['compose'],
  },
];

export const SCENARIO_DESCRIPTIONS: Record<RunScenario, string> = {
  happy_path: '所有步骤通过，用于验证完整生产闭环。',
  capture_retry: '录屏步骤先在固定位置失败，重试后成功，用于验证异常恢复。',
  approval_gate: '录屏开始前暂停，等待人工批准后继续，用于验证审批 Gate。',
};

export function createProductionSteps(): ProductionStep[] {
  return PRODUCTION_STEP_BLUEPRINTS.map((blueprint) => ({
    id: `step_${blueprint.key}`,
    key: blueprint.key,
    name: blueprint.name,
    description: blueprint.description,
    status: 'pending',
    durationMs: blueprint.durationMs,
    progress: 0,
    attempt: 0,
    dependsOn: blueprint.dependsOn,
    requiresApproval: blueprint.requiresApproval ?? false,
  }));
}

export function productionSimulatedSeconds(sceneCount: number, durationSec: number): {
  browserSeconds: number;
  renderSeconds: number;
  narrationCharacters: number;
} {
  return {
    browserSeconds: Math.round(8 + sceneCount * 1.4),
    renderSeconds: Math.round(durationSec * 1.25),
    narrationCharacters: Math.round(durationSec * 4.2),
  };
}
