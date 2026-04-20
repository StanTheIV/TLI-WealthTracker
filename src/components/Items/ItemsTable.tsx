import {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Search, Loader2, Check, X} from 'lucide-react';
import {useItemsStore} from '@/state/itemsStore';
import type {DbItem} from '@/types/electron';
import {ITEM_TYPES, type ItemType} from '@/types/itemType';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortField = 'id' | 'name' | 'type' | 'price' | 'priceDate';
type SortDir   = 'asc' | 'desc';

interface EditingCell {
  id:    string;
  field: 'name' | 'price';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
}

function sortRows(rows: DbItem[], field: SortField, dir: SortDir): DbItem[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (field === 'id')        cmp = Number(a.id) - Number(b.id);
    if (field === 'name')      cmp = a.name.localeCompare(b.name);
    if (field === 'type')      cmp = a.type.localeCompare(b.type);
    if (field === 'price')     cmp = a.price - b.price;
    if (field === 'priceDate') cmp = a.priceDate - b.priceDate;
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------------------
// Column header
// ---------------------------------------------------------------------------

function ColHeader({label, field, sortField, sortDir, onSort}: {
  label:     string;
  field:     SortField;
  sortField: SortField;
  sortDir:   SortDir;
  onSort:    (f: SortField) => void;
}) {
  const active = sortField === field;
  return (
    <button
      onClick={() => onSort(field)}
      className="flex items-center gap-0.5 text-[11px] font-semibold uppercase tracking-widest text-text-disabled hover:text-text-secondary transition-colors"
    >
      {label}
      {active && <span className="text-[9px]">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  rows:             DbItem[];
  focusItemId?:     string | null;
  onFocusConsumed?: () => void;
}

type LookupStatus = 'idle' | 'loading' | 'found' | 'not_found' | 'error';

export default function ItemsTable({rows, focusItemId = null, onFocusConsumed}: Props) {
  const {t}           = useTranslation('items');
  const setName       = useItemsStore(s => s.setName);
  const setType       = useItemsStore(s => s.setType);
  const setPrice      = useItemsStore(s => s.setPrice);
  const lookupName    = useItemsStore(s => s.lookupName);
  const lookupsToday  = useItemsStore(s => s.lookupsToday);

  const [sortField, setSortField] = useState<SortField>('id');
  const [sortDir,   setSortDir]   = useState<SortDir>('asc');
  const [editing,   setEditing]   = useState<EditingCell | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [lookupStatus, setLookupStatus] = useState<Record<string, LookupStatus>>({});
  const [flashId, setFlashId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs  = useRef<Record<string, HTMLDivElement | null>>({});

  // Scroll the requested row into view and briefly flash it.
  useEffect(() => {
    if (!focusItemId) return;
    const el = rowRefs.current[focusItemId];
    if (!el) return;
    el.scrollIntoView({behavior: 'smooth', block: 'center'});
    setFlashId(focusItemId);
    const flashTimer = setTimeout(() => setFlashId(null), 1600);
    onFocusConsumed?.();
    return () => clearTimeout(flashTimer);
  }, [focusItemId, onFocusConsumed]);

  async function handleLookup(item: DbItem) {
    setLookupStatus(s => ({...s, [item.id]: 'loading'}));
    const result = await lookupName(item.id);
    if (result.error === 'limit_reached' || result.error === 'no_api_key') {
      setLookupStatus(s => ({...s, [item.id]: 'error'}));
    } else if (result.error) {
      setLookupStatus(s => ({...s, [item.id]: 'error'}));
    } else if (result.name) {
      setLookupStatus(s => ({...s, [item.id]: 'found'}));
    } else {
      setLookupStatus(s => ({...s, [item.id]: 'not_found'}));
    }
  }

  const sorted = sortRows(rows, sortField, sortDir);

  function handleSort(field: SortField) {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  }

  function startEdit(item: DbItem, field: 'name' | 'price') {
    setEditing({id: item.id, field});
    setDraftValue(field === 'price' ? String(item.price) : item.name);
    // Focus input on next tick
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commitEdit() {
    if (!editing) return;
    if (editing.field === 'name') {
      setName(editing.id, draftValue.trim());
    } else {
      const price = parseFloat(draftValue);
      if (!isNaN(price)) setPrice(editing.id, price);
    }
    setEditing(null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter')  commitEdit();
    if (e.key === 'Escape') setEditing(null);
  }

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-1 pb-1.5 border-b border-border">
        <div className="w-14 shrink-0">
          <ColHeader label={t('columns.id')} field="id" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
        </div>
        <div className="flex-1 min-w-0">
          <ColHeader label={t('columns.name')} field="name" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
        </div>
        <div className="w-28 shrink-0">
          <ColHeader label={t('columns.type')} field="type" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
        </div>
        <div className="w-24 shrink-0 text-right">
          <ColHeader label={t('columns.price')} field="price" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
        </div>
        <div className="w-32 shrink-0">
          <ColHeader label={t('columns.priceDate')} field="priceDate" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
        </div>
      </div>

      {/* Rows */}
      <div className="space-y-0.5 pt-1">
        {sorted.map(item => {
          const isEditingName  = editing?.id === item.id && editing.field === 'name';
          const isEditingPrice = editing?.id === item.id && editing.field === 'price';

          const isFlashing = flashId === item.id;

          return (
            <div
              key={item.id}
              ref={(el) => { rowRefs.current[item.id] = el; }}
              className={[
                'flex items-center gap-2 px-1 py-0.5 rounded transition-colors',
                isFlashing ? 'bg-accent/20' : 'hover:bg-white/3',
              ].join(' ')}
            >
              {/* ID */}
              <span className="font-mono text-xs text-text-disabled w-14 shrink-0 tabular-nums">
                {item.id}
              </span>

              {/* Name — editable + lookup button */}
              <div className="flex-1 min-w-0 flex items-center gap-1">
                <div className="flex-1 min-w-0">
                  {isEditingName ? (
                    <input
                      ref={inputRef}
                      value={draftValue}
                      onChange={e => setDraftValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={handleKeyDown}
                      className="w-full bg-surface-elevated border border-accent/50 rounded px-1.5 py-px text-sm text-text-primary outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => startEdit(item, 'name')}
                      className="w-full text-left text-sm text-text-primary truncate hover:text-accent transition-colors"
                      title={item.name || `#${item.id}`}
                    >
                      {item.name || <span className="text-text-disabled italic">#{item.id}</span>}
                    </button>
                  )}
                </div>
                {/* Lookup button */}
                {(() => {
                  const status = lookupStatus[item.id] ?? 'idle';
                  const atLimit = lookupsToday >= 500;
                  const title = atLimit
                    ? t('lookup.limitReached', {used: lookupsToday, max: 500})
                    : t('lookup.button');
                  return (
                    <button
                      onClick={() => handleLookup(item)}
                      disabled={status === 'loading' || atLimit}
                      title={title}
                      className="shrink-0 p-0.5 rounded text-text-disabled hover:text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {status === 'loading'   && <Loader2 className="w-3 h-3 animate-spin" />}
                      {status === 'found'     && <Check   className="w-3 h-3 text-green-400" />}
                      {status === 'not_found' && <X       className="w-3 h-3 text-text-disabled" />}
                      {status === 'error'     && <X       className="w-3 h-3 text-red-400" />}
                      {status === 'idle'      && <Search  className="w-3 h-3" />}
                    </button>
                  );
                })()}
              </div>

              {/* Type — dropdown */}
              <div className="w-28 shrink-0">
                <select
                  value={item.type}
                  onChange={e => setType(item.id, e.target.value)}
                  className="w-full bg-surface-elevated border border-border rounded px-1.5 py-px text-xs text-text-secondary outline-none hover:border-accent/50 transition-colors cursor-pointer"
                >
                  {ITEM_TYPES.map(type => (
                    <option key={type} value={type}>
                      {t(`types.${type}` as never)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Price — editable */}
              <div className="w-24 shrink-0 text-right">
                {isEditingPrice ? (
                  <input
                    ref={inputRef}
                    value={draftValue}
                    onChange={e => setDraftValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={handleKeyDown}
                    type="number"
                    step="any"
                    className="w-full bg-surface-elevated border border-accent/50 rounded px-1.5 py-px text-xs text-right font-mono text-text-primary outline-none tabular-nums"
                  />
                ) : (
                  <button
                    onClick={() => startEdit(item, 'price')}
                    className={[
                      'w-full text-right font-mono text-xs tabular-nums hover:text-accent transition-colors',
                      item.price === 0 ? 'text-text-disabled' : 'text-text-secondary',
                    ].join(' ')}
                  >
                    {item.price === 0 ? '—' : item.price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                  </button>
                )}
              </div>

              {/* Price date */}
              <span className="text-xs text-text-disabled w-32 shrink-0 truncate tabular-nums">
                {formatDate(item.priceDate)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
