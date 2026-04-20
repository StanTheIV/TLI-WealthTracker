import {useWealthRefresh} from '@/hooks/useWealthRefresh';
import WealthChart from './WealthChart';
import ItemBreakdown from './ItemBreakdown';

interface Props {
  onRequestItemFocus: (id: string) => void;
}

export default function DashboardScreen({onRequestItemFocus}: Props) {
  useWealthRefresh();

  return (
    <div className="flex flex-col h-full p-6 overflow-hidden">
      <WealthChart />
      <div className="flex-1 flex flex-col min-h-0 mt-6">
        <ItemBreakdown onRequestItemFocus={onRequestItemFocus} />
      </div>
    </div>
  );
}
