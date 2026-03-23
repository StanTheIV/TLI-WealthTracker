import {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Plus, ToggleLeft, ToggleRight, Pencil, Trash2, Info} from 'lucide-react';
import {useFilterStore} from '@/state/filterStore';
import type {ItemFilter, FilterRule} from '@/types/itemFilter';
import RuleCard from './RuleCard';
import AddRuleDialog from './AddRuleDialog';

// ---------------------------------------------------------------------------
// Left panel: filter list
// ---------------------------------------------------------------------------

interface FilterListProps {
  filters:    ItemFilter[];
  selectedId: string | null;
  onSelect:   (id: string) => void;
  onCreate:   () => void;
}

function FilterList({filters, selectedId, onSelect, onCreate}: FilterListProps) {
  const {t}           = useTranslation('filters');
  const enableFilter  = useFilterStore(s => s.enableFilter);
  const disableFilter = useFilterStore(s => s.disableFilter);
  const deleteFilter  = useFilterStore(s => s.deleteFilter);
  const renameFilter  = useFilterStore(s => s.renameFilter);

  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = (e: React.MouseEvent, filter: ItemFilter) => {
    e.stopPropagation();
    setEditingId(filter.id);
    setEditingName(filter.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitEdit = () => {
    if (editingId && editingName.trim()) {
      renameFilter(editingId, editingName.trim());
    }
    setEditingId(null);
  };

  const handleToggle = (e: React.MouseEvent, filter: ItemFilter) => {
    e.stopPropagation();
    if (filter.enabled) disableFilter(filter.id);
    else                enableFilter(filter.id);
  };

  const handleDelete = (e: React.MouseEvent, filter: ItemFilter) => {
    e.stopPropagation();
    if (window.confirm(t('confirmDelete', {name: filter.name}))) {
      deleteFilter(filter.id);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-border shrink-0">
        <button
          onClick={onCreate}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-semibold hover:bg-accent/20 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('newFilter')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {filters.length === 0 ? (
          <p className="px-4 py-3 text-xs text-text-disabled">{t('noFilters')}</p>
        ) : (
          filters.map(filter => (
            <div
              key={filter.id}
              onClick={() => { if (editingId !== filter.id) onSelect(filter.id); }}
              className={[
                'w-full flex items-center gap-2 px-4 py-3 text-left transition-colors group cursor-pointer',
                selectedId === filter.id
                  ? 'bg-accent/10 text-text-primary'
                  : 'text-text-secondary hover:bg-white/5',
              ].join(' ')}
            >
              {/* Enable toggle */}
              <button
                onClick={e => handleToggle(e, filter)}
                className={filter.enabled ? 'text-accent' : 'text-text-disabled hover:text-text-secondary'}
                title={filter.enabled ? t('disable') : t('enable')}
              >
                {filter.enabled
                  ? <ToggleRight className="w-4 h-4" />
                  : <ToggleLeft  className="w-4 h-4" />
                }
              </button>

              {/* Name — inline editable */}
              {editingId === filter.id ? (
                <input
                  ref={inputRef}
                  value={editingName}
                  onChange={e => setEditingName(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={e => {
                    if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); }
                    if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null); }
                  }}
                  onClick={e => e.stopPropagation()}
                  className="flex-1 bg-bg border border-accent/50 rounded px-1.5 py-0.5 text-sm text-text-primary outline-none min-w-0"
                  autoFocus
                />
              ) : (
                <span className="flex-1 text-sm font-medium truncate">{filter.name}</span>
              )}

              {/* Active badge */}
              {filter.enabled && editingId !== filter.id && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-accent/15 text-accent uppercase tracking-wide shrink-0">
                  {t('active')}
                </span>
              )}

              {/* Actions (visible on hover or selected) */}
              {editingId !== filter.id && (
                <div className={[
                  'flex items-center gap-1',
                  selectedId === filter.id ? 'flex' : 'hidden group-hover:flex',
                ].join(' ')}>
                  <button
                    onClick={e => startEditing(e, filter)}
                    className="text-text-disabled hover:text-text-primary transition-colors p-0.5"
                    title={t('rename')}
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={e => handleDelete(e, filter)}
                    className="text-text-disabled hover:text-danger transition-colors p-0.5"
                    title={t('delete')}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right panel: rule editor
// ---------------------------------------------------------------------------

interface RuleEditorProps {
  filter: ItemFilter | null;
}

function RuleEditor({filter}: RuleEditorProps) {
  const {t}           = useTranslation('filters');
  const addRule       = useFilterStore(s => s.addRule);
  const removeRule    = useFilterStore(s => s.removeRule);
  const reorderRules  = useFilterStore(s => s.reorderRules);
  const enableFilter  = useFilterStore(s => s.enableFilter);
  const disableFilter = useFilterStore(s => s.disableFilter);

  const [showDialog, setShowDialog] = useState(false);

  // ---- drag-and-drop state ----
  const [dragIndex, setDragIndex]   = useState<number | null>(null);
  const [overIndex, setOverIndex]   = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);

  if (!filter) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-text-disabled px-6 text-center">
        Select a filter to edit its rules.
      </div>
    );
  }

  const handleAddRule = (rule: FilterRule) => {
    addRule(filter.id, rule);
    setShowDialog(false);
  };

  // Native HTML5 drag-and-drop for rule reordering
  const handleDragStart = (index: number) => {
    dragItem.current = index;
    setDragIndex(index);
  };

  const handleDragEnter = (index: number) => {
    setOverIndex(index);
  };

  const handleDragEnd = () => {
    if (dragItem.current !== null && overIndex !== null && dragItem.current !== overIndex) {
      const newOrder = [...filter.rules];
      const [moved]  = newOrder.splice(dragItem.current, 1);
      newOrder.splice(overIndex, 0, moved);
      reorderRules(filter.id, newOrder.map(r => r.id));
    }
    dragItem.current = null;
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border shrink-0 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-base font-bold text-text-primary truncate">{filter.name}</h2>
          {filter.enabled && (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-accent/15 text-accent uppercase tracking-wide shrink-0">
              {t('active')}
            </span>
          )}
        </div>
        <button
          onClick={() => filter.enabled ? disableFilter(filter.id) : enableFilter(filter.id)}
          className={[
            'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors',
            filter.enabled
              ? 'bg-accent/10 border-accent/30 text-accent hover:bg-accent/20'
              : 'bg-surface-elevated border-border text-text-secondary hover:border-accent/50',
          ].join(' ')}
        >
          {filter.enabled
            ? <><ToggleRight className="w-3.5 h-3.5" />{t('disable')}</>
            : <><ToggleLeft  className="w-3.5 h-3.5" />{t('enable')}</>
          }
        </button>
      </div>

      {/* Rules section */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Section heading */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest">
            {t('rules.heading')}
          </p>
          <button
            onClick={() => setShowDialog(true)}
            className="flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <Plus className="w-3 h-3" />
            {t('rules.add')}
          </button>
        </div>

        {/* Fallthrough hint */}
        <div className="flex items-start gap-2 bg-surface-elevated border border-border rounded-lg px-3 py-2 mb-4">
          <Info className="w-3.5 h-3.5 text-text-disabled mt-0.5 shrink-0" />
          <p className="text-xs text-text-disabled">{t('rules.firstWins')}</p>
        </div>

        {/* Rule list */}
        {filter.rules.length === 0 ? (
          <p className="text-sm text-text-disabled py-2">{t('noRules')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {filter.rules.map((rule, index) => (
              <div
                key={rule.id}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragOver={e => e.preventDefault()}
                onDragEnd={handleDragEnd}
                className={[
                  'transition-opacity',
                  dragIndex === index ? 'opacity-40' : '',
                  overIndex === index && dragIndex !== index ? 'border-t-2 border-accent' : '',
                ].join(' ')}
              >
                <RuleCard
                  rule={rule}
                  onRemove={() => removeRule(filter.id, rule.id)}
                  dragHandleProps={{}}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add rule dialog */}
      {showDialog && (
        <AddRuleDialog
          onConfirm={handleAddRule}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function FiltersScreen() {
  const {t}          = useTranslation('filters');
  const filters      = useFilterStore(s => s.filters);
  const isLoaded     = useFilterStore(s => s.isLoaded);
  const createFilter = useFilterStore(s => s.createFilter);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) useFilterStore.getState().load();
  }, [isLoaded]);

  // Auto-select first filter on load
  useEffect(() => {
    if (isLoaded && filters.length > 0 && !selectedId) {
      setSelectedId(filters[0].id);
    }
  }, [isLoaded, filters, selectedId]);

  const selectedFilter = filters.find(f => f.id === selectedId) ?? null;

  const handleCreate = () => {
    createFilter(t('defaultName'));
    // Select the newly created filter
    setTimeout(() => {
      const latest = useFilterStore.getState().filters.at(-1);
      if (latest) setSelectedId(latest.id);
    }, 0);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border shrink-0">
        <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
      </div>

      {/* Body: filter list + rule editor */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: filter list — fixed width */}
        <div className="w-56 shrink-0 border-r border-border overflow-hidden">
          {!isLoaded ? (
            <div className="flex items-center justify-center h-full text-sm text-text-disabled">
              Loading…
            </div>
          ) : (
            <FilterList
              filters={filters}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCreate={handleCreate}
            />
          )}
        </div>

        {/* Right: rule editor */}
        <div className="flex-1 overflow-hidden">
          <RuleEditor filter={selectedFilter} />
        </div>
      </div>
    </div>
  );
}
