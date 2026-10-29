import {contextBridge, ipcRenderer} from 'electron';
import type {ElectronAPI} from '@/shared/contracts/api';
import type {
  DbItem,
  DbItemFilter,
  ItemChangedPatch,
} from '@/shared/contracts/db';
import type {EngineEnvelope, EngineSnapshot} from '@/shared/contracts/engine';
import type {FilterRule} from '@/shared/item-filter';
import type {Settings} from '@/shared/settings';

const api = {
  pickFolder:    () => ipcRenderer.invoke('dialog:pick-folder') as Promise<string | null>,
  checkLogFile:  (folder: string) => ipcRenderer.invoke('fs:check-log-file', folder) as Promise<boolean>,

  overlay: {
    show:           ()                       => ipcRenderer.send('overlay:show'),
    hide:           ()                       => ipcRenderer.send('overlay:hide'),
    setClickThrough:(enabled: boolean)       => ipcRenderer.send('overlay:set-clickthrough', enabled),
    setSize:        (w: number, h: number)   => ipcRenderer.send('overlay:set-size', w, h),
    notifyReady:    ()                       => ipcRenderer.send('overlay:notify-ready'),
    moveBy:         (dx: number, dy: number) => ipcRenderer.send('overlay:move-by', dx, dy),
    dragEnd:        ()                       => ipcRenderer.send('overlay:drag-end'),
  },

  settings: {
    getAll: ()                           => ipcRenderer.invoke('settings:get-all'),
    set:    (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    onChanged: (cb: (settings: Settings) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, settings: Settings) => cb(settings);
      ipcRenderer.on('settings:changed', wrapped);
      return () => ipcRenderer.removeListener('settings:changed', wrapped);
    },
  },

  engine: {
    start:           ()                  => ipcRenderer.send('engine:start'),
    startWithSession:(sessionId: string) => ipcRenderer.invoke('engine:start-with-session', sessionId),
    stop:            ()                  => ipcRenderer.send('engine:stop'),
    pause:           ()                  => ipcRenderer.send('engine:pause'),
    resume:          ()                  => ipcRenderer.send('engine:resume'),
    reset:           ()                  => ipcRenderer.send('engine:reset'),
    updateFilterRules: (rules: FilterRule[] | null) => ipcRenderer.send('engine:update-filter-rules', rules),
    dismissMaterial:   (itemId: number) => ipcRenderer.send('engine:dismiss-material', itemId),
    getState:          () => ipcRenderer.invoke('engine:get-state') as Promise<EngineSnapshot>,
    onEvent: (cb: (envelope: EngineEnvelope) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, envelope: EngineEnvelope) => cb(envelope);
      ipcRenderer.on('engine:event', wrapped);
      return () => ipcRenderer.removeListener('engine:event', wrapped);
    },
  },

  logging: {
    getLogPath: () => ipcRenderer.invoke('logging:get-log-path'),
  },

  updater: {
    check:            () => ipcRenderer.invoke('updater:check'),
    download:         () => ipcRenderer.invoke('updater:download'),
    install:          (path: string) => ipcRenderer.send('updater:install', path),
    getChangelog:     () => ipcRenderer.invoke('updater:get-changelog'),
    dismissChangelog: () => ipcRenderer.invoke('updater:dismiss-changelog'),
    onProgress: (cb: (pct: number) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, pct: number) => cb(pct);
      ipcRenderer.on('updater:progress', wrapped);
      return () => ipcRenderer.removeListener('updater:progress', wrapped);
    },
  },

  db: {
    items: {
      getAll:     ()                                    => ipcRenderer.invoke('db:items:get-all'),
      setName:    (id: string, name: string)            => ipcRenderer.invoke('db:items:set-name', id, name),
      setType:    (id: string, type: string)            => ipcRenderer.invoke('db:items:set-type', id, type),
      setPrice:   (id: string, price: number)           => ipcRenderer.invoke('db:items:set-price', id, price),
      setLocked:  (id: string, locked: boolean)         => ipcRenderer.invoke('db:items:set-locked', id, locked),
      lookupName:   (id: string)                          => ipcRenderer.invoke('db:items:lookup-name', id),
      importBatch:  (items: DbItem[])                     => ipcRenderer.invoke('db:items:import-batch', items),
      onChanged: (cb: (patch: ItemChangedPatch) => void) => {
        const wrapped = (_e: Electron.IpcRendererEvent, patch: ItemChangedPatch) => cb(patch);
        ipcRenderer.on('items:changed', wrapped);
        return () => ipcRenderer.removeListener('items:changed', wrapped);
      },
    },
    lookups: {
      getToday: () => ipcRenderer.invoke('db:lookups:get-today'),
    },
    sessions: {
      getAll:  ()                                => ipcRenderer.invoke('db:sessions:get-all'),
      delete:  (id: string)                      => ipcRenderer.invoke('db:sessions:delete', id),
      rename:  (id: string, name: string)        => ipcRenderer.invoke('db:sessions:rename', id, name),
    },
    sessionMaps: {
      getForSession: (sessionId: string) => ipcRenderer.invoke('db:session-maps:get-for-session', sessionId),
    },
    wealth: {
      series:    (from: number, to: number)  => ipcRenderer.invoke('db:wealth:series', from, to),
      latestBreakdown: ()                    => ipcRenderer.invoke('db:wealth:latest-breakdown'),
      delete:    (id: number)                => ipcRenderer.invoke('db:wealth:delete', id),
      clear:     ()                          => ipcRenderer.invoke('db:wealth:clear'),
      onChanged: (cb: () => void) => {
        const wrapped = () => cb();
        ipcRenderer.on('wealth:changed', wrapped);
        return () => ipcRenderer.removeListener('wealth:changed', wrapped);
      },
    },
    filters: {
      getAll:     ()                                  => ipcRenderer.invoke('db:filters:get-all'),
      insert:     (filter: DbItemFilter)              => ipcRenderer.invoke('db:filters:insert', filter),
      update:     (filter: DbItemFilter)              => ipcRenderer.invoke('db:filters:update', filter),
      delete:     (id: string)                        => ipcRenderer.invoke('db:filters:delete', id),
      setEnabled: (id: string, enabled: boolean)      => ipcRenderer.invoke('db:filters:set-enabled', id, enabled),
    },
    leagues: {
      getAll:   ()                          => ipcRenderer.invoke('db:leagues:get-all'),
      startNow: (name?: string)             => ipcRenderer.invoke('db:leagues:start-now', name),
      setStart: (id: string, ts: number)    => ipcRenderer.invoke('db:leagues:set-start', id, ts),
      onChanged: (cb: () => void) => {
        const wrapped = () => cb();
        ipcRenderer.on('leagues:changed', wrapped);
        return () => ipcRenderer.removeListener('leagues:changed', wrapped);
      },
    },
    prices: {
      history: (itemId: string, from: number, to: number) => ipcRenderer.invoke('db:prices:history', itemId, from, to),
      movers:  (from: number, to: number)                 => ipcRenderer.invoke('db:prices:movers', from, to),
      export:  (from: number, to: number)                 => ipcRenderer.invoke('db:prices:export', from, to),
    },
  },
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electronAPI', api);
