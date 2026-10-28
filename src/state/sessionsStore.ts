import {create} from 'zustand';
import type {DbSession} from '@/shared/contracts/db';

interface SessionsState {
  sessions:   DbSession[];
  isLoaded:   boolean;
  selectedId: string | null;
}

interface SessionsActions {
  load:          () => Promise<void>;
  refresh:       () => Promise<void>;
  select:        (id: string | null) => void;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState & SessionsActions>((set, get) => ({
  sessions:   [],
  isLoaded:   false,
  selectedId: null,

  load: async () => {
    const sessions = await window.electronAPI.db.sessions.getAll();
    set({sessions, isLoaded: true});
  },

  refresh: async () => {
    const sessions = await window.electronAPI.db.sessions.getAll();
    set({sessions});
  },

  select: (id) => set({selectedId: id}),

  // Main may refuse (e.g. deleting the session being tracked): the local list
  // then re-reads the DB instead of assuming the change happened.
  deleteSession: async (id) => {
    try {
      await window.electronAPI.db.sessions.delete(id);
    } catch (err) {
      console.error('[session] delete refused:', err);
      await get().refresh();
      return;
    }
    set(s => ({
      sessions:   s.sessions.filter(ss => ss.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },

  renameSession: async (id, name) => {
    try {
      await window.electronAPI.db.sessions.rename(id, name);
    } catch (err) {
      console.error('[session] rename failed:', err);
      await get().refresh();
      return;
    }
    set(s => ({
      sessions: s.sessions.map(ss => ss.id === id ? {...ss, name} : ss),
    }));
  },
}));
