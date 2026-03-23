import {create} from 'zustand';
import type {DbSession} from '@/types/electron';

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

export const useSessionsStore = create<SessionsState & SessionsActions>((set) => ({
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

  deleteSession: async (id) => {
    await window.electronAPI.db.sessions.delete(id);
    set(s => ({
      sessions:   s.sessions.filter(ss => ss.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },

  renameSession: async (id, name) => {
    await window.electronAPI.db.sessions.rename(id, name);
    set(s => ({
      sessions: s.sessions.map(ss => ss.id === id ? {...ss, name} : ss),
    }));
  },
}));
