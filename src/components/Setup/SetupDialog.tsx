import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useSettingsStore} from '@/state/settingsStore';
import {LOG_SUBPATH} from '@/shared/paths';
import Modal, {ModalTitle} from '@/components/ui/Modal';

const STEAM_EXAMPLE = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Torchlight Infinite';

type SetupError = '' | 'noFolder' | 'logNotFound';

/** Shown until a valid log folder is picked; it cannot be dismissed (the Modal gets no close handler). */
export default function SetupDialog() {
  const {t} = useTranslation('setup');
  const setTorchlightPath = useSettingsStore(s => s.setTorchlightPath);
  const validateLogFile   = useSettingsStore(s => s.validateLogFile);
  const torchlightPath    = useSettingsStore(s => s.torchlightPath);
  const [picked, setPicked] = useState(torchlightPath);
  const [error, setError]   = useState<SetupError>('');
  const [checking, setChecking] = useState(false);

  const browse = async () => {
    const folder = await window.electronAPI.pickFolder();
    if (folder) {
      setPicked(folder);
      setError('');
    }
  };

  const confirm = async () => {
    if (!picked) {
      setError('noFolder');
      return;
    }
    setChecking(true);
    setTorchlightPath(picked);
    const valid = await validateLogFile();
    setChecking(false);
    if (!valid) {
      setError('logNotFound');
    }
  };

  return (
    <Modal className="p-8 w-[520px]">
      <ModalTitle className="text-xl font-bold text-text-primary mb-2">{t('title')}</ModalTitle>
      <p className="text-sm text-text-secondary mb-6">{t('intro')}</p>

      <div className="bg-bg rounded-lg border border-border p-4 mb-6">
        <p className="text-xs text-text-secondary mb-1 font-semibold uppercase tracking-widest">{t('expectedLocation')}</p>
        <p className="text-xs font-mono text-gold break-all">
          {t('yourFolder')}\{LOG_SUBPATH.replace(/\//g, '\\')}
        </p>
        <p className="text-xs text-text-disabled mt-3">
          {t('steamHint')}<br />
          <span className="font-mono">{STEAM_EXAMPLE}</span>
        </p>
      </div>

      <div className="flex gap-3 items-center mb-2">
        <div className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm font-mono text-text-secondary truncate min-h-[36px]">
          {picked || <span className="text-text-disabled">{t('noFolder')}</span>}
        </div>
        <button
          onClick={browse}
          className="px-4 py-2 rounded-lg bg-surface-elevated border border-border text-sm text-text-primary hover:bg-accent/10 hover:border-accent transition-colors whitespace-nowrap"
        >
          {t('browse')}
        </button>
      </div>

      {error && <p className="text-xs text-danger mb-3">{t(`error.${error}`)}</p>}

      <button
        onClick={confirm}
        disabled={!picked || checking}
        className="w-full mt-4 py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {checking ? t('checking') : t('confirm')}
      </button>
    </Modal>
  );
}
