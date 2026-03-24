import {useTranslation} from 'react-i18next';
import {useUpdaterStore} from '@/state/updaterStore';

export default function UpdateBanner() {
  const {t} = useTranslation('updater');
  const updateInfo       = useUpdaterStore(s => s.updateInfo);
  const downloading      = useUpdaterStore(s => s.downloading);
  const downloadProgress = useUpdaterStore(s => s.downloadProgress);
  const downloadedPath   = useUpdaterStore(s => s.downloadedPath);
  const dismissed        = useUpdaterStore(s => s.dismissed);
  const startDownload    = useUpdaterStore(s => s.startDownload);
  const installUpdate    = useUpdaterStore(s => s.installUpdate);
  const dismiss          = useUpdaterStore(s => s.dismiss);

  if (!updateInfo || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-accent/10 border-b border-accent/30 text-sm">
      <span className="flex-1 text-text-primary">
        {downloadedPath
          ? t('banner.ready')
          : downloading
            ? t('banner.downloading', {pct: downloadProgress ?? 0})
            : t('banner.available', {version: updateInfo.version})}
      </span>

      {downloadedPath ? (
        <button
          onClick={installUpdate}
          className="px-3 py-1 rounded bg-accent text-white text-xs font-semibold hover:opacity-90 transition-opacity"
        >
          {t('banner.install')}
        </button>
      ) : downloading ? (
        <div className="w-32 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all"
            style={{width: `${downloadProgress ?? 0}%`}}
          />
        </div>
      ) : (
        <>
          <button
            onClick={startDownload}
            className="px-3 py-1 rounded bg-accent text-white text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            {t('banner.download')}
          </button>
          <button
            onClick={dismiss}
            className="px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            {t('banner.later')}
          </button>
        </>
      )}
    </div>
  );
}
