interface Segment<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}

export default function SegmentedControl<T extends string>({segments, value, onChange}: Props<T>) {
  return (
    <div className="inline-flex rounded-lg border border-border overflow-hidden">
      {segments.map((seg, i) => {
        const active = seg.value === value;
        return (
          <button
            key={seg.value}
            onClick={() => onChange(seg.value)}
            className={[
              'px-4 py-2 text-sm transition-colors',
              i > 0 ? 'border-l border-border' : '',
              active
                ? 'bg-accent/15 text-accent'
                : 'bg-surface-elevated text-text-primary hover:bg-accent/10 hover:text-accent',
            ].join(' ')}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
