import type {ElectronAPI} from '@/shared/contracts/api';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
