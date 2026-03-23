import {useState} from 'react';
import {useSettingsStore} from '@/state/settingsStore';

export default function SetupDialog() {
  const setTorchlightPath = useSettingsStore(s => s.setTorchlightPath);
  const validateLogFile   = useSettingsStore(s => s.validateLogFile);
  const torchlightPath    = useSettingsStore(s => s.torchlightPath);
  const [picked, setPicked] = useState(torchlightPath);
  const [error, setError]   = useState('');
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
      setError('Please select a folder first.');
      return;
    }
    setChecking(true);
    setTorchlightPath(picked);
    const valid = await validateLogFile();
    setChecking(false);
    if (!valid) {
      setError('Log file not found in the selected folder. Make sure you selected the correct Torchlight Infinite installation folder.');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-surface border border-border rounded-xl p-8 w-[520px] shadow-2xl">
        <h2 className="text-xl font-bold text-text-primary mb-2">Welcome to TLI Tracker</h2>
        <p className="text-sm text-text-secondary mb-6">
          To get started, select your Torchlight Infinite installation folder.
        </p>

        <div className="bg-bg rounded-lg border border-border p-4 mb-6">
          <p className="text-xs text-text-secondary mb-1 font-semibold uppercase tracking-widest">Expected log file location</p>
          <p className="text-xs font-mono text-gold break-all">
            &lt;your folder&gt;\TorchLight\Saved\Logs\UE_game.log
          </p>
          <p className="text-xs text-text-disabled mt-3">
            Usually found in your Steam library, e.g.:<br />
            <span className="font-mono">C:\Program Files (x86)\Steam\steamapps\common\Torchlight Infinite</span>
          </p>
        </div>

        <div className="flex gap-3 items-center mb-2">
          <div className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm font-mono text-text-secondary truncate min-h-[36px]">
            {picked || <span className="text-text-disabled">No folder selected</span>}
          </div>
          <button
            onClick={browse}
            className="px-4 py-2 rounded-lg bg-surface-elevated border border-border text-sm text-text-primary hover:bg-accent/10 hover:border-accent transition-colors whitespace-nowrap"
          >
            Browse…
          </button>
        </div>

        {error && <p className="text-xs text-danger mb-3">{error}</p>}

        <button
          onClick={confirm}
          disabled={!picked || checking}
          className="w-full mt-4 py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {checking ? 'Checking…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}
