import {contextBridge, ipcRenderer} from 'electron';
import type {ElectronAPI} from '@/shared/contracts/api';
import type {
  DbItem,
  DbItemFilter,
  ItemChangedPatch,
} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {FilterRule} from '@/shared/item-filter';

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
    setOpacity:     (v: number)              => ipcRenderer.send('overlay:set-opacity', v),
    onOpacity: (cb: (v: number) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, v: number) => cb(v);
      ipcRenderer.on('overlay:opacity-changed', wrapped);
      return () => ipcRenderer.removeListener('overlay:opacity-changed', wrapped);
    },
    broadcastSetting: (key: string, value: string) => ipcRenderer.send('settings:broadcast', key, value),
    onSettingChange: (cb: (key: string, value: string) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, key: string, value: string) => cb(key, value);
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
    setLowStockThreshold: (n: number)   => ipcRenderer.send('engine:set-low-stock-threshold', n),
    setOverrealmLootMs:   (ms: number)  => ipcRenderer.send('engine:set-overrealm-loot-ms', ms),
    setCarjackLootMs:     (ms: number)  => ipcRenderer.send('engine:set-carjack-loot-ms', ms),
    setClockworkLootMs:   (ms: number)  => ipcRenderer.send('engine:set-clockwork-loot-ms', ms),
    setLunariaLootMs:     (ms: number)  => ipcRenderer.send('engine:set-lunaria-loot-ms', ms),
    setSandlordWaveMs:    (ms: number)  => ipcRenderer.send('engine:set-sandlord-wave-ms', ms),
    setHuntingLootMs:     (ms: number)  => ipcRenderer.send('engine:set-hunting-loot-ms', ms),
    setAfterlightLootMs:  (ms: number)  => ipcRenderer.send('engine:set-afterlight-loot-ms', ms),
    onEvent: (cb: (event: EngineEvent) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, ev: EngineEvent) => cb(ev);
      ipcRenderer.on('engine:event', wrapped);
      return () => ipcRenderer.removeListener('engine:event', wrapped);
    },
  },

  logging: {
    reloadConfig: () => ipcRenderer.invoke('logging:reload-config'),
    getLogPath:   () => ipcRenderer.invoke('logging:get-log-path'),
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
    settings: {
      getAll: ()                            => ipcRenderer.invoke('db:settings:get-all'),
      set:    (key: string, value: string)  => ipcRenderer.invoke('db:settings:set', key, value),
    },
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
      getRange:  (from: number, to: number)  => ipcRenderer.invoke('db:wealth:get-range', from, to),
      getLatest: (limit: number)             => ipcRenderer.invoke('db:wealth:get-latest', limit),
      delete:    (id: number)                => ipcRenderer.invoke('db:wealth:delete', id),
      clear:     ()                          => ipcRenderer.invoke('db:wealth:clear'),
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
