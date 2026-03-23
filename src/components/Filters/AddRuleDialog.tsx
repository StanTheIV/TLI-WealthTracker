import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {X} from 'lucide-react';
import {ITEM_TYPE_CONFIG, ITEM_TYPES} from '@/types/itemType';
import {FILTER_SCOPES} from '@/types/itemFilter';
import type {FilterRule, FilterScope, RuleAction, RuleKind} from '@/types/itemFilter';
import {useItemsStore} from '@/state/itemsStore';

interface Props {
  onConfirm: (rule: FilterRule) => void;
  onClose:   () => void;
}

// ---------------------------------------------------------------------------
// Item typeahead
// ---------------------------------------------------------------------------

function ItemSearch({onSelect}: {onSelect: (id: string, name: string) => void}) {
  const {t}   = useTranslation('filters');
  const items = useItemsStore(s => s.items);
  const [query, setQuery]   = useState('');
  const [open,  setOpen]    = useState(false);

  const q = query.trim().toLowerCase();
  const results = q.length >= 1
    ? Object.values(items)
        .filter(i => i.name.toLowerCase().includes(q) || i.id.includes(q))
        .slice(0, 10)
    : [];

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={t('itemSearch.placeholder')}
        className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled outline-none focus:border-accent/50 transition-colors"
      />
      {open && results.length > 0 && (
        <div className="absolute z-50 top-full mt-1 w-full bg-surface-elevated border border-border rounded-lg shadow-lg overflow-hidden">
          {results.map(item => (
            <button
              key={item.id}
              onMouseDown={() => {
                onSelect(item.id, item.name || item.id);
                setQuery(item.name || item.id);
                setOpen(false);
              }}
              className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/10 transition-colors text-left"
            >
              <span className="text-text-primary truncate">{item.name || <span className="text-text-disabled italic">#{item.id}</span>}</span>
              <span className="text-text-disabled text-xs ml-2 shrink-0">#{item.id}</span>
            </button>
          ))}
        </div>
      )}
      {open && q.length >= 1 && results.length === 0 && (
        <div className="absolute z-50 top-full mt-1 w-full bg-surface-elevated border border-border rounded-lg shadow-lg px-3 py-2 text-sm text-text-disabled">
          {t('itemSearch.noResults')}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export default function AddRuleDialog({onConfirm, onClose}: Props) {
  const {t}      = useTranslation('filters');
  const tItems   = useTranslation('items').t;

  const [action,    setAction]    = useState<RuleAction>('hide');
  const [matchType, setMatchType] = useState<'by-type' | 'by-item'>('by-type');
  const [itemType,  setItemType]  = useState<string>(ITEM_TYPES[0]);
  const [itemId,    setItemId]    = useState<string>('');
  const [itemName,  setItemName]  = useState<string>('');
  const [scopes,    setScopes]    = useState<FilterScope[]>([...FILTER_SCOPES]);

  const toggleScope = (s: FilterScope) => {
    setScopes(prev =>
      prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
    );
  };

  const toggleAllScopes = () => {
    setScopes(scopes.length === FILTER_SCOPES.length ? [] : [...FILTER_SCOPES]);
  };

  const canConfirm = scopes.length > 0 && (matchType === 'by-type' || itemId !== '');

  const handleConfirm = () => {
    if (!canConfirm) return;
    const kind: RuleKind = matchType === 'by-type'
      ? {type: 'by-type', itemType: itemType as never}
      : {type: 'by-item', itemId};
    onConfirm({id: crypto.randomUUID(), action, kind, scopes});
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-bold text-text-primary">{t('addRule.title')}</h2>
          <button onClick={onClose} className="text-text-disabled hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          {/* Step 1: Action */}
          <div>
            <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-2">
              {t('addRule.action')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(['show', 'hide'] as RuleAction[]).map(a => (
                <button
                  key={a}
                  onClick={() => setAction(a)}
                  className={[
                    'flex flex-col items-start px-4 py-3 rounded-lg border text-sm transition-colors',
                    action === a
                      ? a === 'show'
                        ? 'bg-green-500/10 border-green-500/50 text-green-400'
                        : 'bg-red-500/10 border-red-500/50 text-red-400'
                      : 'bg-surface-elevated border-border text-text-secondary hover:border-accent/50',
                  ].join(' ')}
                >
                  <span className="font-semibold">{t(`action.${a}`)}</span>
                  <span className="text-xs opacity-70 mt-0.5">{t(`action.${a}Desc`)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: Match by */}
          <div>
            <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-2">
              {t('addRule.matchBy')}
            </p>
            <div className="flex gap-2 mb-3">
              {(['by-type', 'by-item'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMatchType(m)}
                  className={[
                    'px-3 py-1.5 rounded-lg border text-sm transition-colors',
                    matchType === m
                      ? 'bg-accent/15 border-accent text-accent font-semibold'
                      : 'bg-surface-elevated border-border text-text-secondary hover:border-accent/50',
                  ].join(' ')}
                >
                  {t(`matchBy.${m === 'by-type' ? 'byType' : 'byItem'}`)}
                </button>
              ))}
            </div>

            {matchType === 'by-type' ? (
              <div className="grid grid-cols-3 gap-1.5">
                {ITEM_TYPES.map(type => (
                  <button
                    key={type}
                    onClick={() => setItemType(type)}
                    className={[
                      'px-2 py-1.5 rounded-md border text-xs transition-colors',
                      itemType === type
                        ? 'bg-accent/15 border-accent text-accent font-semibold'
                        : 'bg-surface-elevated border-border text-text-secondary hover:border-accent/50',
                    ].join(' ')}
                  >
                    {tItems(`types.${type}` as never)}
                  </button>
                ))}
              </div>
            ) : (
              <ItemSearch
                onSelect={(id, name) => { setItemId(id); setItemName(name); }}
              />
            )}
          </div>

          {/* Step 3: Scopes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest">
                {t('addRule.scopes')}
              </p>
              <button
                onClick={toggleAllScopes}
                className="text-xs text-accent hover:underline"
              >
                {t('addRule.allScopes')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FILTER_SCOPES.map(s => (
                <button
                  key={s}
                  onClick={() => toggleScope(s)}
                  className={[
                    'px-2.5 py-1 rounded-full border text-xs font-medium transition-colors',
                    scopes.includes(s)
                      ? 'bg-accent/15 border-accent text-accent'
                      : 'bg-surface-elevated border-border text-text-secondary hover:border-accent/50',
                  ].join(' ')}
                >
                  {t(`scopes.${s}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg border border-border text-sm text-text-secondary hover:bg-white/5 transition-colors"
          >
            {t('addRule.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex-1 px-4 py-2 rounded-lg bg-accent text-bg text-sm font-semibold hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('addRule.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
