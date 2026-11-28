import type { Claim, RenderInputV1, StudioSnapshot } from '@asvs/domain';
import { evaluateClaimGate } from '@asvs/domain';
import type { SceneTimelineWindow } from './scene-mapper';

/**
 * Fact / content checks (docs/16 §5.4 · 事实 QA and 内容与品牌 QA).
 *
 * These are deliberately duplicated from earlier steps instead of trusting
 * them: `verify_claims` ran against the snapshot at freeze time, but the
 * workspace can change while a run is in flight, and a reviewer edits scenes
 * after a run is created. `qa_final` re-reads *now* and re-evaluates, which is
 * the whole point of an independent gate.
 */

export const LAUNCHED_OVERCLAIM_PATTERN = /已上线|全面上线|现已上线|正式上线|全量可用|已全量开放/;
export const LIMITATION_PATTERN =
  /Release|release|随 Release|staging|beta|preview|测试环境|预发布|验证中|待验证|提示|辅助|参考|限定|Beta|确认/;

export interface FactContentFindingDraft {
  ruleId: string;
  category: 'fact' | 'content';
  severity: 'blocker' | 'warning' | 'info';
  sourceKind:
    | 'claim_record'
    | 'scene_text'
    | 'demo_plan'
    | 'subtitle_srt'
    | 'audio_stream'
    | 'capture_receipt';
  title: string;
  message: string;
  remediation: string;
  remediationAction: 'editor' | 'production' | 'knowledge' | 'none';
  sceneId?: string;
  sceneOrder?: number;
  sceneTitle?: string;
  claimId?: string;
  featureId?: string;
  assetId?: string;
  metrics?: Record<string, number | string | boolean>;
}

function sceneTextFor(scene: RenderInputV1['storyboard']['scenes'][number]): string {
  return [scene.title, scene.narration, scene.caption, ...scene.onScreenText].join('\n');
}

/**
 * Claims referenced by the film, re-evaluated against the live snapshot.
 * Blocking eligibilities produce one blocker per *scene* that cites the claim,
 * so Gate 3 can send the reviewer to the exact scene to fix.
 */
export function collectClaimEligibilityFindings(
  frozen: { input: RenderInputV1 },
  snapshot: StudioSnapshot,
  videoSceneIds?: Map<string, { order: number; title: string }>,
): FactContentFindingDraft[] {
  const findings: FactContentFindingDraft[] = [];
  const { storyboard } = frozen.input;

  const claimsById = new Map<string, Claim>(snapshot.claims.map((claim) => [claim.id, claim]));
  const referenced = new Map<string, string[]>();
  for (const scene of storyboard.scenes) {
    for (const claimId of scene.claimIds) {
      const list = referenced.get(claimId) ?? [];
      list.push(scene.id);
      referenced.set(claimId, list);
    }
  }
  if (referenced.size === 0) return findings;

  const claims = [...referenced.keys()]
    .map((claimId) => claimsById.get(claimId))
    .filter((claim): claim is Claim => Boolean(claim));
  const evaluation = evaluateClaimGate(claims);

  for (const blocked of evaluation.blocked) {
    const sceneIds = referenced.get(blocked.claimId) ?? [];
    const claim = claimsById.get(blocked.claimId);
    const text = sceneIds
      .map((sceneId) => storyboard.scenes.find((scene) => scene.id === sceneId))
      .map((scene) => (scene ? sceneTextFor(scene) : ''))
      .join('\n');
    // A 4D-blocked claim may only remain on screen if the copy qualifies it.
    const overclaims = LAUNCHED_OVERCLAIM_PATTERN.test(text);
    for (const sceneId of sceneIds) {
      const scene = storyboard.scenes.find((item) => item.id === sceneId);
      const meta = videoSceneIds?.get(sceneId);
      findings.push({
        ruleId: 'fact.claim_eligibility',
        category: 'fact',
        severity: 'blocker',
        sourceKind: 'claim_record',
        title: '镜头引用了不可发布的声明',
        message: `声明 ${blocked.claimId} 的可发布资格为 ${blocked.eligibility}${
          overclaims ? '，且画面文案包含「已上线 / 全量可用」等未经核验的表述' : ''
        }。${blocked.reason}`,
        remediation:
          blocked.eligibility === 'blocked_stale'
            ? '证据已过期：前往知识中心补齐最新运行态证据，或从该镜头移除声明后重新运行。'
            : blocked.eligibility === 'blocked_rejected'
              ? '声明已被人工驳回：从镜头中移除该声明，或按驳回意见补充证据后重新核验。'
              : '声明缺少发布/运行态证据：补齐证据，或在文案中删除确定性承诺后重新运行。',
        remediationAction:
          blocked.eligibility === 'blocked_unverified' ? 'editor' : 'knowledge',
        ...(sceneId ? { sceneId } : {}),
        ...(meta ? { sceneOrder: meta.order, sceneTitle: meta.title } : {}),
        claimId: blocked.claimId,
        ...(claim?.featureId ? { featureId: claim.featureId } : {}),
        ...(scene ? { sceneTitle: meta?.title ?? scene.title } : {}),
      });
    }
  }

  for (const warning of evaluation.warnings) {
    const sceneIds = referenced.get(warning.claimId) ?? [];
    for (const sceneId of sceneIds) {
      const scene = storyboard.scenes.find((item) => item.id === sceneId);
      if (!scene) continue;
      const text = sceneTextFor(scene);
      const qualified = LIMITATION_PATTERN.test(text);
      if (!qualified) {
        const meta = videoSceneIds?.get(sceneId);
        findings.push({
          ruleId: 'fact.claim_eligibility',
          category: 'fact',
          severity: 'blocker',
          sourceKind: 'claim_record',
          title: '声明需要限定表述但镜头文案未限定',
          message: `声明 ${warning.claimId} 仅在有限范围内成立，镜头文案缺少「随 Release / 测试环境 / beta」等限定词。`,
          remediation: '在旁白或字幕中补充明确的环境/版本限定，或在知识中心补齐生产运行态证据。',
          remediationAction: 'editor',
          sceneId,
          ...(meta ? { sceneOrder: meta.order } : {}),
          claimId: warning.claimId,
        });
      } else {
        const meta = videoSceneIds?.get(sceneId);
        findings.push({
          ruleId: 'fact.claim_eligibility',
          category: 'fact',
          severity: 'warning',
          sourceKind: 'claim_record',
          title: '声明含限定表述，请确认范围准确',
          message: `声明 ${warning.claimId} 需要限定表述；镜头已包含限定词，请审核员确认其与证据范围一致。`,
          remediation: '确认限定表述与最新证据一致；如范围扩大，请先补充证据再更新文案。',
          remediationAction: 'knowledge',
          sceneId,
          ...(meta ? { sceneOrder: meta.order } : {}),
          claimId: warning.claimId,
        });
      }
    }
  }
  return findings;
}

export interface CaptureProvenanceContext {
  /** `capture-receipt.json` content, when this run captured for real. */
  receipt?: {
    assertions: { total: number; passed: number; failed: number };
    clip: { sha256: string };
  };
  clipSha256?: string;
  approvedPlanDigest?: string;
  manifestAssetHashes?: Array<{ assetId: string; sha256: string; mock: boolean; mediaSha256?: string }>;
}

/**
 * `fact.capture_provenance`: every `real_demo` scene must either say it is a
 * placeholder (warning — honest, not silent) or prove the footage is real:
 * assertions all passed, the clip hash matches the receipt and the approved
 * plan digest matches Gate 2's ledger.
 */
export function collectCaptureProvenanceFindings(
  frozen: { input: RenderInputV1 },
  context: CaptureProvenanceContext,
  windows: SceneTimelineWindow[],
): FactContentFindingDraft[] {
  const findings: FactContentFindingDraft[] = [];
  const assetsById = new Map(frozen.input.assets.map((asset) => [asset.id, asset]));
  const realDemoScenes = frozen.input.storyboard.scenes.filter(
    (scene) => scene.visual.type === 'real_demo',
  );

  for (const scene of realDemoScenes) {
    const window = windows.find((entry) => entry.sceneId === scene.id);
    // Resolve the clip the way the renderer does — through `assetIds` first
    // (`findRealCaptureAsset`). `visual.assetId` is only a hint: scenes that
    // were persisted without the IR, and the Gate 2 backfill, leave `visual`
    // as a bare `{ type: 'real_demo' }` and name the asset in `scene.assetId`
    // alone. Reading only `visual.assetId` reported every genuine capture as
    // "缺少素材绑定" — a warning on the happy path, which trains reviewers to
    // ignore provenance findings.
    const assetId =
      scene.assetIds.find((id) => assetsById.has(id)) ??
      (scene.visual.type === 'real_demo' ? scene.visual.assetId : undefined);
    const asset = assetId ? assetsById.get(assetId) : undefined;
    if (!assetId || !asset) {
      findings.push({
        ruleId: 'fact.capture_provenance',
        category: 'fact',
        severity: 'warning',
        sourceKind: 'scene_text',
        title: '真实录屏镜头缺少素材绑定',
        message: `第 ${(window?.sceneOrder ?? 0) + 1} 镜标记为 real_demo，但没有绑定任何素材。`,
        remediation: '在编辑器中为该镜头绑定真实录屏素材，或改为动效镜头后重新运行。',
        remediationAction: 'editor',
        sceneId: scene.id,
        ...(window ? { sceneOrder: window.sceneOrder, sceneTitle: window.sceneTitle } : {}),
      });
      continue;
    }
    const assetHashes = context.manifestAssetHashes?.find((entry) => entry.assetId === assetId);
    if (asset.mock) {
      findings.push({
        ruleId: 'fact.capture_provenance',
        category: 'fact',
        severity: 'warning',
        sourceKind: 'scene_text',
        title: '真实录屏镜头仍在使用占位素材',
        message: `第 ${(window?.sceneOrder ?? 0) + 1} 镜绑定的素材 ${assetId} 仍是占位画面，尚未接入真实录屏。`,
        remediation: '开启 Gate 2 真实录屏并批准演示计划，或为该镜头接入已脱敏的真实录屏素材。',
        remediationAction: 'production',
        sceneId: scene.id,
        ...(window ? { sceneOrder: window.sceneOrder, sceneTitle: window.sceneTitle } : {}),
      });
      continue;
    }

    // Real asset: every provenance link must hold, or this is a blocker.
    const issues: string[] = [];
    if (context.receipt) {
      if (context.receipt.assertions.failed > 0 || context.receipt.assertions.passed !== context.receipt.assertions.total) {
        issues.push('录屏回执存在未通过的断言');
      }
      if (context.clipSha256 && context.receipt.clip.sha256 !== context.clipSha256) {
        issues.push('磁盘片段 SHA256 与回执不一致');
      }
    }
    if (assetHashes && assetHashes.mock) {
      issues.push('渲染清单把该素材标记为占位');
    }
    if (assetHashes?.mediaSha256 && context.clipSha256 && assetHashes.mediaSha256 !== context.clipSha256) {
      issues.push('渲染清单素材哈希与回执片段不一致');
    }
    if (issues.length > 0) {
      findings.push({
        ruleId: 'fact.capture_provenance',
        category: 'fact',
        severity: 'blocker',
        sourceKind: 'capture_receipt',
        title: '真实录屏溯源链不完整',
        message: `${issues.join('；')}。`,
        remediation: '重新执行 Gate 2 录屏并确保断言全部通过；必要时重新渲染以重建素材哈希链。',
        remediationAction: 'production',
        sceneId: scene.id,
        ...(window ? { sceneOrder: window.sceneOrder, sceneTitle: window.sceneTitle } : {}),
        assetId,
      });
    }
  }
  return findings;
}

/** `content.banned_phrase`: brief bans, located in every offending scene. */
export function collectBannedPhraseFindings(
  frozen: { input: RenderInputV1 },
  bannedPhrases: string[],
  windows: SceneTimelineWindow[],
): FactContentFindingDraft[] {
  const phrases = bannedPhrases.map((phrase) => phrase.trim()).filter(Boolean);
  if (phrases.length === 0) return [];
  const findings: FactContentFindingDraft[] = [];
  for (const scene of frozen.input.storyboard.scenes) {
    const text = sceneTextFor(scene);
    const window = windows.find((entry) => entry.sceneId === scene.id);
    for (const phrase of phrases) {
      if (!text.includes(phrase)) continue;
      findings.push({
        ruleId: 'content.banned_phrase',
        category: 'content',
        severity: 'blocker',
        sourceKind: 'scene_text',
        title: '镜头文案包含禁用词',
        message: `第 ${(window?.sceneOrder ?? 0) + 1} 镜的文案包含简报禁用词「${phrase}」。`,
        remediation: '在编辑器中改写该镜头的标题/旁白/字幕，移除禁用词后重新运行。',
        remediationAction: 'editor',
        sceneId: scene.id,
        ...(window ? { sceneOrder: window.sceneOrder, sceneTitle: window.sceneTitle } : {}),
        metrics: { phraseLength: phrase.length },
      });
    }
  }
  return findings;
}

export interface NarrationContentInput {
  narrationEnabled: boolean;
  subtitleCueCount: number;
}

/** `content.narration_and_caption`: empty narration blocks; no captions warns. */
export function collectNarrationContentFindings(
  frozen: { input: RenderInputV1 },
  input: NarrationContentInput,
  windows: SceneTimelineWindow[],
): FactContentFindingDraft[] {
  if (!input.narrationEnabled) return [];
  const findings: FactContentFindingDraft[] = [];
  for (const scene of frozen.input.storyboard.scenes) {
    const window = windows.find((entry) => entry.sceneId === scene.id);
    if (!scene.narration.trim()) {
      findings.push({
        ruleId: 'content.narration_and_caption',
        category: 'content',
        severity: 'blocker',
        sourceKind: 'scene_text',
        title: '启用旁白但镜头没有旁白文本',
        message: `第 ${(window?.sceneOrder ?? 0) + 1} 镜启用了旁白，但旁白为空，成片会出现无声段落。`,
        remediation: '为该镜头补写旁白，或关闭旁白后重新运行。',
        remediationAction: 'editor',
        sceneId: scene.id,
        ...(window ? { sceneOrder: window.sceneOrder, sceneTitle: window.sceneTitle } : {}),
      });
    }
  }
  if (input.subtitleCueCount === 0) {
    findings.push({
      ruleId: 'content.narration_and_caption',
      category: 'content',
      severity: 'warning',
      sourceKind: 'subtitle_srt',
      title: '启用旁白但没有字幕',
      message: '运行启用了旁白，但 SRT 没有任何字幕条目。',
      remediation: '确认字幕生成步骤已执行；必要时重新运行以生成 SRT。',
      remediationAction: 'production',
    });
  }
  return findings;
}

/** `content.synthetic_voice_notice`: an honest info note, never a blocker. */
export function collectSyntheticVoiceNotice(
  manifest: { narration?: { synthetic: boolean; license?: string } } | null,
): FactContentFindingDraft[] {
  if (!manifest?.narration?.synthetic) return [];
  return [
    {
      ruleId: 'content.synthetic_voice_notice',
      category: 'content',
      severity: 'info',
      sourceKind: 'audio_stream',
      title: '当前使用合成音轨',
      message: '旁白为测试/合成音轨（synthetic: true），不是真人商用配音；对外发布前请替换为授权配音。',
      remediation: '交付前在服务端配置正式 TTS 音色并重新合成旁白。',
      remediationAction: 'production',
    },
  ];
}

/** `content.brand_kit`: missing brand wordmark / CTA is a warning. */
export function collectBrandKitFindings(
  frozen: { input: RenderInputV1 },
): FactContentFindingDraft[] {
  const findings: FactContentFindingDraft[] = [];
  const scenes = frozen.input.storyboard.scenes;
  const hasTitle = scenes.some((scene) => scene.visual.type === 'title');
  const hasCta = scenes.some(
    (scene) => scene.visual.type === 'cta' || /CTA|行动|立即|开始|Try|Start/i.test(scene.caption),
  );
  if (!hasTitle) {
    findings.push({
      ruleId: 'content.brand_kit',
      category: 'content',
      severity: 'warning',
      sourceKind: 'scene_text',
      title: '缺少品牌标题镜',
      message: '分镜中没有 title 镜头，品牌字标可能不会出现。',
      remediation: '在编辑器中新增标题镜头并套用品牌字标。',
      remediationAction: 'editor',
    });
  }
  if (!hasCta) {
    findings.push({
      ruleId: 'content.brand_kit',
      category: 'content',
      severity: 'warning',
      sourceKind: 'scene_text',
      title: '缺少明确的行动号召',
      message: '分镜中没有 CTA 镜头，也没有可识别的行动号召文案。',
      remediation: '在结尾镜头补充 CTA（如「立即体验」）后重新运行。',
      remediationAction: 'editor',
    });
  }
  return findings;
}
