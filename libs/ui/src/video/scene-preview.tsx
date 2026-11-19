import type { ReactNode } from 'react';
import type { AspectRatio, BrandKit, Feature, Project, Scene } from '@asvs/domain';
import { blendHex, readableAccentOn, readableOn, withAlpha } from '@asvs/domain';
import { BrandMark } from '../brand';
import { cn } from '../cn';

export interface ScenePreviewProps {
  scene: Scene;
  project: Project;
  feature?: Feature;
  aspect?: AspectRatio;
  showCaption?: boolean;
  showChrome?: boolean;
  className?: string;
}

type Surface = 'paper' | 'ink' | 'tint' | 'brand';

const SURFACE_BY_TEMPLATE: Record<string, Surface> = {
  tpl_signal: 'paper',
  tpl_grid: 'ink',
  tpl_bloom: 'tint',
  tpl_type: 'brand',
};

function surfaceFor(scene: Scene, brand: BrandKit): Surface {
  const direct = SURFACE_BY_TEMPLATE[scene.templateId];
  if (direct) return direct;
  if (brand.style === 'editorial') return 'paper';
  if (brand.style === 'minimal') return 'ink';
  if (brand.style === 'bold') return 'brand';
  return 'tint';
}

function fontStack(brand: BrandKit): string {
  switch (brand.fontPair) {
    case 'serif':
      return "'Iowan Old Style', 'Songti SC', Georgia, serif";
    case 'mono':
      return "var(--font-mono)";
    case 'clean':
      return "var(--font-sans)";
    default:
      return 'var(--font-display)';
  }
}

function demoVariant(feature?: Feature): string {
  const name = feature?.name ?? '';
  if (name.includes('协作') || name.includes('实时')) return 'collab';
  if (name.includes('漏斗') || name.includes('分析')) return 'funnel';
  if (name.includes('分享') || name.includes('权限')) return 'share';
  if (name.includes('连接') || name.includes('集成')) return 'connectors';
  if (name.includes('异常') || name.includes('预警')) return 'anomaly';
  if (name.includes('暗色') || name.includes('主题')) return 'theme';
  return 'dashboard';
}

export function ScenePreview({
  scene,
  project,
  feature,
  aspect = '16:9',
  showCaption = true,
  showChrome = true,
  className,
}: ScenePreviewProps) {
  const brand = project.brand;
  const surface = surfaceFor(scene, brand);
  const scale = aspect === '9:16' ? 1.75 : aspect === '1:1' ? 1.28 : 1;
  const u = (n: number) => `${(n * scale).toFixed(2)}cqw`;

  const paper = '#F2EEE3';
  const ink = '#0B0D11';
  const bg =
    surface === 'paper'
      ? paper
      : surface === 'brand'
        ? brand.primary
        : surface === 'tint'
          ? '#101217'
          : ink;
  const fg =
    surface === 'paper'
      ? '#1A1915'
      : surface === 'brand'
        ? readableOn(brand.primary)
        : '#F4F2EC';
  const muted =
    surface === 'paper'
      ? 'rgba(26,25,21,.65)'
      : surface === 'brand'
        ? withAlpha(readableOn(brand.primary) === '#15140F' ? '#15140F' : '#FFFDF7', 0.64)
        : 'rgba(244,242,236,.56)';
  const line =
    surface === 'paper' ? 'rgba(26,25,21,.14)' : surface === 'brand' ? withAlpha(fg, 0.22) : 'rgba(255,255,255,.12)';
  const accent = surface === 'paper' ? brand.primary : surface === 'brand' ? fg : brand.primary;

  const caption = (scene.caption || scene.narration || scene.title).trim();

  return (
    <div
      className={cn('scene-canvas relative h-full w-full overflow-hidden', className)}
      style={{
        background: bg,
        color: fg,
        fontFamily: 'var(--font-sans)',
        // @ts-expect-error CSS custom properties are valid inline styles
        '--pv-bg': bg,
        '--pv-fg': fg,
        '--pv-muted': muted,
        '--pv-line': line,
        '--pv-accent': accent,
        '--pv-on-accent': readableOn(brand.primary),
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          filter: `brightness(${scene.brightness})`,
        }}
      >
        {scene.visualType === 'title' ? (
          <TitleScreen scene={scene} project={project} feature={feature} u={u} surface={surface} />
        ) : null}
        {scene.visualType === 'cta' ? (
          <CtaScreen scene={scene} project={project} u={u} />
        ) : null}
        {scene.visualType === 'real_demo' ? (
          <RealDemoScreen
            scene={scene}
            project={project}
            feature={feature}
            u={u}
            variant={demoVariant(feature)}
          />
        ) : null}
        {scene.visualType === 'motion' ? (
          <MotionScreen scene={scene} project={project} feature={feature} u={u} surface={surface} />
        ) : null}
        {scene.visualType === 'generated' ? (
          <GeneratedScreen scene={scene} project={project} u={u} />
        ) : null}
      </div>

      {scene.vignette ? (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 90% at 50% 48%, transparent 52%, rgba(0,0,0,.34) 100%)',
          }}
        />
      ) : null}

      {showCaption && caption ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center"
          style={{
            padding: `${u(2.2)} ${u(5)} ${u(2.8)}`,
            background: 'linear-gradient(to top, rgba(6,7,9,.72), rgba(6,7,9,0))',
          }}
        >
          <p
            className="max-w-[86%] text-center font-medium leading-[1.5] text-[#FFFDF7]"
            style={{
              fontSize: u(1.55),
              textShadow: '0 1px 12px rgba(0,0,0,.6)',
            }}
          >
            {caption}
          </p>
        </div>
      ) : null}

      {showChrome ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between"
          style={{ padding: u(1.4), fontSize: u(0.78), color: 'var(--pv-muted)' }}
        >
          <span
            className="rounded-[3px] border border-white/20 bg-black/70 px-1.5 py-0.5 font-medium tracking-[0.08em] text-white/90 backdrop-blur-sm"
            style={{ fontSize: u(0.76) }}
          >
            模拟预览 · 非成片
          </span>
          <span className="font-mono tabular" style={{ fontSize: u(0.76) }}>
            {String(scene.order + 1).padStart(2, '0')} / {String(scene.order + 1).padStart(2, '0')}
          </span>
        </div>
      ) : null}
    </div>
  );
}

type Unit = (n: number) => string;

function BrandRow({
  project,
  u,
  color,
  compact,
}: {
  project: Project;
  u: Unit;
  color?: string;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center" style={{ gap: u(0.9), color }}>
      <span
        style={{ width: u(compact ? 2.2 : 3), height: u(compact ? 2.2 : 3), display: 'inline-block' }}
        className="shrink-0"
      >
        <BrandMark
          mark={project.brand.logoMark}
          size={32}
          className="h-full w-full"
          title={project.brand.logoText}
        />
      </span>
      <span
        className="font-semibold uppercase"
        style={{ fontSize: u(compact ? 1.15 : 1.45), letterSpacing: '0.16em' }}
      >
        {project.brand.logoText}
      </span>
    </div>
  );
}

function TitleScreen({
  scene,
  project,
  feature,
  u,
  surface,
}: {
  scene: Scene;
  project: Project;
  feature?: Feature;
  u: Unit;
  surface: Surface;
}) {
  const paper = surface === 'paper';
  const brand = project.brand;
  const accentText = paper
    ? readableAccentOn(brand.primary, blendHex('#F2EEE3', brand.primary, 0.16))
    : surface === 'brand'
      ? readableOn(brand.primary)
      : brand.primary;
  return (
    <div className="absolute inset-0 flex flex-col" style={{ padding: u(4.6) }}>
      <div className="flex items-center justify-between">
        <BrandRow project={project} u={u} color={paper ? '#1A1915' : undefined} />
        <span
          className="font-mono uppercase tracking-[0.18em]"
          style={{ fontSize: u(0.82), color: 'var(--pv-muted)' }}
        >
          {feature?.category ?? '产品影像'} / 2026
        </span>
      </div>

      <div className="relative flex flex-1 flex-col justify-center" style={{ paddingTop: u(1) }}>
        <div
          className="absolute right-0 top-[8%] hidden h-[54%] w-[30%] sm:block"
          style={{
            background: paper ? withAlpha(brand.primary, 0.16) : withAlpha(brand.primary, 0.24),
            border: `1px solid ${withAlpha(brand.primary, 0.45)}`,
          }}
        />
        <div
          className="absolute right-[4%] top-[16%] hidden flex-col items-end sm:flex"
          style={{ gap: u(0.7) }}
        >
          <span
            className="font-display leading-none"
            style={{ fontSize: u(7.4), color: paper || surface === 'brand' ? accentText : withAlpha(brand.primary, 0.75), fontWeight: 500 }}
          >
            {String(scene.order + 1).padStart(2, '0')}
          </span>
          <span
            className="font-mono uppercase"
            style={{ fontSize: u(0.8), letterSpacing: '0.2em', color: 'var(--pv-muted)' }}
          >
            Scene
          </span>
        </div>

        <div
          className="mb-3 flex items-center gap-2"
          style={{ color: accentText, fontSize: u(0.92), letterSpacing: '0.16em' }}
        >
          <span style={{ width: u(2.4), height: 1, background: brand.primary }} />
          <span className="font-semibold uppercase">{feature?.name ?? 'AI SOFTWARE VIDEO STUDIO'}</span>
        </div>
        <h2
          className="max-w-[78%] font-medium leading-[1.08] tracking-[-0.03em] text-balance"
          style={{ fontSize: u(5.4), fontFamily: fontStack(brand) }}
        >
          {scene.title}
        </h2>
        <p
          className="mt-4 max-w-[52%] leading-[1.6]"
          style={{ fontSize: u(1.35), color: 'var(--pv-muted)' }}
        >
          {feature?.summary ?? scene.intent}
        </p>
      </div>

      <div
        className="flex items-center justify-between border-t pt-3"
        style={{ borderColor: 'var(--pv-line)', fontSize: u(0.9), color: 'var(--pv-muted)' }}
      >
        <span className="uppercase tracking-[0.14em]">{project.productName}</span>
        <span className="font-mono">{project.website || 'demo'}</span>
      </div>
    </div>
  );
}

function CtaScreen({ scene, project, u }: { scene: Scene; project: Project; u: Unit }) {
  const fg = readableOn(project.brand.primary);
  return (
    <div className="absolute inset-0 flex flex-col justify-between" style={{ padding: u(5) }}>
      <div className="flex items-center justify-between">
        <BrandRow project={project} u={u} color={fg} />
        <span
          className="font-mono uppercase tracking-[0.18em]"
          style={{ fontSize: u(0.82), color: withAlpha(fg, 0.6) }}
        >
          END CARD
        </span>
      </div>
      <div className="max-w-[74%]">
        <div
          className="mb-3 uppercase"
          style={{ fontSize: u(1), letterSpacing: '0.2em', color: withAlpha(fg, 0.65) }}
        >
          {project.brand.outro || '现在开始'}
        </div>
        <h2
          className="font-medium leading-[1.1] tracking-[-0.03em]"
          style={{ fontSize: u(5.2), fontFamily: fontStack(project.brand), color: fg }}
        >
          {scene.title}
        </h2>
        <div
          className="mt-5 inline-flex items-center gap-2 rounded-sm px-4 py-2"
          style={{
            background: fg,
            color: project.brand.primary,
            fontSize: u(1.2),
            fontWeight: 600,
          }}
        >
          {scene.caption || '访问产品官网'}
          <span aria-hidden>↗</span>
        </div>
      </div>
      <div
        className="flex items-end justify-between border-t pt-3"
        style={{ borderColor: withAlpha(fg, 0.24), color: withAlpha(fg, 0.64), fontSize: u(0.92) }}
      >
        <span>{project.brand.outro}</span>
        <span className="font-mono">{project.productName}</span>
      </div>
    </div>
  );
}

function WindowChrome({ u, url }: { u: Unit; url: string }) {
  return (
    <div
      className="flex items-center"
      style={{
        height: u(3.4),
        paddingInline: u(1.2),
        gap: u(0.8),
        borderBottom: '1px solid var(--pv-line)',
        background: 'rgba(15,17,22,.85)',
      }}
    >
      <span className="flex" style={{ gap: u(0.45) }}>
        {['#FF6B5E', '#F5BF4F', '#62C554'].map((color) => (
          <span
            key={color}
            className="rounded-full"
            style={{ width: u(0.62), height: u(0.62), background: color }}
          />
        ))}
      </span>
      <div
        className="flex flex-1 items-center justify-center rounded-sm"
        style={{
          height: u(1.9),
          background: 'rgba(255,255,255,.06)',
          color: 'rgba(255,255,255,.5)',
          fontSize: u(0.72),
          fontFamily: 'var(--font-mono)',
        }}
      >
        {url}
      </div>
      <span
        className="rounded-[2px] border border-white/15 px-1"
        style={{ fontSize: u(0.62), color: 'rgba(255,255,255,.55)', letterSpacing: '.08em' }}
      >
        DEMO
      </span>
    </div>
  );
}

function ProductShell({
  project,
  feature,
  u,
  active,
  children,
}: {
  project: Project;
  feature?: Feature;
  u: Unit;
  active: string;
  children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: '#0E1116' }}>
      <WindowChrome u={u} url={`atlas.demo.invalid${feature?.demoRoute ?? '/workspace'}`} />
      <div
        className="flex items-center border-b"
        style={{
          height: u(3.6),
          borderColor: 'var(--pv-line)',
          paddingInline: u(1.4),
          gap: u(1.6),
        }}
      >
        <BrandRow project={project} u={u} compact />
        <div className="flex flex-1 items-center" style={{ gap: u(1.2) }}>
          {['工作区', '项目', '报表', '成员'].map((item) => (
            <span
              key={item}
              style={{
                fontSize: u(0.84),
                color: item === active ? '#F4F2EC' : 'rgba(244,242,236,.62)',
                borderBottom: item === active ? '1px solid var(--pv-accent)' : '1px solid transparent',
                paddingBottom: u(0.55),
                paddingTop: u(0.55),
              }}
            >
              {item}
            </span>
          ))}
        </div>
        <div className="flex items-center" style={{ gap: u(0.5) }}>
          {['L', 'M'].map((letter, index) => (
            <span
              key={letter}
              className="grid place-items-center rounded-full"
              style={{
                width: u(1.45),
                height: u(1.45),
                background: index === 0 ? project.brand.primary : '#3A4558',
                color: index === 0 ? readableOn(project.brand.primary) : '#E8EDF7',
                fontSize: u(0.6),
                fontWeight: 600,
              }}
            >
              {letter}
            </span>
          ))}
          <span
            className="rounded-sm"
            style={{
              marginLeft: u(0.55),
              padding: `${u(0.35)} ${u(0.9)}`,
              background: project.brand.primary,
              color: 'var(--pv-on-accent)',
              fontSize: u(0.72),
              fontWeight: 600,
            }}
          >
            分享
          </span>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

function DemoStat({
  label,
  value,
  hint,
  accent,
  u,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  u: Unit;
}) {
  return (
    <div
      className="flex flex-col justify-between rounded-sm"
      style={{
        padding: u(1.1),
        background: 'rgba(255,255,255,.035)',
        border: '1px solid var(--pv-line)',
      }}
    >
      <span style={{ fontSize: u(0.7), color: 'var(--pv-muted)' }}>{label}</span>
      <span
        className="font-display tabular"
        style={{ fontSize: u(2.2), lineHeight: 1.1, color: accent ? 'var(--pv-accent)' : '#F4F2EC' }}
      >
        {value}
      </span>
      {hint ? <span style={{ fontSize: u(0.64), color: 'var(--pv-muted)' }}>{hint}</span> : null}
    </div>
  );
}

function RealDemoScreen({
  scene,
  project,
  feature,
  u,
  variant,
}: {
  scene: Scene;
  project: Project;
  feature?: Feature;
  u: Unit;
  variant: string;
}) {
  const active =
    variant === 'collab'
      ? '工作区'
      : variant === 'funnel' || variant === 'anomaly'
        ? '报表'
        : variant === 'connectors'
          ? '成员'
          : '项目';

  return (
    <ProductShell project={project} feature={feature} u={u} active={active}>
      {variant === 'collab' ? <CollabBoard u={u} project={project} /> : null}
      {variant === 'funnel' ? <FunnelBoard u={u} /> : null}
      {variant === 'share' ? <ShareBoard u={u} project={project} /> : null}
      {variant === 'connectors' ? <ConnectorsBoard u={u} /> : null}
      {variant === 'anomaly' ? <AnomalyBoard u={u} /> : null}
      {variant === 'theme' ? <ThemeBoard u={u} project={project} /> : null}
      {variant === 'dashboard' ? (
        <DashboardBoard u={u} project={project} title={scene.title} feature={feature} />
      ) : null}
    </ProductShell>
  );
}

function BoardHeader({ title, sub, u }: { title: string; sub?: string; u: Unit }) {
  return (
    <div className="flex items-end justify-between" style={{ marginBottom: u(1.2) }}>
      <div>
        <div
          className="font-medium"
          style={{ fontSize: u(1.55), color: '#F4F2EC', letterSpacing: '-0.01em' }}
        >
          {title}
        </div>
        {sub ? (
          <div style={{ fontSize: u(0.68), color: 'var(--pv-muted)', marginTop: u(0.2) }}>{sub}</div>
        ) : null}
      </div>
      <div className="flex" style={{ gap: u(0.5) }}>
        <span
          className="rounded-sm border"
          style={{
            borderColor: 'var(--pv-line)',
            padding: `${u(0.3)} ${u(0.7)}`,
            fontSize: u(0.65),
            color: 'var(--pv-muted)',
          }}
        >
          本月
        </span>
        <span
          className="rounded-sm"
          style={{
            background: 'var(--pv-accent)',
            color: 'var(--pv-on-accent)',
            padding: `${u(0.3)} ${u(0.7)}`,
            fontSize: u(0.65),
            fontWeight: 600,
          }}
        >
          新建
        </span>
      </div>
    </div>
  );
}

function CollabBoard({ u, project }: { u: Unit; project: Project }) {
  const columns = [
    { title: '待处理', count: 4, cards: [['激活漏斗', 'P1', '3 条评论'], ['留存看板', 'P2', '待指派']] },
    { title: '进行中', count: 3, cards: [['Q3 增长复盘', 'P1', '今天 14:00'], ['渠道归因', 'P2', '2 人协作']] },
    { title: '已完成', count: 8, cards: [['周报模板', 'P2', '已归档'], ['异常规则', 'P1', '已验收']] },
  ];
  return (
    <div className="absolute inset-0 flex" style={{ background: '#0D1015' }}>
      <div
        className="flex flex-col items-center border-r"
        style={{ width: u(4.4), borderColor: 'var(--pv-line)', paddingTop: u(1.2), gap: u(1) }}
      >
        {['◫', '◎', '▤', '⌘'].map((icon, index) => (
          <span
            key={icon}
            className="grid place-items-center rounded-sm"
            style={{
              width: u(2.2),
              height: u(2.2),
              background: index === 0 ? 'rgba(255,255,255,.08)' : 'transparent',
              color: index === 0 ? 'var(--pv-accent)' : 'rgba(255,255,255,.35)',
              fontSize: u(0.85),
            }}
          >
            {icon}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1" style={{ padding: u(1.8) }}>
        <BoardHeader title="Q3 增长看板" sub="产品 · 6 位成员 · 刚刚更新" u={u} />
        <div className="grid grid-cols-3" style={{ gap: u(1) }}>
          {columns.map((column, columnIndex) => (
            <div
              key={column.title}
              className="rounded-sm"
              style={{
                background: 'rgba(255,255,255,.025)',
                border: '1px solid var(--pv-line)',
                padding: u(0.8),
                minHeight: u(18),
              }}
            >
              <div
                className="flex items-center justify-between"
                style={{ marginBottom: u(0.7), fontSize: u(0.7), color: 'var(--pv-muted)' }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: u(0.35) }}>
                  <span
                    className="rounded-full"
                    style={{
                      width: u(0.45),
                      height: u(0.45),
                      background: columnIndex === 1 ? project.brand.primary : 'rgba(255,255,255,.28)',
                    }}
                  />
                  {column.title}
                </span>
                <span className="font-mono">{column.count}</span>
              </div>
              <div className="flex flex-col" style={{ gap: u(0.55) }}>
                {column.cards.map(([title, tag, meta]) => (
                  <div
                    key={title}
                    className="rounded-sm"
                    style={{
                      background: '#151920',
                      borderLeft: `2px solid ${tag === 'P1' ? 'var(--pv-accent)' : 'rgba(255,255,255,.18)'}`,
                      padding: u(0.65),
                    }}
                  >
                    <div style={{ fontSize: u(0.72), color: '#E9ECF2' }}>{title}</div>
                    <div
                      className="flex items-center justify-between"
                      style={{ marginTop: u(0.5), fontSize: u(0.58), color: 'rgba(255,255,255,.36)' }}
                    >
                      <span>{tag}</span>
                      <span>{meta}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div
          className="absolute"
          style={{ left: '47%', top: '48%', display: 'flex', alignItems: 'center', gap: u(0.3) }}
        >
          <svg width={u(1.3)} height={u(1.3)} viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M5 3l14 8-6 1.5L10 20 5 3z" fill={project.brand.primary} stroke="#0D1015" strokeWidth="1.2" />
          </svg>
          <span
            className="rounded-sm"
            style={{
              background: project.brand.primary,
              color: 'var(--pv-on-accent)',
              padding: `${u(0.18)} ${u(0.45)}`,
              fontSize: u(0.56),
              fontWeight: 600,
            }}
          >
            Mia
          </span>
        </div>
        <div
          className="absolute rounded-md"
          style={{
            right: u(2.4),
            bottom: u(2.2),
            width: u(13),
            background: '#1A1F28',
            border: '1px solid rgba(255,255,255,.14)',
            padding: u(0.8),
            boxShadow: '0 12px 30px rgba(0,0,0,.4)',
          }}
        >
          <div className="flex items-center" style={{ gap: u(0.4), marginBottom: u(0.4) }}>
            <span
              className="grid place-items-center rounded-full"
              style={{
                width: u(1.1),
                height: u(1.1),
                background: '#3A4558',
                fontSize: u(0.5),
                color: '#fff',
              }}
            >
              M
            </span>
            <span style={{ fontSize: u(0.62), color: '#F0F2F6', fontWeight: 600 }}>Mia Chen</span>
            <span style={{ fontSize: u(0.52), color: 'rgba(255,255,255,.35)' }}>刚刚</span>
          </div>
          <div style={{ fontSize: u(0.62), color: 'rgba(255,255,255,.62)', lineHeight: 1.55 }}>
            这里的转化率数据源要不要换成本周？
          </div>
        </div>
      </div>
    </div>
  );
}

function FunnelBoard({ u }: { u: Unit }) {
  const steps = [
    ['访问落地页', '48,210', 100],
    ['注册试用', '12,840', 72],
    ['创建工作区', '7,320', 48],
    ['邀请成员', '3,944', 27],
    ['升级付费', '1,208', 12],
  ] as const;
  return (
    <div style={{ padding: u(1.8) }}>
      <BoardHeader title="激活漏斗" sub="过去 30 天 · 全部渠道" u={u} />
      <div className="grid grid-cols-[1.1fr_1fr]" style={{ gap: u(1.2) }}>
        <div
          className="rounded-sm"
          style={{
            border: '1px solid var(--pv-line)',
            background: 'rgba(255,255,255,.025)',
            padding: u(1),
          }}
        >
          <div style={{ fontSize: u(0.68), color: 'var(--pv-muted)', marginBottom: u(0.8) }}>
            步骤
          </div>
          <div className="flex flex-col" style={{ gap: u(0.5) }}>
            {steps.map(([label, value], index) => (
              <div
                key={label}
                className="flex items-center justify-between rounded-sm"
                style={{
                  padding: u(0.55),
                  background: index === 2 ? 'color-mix(in srgb, var(--pv-accent) 14%, transparent)' : 'transparent',
                  border: `1px solid ${index === 2 ? 'color-mix(in srgb, var(--pv-accent) 40%, transparent)' : 'transparent'}`,
                }}
              >
                <span
                  className="flex items-center"
                  style={{ gap: u(0.5), fontSize: u(0.7), color: '#E6E9EF' }}
                >
                  <span
                    className="grid place-items-center rounded-sm"
                    style={{
                      width: u(1.3),
                      height: u(1.3),
                      background: 'rgba(255,255,255,.07)',
                      fontSize: u(0.55),
                      color: 'var(--pv-muted)',
                    }}
                  >
                    {index + 1}
                  </span>
                  {label}
                </span>
                <span className="font-mono tabular" style={{ fontSize: u(0.68), color: 'rgba(255,255,255,.55)' }}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div
          className="rounded-sm"
          style={{
            border: '1px solid var(--pv-line)',
            background: 'rgba(255,255,255,.025)',
            padding: u(1),
          }}
        >
          <div className="flex items-baseline justify-between">
            <span style={{ fontSize: u(0.68), color: 'var(--pv-muted)' }}>转化率</span>
            <span className="font-display tabular" style={{ fontSize: u(1.9), color: 'var(--pv-accent)' }}>
              2.5%
            </span>
          </div>
          <div className="flex h-full flex-col justify-center" style={{ gap: u(0.55), paddingTop: u(0.8) }}>
            {steps.map(([label, , width], index) => (
              <div key={label} className="flex items-center" style={{ gap: u(0.4) }}>
                <div className="flex-1 overflow-hidden rounded-[1px]" style={{ height: u(1.35), background: 'rgba(255,255,255,.05)' }}>
                  <div
                    style={{
                      width: `${width}%`,
                      height: '100%',
                      background:
                        index === 0
                          ? 'var(--pv-accent)'
                          : `color-mix(in srgb, var(--pv-accent) ${Math.max(25, width)}%, #2A3040)`,
                      opacity: 0.9,
                    }}
                  />
                </div>
                <span className="font-mono" style={{ width: u(2.4), fontSize: u(0.56), color: 'var(--pv-muted)' }}>
                  {width}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ShareBoard({ u, project }: { u: Unit; project: Project }) {
  return (
    <div className="absolute inset-0" style={{ padding: u(1.8), background: '#0C0F14' }}>
      <div
        className="h-full rounded-sm opacity-40"
        style={{ border: '1px solid var(--pv-line)', background: 'rgba(255,255,255,.02)' }}
      />
      <div
        className="absolute left-1/2 top-1/2 rounded-md"
        style={{
          width: '54%',
          transform: 'translate(-50%,-50%)',
          background: '#171B22',
          border: '1px solid rgba(255,255,255,.15)',
          padding: u(1.6),
          boxShadow: '0 24px 60px rgba(0,0,0,.55)',
        }}
      >
        <div className="flex items-start justify-between">
          <div style={{ fontSize: u(1.25), color: '#F4F2EC', fontWeight: 600 }}>分享看板</div>
          <span style={{ fontSize: u(0.8), color: 'rgba(255,255,255,.4)' }}>✕</span>
        </div>
        <div style={{ fontSize: u(0.66), color: 'var(--pv-muted)', marginTop: u(0.25) }}>
          Q3 增长看板 · 任何获得链接的成员可查看
        </div>
        <div
          className="flex items-center rounded-sm"
          style={{ marginTop: u(1), border: '1px solid var(--pv-line)', background: 'rgba(255,255,255,.04)' }}
        >
          <span
            className="flex-1 truncate font-mono"
            style={{ padding: `${u(0.55)} ${u(0.7)}`, fontSize: u(0.6), color: 'rgba(255,255,255,.6)' }}
          >
            atlas.demo.invalid/b/q3-growth
          </span>
          <span
            style={{
              background: project.brand.primary,
              color: 'var(--pv-on-accent)',
              padding: `${u(0.45)} ${u(0.8)}`,
              fontSize: u(0.6),
              fontWeight: 600,
            }}
          >
            复制链接
          </span>
        </div>
        <div className="flex items-center" style={{ gap: u(0.5), marginTop: u(1) }}>
          {['LC', 'MW', 'JT', '+3'].map((letter) => (
            <span
              key={letter}
              className="grid place-items-center rounded-full"
              style={{
                width: u(1.5),
                height: u(1.5),
                background: letter === '+3' ? 'rgba(255,255,255,.08)' : '#2E3746',
                color: '#E6EAF2',
                fontSize: u(0.52),
                border: '1px solid rgba(255,255,255,.14)',
              }}
            >
              {letter}
            </span>
          ))}
          <span style={{ marginLeft: u(0.3), fontSize: u(0.6), color: 'var(--pv-muted)' }}>
            已有 6 人可以查看
          </span>
        </div>
        <div
          className="flex items-center justify-between border-t"
          style={{ marginTop: u(1.2), paddingTop: u(0.9), borderColor: 'var(--pv-line)' }}
        >
          <span className="flex items-center" style={{ gap: u(0.35), fontSize: u(0.6), color: 'var(--pv-muted)' }}>
            <span
              className="rounded-full"
              style={{ width: u(0.45), height: u(0.45), background: '#5BD6A2' }}
            />
            权限变更会记录在审计日志
          </span>
          <span style={{ fontSize: u(0.6), color: 'rgba(255,255,255,.4)' }}>只读</span>
        </div>
      </div>
    </div>
  );
}

function ConnectorsBoard({ u }: { u: Unit }) {
  const cards = [
    ['Slack', '消息通知', '已连接', '#7C5CFF'],
    ['Linear', '任务同步', '已连接', '#5E6AD2'],
    ['Snowflake', '数据仓库', '已连接', '#29B5E8'],
    ['HubSpot', '客户数据', '需授权', '#FF7A59'],
  ];
  return (
    <div style={{ padding: u(1.8) }}>
      <BoardHeader title="集成中心" sub="管理连接状态与授权范围" u={u} />
      <div className="grid grid-cols-2" style={{ gap: u(0.8) }}>
        {cards.map(([name, desc, status, color]) => (
          <div
            key={name}
            className="flex items-center rounded-sm"
            style={{ border: '1px solid var(--pv-line)', background: 'rgba(255,255,255,.025)', padding: u(0.85), gap: u(0.7) }}
          >
            <span
              className="grid place-items-center rounded-sm"
              style={{ width: u(2.3), height: u(2.3), background: `${color}22`, color, fontSize: u(0.75), fontWeight: 700 }}
            >
              {name.slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: u(0.75), color: '#EDF0F5', fontWeight: 600 }}>{name}</div>
              <div style={{ fontSize: u(0.6), color: 'var(--pv-muted)', marginTop: u(0.15) }}>{desc}</div>
            </div>
            <span
              className="rounded-full"
              style={{
                fontSize: u(0.54),
                padding: `${u(0.15)} ${u(0.45)}`,
                background: status === '已连接' ? 'rgba(91,214,162,.12)' : 'rgba(240,184,96,.12)',
                color: status === '已连接' ? '#5BD6A2' : '#F0B860',
              }}
            >
              {status}
            </span>
          </div>
        ))}
      </div>
      <div
        className="mt-3 flex items-center justify-between rounded-sm"
        style={{ border: '1px dashed rgba(255,255,255,.12)', padding: u(0.8), fontSize: u(0.6), color: 'var(--pv-muted)' }}
      >
        <span>连接范围只包含读取权限，不写入第三方数据。</span>
        <span style={{ color: 'var(--pv-accent)' }}>查看权限说明 →</span>
      </div>
    </div>
  );
}

function AnomalyBoard({ u }: { u: Unit }) {
  return (
    <div style={{ padding: u(1.8) }}>
      <BoardHeader title="转化率趋势" sub="按天 · 最近 14 天" u={u} />
      <div className="grid grid-cols-[1.5fr_1fr]" style={{ gap: u(1) }}>
        <div
          className="relative rounded-sm"
          style={{ border: '1px solid var(--pv-line)', background: 'rgba(255,255,255,.02)', padding: u(0.9), height: u(17) }}
        >
          <div className="flex items-baseline" style={{ gap: u(0.5) }}>
            <span className="font-display tabular" style={{ fontSize: u(2.1), color: '#F4F2EC' }}>
              2.42%
            </span>
            <span style={{ fontSize: u(0.65), color: '#5BD6A2' }}>+0.18</span>
          </div>
          <svg viewBox="0 0 300 110" className="absolute inset-x-0 bottom-0 w-full" style={{ height: '64%' }} aria-hidden>
            {[25, 50, 75].map((y) => (
              <line key={y} x1="10" x2="292" y1={y} y2={y} stroke="rgba(255,255,255,.07)" strokeWidth="0.7" />
            ))}
            <path
              d="M12 84 L38 78 L64 80 L90 66 L116 70 L142 58 L168 62 L194 48 L220 52 L246 36 L272 44 L290 38"
              fill="none"
              stroke="var(--pv-accent)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <circle cx="246" cy="36" r="3.5" fill="var(--pv-accent)" />
            <circle cx="246" cy="36" r="7" fill="none" stroke="rgba(255,255,255,.22)" />
          </svg>
          <div
            className="absolute rounded-sm"
            style={{
              left: '63%',
              top: '10%',
              background: 'rgba(240,184,96,.14)',
              border: '1px solid rgba(240,184,96,.3)',
              color: '#F0B860',
              padding: `${u(0.2)} ${u(0.5)}`,
              fontSize: u(0.55),
            }}
          >
            11-12 · +18%
          </div>
        </div>
        <div
          className="flex flex-col justify-between rounded-sm"
          style={{
            border: '1px solid rgba(240,184,96,.28)',
            background: 'rgba(240,184,96,.06)',
            padding: u(0.9),
          }}
        >
          <div>
            <div className="flex items-center" style={{ gap: u(0.35), color: '#F0B860', fontSize: u(0.68), fontWeight: 600 }}>
              <span
                className="rounded-full"
                style={{ width: u(0.45), height: u(0.45), background: '#F0B860' }}
              />
              AI 提示异常
            </div>
            <div style={{ marginTop: u(0.5), fontSize: u(0.68), lineHeight: 1.6, color: 'rgba(255,255,255,.75)' }}>
              11 月 12 日转化率出现异常上升，主要来自单一渠道。建议先核对归因，再决定是否写入周报。
            </div>
          </div>
          <div className="flex items-center justify-between" style={{ marginTop: u(0.7) }}>
            <span style={{ fontSize: u(0.56), color: 'rgba(255,255,255,.4)' }}>置信度 72% · 需人工确认</span>
            <span
              className="rounded-sm"
              style={{
                border: '1px solid rgba(255,255,255,.16)',
                padding: `${u(0.2)} ${u(0.5)}`,
                fontSize: u(0.56),
                color: 'rgba(255,255,255,.7)',
              }}
            >
              查看证据
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ThemeBoard({ u, project }: { u: Unit; project: Project }) {
  return (
    <div style={{ padding: u(1.8) }}>
      <BoardHeader title="外观设置" sub="按工作区保存偏好" u={u} />
      <div className="grid grid-cols-2" style={{ gap: u(0.9) }}>
        {[
          ['深色', '#0F1217', '#F4F2EC', true],
          ['浅色', '#F4F1E9', '#1C1B18', false],
        ].map(([name, bg, fg, selected]) => (
          <div
            key={String(name)}
            className="rounded-sm"
            style={{
              border: selected ? `1px solid ${project.brand.primary}` : '1px solid var(--pv-line)',
              padding: u(0.6),
            }}
          >
            <div
              className="flex flex-col justify-between rounded-sm"
              style={{ background: String(bg), padding: u(0.7), height: u(6.4) }}
            >
              <div className="flex items-center justify-between">
                <span style={{ width: u(2), height: u(0.35), background: String(fg), opacity: 0.8, borderRadius: 2 }} />
                <span
                  style={{
                    width: u(0.9),
                    height: u(0.9),
                    borderRadius: 999,
                    background: selected ? project.brand.primary : 'rgba(120,120,120,.35)',
                  }}
                />
              </div>
              <div className="flex" style={{ gap: u(0.3) }}>
                {[0.9, 0.65, 0.4].map((opacity, i) => (
                  <span
                    key={i}
                    style={{ width: u(2.5), height: u(0.3), background: String(fg), opacity, borderRadius: 2 }}
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between" style={{ marginTop: u(0.5) }}>
              <span style={{ fontSize: u(0.66), color: '#E8EBF0' }}>{name}</span>
              <span
                style={{
                  width: u(0.7),
                  height: u(0.7),
                  borderRadius: 999,
                  border: selected ? `2px solid ${project.brand.primary}` : '1px solid rgba(255,255,255,.2)',
                  background: selected ? project.brand.primary : 'transparent',
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div
        className="mt-3 flex items-center justify-between rounded-sm"
        style={{ border: '1px solid var(--pv-line)', padding: u(0.75), fontSize: u(0.62), color: 'rgba(255,255,255,.6)' }}
      >
        <span>跟随系统外观</span>
        <span
          className="rounded-full"
          style={{ width: u(1.6), height: u(0.85), background: 'rgba(255,255,255,.12)', padding: u(0.12) }}
        >
          <span
            style={{
              display: 'block',
              width: u(0.6),
              height: u(0.6),
              borderRadius: 999,
              background: '#fff',
            }}
          />
        </span>
      </div>
    </div>
  );
}

function DashboardBoard({
  u,
  project,
  title,
  feature,
}: {
  u: Unit;
  project: Project;
  title: string;
  feature?: Feature;
}) {
  return (
    <div style={{ padding: u(1.8) }}>
      <BoardHeader title={title} sub={feature?.summary ?? project.description} u={u} />
      <div className="grid grid-cols-3" style={{ gap: u(0.8) }}>
        <DemoStat label="活跃项目" value="24" hint="+6 本周" accent u={u} />
        <DemoStat label="待处理" value="12" hint="3 项高优" u={u} />
        <DemoStat label="团队完成率" value="86%" hint="过去 30 天" u={u} />
      </div>
      <div
        className="mt-3 rounded-sm"
        style={{ border: '1px solid var(--pv-line)', background: 'rgba(255,255,255,.02)', padding: u(0.9), height: u(12) }}
      >
        <div className="flex items-center justify-between">
          <span style={{ fontSize: u(0.72), color: '#E8EBF0' }}>项目活跃趋势</span>
          <span style={{ fontSize: u(0.58), color: 'var(--pv-muted)' }}>最近 14 天</span>
        </div>
        <div className="flex h-full items-end" style={{ gap: u(0.4), paddingTop: u(0.8) }}>
          {[34, 42, 38, 54, 46, 62, 58, 74, 68, 82, 76, 90, 84, 96].map((height, index) => (
            <div
              key={index}
              className="flex-1 rounded-t-[2px]"
              style={{
                height: `${height * 0.55}%`,
                background: index > 10 ? project.brand.primary : 'rgba(255,255,255,.13)',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MotionScreen({
  scene,
  project,
  feature,
  u,
  surface,
}: {
  scene: Scene;
  project: Project;
  feature?: Feature;
  u: Unit;
  surface: Surface;
}) {
  const paper = surface === 'paper';
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ padding: u(4.4) }}>
      <div className="dot-grid absolute inset-0 opacity-[0.35]" style={{ backgroundSize: `${u(2.2)} ${u(2.2)}` }} />
      <div
        className="absolute rounded-full"
        style={{
          width: u(38),
          height: u(38),
          right: u(-12),
          top: u(-14),
          background: `radial-gradient(circle at 40% 40%, ${withAlpha(project.brand.primary, 0.5)}, transparent 65%)`,
          filter: 'blur(4px)',
        }}
      />
      <div className="relative flex h-full flex-col justify-between">
        <div className="flex items-center justify-between">
          <BrandRow project={project} u={u} color={paper ? '#1A1915' : undefined} />
          <span className="font-mono uppercase" style={{ fontSize: u(0.75), letterSpacing: '.18em', color: 'var(--pv-muted)' }}>
            SIGNAL / MOTION
          </span>
        </div>
        <div className="relative grid grid-cols-[1.2fr_.8fr] items-center" style={{ gap: u(2) }}>
          <div>
            <div
              className="uppercase"
              style={{ fontSize: u(0.85), letterSpacing: '0.2em', color: 'var(--pv-accent)' }}
            >
              {feature?.name ?? scene.intent}
            </div>
            <h2
              className="mt-3 font-medium leading-[1.12] tracking-[-0.03em]"
              style={{ fontSize: u(4.4), fontFamily: fontStack(project.brand) }}
            >
              {scene.title}
            </h2>
            <p style={{ marginTop: u(1.2), fontSize: u(1.1), color: 'var(--pv-muted)', maxWidth: '88%' }}>
              {scene.narration}
            </p>
          </div>
          <div className="relative" style={{ height: u(20) }}>
            {[
              { top: '4%', left: '12%', rotate: '-6deg', label: '数据卡', value: '48,210' },
              { top: '34%', left: '38%', rotate: '3deg', label: '断开的连接', value: '— —' },
              { top: '64%', left: '8%', rotate: '-2deg', label: '待确认', value: '3 项' },
            ].map((card) => (
              <div
                key={card.label}
                className="absolute rounded-sm"
                style={{
                  top: card.top,
                  left: card.left,
                  transform: `rotate(${card.rotate})`,
                  width: '72%',
                  background: paper ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.05)',
                  border: '1px solid var(--pv-line)',
                  padding: u(0.8),
                  backdropFilter: 'blur(6px)',
                }}
              >
                <div style={{ fontSize: u(0.55), color: 'var(--pv-muted)' }}>{card.label}</div>
                <div className="font-mono" style={{ fontSize: u(0.95), color: 'var(--pv-fg)', marginTop: u(0.2) }}>
                  {card.value}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between" style={{ fontSize: u(0.78), color: 'var(--pv-muted)' }}>
          <span className="font-mono uppercase tracking-[0.16em]">{project.productName}</span>
          <span>模拟动效 · 不代表产品实际界面</span>
        </div>
      </div>
    </div>
  );
}

function GeneratedScreen({ scene, project, u }: { scene: Scene; project: Project; u: Unit }) {
  return (
    <div
      className="absolute inset-0"
      style={{
        background: `
          radial-gradient(48% 52% at 22% 30%, ${withAlpha(project.brand.primary, 0.75)}, transparent 70%),
          radial-gradient(44% 60% at 82% 74%, ${withAlpha(project.brand.secondary, 0.72)}, transparent 68%),
          radial-gradient(40% 40% at 62% 18%, rgba(110,72,220,.45), transparent 72%),
          #0A0B0F
        `,
      }}
    >
      <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,.2), rgba(0,0,0,.55))' }} />
      <div className="relative flex h-full flex-col justify-between" style={{ padding: u(4.6) }}>
        <div className="flex items-center justify-between">
          <BrandRow project={project} u={u} />
          <span className="font-mono uppercase" style={{ fontSize: u(0.72), letterSpacing: '.18em', color: 'rgba(255,255,255,.55)' }}>
            GENERATED / SIMULATED
          </span>
        </div>
        <div className="max-w-[72%]">
          <div style={{ fontSize: u(0.9), letterSpacing: '.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,.55)' }}>
            {project.brand.intro || 'Brand film'}
          </div>
          <h2
            className="mt-3 font-medium leading-[1.1] tracking-[-0.03em] text-[#FFFDF7]"
            style={{ fontSize: u(4.8), fontFamily: fontStack(project.brand) }}
          >
            {scene.title}
          </h2>
        </div>
        <div className="flex items-center justify-between" style={{ fontSize: u(0.75), color: 'rgba(255,255,255,.55)' }}>
          <span>生成画面仅作氛围，不证明任何产品能力</span>
          <span className="font-mono">{project.brand.logoText}</span>
        </div>
      </div>
    </div>
  );
}
