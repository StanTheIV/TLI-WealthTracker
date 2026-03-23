import {useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useSettingsStore} from '@/state/settingsStore';
import {SUPPORTED_LANGUAGES} from '@/i18n';
import type {DbItem} from '@/types/electron';

export default function GeneralTab() {
  const {t} = useTranslation('settings');
  const torchlightPath  = useSettingsStore(s => s.torchlightPath);
  const overlayOpacity  = useSettingsStore(s => s.overlayOpacity);
  const language        = useSettingsStore(s => s.language);
  const serperApiKey    = useSettingsStore(s => s.serperApiKey);
  const setTorchlightPath = useSettingsStore(s => s.setTorchlightPath);
  const setOverlayOpacity = useSettingsStore(s => s.setOverlayOpacity);
  const setLanguage       = useSettingsStore(s => s.setLanguage);
  const setSerperApiKey   = useSettingsStore(s => s.setSerperApiKey);
  const rateTimeframe     = useSettingsStore(s => s.rateTimeframe);
  const setRateTimeframe  = useSettingsStore(s => s.setRateTimeframe);

  const fileInputRef                    = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const browse = async () => {
    const folder = await window.electronAPI.pickFolder();
    if (folder) setTorchlightPath(folder);
  };

  const handleExport = async () => {
    const items = await window.electronAPI.db.items.getAll();
    const table: Record<string, {name: string; type: string; price: number; last_update: number}> = {};
    for (const item of items) {
      table[item.id] = {name: item.name, type: item.type, price: item.price, last_update: item.priceDate};
    }
    const blob = new Blob([JSON.stringify(table, null, 2)], {type: 'application/json'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'full_table.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportStatus(null);
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      const text = await file.text();
      const raw  = JSON.parse(text) as Record<string, {name?: string; type?: string; price?: number; last_update?: number}>;
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad shape');

      const items: DbItem[] = Object.entries(raw).map(([id, v]) => ({
        id,
        name:      v.name      ?? '',
        type:      v.type      ?? '',
        price:     v.price     ?? 0,
        priceDate: v.last_update ?? 0,
      }));

      const inserted = await window.electronAPI.db.items.importBatch(items);
      setImportStatus(inserted > 0 ? t('itemImport.success', {count: inserted}) : t('itemImport.noneNew'));
    } catch {
      setImportStatus(t('itemImport.error'));
    }
  };

  return (
    <>
      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('language.heading')}
        </h2>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <p className="text-sm text-text-primary mb-3">{t('language.label')}</p>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(SUPPORTED_LANGUAGES).map(([code, label]) => (
              <button
                key={code}
                onClick={() => setLanguage(code)}
                className={`px-4 py-2 rounded-lg border text-sm transition-colors ${
                  language === code
                    ? 'bg-accent/15 border-accent text-accent'
                    : 'bg-surface-elevated border-border text-text-primary hover:bg-accent/10 hover:border-accent'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('logPath.heading')}
        </h2>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <p className="text-sm text-text-primary mb-3">{t('logPath.label')}</p>
          <div className="flex gap-3 items-center mb-2">
            <div className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm font-mono text-text-secondary truncate">
              {torchlightPath || <span className="text-text-disabled">{t('logPath.notSet')}</span>}
            </div>
            <button
              onClick={browse}
              className="px-4 py-2 rounded-lg bg-surface-elevated border border-border text-sm text-text-primary hover:bg-accent/10 hover:border-accent transition-colors whitespace-nowrap"
            >
              {t('logPath.browse')}
            </button>
          </div>
          <p className="text-xs text-text-secondary mt-2">{t('logPath.hint')}</p>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('tracker.heading')}
        </h2>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <p className="text-sm text-text-primary mb-3">{t('tracker.rateTimeframe.label')}</p>
          <div className="flex gap-2">
            {(['hour', 'minute'] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setRateTimeframe(tf)}
                className={`px-4 py-2 rounded-lg border text-sm transition-colors ${
                  rateTimeframe === tf
                    ? 'bg-accent/15 border-accent text-accent'
                    : 'bg-surface-elevated border-border text-text-primary hover:bg-accent/10 hover:border-accent'
                }`}
              >
                {t(`tracker.rateTimeframe.${tf}`)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('overlay.heading')}
        </h2>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <div className="flex justify-between mb-3">
            <span className="text-sm text-text-primary">{t('overlay.opacity')}</span>
            <span className="text-sm font-semibold text-accent">{Math.round(overlayOpacity * 100)}%</span>
          </div>
          <input
            type="range"
            min={0} max={1} step={0.05}
            value={overlayOpacity}
            onChange={e => setOverlayOpacity(Number(e.target.value))}
            className="w-full accent-accent"
          />
          <p className="text-xs text-text-secondary mt-2">{t('overlay.opacityHint')}</p>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('itemImport.heading')}
        </h2>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <p className="text-sm text-text-primary mb-3">{t('itemImport.label')}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImport}
          />
          <div className="flex gap-2">
            <button
              onClick={() => { setImportStatus(null); fileInputRef.current?.click(); }}
              className="px-4 py-2 rounded-lg bg-surface-elevated border border-border text-sm text-text-primary hover:bg-accent/10 hover:border-accent transition-colors"
            >
              {t('itemImport.importButton')}
            </button>
            <button
              onClick={handleExport}
              className="px-4 py-2 rounded-lg bg-surface-elevated border border-border text-sm text-text-primary hover:bg-accent/10 hover:border-accent transition-colors"
            >
              {t('itemImport.exportButton')}
            </button>
          </div>
          {importStatus && (
            <p className="text-xs mt-2 text-text-secondary">{importStatus}</p>
          )}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('apiKeys.heading')}
        </h2>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <p className="text-sm text-text-primary mb-3">{t('apiKeys.serperApiKey.label')}</p>
          <input
            type="password"
            value={serperApiKey}
            onChange={e => setSerperApiKey(e.target.value)}
            placeholder={t('apiKeys.serperApiKey.placeholder')}
            className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm font-mono text-text-secondary outline-none focus:border-accent/50 transition-colors placeholder:text-text-disabled"
          />
          <p className="text-xs text-text-secondary mt-2">{t('apiKeys.serperApiKey.hint')}</p>
        </div>
      </section>
    </>
  );
}
