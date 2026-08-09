import type {ReactNode} from 'react';

export function Section({title, hint, right, children}: {
  title:    string;
  hint?:    string;
  right?:   ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
          {title}
        </h2>
        {hint && <span className="text-[11px] text-text-disabled truncate">{hint}</span>}
        {right && <div className="ml-auto shrink-0">{right}</div>}
      </div>
      {children}
    </section>
  );
}

export function Card({className = '', children}: {className?: string; children: ReactNode}) {
  return (
    <div className={`bg-surface border border-border rounded-lg p-4 ${className}`}>
      {children}
    </div>
  );
}

export function EmptyCard({message}: {message: string}) {
  return (
    <div className="flex items-center justify-center h-40 rounded-lg border border-border bg-surface text-xs text-text-disabled px-6 text-center">
      {message}
    </div>
  );
}

/** Sortable column header. Mirrors the pattern in Items/ItemsTable.tsx. */
export function ColHeader<F extends string>({label, field, sortField, sortDir, onSort, align = 'right'}: {
  label:     string;
  field:     F;
  sortField: F;
  sortDir:   'asc' | 'desc';
  onSort:    (f: F) => void;
  align?:    'left' | 'right';
}) {
  const active = sortField === field;
  return (
    <button
      onClick={() => onSort(field)}
      className={`flex items-center gap-0.5 w-full text-[10px] font-semibold uppercase tracking-widest transition-colors ${
        align === 'right' ? 'justify-end' : 'justify-start'
      } ${active ? 'text-text-secondary' : 'text-text-disabled hover:text-text-secondary'}`}
    >
      {label}
      {active && <span className="text-[9px]">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );
}

export function Pill({children, color}: {children: ReactNode; color: string}) {
  return (
    <span
      className="inline-block text-[10px] font-semibold px-1.5 py-px rounded-full border"
      style={{color, borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`}}
    >
      {children}
    </span>
  );
}

/** Small colour key used by the mechanic table and allocation bars. */
export function Swatch({color}: {color: string}) {
  return (
    <i className="w-2 h-2 rounded-sm shrink-0 inline-block" style={{backgroundColor: color}} />
  );
}
