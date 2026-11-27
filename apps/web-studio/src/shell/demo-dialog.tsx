import { useState } from 'react';
import { CheckCircle2, CircleSlash, Database, Download, RotateCcw } from 'lucide-react';
import { Button, Callout, Dialog, DialogContent } from '@asvs/ui';
import { useStudioStore, useUiStore } from '@asvs/state';

export function DemoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const resetDemoData = useStudioStore((state) => state.resetDemoData);
  const pushToast = useUiStore((state) => state.pushToast);

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setConfirming(false);
        onOpenChange(value);
      }}
    >
      <DialogContent
        title="模拟能力与真实边界"
        description="这个工作区是可交互的前端产品原型。所有业务数据都来自本地 Demo 快照，刷新后仍会保留；重置后可恢复初始状态。"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            {confirming ? (
              <>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  取消
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    resetDemoData();
                    setConfirming(false);
                    pushToast({
                      tone: 'success',
                      title: '已重置演示数据',
                      description: '项目、知识、视频、运行与导出记录已恢复到初始快照。',
                    });
                  }}
                >
                  确认重置全部数据
                </Button>
              </>
            ) : (
              <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={() => setConfirming(true)}>
                重置演示数据
              </Button>
            )}
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <section className="rounded-md border border-success/20 bg-success-soft/40 p-3.5">
            <h3 className="flex items-center gap-2 text-[12.5px] font-medium text-success">
              <CheckCircle2 size={15} />
              真实可用的前端能力
            </h3>
            <ul className="mt-2.5 space-y-2 text-[12px] leading-[18px] text-muted">
              <li>结构化知识、声明与证据的增删改查，跨页面同步。</li>
              <li>连接本机 API 后支持真实只读 GitHub App 接入、增量索引、PR 发现（AC-02）、核验审计（AC-03）与过期传播（AC-09）。</li>
              <li>AI 导演只执行有限的确定性指令，并列出每一处变更。</li>
              <li>分镜拖拽排序、时长编辑、字幕与画幅设置。</li>
              <li>时间驱动的预览、播放头、撤销 / 重做，刷新后保留。</li>
              <li>确定性生产状态机：成功、失败、重试、审批、取消。</li>
              <li>真实下载视频工程 JSON 与 SRT 字幕文件。</li>
            </ul>
          </section>
          <section className="rounded-md border border-line bg-raised/40 p-3.5">
            <h3 className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
              <CircleSlash size={15} className="text-warn" />
              明确模拟、不会伪造的部分
            </h3>
            <ul className="mt-2.5 space-y-2 text-[12px] leading-[18px] text-muted">
              <li>GitHub 知识源：未配置本机 GitHub App 凭证或使用演示项目时为模拟；配置后可通过本机 API 真实只读接入。</li>
              <li>AI 模型调用：本地确定性规则，不请求外部模型。</li>
              <li>录屏、配音与渲染：模拟任务与进度，不生成音视频文件。</li>
              <li>MP4 / WebM 导出：只有状态，不会伪造可播放成片。</li>
              <li>上传、发布与真实审批流：未接入外部服务；工作区可写入本机 SQLite API。</li>
            </ul>
          </section>
        </div>

        <Callout tone="info" className="mt-4" title="数据保存在哪里">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Database size={12} />
            默认保存在浏览器 localStorage 的
            <code className="rounded bg-ink px-1 py-0.5 font-mono text-[10.5px] text-fg">asvs.studio.v1</code>
            ，界面偏好保存在
            <code className="rounded bg-ink px-1 py-0.5 font-mono text-[10.5px] text-fg">asvs.ui.v1</code>
            。可在项目设置中启用本机 SQLite API 同步；没有账号、第三方云或真实上传。
          </span>
        </Callout>

        <Callout tone="warning" className="mt-2" title="关于导出的诚实说明">
          <span className="flex items-center gap-2">
            <Download size={12} />
            工程 JSON 与 SRT 是真实生成并下载的文件；MP4/WebM 仅演示导出状态，不产生任何媒体文件。
          </span>
        </Callout>
      </DialogContent>
    </Dialog>
  );
}
