export const ITEM_TYPE_CONFIG = {
  ember:       { label: 'Ember',        rawNames: ['Remembrance Material'] },
  fuel:        { label: 'Fuel',         rawNames: ['Corrosion Material', 'Equipment Material', 'Erosion Material', 'Overlay Material', 'Tower Material', 'Tower Materials'] },
  compass:     { label: 'Compass',      rawNames: ['Compass'] },
  dream:       { label: 'Dream',        rawNames: ['Dream Material'] },
  cube:        { label: 'Cube',         rawNames: ['Cube Material', 'Magic Cube Material', 'Magic Cube Materials'] },
  card:        { label: 'Fluorescent',  rawNames: ['Memory Fluorescence'] },
  skill:       { label: 'Skill',        rawNames: [] },
  equipment:   { label: 'Equipment',    rawNames: [] },
  mapMaterial: { label: 'Map Material', rawNames: [] },
  other:       { label: 'Other',        rawNames: [] },
} as const;

export type ItemType = keyof typeof ITEM_TYPE_CONFIG;

export const ITEM_TYPES = Object.keys(ITEM_TYPE_CONFIG) as ItemType[];

const RAW_TYPE_MAP: Record<string, ItemType> = Object.entries(ITEM_TYPE_CONFIG).reduce(
  (acc, [type, cfg]) => {
    for (const raw of cfg.rawNames) acc[raw] = type as ItemType;
    return acc;
  },
  {} as Record<string, ItemType>,
);

export function mapRawType(raw: string | undefined): ItemType {
  if (!raw) return 'other';
  if (raw in ITEM_TYPE_CONFIG) return raw as ItemType;
  return RAW_TYPE_MAP[raw] ?? 'other';
}
