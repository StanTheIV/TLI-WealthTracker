import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useItemsStore} from '@/state/itemsStore';
import {useTaxConfig} from '@/state/settingsStore';
import {makePriceLookup, valueItem, type PriceLookup} from '@/domain/valuation';
import type {DbItem} from '@/shared/contracts/db';

interface DropTableProps {
  drops: Record<number, number>;
  /** Entry materials the tracker consumed. Listed after the loot as negatives. */
  spent: Record<number, number>;
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

/** Live leg of the analytics rule. `sign` flips spent rows to read as what they
 *  cost: a negative quantity and total. Unit price and total come from the same
 *  taxed lookup, so the row never reads as broken arithmetic (10 FE x 10 = 85 FE). */
function toRows(qty: Record<number, number>, items: Record<string, DbItem>, prices: PriceLookup, sign: 1 | -1): DropRow[] {
  return Object.entries(qty)
    .filter(([, q]) => q !== 0)
    .map(([id, q]) => ({
      id,
      name:       items[id]?.name || `#${id}`,
      unitPrice:  prices.live(id),
      quantity:   sign * q,
      totalValue: sign * valueItem(prices, id, q).live,
    }))
    .sort((a, b) => Math.abs(b.totalValue) - Math.abs(a.totalValue));
}

const HEADER_CELL = 'text-[11px] font-semibold uppercase tracking-widest text-text-disabled';

function Rows({rows}: {rows: DropRow[]}) {
  return (
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
  );
}

export default function DropTable({drops, spent}: DropTableProps) {
  const {t}   = useTranslation('tracker');
  const items = useItemsStore(s => s.items);
  const tax   = useTaxConfig();

  const {loot, cost} = useMemo(() => {
    const prices = makePriceLookup(items, null, tax);
    return {loot: toRows(drops, items, prices, 1), cost: toRows(spent, items, prices, -1)};
  }, [drops, spent, items, tax]);

  if (loot.length === 0 && cost.length === 0) {
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
        <span className={`${HEADER_CELL} flex-1`}>
          {t('table.name')}
        </span>
        <span className={`${HEADER_CELL} w-16 text-right shrink-0`}>
          {t('table.price')}
        </span>
        <span className={`${HEADER_CELL} w-12 text-right shrink-0`}>
          {t('table.amount')}
        </span>
        <span className={`${HEADER_CELL} w-20 text-right shrink-0`}>
          {t('table.total')}
        </span>
      </div>

      <Rows rows={loot} />

      {/* Spent — the entry materials the Total/Map net already subtracts */}
      {cost.length > 0 && (
        <>
          <div className={`${HEADER_CELL} px-1 pt-2 pb-1.5 mt-1 border-b border-border`}>
            {t('table.spent')}
          </div>
          <Rows rows={cost} />
        </>
      )}
    </div>
  );
}
