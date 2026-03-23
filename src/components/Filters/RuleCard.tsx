import {useTranslation} from 'react-i18next';
import {GripVertical, Trash2} from 'lucide-react';
import type {FilterRule} from '@/types/itemFilter';
import {useItemsStore} from '@/state/itemsStore';

interface Props {
  rule:         FilterRule;
  onRemove:     () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
}

export default function RuleCard({rule, onRemove, dragHandleProps}: Props) {
  const {t}      = useTranslation('filters');
  const tItems   = useTranslation('items').t;
  const items    = useItemsStore(s => s.items);

  const actionColor = rule.action === 'show'
    ? 'text-green-400 bg-green-500/10 border-green-500/30'
    : 'text-red-400 bg-red-500/10 border-red-500/30';

  const description = (() => {
    if (rule.kind.type === 'by-type') {
      const typeName = tItems(`types.${rule.kind.itemType}` as never);
      return t(rule.action === 'show' ? 'ruleDesc.showType' : 'ruleDesc.hideType', {type: typeName});
    }
    const name = items[rule.kind.itemId]?.name || `#${rule.kind.itemId}`;
    return t(rule.action === 'show' ? 'ruleDesc.showItem' : 'ruleDesc.hideItem', {name});
  })();

  return (
    <div className="flex items-center gap-2 bg-surface-elevated border border-border rounded-lg px-3 py-2.5 group">
      {/* Drag handle */}
      <div
        {...dragHandleProps}
        className="text-text-disabled hover:text-text-secondary cursor-grab active:cursor-grabbing shrink-0"
      >
        <GripVertical className="w-4 h-4" />
      </div>

      {/* Action badge */}
      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 uppercase tracking-wide ${actionColor}`}>
        {t(`action.${rule.action}`)}
      </span>

      {/* Description */}
      <span className="flex-1 text-sm text-text-primary truncate">{description}</span>

      {/* Scopes */}
      <div className="hidden group-hover:flex items-center gap-1 shrink-0">
        {rule.scopes.map(s => (
          <span key={s} className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-accent/10 text-accent uppercase tracking-wide">
            {t(`scopes.${s}`)}
          </span>
        ))}
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="text-text-disabled hover:text-danger transition-colors shrink-0 ml-1"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
