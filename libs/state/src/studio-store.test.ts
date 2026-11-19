import { beforeEach, describe, expect, it } from 'vitest';
import { orderedScenes, totalDuration } from '@asvs/domain';
import { useStudioStore } from './studio-store';

const RELEASE_VIDEO = 'vid_lumen_release';
const TUTORIAL_VIDEO = 'vid_lumen_tutorial';

function store() {
  return useStudioStore.getState();
}

beforeEach(() => {
  localStorage.clear();
  store().resetDemoData();
});

describe('工作区种子与持久化数据', () => {
  it('默认加载两个演示项目与视频模板', () => {
    const state = store();
    expect(state.projects.map((project) => project.id)).toEqual(['proj_lumen', 'proj_pulse']);
    expect(state.videos.length).toBeGreaterThanOrEqual(2);
    expect(state.templates.length).toBeGreaterThan(0);

    const persisted = JSON.parse(localStorage.getItem('asvs.studio.v1') ?? '{}');
    expect(persisted.state.videos).toBeDefined();
    expect(persisted.state.history).toBeUndefined();
  });
});

describe('镜头编辑历史', () => {
  it('修改字幕后可撤销与重做', () => {
    const video = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    const scene = orderedScenes(video.scenes)[0]!;
    const original = scene.caption;

    store().updateScene(RELEASE_VIDEO, scene.id, { caption: '新的字幕内容' });
    expect(
      store().videos.find((item) => item.id === RELEASE_VIDEO)!.scenes.find(
        (item) => item.id === scene.id,
      )!.caption,
    ).toBe('新的字幕内容');
    expect(store().history[RELEASE_VIDEO]?.past.length).toBeGreaterThan(0);

    store().undoVideo(RELEASE_VIDEO);
    expect(
      store().videos.find((item) => item.id === RELEASE_VIDEO)!.scenes.find(
        (item) => item.id === scene.id,
      )!.caption,
    ).toBe(original);

    store().redoVideo(RELEASE_VIDEO);
    expect(
      store().videos.find((item) => item.id === RELEASE_VIDEO)!.scenes.find(
        (item) => item.id === scene.id,
      )!.caption,
    ).toBe('新的字幕内容');
  });

  it('重排镜头会重写 order 并可按历史恢复', () => {
    const before = orderedScenes(
      store().videos.find((item) => item.id === TUTORIAL_VIDEO)!.scenes,
    );
    const reversed = [...before].reverse().map((scene) => scene.id);

    store().reorderScenes(TUTORIAL_VIDEO, reversed);
    const after = orderedScenes(
      store().videos.find((item) => item.id === TUTORIAL_VIDEO)!.scenes,
    );

    expect(after.map((scene) => scene.id)).toEqual(reversed);
    expect(after.map((scene) => scene.order)).toEqual(reversed.map((_, index) => index));

    store().undoVideo(TUTORIAL_VIDEO);
    const restored = orderedScenes(
      store().videos.find((item) => item.id === TUTORIAL_VIDEO)!.scenes,
    );
    expect(restored.map((scene) => scene.id)).toEqual(before.map((scene) => scene.id));
  });

  it('修改 Brief 时长会同步缩放场景并写回实际总时长', () => {
    store().updateBrief(TUTORIAL_VIDEO, { durationSec: 20 });
    const video = store().videos.find((item) => item.id === TUTORIAL_VIDEO)!;

    expect(totalDuration(video.scenes)).toBeCloseTo(20, 5);
    expect(video.brief.durationSec).toBeCloseTo(20, 5);
  });
});

describe('AI 导演接入状态', () => {
  it('导演命令修改真实工程并写入对话历史', async () => {
    const before = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    const result = await store().sendDirectorCommand(RELEASE_VIDEO, '把视频缩短到 24 秒');

    expect(result?.recognized).toBe(true);
    const after = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    expect(totalDuration(after.scenes)).toBeCloseTo(24, 5);
    expect(after.directorMessages.length).toBe(before.directorMessages.length + 2);
    expect(after.directorMessages.at(-1)?.role).toBe('assistant');
    expect(after.directorMessages.at(-1)?.changes?.length).toBeGreaterThan(0);
  });

  it('无法识别的命令只追加对话，不修改工程', async () => {
    const before = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    const result = await store().sendDirectorCommand(RELEASE_VIDEO, '换成真人出镜');
    const after = store().videos.find((item) => item.id === RELEASE_VIDEO)!;

    expect(result?.recognized).toBe(false);
    expect(after.scenes).toEqual(before.scenes);
    expect(after.directorMessages.at(-1)?.text).toContain('无法');
  });
});

describe('审核、导出与品牌失效', () => {
  it('没有成功生产运行时不能批准', () => {
    const result = store().approveVideo(TUTORIAL_VIDEO);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('检查未通过');
  });

  it('未审核通过的视频不能导出', () => {
    const result = store().startExport(RELEASE_VIDEO, {
      format: 'json',
      aspect: '16:9',
      resolution: '1920×1080',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('只有已通过审核');
  });

  it('更新品牌会让已通过审核的视频回到待修改', () => {
    useStudioStore.setState((state) => ({
      videos: state.videos.map((video) =>
        video.id === RELEASE_VIDEO
          ? {
              ...video,
              stage: 'approved' as const,
              review: { status: 'approved' as const, decidedAt: '2026-11-14T00:00:00.000Z' },
            }
          : video,
      ),
    }));
    const project = store().projects.find((item) => item.id === 'proj_lumen')!;

    store().updateBrand('proj_lumen', { ...project.brand, primary: '#7C9CFF' });

    const video = store().videos.find((item) => item.id === RELEASE_VIDEO)!;
    expect(video.stage).toBe('changes_requested');
    expect(video.review?.status).toBe('pending');
    expect(video.review?.note).toContain('品牌资产已更新');
  });
});
