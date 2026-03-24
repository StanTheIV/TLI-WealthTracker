import {useTranslation} from 'react-i18next';
import {useUpdaterStore} from '@/state/updaterStore';

export default function ChangelogModal() {
  const {t} = useTranslation('updater');
  const changelog       = useUpdaterStore(s => s.changelog);
  const showChangelog   = useUpdaterStore(s => s.showChangelog);
  const dismissChangelog = useUpdaterStore(s => s.dismissChangelog);

  if (!showChangelog || !changelog) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-surface border border-border rounded-xl p-8 w-[520px] max-h-[70vh] flex flex-col shadow-2xl">
        <h2 className="text-xl font-bold text-text-primary mb-4">
          {t('changelog.title', {version: changelog.version})}
        </h2>

        <div className="flex-1 overflow-auto mb-6 text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
          {changelog.changelog}
        </div>

        <button
          onClick={dismissChangelog}
          className="w-full py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:opacity-90 transition-opacity"
        >
          {t('changelog.dismiss')}
        </button>
      </div>
    </div>
  );
}
