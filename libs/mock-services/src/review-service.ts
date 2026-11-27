import type {
  Claim,
  Evidence,
  Feature,
  ProductionRun,
  Project,
  ReviewBundle,
  ReviewCheck,
  Scene,
  VideoProject,
} from '@asvs/domain';
import { MIN_SCENE_DURATION, totalDuration } from '@asvs/domain';

const LIMITATION_PATTERN =
  /Release|release|随 Release|staging|beta|preview|测试环境|预发布|验证中|待验证|提示|辅助|参考|限定|Beta|确认/;
const LAUNCHED_OVERCLAIM_PATTERN = /已上线|全面上线|现已上线|正式上线|全量可用|已全量开放/;

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/;
const SECRET_PATTERN = /(sk-[a-z0-9]{8,}|ghp_[a-z0-9]{10,}|bearer\s+[a-z0-9]{8,})/i;
const SENSITIVE_WORD_PATTERN = /(password|passwd|secret|api[_-]?key|身份证|银行卡|客户名单)/i;
const LONG_NUMBER_PATTERN = /\b\d{16,}\b/;

function sceneText(scene: Scene): string {
  return `${scene.title}\n${scene.narration}\n${scene.caption}\n${scene.notes ?? ''}`;
}

function checkProduction(
  video: VideoProject,
  runs: ProductionRun[],
): ReviewCheck {
  const videoRuns = runs
    .filter((run) => run.videoId === video.id)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const successes = videoRuns
    .filter((run) => run.status === 'succeeded')
    .sort(
      (a, b) =>
        new Date(b.finishedAt ?? b.startedAt).getTime() -
        new Date(a.finishedAt ?? a.startedAt).getTime(),
    );
  const latestSuccess = successes[0];
  const latestRun = videoRuns[0];

  if (!latestSuccess) {
    return {
      id: 'production',
      label: '生产运行',
      description: '视频需要一次成功的生产运行才能审核与导出。',
      status: 'fail',
      detail:
        latestRun?.status === 'failed'
          ? '最近一次模拟生产在录屏步骤失败，尚未生成可用于审核的版本。'
          : '还没有完成一次模拟生产运行。',
      action: 'production',
    };
  }

  const finishedAt = new Date(latestSuccess.finishedAt ?? latestSuccess.startedAt).getTime();
  if (new Date(video.updatedAt).getTime() > finishedAt + 1000) {
    return {
      id: 'production',
      label: '生产运行',
      description: '审核与导出必须基于最近一次生产对应的工程版本。',
      status: 'fail',
      detail: '工程在最近一次生产完成后又被修改，请重新运行生产后再审核。',
      action: 'production',
    };
  }

  if (
    latestRun &&
    latestRun.id !== latestSuccess.id &&
    latestRun.status === 'failed' &&
    new Date(latestRun.startedAt).getTime() > finishedAt
  ) {
    return {
      id: 'production',
      label: '生产运行',
      description: '最近一次生产尝试失败，但存在更早的成功版本。',
      status: 'warn',
      detail: '当前审核沿用更早的成功运行；建议重试失败步骤，确保导出的是最新生产结果。',
      action: 'production',
    };
  }

  return {
    id: 'production',
    label: '生产运行',
    description: '检查是否存在与当前工程一致的成功生产运行。',
    status: 'pass',
    detail: `模拟生产已完成 · ${latestSuccess.input.sceneCount} 个镜头 / ${latestSuccess.input.durationSec}s（未生成真实媒体文件）`,
    action: 'production',
  };
}

function checkClaims(
  video: VideoProject,
  features: Feature[],
  claims: Claim[],
  scenes: Scene[],
): ReviewCheck {
  const claimIds = Array.from(new Set(scenes.flatMap((scene) => scene.claimIds)));
  if (claimIds.length === 0) {
    return {
      id: 'claims',
      label: '功能声明与证据',
      description: '每一个对外功能声明都应有可追溯的证据与核验状态。',
      status: 'warn',
      detail: '当前镜头尚未关联任何功能声明，无法核对画面与卖点是否一致。',
      action: 'knowledge',
    };
  }

  const relatedClaims = claimIds
    .map((id) => claims.find((claim) => claim.id === id))
    .filter((claim): claim is Claim => Boolean(claim));
  if (relatedClaims.length !== claimIds.length) {
    return {
      id: 'claims',
      label: '功能声明与证据',
      description: '每一个对外功能声明都应有可追溯的证据与核验状态。',
      status: 'fail',
      detail: '有镜头引用了已不存在的声明，请回到知识中心修复后重新生产。',
      action: 'knowledge',
    };
  }

  const failures: string[] = [];
  let supportedCount = 0;
  let verifiedCount = 0;
  relatedClaims.forEach((claim) => {
    const feature = features.find((item) => item.id === claim.featureId);
    const featureLabel = feature?.name ?? claim.featureId;
    const scenesForClaim = scenes.filter((scene) => scene.claimIds.includes(claim.id));

    // When 4C eligibility is present, it is the authoritative publish gate
    // (closing cases like `production_runtime_pending_approval` where status
    // is `supported` but human approval is still missing).
    if (claim.eligibility !== undefined) {
      switch (claim.eligibility) {
        case 'blocked_rejected':
          failures.push(
            `「${featureLabel}」已被人工驳回：${claim.blockers?.[0] ?? '不得发布。'}`,
          );
          return;
        case 'blocked_stale':
          failures.push(
            `「${featureLabel}」的源码证据已过期（AC-09）：${claim.blockers?.[0] ?? '请重新索引并复核声明。'}`,
          );
          return;
        case 'blocked_unverified':
          failures.push(
            `「${featureLabel}」未通过发布核验（AC-03）：${claim.blockers?.[0] ?? '缺少发布或人工批准证据，禁止公开发布。'}`,
          );
          return;
        case 'needs_qualification': {
          supportedCount += 1;
          const hasOverclaim = scenesForClaim.some((scene) =>
            LAUNCHED_OVERCLAIM_PATTERN.test(sceneText(scene)),
          );
          if (hasOverclaim) {
            failures.push(
              `「${featureLabel}」仅有限定范围证据，文案禁止宣称「已上线」或「全量可用」（AC-03）。`,
            );
            return;
          }
          const hasLimitation = scenesForClaim.some((scene) =>
            LIMITATION_PATTERN.test(scene.caption),
          );
          if (!hasLimitation) {
            failures.push(
              `「${featureLabel}」需保留范围限定表述：${claim.guidance ?? '请在字幕注明非生产环境或随 Release 发布。'}`,
            );
          }
          return;
        }
        case 'publishable':
          if (feature?.status === 'stale' || claim.status !== 'verified') {
            failures.push(`「${featureLabel}」的证据已过期或尚未完成核验，需要重新验证。`);
            return;
          }
          verifiedCount += 1;
          return;
      }
    }

    if (claim.status === 'verified') {
      verifiedCount += 1;
      if (feature?.status === 'stale') {
        failures.push(`「${featureLabel}」的证据已过期，需要重新验证。`);
      }
      return;
    }
    if (claim.status === 'supported') {
      supportedCount += 1;
      const hasLimitation = scenesForClaim.some((scene) => LIMITATION_PATTERN.test(scene.caption));
      if (!hasLimitation) {
        failures.push(`「${featureLabel}」是待验证声明，但对应镜头的字幕没有限定表述。`);
      }
      return;
    }
    failures.push(
      `「${featureLabel}」的声明状态为 ${claim.status}，不能用于公开发布。`,
    );
  });

  if (failures.length > 0) {
    return {
      id: 'claims',
      label: '功能声明与证据',
      description: '每一个对外功能声明都应有可追溯的证据与核验状态。',
      status: 'fail',
      detail: failures.join(' '),
      action: 'knowledge',
    };
  }

  return {
    id: 'claims',
    label: '功能声明与证据',
    description: '每一个对外功能声明都应有可追溯的证据与核验状态。',
    status: supportedCount > 0 ? 'warn' : 'pass',
    detail: `${relatedClaims.length} 条声明 · ${verifiedCount} 条已核验${
      supportedCount > 0 ? ` · ${supportedCount} 条待验证（字幕已保留限定表述）` : ''
    }。`,
    action: 'knowledge',
  };
}

function checkPrivacy(video: VideoProject): ReviewCheck {
  const text = video.scenes.map(sceneText).join('\n');
  const findings: string[] = [];
  if (EMAIL_PATTERN.test(text)) findings.push('疑似邮箱地址');
  if (SECRET_PATTERN.test(text)) findings.push('疑似密钥 / 令牌');
  if (SENSITIVE_WORD_PATTERN.test(text)) findings.push('敏感字段关键词');
  if (LONG_NUMBER_PATTERN.test(text)) findings.push('疑似身份证 / 银行卡号');
  if (findings.length > 0) {
    return {
      id: 'privacy',
      label: '敏感信息扫描',
      description: '检查字幕、旁白与备注中是否出现凭证、客户数据或个人信息。',
      status: 'fail',
      detail: `发现${findings.join('、')}。请遮挡或改写后重新生产（模拟扫描）。`,
      action: 'editor',
    };
  }
  return {
    id: 'privacy',
    label: '敏感信息扫描',
    description: '检查字幕、旁白与备注中是否出现凭证、客户数据或个人信息。',
    status: 'pass',
    detail: '未发现邮箱、令牌、密钥或疑似客户数据（模拟扫描）。',
    action: 'none',
  };
}

function checkBannedPhrases(video: VideoProject): ReviewCheck {
  const text = video.scenes.map(sceneText).join('\n');
  const found = video.brief.bannedPhrases.filter(
    (phrase) => phrase.trim().length > 0 && text.includes(phrase),
  );
  if (found.length > 0) {
    return {
      id: 'banned',
      label: '品牌与合规用语',
      description: '禁止使用 Brief 中列出的夸大或不可证实表述。',
      status: 'fail',
      detail: `发现禁用表述：${found.map((phrase) => `「${phrase}」`).join('、')}。`,
      action: 'editor',
    };
  }
  return {
    id: 'banned',
    label: '品牌与合规用语',
    description: '禁止使用 Brief 中列出的夸大或不可证实表述。',
    status: 'pass',
    detail: `未使用 ${video.brief.bannedPhrases.length} 条禁用表述。`,
    action: 'none',
  };
}

function checkNarrationCue(video: VideoProject): ReviewCheck {
  const missing = video.scenes.filter((scene) => scene.narration.trim().length === 0);
  if (missing.length > 0) {
    return {
      id: 'narration',
      label: '旁白完整性',
      description: '所有镜头需要旁白文本，预览与配音时间轴才能一致。',
      status: 'fail',
      detail: `${missing.length} 个镜头缺少旁白：第 ${missing
        .map((scene) => scene.order + 1)
        .join('、')} 镜。`,
      action: 'editor',
    };
  }
  return {
    id: 'narration',
    label: '旁白完整性',
    description: '所有镜头需要旁白文本，预览与配音时间轴才能一致。',
    status: 'pass',
    detail: `${video.scenes.length} 个镜头的旁白均已填写（模拟配音，不播放真实音频）。`,
    action: 'none',
  };
}

function checkCaptions(video: VideoProject): ReviewCheck {
  const missing = video.scenes.filter((scene) => scene.caption.trim().length === 0);
  if (missing.length > 0) {
    return {
      id: 'captions',
      label: '字幕与时间轴',
      description: '字幕应覆盖所有镜头，并与时间轴时长一致。',
      status: 'warn',
      detail: `${missing.length} 个镜头没有字幕，导出 SRT 时会回退为旁白文本。`,
      action: 'editor',
    };
  }
  return {
    id: 'captions',
    label: '字幕与时间轴',
    description: '字幕应覆盖所有镜头，并与时间轴时长一致。',
    status: 'pass',
    detail: `${video.scenes.length} 个镜头均有字幕；SRT 时间轴按当前 ${
      totalDuration(video.scenes)
    } 秒生成。`,
    action: 'none',
  };
}

function checkComposition(video: VideoProject): ReviewCheck {
  const scenes = [...video.scenes].sort((a, b) => a.order - b.order);
  const duration = totalDuration(scenes);
  if (scenes.length < 2) {
    return {
      id: 'composition',
      label: '画幅与节奏',
      description: '检查镜头数、单镜时长、总时长与画幅设置。',
      status: 'fail',
      detail: '至少需要 2 个镜头才能组成完整视频。',
      action: 'editor',
    };
  }
  if (duration < 10) {
    return {
      id: 'composition',
      label: '画幅与节奏',
      description: '检查镜头数、单镜时长、总时长与画幅设置。',
      status: 'fail',
      detail: '总时长不足 10 秒，无法形成完整叙事。',
      action: 'editor',
    };
  }
  const tooShort = scenes.filter((scene) => scene.durationSec < MIN_SCENE_DURATION);
  if (tooShort.length > 0) {
    return {
      id: 'composition',
      label: '画幅与节奏',
      description: '检查镜头数、单镜时长、总时长与画幅设置。',
      status: 'warn',
      detail: `${tooShort.length} 个镜头短于 ${MIN_SCENE_DURATION} 秒，可能影响可读性。`,
      action: 'editor',
    };
  }
  return {
    id: 'composition',
    label: '画幅与节奏',
    description: '检查镜头数、单镜时长、总时长与画幅设置。',
    status: 'pass',
    detail: `${scenes.length} 个镜头 / ${duration}s / ${video.brief.aspect}；模拟预览与时间轴一致。`,
    action: 'none',
  };
}

function checkBrand(video: VideoProject, project: Project): ReviewCheck {
  const missing: string[] = [];
  if (!project.brand.logoText.trim()) missing.push('品牌字标');
  if (!video.brief.cta.trim()) missing.push('CTA');
  if (missing.length > 0) {
    return {
      id: 'brand',
      label: '品牌一致性',
      description: '检查品牌字标、主色与结尾行动号召。',
      status: 'warn',
      detail: `缺少${missing.join('、')}，可能影响成片完整度。`,
      action: 'none',
    };
  }
  return {
    id: 'brand',
    label: '品牌一致性',
    description: '检查品牌字标、主色与结尾行动号召。',
    status: 'pass',
    detail: `已应用 ${project.brand.logoText} 字标、主色 ${project.brand.primary} 与 CTA。`,
    action: 'none',
  };
}

export function buildReviewBundle(input: {
  video: VideoProject;
  project: Project;
  features: Feature[];
  claims: Claim[];
  evidence: Evidence[];
  runs: ProductionRun[];
}): ReviewBundle {
  const { video, project, features, claims, runs } = input;
  const scenes = [...video.scenes].sort((a, b) => a.order - b.order);
  const checks: ReviewCheck[] = [
    checkComposition(video),
    checkProduction(video, runs),
    checkClaims(video, features, claims, scenes),
    checkNarrationCue(video),
    checkCaptions(video),
    checkPrivacy(video),
    checkBannedPhrases(video),
    checkBrand(video, project),
  ];

  if (video.review?.status === 'approved' && video.review.decidedAt) {
    if (new Date(video.updatedAt).getTime() > new Date(video.review.decidedAt).getTime() + 1000) {
      checks.push({
        id: 'approval-freshness',
        label: '审核版本',
        description: '审核结果必须绑定当前工程版本。',
        status: 'fail',
        detail: '工程在审核通过后又被修改，原审核已失效。请重新审核。',
        action: 'editor',
      });
    }
  }

  const failCount = checks.filter((check) => check.status === 'fail').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;
  return {
    checks,
    canApprove: failCount === 0,
    failCount,
    warnCount,
  };
}
