import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useItemsStore} from '@/state/itemsStore';

interface DropTableProps {
  drops: Record<number, number>;
}

interface DropRow {
  id:         string;
  name:       string;
  unitPrice:  number;
  quantity:   number;
  totalValue: number;
}

function feClass(value: number): string {
  return value < 0 ? 'text-danger' : 'text-gold';
}

function formatFE(value: number): string {
  const abs  = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  return `${sign}${abs.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}

export default function DropTable({drops}: DropTableProps) {
  const {t}   = useTranslation('tracker');
  const items = useItemsStore(s => s.items);

  const rows = useMemo<DropRow[]>(() => {
    return Object.entries(drops)
      .map(([idStr, qty]) => {
        const item = items[idStr];
        const unitPrice = item?.price ?? 0;
        return {
          id:         idStr,
          name:       item?.name || `#${idStr}`,
          unitPrice,
          quantity:   qty,
          totalValue: qty * unitPrice,
        };
      })
      .filter(r => r.quantity !== 0)
      .sort((a, b) => Math.abs(b.totalValue) - Math.abs(a.totalValue));
  }, [drops, items]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-xs text-text-disabled">
        {t('noDrops')}
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-1 pb-1.5 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-text-disabled flex-1">
          {t('table.name')}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-text-disabled w-16 text-right shrink-0">
          {t('table.price')}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-text-disabled w-12 text-right shrink-0">
          {t('table.amount')}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-text-disabled w-20 text-right shrink-0">
          {t('table.total')}
        </span>
      </div>

      {/* Rows */}
      <div className="space-y-0.5 pt-1">
        {rows.map(row => (
          <div key={row.id} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/3">
            <span className="text-sm text-text-primary truncate flex-1">
              {row.name}
            </span>
            <span className="font-mono text-xs text-text-secondary w-16 text-right shrink-0 tabular-nums">
              {row.unitPrice.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </span>
            <span className={`font-mono text-xs w-12 text-right shrink-0 tabular-nums ${row.quantity < 0 ? 'text-danger' : 'text-text-primary'}`}>
              {row.quantity > 0 ? '+' : ''}{row.quantity}
            </span>
            <span className={`font-mono text-xs w-20 text-right shrink-0 tabular-nums ${feClass(row.totalValue)}`}>
              {formatFE(row.totalValue)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
