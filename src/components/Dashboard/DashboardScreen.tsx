import {useWealthRefresh} from '@/hooks/useWealthRefresh';
import {useSettingsStore} from '@/state/settingsStore';
import WealthChart from './WealthChart';
import ItemBreakdown from './ItemBreakdown';
import EventFeed from './EventFeed';

interface Props {
  onRequestItemFocus: (id: string) => void;
}

export default function DashboardScreen({onRequestItemFocus}: Props) {
  const showEventFeed = useSettingsStore(s => s.showEventFeed);
  useWealthRefresh();

  return (
    <div className="flex flex-col h-full p-6 overflow-hidden">
      <WealthChart />
      <div className="flex-1 flex flex-col min-h-0 mt-6">
        <ItemBreakdown onRequestItemFocus={onRequestItemFocus} />
      </div>
      {showEventFeed && (
        <div className="mt-6 h-56 shrink-0 flex flex-col">
          <EventFeed />
        </div>
      )}
    </div>
  );
}
