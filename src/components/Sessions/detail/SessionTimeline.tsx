import {useTranslation} from 'react-i18next';
import {useTheme} from '@/theme/ThemeContext';
import type {SessionAnalytics, TimelineSegment} from '../analytics';
import {mechanicColors} from './colors';
import {Swatch} from './primitives';
import {formatFEFull, formatSeconds, pick, type ValueMode} from './format';

/** Minimum flex weight so a very short run stays visible and hoverable. */
const MIN_WEIGHT = 0.35;

export default function SessionTimeline({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t}    = useTranslation('sessions');
  const theme  = useTheme();
  const colors = mechanicColors(theme);
  const {timeline} = analytics;

  if (timeline.length === 0) {
    return (
      <div className="flex items-center justify-center h-28 rounded-lg border border-border bg-surface text-xs text-text-disabled px-6 text-center">
        {t('details.timelineEmpty')}
      </div>
    );
  }

  const label = (s: TimelineSegment) =>
    `${t(`details.source.${s.mechanic}` as never)} #${s.mapIndex} · ${formatSeconds(s.seconds)} · ${formatFEFull(pick(s.income, mode))} FE`;

  const legendKeys = [...new Set(timeline.flatMap(s => [s.mechanic, ...s.children.map(c => c.mechanic)]))];

  return (
    <div className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="overflow-x-auto">
        <div className="min-w-[720px] flex flex-col gap-1">
          {/* Mechanic lane — children sit above their parent run. */}
          <div className="flex h-3.5 gap-px">
            {timeline.map(seg => {
              const childTotal = seg.children.reduce((sum, c) => sum + c.seconds, 0);
              const rest = Math.max(0, seg.seconds - childTotal);
              return (
                <div key={seg.key} className="flex gap-px" style={{flex: Math.max(MIN_WEIGHT, seg.seconds)}}>
                  {seg.children.map(child => (
                    <div
                      key={child.key}
                      title={label(child)}
                      className="rounded-sm"
                      style={{flex: Math.max(MIN_WEIGHT, child.seconds), backgroundColor: colors[child.mechanic]}}
                    />
                  ))}
                  {rest > 0 && <div style={{flex: rest}} />}
                </div>
              );
            })}
          </div>

          {/* Run lane. */}
          <div className="flex h-6 gap-px">
            {timeline.map(seg => (
              <div
                key={seg.key}
                title={label(seg)}
                className="rounded-sm"
                style={{flex: Math.max(MIN_WEIGHT, seg.seconds), backgroundColor: colors[seg.mechanic]}}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-text-secondary">
        {legendKeys.map(key => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <Swatch color={colors[key]} />
            {t(`details.source.${key}` as never)}
          </span>
        ))}
      </div>
    </div>
  );
}
