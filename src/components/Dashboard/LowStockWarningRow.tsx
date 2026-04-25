import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {AlertTriangle, ChevronDown, X} from 'lucide-react';
import {useEngineStore, type LowStockWarning} from '@/state/engineStore';
import {useItemsStore} from '@/state/itemsStore';

interface Props {
  warnings: LowStockWarning[];
}

export default function LowStockWarningRow({warnings}: Props) {
  const {t} = useTranslation('tracker');
  const items   = useItemsStore(s => s.items);
  const dismiss = useEngineStore(s => s.dismissLowStockItem);

  const [expanded, setExpanded] = useState(true);

  const count = warnings.length;
  const header =
    count === 1
      ? t('lowStock.singular')
      : t('lowStock.plural', {count});

  const nameFor = (itemId: number): string => {
    const item = items[String(itemId)];
    return item?.name || `#${itemId}`;
  };

  return (
    <div
      className="relative flex flex-col rounded-md overflow-hidden"
      style={{
        backgroundColor: 'rgba(17,17,40,var(--card-opacity,1))',
        animation: 'tracker-warning-pulse 1.2s ease-in-out infinite',
      }}
    >
      <div className="flex items-stretch">
        <div className="w-1 shrink-0 bg-danger" />

        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="flex items-center flex-1 min-w-0 px-3 py-2 gap-2 text-left hover:bg-white/3 transition-colors"
          aria-label={expanded ? t('lowStock.collapse') : t('lowStock.expand')}
        >
          <AlertTriangle className="w-4 h-4 text-danger shrink-0" />
          <span className="text-[13px] font-semibold uppercase tracking-wider text-text-primary leading-none">
            {header}
          </span>
          <ChevronDown
            className={`ml-auto w-3.5 h-3.5 text-text-secondary transition-transform duration-200 ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </button>
      </div>

      {expanded && (
        <ul className="flex flex-col border-t border-border/50 mx-2 mb-1">
          {warnings.map(w => (
            <li
              key={w.itemId}
              className="flex items-center gap-2 py-1 px-1 text-[12px]"
            >
              <span className="flex-1 min-w-0 truncate text-text-primary">
                {nameFor(w.itemId)}
              </span>
              <span className="font-mono tabular-nums text-danger shrink-0">
                {t('lowStock.remaining', {count: w.quantity})}
              </span>
              <button
                type="button"
                onClick={() => dismiss(w.itemId)}
                className="p-0.5 rounded hover:bg-white/8 text-text-secondary hover:text-text-primary transition-colors"
                aria-label={t('lowStock.dismiss')}
                title={t('lowStock.dismiss')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
