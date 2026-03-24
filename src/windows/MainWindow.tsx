import {useState, useEffect} from 'react';
import Sidebar, {type NavItemId} from '@/components/Sidebar/Sidebar';
import DashboardScreen from '@/components/Dashboard/DashboardScreen';
import ItemsScreen from '@/components/Items/ItemsScreen';
import SessionsScreen from '@/components/Sessions/SessionsScreen';
import FiltersScreen from '@/components/Filters/FiltersScreen';
import SettingsScreen from '@/components/Settings/SettingsScreen';
import Playbar from '@/components/Playbar/Playbar';
import SetupDialog from '@/components/Setup/SetupDialog';
import UpdateBanner from '@/components/Update/UpdateBanner';
import ChangelogModal from '@/components/Update/ChangelogModal';
import {useSettingsStore} from '@/state/settingsStore';
import {useUpdaterStore} from '@/state/updaterStore';

export default function MainWindow() {
  const [activeNav, setActiveNav] = useState<NavItemId>('dashboard');
  const torchlightPath = useSettingsStore(s => s.torchlightPath);
  const logFileValid   = useSettingsStore(s => s.logFileValid);
  const checkForUpdate = useUpdaterStore(s => s.checkForUpdate);
  const loadChangelog  = useUpdaterStore(s => s.loadChangelog);

  useEffect(() => {
    checkForUpdate();
    loadChangelog();
  }, []);

  return (
    <div className="flex flex-col h-full bg-bg text-text-primary">
      {(!torchlightPath || !logFileValid) && <SetupDialog />}
      <ChangelogModal />
      <UpdateBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar activeItem={activeNav} onNavChange={setActiveNav} />
        <main className="flex-1 overflow-auto">
          {activeNav === 'dashboard' && <DashboardScreen />}
          {activeNav === 'items'     && <ItemsScreen />}
          {activeNav === 'sessions'  && <SessionsScreen onNavChange={setActiveNav} />}
          {activeNav === 'filters'   && <FiltersScreen />}
          {activeNav === 'settings'  && <SettingsScreen />}
        </main>
      </div>
      <Playbar />
    </div>
  );
}
