import {useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useSettingsStore, type ThemeMode} from '@/state/settingsStore';
import {useWealthStore} from '@/state/wealthStore';
import {useItemsStore} from '@/state/itemsStore';
import {SUPPORTED_LANGUAGES} from '@/i18n';
import type {DbItem} from '@/types/electron';
import SegmentedControl from '@/components/ui/SegmentedControl';

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
  const themeMode         = useSettingsStore(s => s.themeMode);
  const setThemeMode      = useSettingsStore(s => s.setThemeMode);
  const lowStockThreshold    = useSettingsStore(s => s.lowStockThreshold);
  const setLowStockThreshold = useSettingsStore(s => s.setLowStockThreshold);

  const fileInputRef                      = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus]   = useState<string | null>(null);
  const [wealthResetState, setWealthResetState] = useState<'idle' | 'confirm' | 'done'>('idle');

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
        type:      v.type      || 'other',
        price:     v.price     ?? 0,
        priceDate: v.last_update ?? 0,
      }));

      const inserted = await window.electronAPI.db.items.importBatch(items);
      if (inserted > 0) await useItemsStore.getState().load();
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
          <SegmentedControl
            segments={Object.entries(SUPPORTED_LANGUAGES).map(([code, label]) => ({value: code, label}))}
            value={language}
            onChange={setLanguage}
          />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('theme.heading')}
        </h2>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <p className="text-sm text-text-primary mb-3">{t('theme.label')}</p>
          <SegmentedControl
            segments={(['system', 'dark', 'light'] as const).map(mode => ({value: mode, label: t(`theme.${mode}`)}))}
            value={themeMode}
            onChange={(v) => setThemeMode(v as ThemeMode)}
          />
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
        <div className="bg-surface rounded-lg p-4 border border-border mb-3">
          <p className="text-sm text-text-primary mb-3">{t('tracker.rateTimeframe.label')}</p>
          <SegmentedControl
            segments={(['hour', 'minute'] as const).map(tf => ({value: tf, label: t(`tracker.rateTimeframe.${tf}`)}))}
            value={rateTimeframe}
            onChange={setRateTimeframe}
          />
        </div>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-text-primary">{t('tracker.lowStock.label')}</p>
            <input
              type="number"
              min={0}
              step={1}
              value={lowStockThreshold}
              onChange={e => setLowStockThreshold(Number(e.target.value))}
              className="w-20 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm font-mono tabular-nums text-text-primary text-right outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <p className="text-xs text-text-secondary">{t('tracker.lowStock.hint')}</p>
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
          {t('wealthReset.heading')}
        </h2>
        <div className="bg-surface rounded-lg p-4 border border-border">
          <p className="text-sm text-text-primary mb-3">{t('wealthReset.label')}</p>
          {wealthResetState === 'idle' && (
            <button
              onClick={() => setWealthResetState('confirm')}
              className="px-4 py-2 rounded-lg bg-surface-elevated border border-danger/40 text-sm text-danger hover:bg-danger/10 hover:border-danger transition-colors"
            >
              {t('wealthReset.button')}
            </button>
          )}
          {wealthResetState === 'confirm' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-danger">{t('wealthReset.confirm')}</p>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    await window.electronAPI.db.wealth.clear();
                    await useWealthStore.getState().refresh();
                    setWealthResetState('done');
                  }}
                  className="px-4 py-2 rounded-lg bg-danger/15 border border-danger text-sm text-danger hover:bg-danger/25 transition-colors font-medium"
                >
                  {t('wealthReset.button')}
                </button>
                <button
                  onClick={() => setWealthResetState('idle')}
                  className="px-4 py-2 rounded-lg bg-surface-elevated border border-border text-sm text-text-primary hover:bg-accent/10 hover:border-accent transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {wealthResetState === 'done' && (
            <p className="text-sm text-success">{t('wealthReset.done')}</p>
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
