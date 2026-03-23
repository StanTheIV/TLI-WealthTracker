import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import GeneralTab from './GeneralTab';
import LoggingTab from './LoggingTab';

type SettingsTab = 'general' | 'logging';

export default function SettingsScreen() {
  const {t} = useTranslation('settings');
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-text-primary mb-6">{t('title')}</h1>

      {/* Tab bar */}
      <div className="flex gap-2 mb-8">
        {(['general', 'logging'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg border text-sm transition-colors ${
              activeTab === tab
                ? 'bg-accent/15 border-accent text-accent font-medium'
                : 'bg-surface-elevated border-border text-text-primary hover:bg-accent/10 hover:border-accent'
            }`}
          >
            {t(`tabs.${tab}` as never)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'general' && <GeneralTab />}
      {activeTab === 'logging' && <LoggingTab />}
    </div>
  );
}
