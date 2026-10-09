import {useTranslation} from 'react-i18next';
import {useLeaguesStore} from '@/state/leaguesStore';
import {availablePresets, type PricePreset} from '@/lib/priceRange';
import SegmentedControl from '@/components/ui/SegmentedControl';

interface Props {
  value:    PricePreset;
  onChange: (p: PricePreset) => void;
}

/** Range presets shared by the price history modal and the trends view. */
export default function PriceRangeControl({value, onChange}: Props) {
  const {t}    = useTranslation('items');
  const ranges = useLeaguesStore(s => s.ranges);
  const segments = availablePresets(ranges, Date.now()).map(p => ({value: p, label: t(`range.${p}`)}));
  return <SegmentedControl segments={segments} value={value} onChange={onChange} />;
}
