import {create} from 'zustand';
import type {UpdateInfo} from '@/shared/contracts/api';

interface UpdaterState {
  updateInfo:       UpdateInfo | null;
  downloadProgress: number | null;
  downloading:      boolean;
  downloaded:       boolean;
  changelog:        {version: string; changelog: string} | null;
  showChangelog:     boolean;
  dismissed:         boolean;
}

interface UpdaterActions {
  checkForUpdate:   () => Promise<void>;
  startDownload:    () => Promise<void>;
  installUpdate:    () => void;
  loadChangelog:    () => Promise<void>;
  dismissChangelog: () => Promise<void>;
  dismiss:          () => void;
}

type Store = UpdaterState & UpdaterActions;

export const useUpdaterStore = create<Store>((set, get) => ({
  updateInfo:       null,
  downloadProgress: null,
  downloading:      false,
  downloaded:       false,
  changelog:        null,
  showChangelog:     false,
  dismissed:         false,

  checkForUpdate: async () => {
    try {
      const info = await window.electronAPI.updater.check();
      if (info) set({updateInfo: info});
    } catch (err) {
      console.warn('[updater] check failed:', err);
    }
  },

  startDownload: async () => {
    set({downloading: true, downloadProgress: 0});

    const unsub = window.electronAPI.updater.onProgress((pct) => {
      set({downloadProgress: pct});
    });

    try {
      const result = await window.electronAPI.updater.download();
      if (result.success) {
        set({downloaded: true});
      } else {
        console.error('[updater] download failed:', result.error);
      }
    } catch (err) {
      console.error('[updater] download failed:', err);
    } finally {
      unsub();
      set({downloading: false});
    }
  },

  installUpdate: () => {
    if (get().downloaded) window.electronAPI.updater.install();
  },

  loadChangelog: async () => {
    try {
      const result = await window.electronAPI.updater.getChangelog();
      if (result) {
        set({changelog: result, showChangelog: true});
      }
    } catch (err) {
      console.warn('[updater] changelog check failed:', err);
    }
  },

  dismissChangelog: async () => {
    set({showChangelog: false, changelog: null});
    await window.electronAPI.updater.dismissChangelog();
  },

  dismiss: () => {
    set({dismissed: true});
  },
}));
