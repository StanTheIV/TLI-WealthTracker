import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {AlertTriangle, X} from 'lucide-react';
import type {AnalyticsWarning} from '../analytics';

/** Turn a warning's payload into i18n interpolation values, rounding the
 *  numeric fields so the message doesn't render raw floats. */
function paramsOf(w: AnalyticsWarning): Record<string, string | number> {
  switch (w.code) {
    case 'time-reconciliation':     return {seconds: Math.round(w.residualSeconds)};
    case 'map-count-mismatch':      return {mapCount: w.mapCount, rows: w.rows};
    case 'orphan-overlap-row':      return {mapIndex: w.mapIndex};
    case 'overlap-exceeds-parent':  return {mapIndex: w.mapIndex};
    case 'nested-exceeds-map-time': return {
      nestedSeconds: Math.round(w.nestedSeconds),
      mapSeconds:    Math.round(w.mapSeconds),
    };
    case 'unknown-seasonal-type':   return {mapIndex: w.mapIndex};
  }
}

export default function DataNotes({warnings}: {warnings: AnalyticsWarning[]}) {
  const {t} = useTranslation('sessions');
  const [dismissed, setDismissed] = useState(false);

  // Repeated per-row warnings would flood the panel; one line per kind is enough
  // to tell the user what to distrust.
  const unique = new Map<string, AnalyticsWarning>();
  for (const w of warnings) if (!unique.has(w.code)) unique.set(w.code, w);

  if (dismissed || unique.size === 0) return null;

  return (
    <div className="rounded-lg border border-gold/30 bg-gold/5 px-4 py-3 flex gap-3">
      <AlertTriangle className="w-4 h-4 text-gold shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gold">
          {t('details.warningsTitle')}
        </span>
        {[...unique.values()].map(w => (
          <p key={w.code} className="text-[11px] text-text-secondary leading-relaxed">
            {t(`details.warning.${w.code}` as never, paramsOf(w)) as unknown as string}
          </p>
        ))}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 text-text-disabled hover:text-text-primary transition-colors self-start"
        aria-label={t('details.warningsTitle')}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
