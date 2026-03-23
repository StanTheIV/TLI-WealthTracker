import {useTranslation} from 'react-i18next';
import type {DbSession} from '@/types/electron';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString('en', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatIncome(fe: number): string {
  return fe > 0 ? `${fe.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} FE` : '—';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  sessions:    DbSession[];
  selectedId:  string | null;
  itemPrices:  Record<string, number>; // itemId → price per unit
  onSelect:    (id: string) => void;
}

export default function SessionsTable({sessions, selectedId, itemPrices, onSelect}: Props) {
  const {t} = useTranslation('sessions');

  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 py-12 text-sm text-text-disabled">
        {t('empty')}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 bg-surface z-10">
          <tr className="border-b border-border text-left text-xs text-text-secondary uppercase tracking-wide">
            <th className="px-4 py-2 font-semibold">{t('columns.name')}</th>
            <th className="px-4 py-2 font-semibold">{t('columns.date')}</th>
            <th className="px-4 py-2 font-semibold text-right">{t('columns.duration')}</th>
            <th className="px-4 py-2 font-semibold text-right">{t('columns.maps')}</th>
            <th className="px-4 py-2 font-semibold text-right">{t('columns.income')}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(session => {
            const income = Object.entries(session.drops).reduce((sum, [id, qty]) => {
              return sum + qty * (itemPrices[id] ?? 0);
            }, 0);
            const isSelected = session.id === selectedId;

            return (
              <tr
                key={session.id}
                onClick={() => onSelect(session.id)}
                className={[
                  'border-b border-border/50 cursor-pointer transition-colors',
                  isSelected
                    ? 'bg-accent/10 text-text-primary'
                    : 'hover:bg-white/5 text-text-primary',
                ].join(' ')}
              >
                <td className="px-4 py-2.5 font-medium truncate max-w-[200px]">
                  {isSelected && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent mr-2 align-middle" />
                  )}
                  {session.name}
                </td>
                <td className="px-4 py-2.5 text-text-secondary text-xs">
                  {formatDate(session.savedAt)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">
                  {formatDuration(session.totalTime)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">
                  {session.mapCount}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-medium text-accent">
                  {formatIncome(income)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export {formatDate, formatDuration, formatIncome};
