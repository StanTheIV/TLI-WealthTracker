import {contextBridge, ipcRenderer} from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  pickFolder:    () => ipcRenderer.invoke('dialog:pick-folder') as Promise<string | null>,
  checkLogFile:  (folder: string) => ipcRenderer.invoke('fs:check-log-file', folder) as Promise<boolean>,

  overlay: {
    show:           ()                       => ipcRenderer.send('overlay:show'),
    hide:           ()                       => ipcRenderer.send('overlay:hide'),
    setClickThrough:(enabled: boolean)       => ipcRenderer.send('overlay:set-clickthrough', enabled),
    setPosition:    (x: number, y: number)   => ipcRenderer.send('overlay:set-position', x, y),
    setSize:        (w: number, h: number)   => ipcRenderer.send('overlay:set-size', w, h),
    notifyReady:    ()                       => ipcRenderer.send('overlay:sized'),
    moveBy:         (dx: number, dy: number) => ipcRenderer.send('overlay:move-by', dx, dy),
    getPosition:    ()                       => ipcRenderer.invoke('overlay:get-position'),
    setOpacity:     (v: number)              => ipcRenderer.send('overlay:set-opacity', v),
    onOpacity: (cb: (v: number) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, v: number) => cb(v);
      ipcRenderer.on('overlay:opacity', wrapped);
      return () => ipcRenderer.removeListener('overlay:opacity', wrapped);
    },
    broadcastSetting: (key: string, value: string) => ipcRenderer.send('settings:broadcast', key, value),
    onSettingChange: (cb: (key: string, value: string) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, key: string, value: string) => cb(key, value);
      ipcRenderer.on('settings:change', wrapped);
      return () => ipcRenderer.removeListener('settings:change', wrapped);
    },
  },

  engine: {
    start:           (logPath: string)                    => ipcRenderer.send('engine:start', logPath),
    startWithSession:(logPath: string, sessionId: string) => ipcRenderer.send('engine:start-with-session', logPath, sessionId),
    stop:            ()                                   => ipcRenderer.send('engine:stop'),
    pause:           ()                                   => ipcRenderer.send('engine:pause'),
    resume:          ()                                   => ipcRenderer.send('engine:resume'),
    updateFilterRules: (rules: unknown) => ipcRenderer.send('engine:update-filter-rules', rules),
    onEvent: (cb: (event: unknown) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, ev: unknown) => cb(ev);
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
      upsert:     (item: unknown)                       => ipcRenderer.invoke('db:items:upsert', item),
      setName:    (id: string, name: string)            => ipcRenderer.invoke('db:items:set-name', id, name),
      setType:    (id: string, type: string)            => ipcRenderer.invoke('db:items:set-type', id, type),
      setPrice:   (id: string, price: number)           => ipcRenderer.invoke('db:items:set-price', id, price),
      lookupName:   (id: string)                          => ipcRenderer.invoke('db:items:lookup-name', id),
      importBatch:  (items: unknown)                      => ipcRenderer.invoke('db:items:import-batch', items),
    },
    lookups: {
      getToday: () => ipcRenderer.invoke('db:lookups:today'),
    },
    sessions: {
      getAll:  ()                                => ipcRenderer.invoke('db:sessions:get-all'),
      insert:  (session: unknown)                => ipcRenderer.invoke('db:sessions:insert', session),
      update:  (session: unknown)                => ipcRenderer.invoke('db:sessions:update', session),
      delete:  (id: string)                      => ipcRenderer.invoke('db:sessions:delete', id),
      rename:  (id: string, name: string)        => ipcRenderer.invoke('db:sessions:rename', id, name),
      getOne:  (id: string)                      => ipcRenderer.invoke('db:sessions:get-one', id),
    },
    seasonal: {
      getAll:   ()              => ipcRenderer.invoke('db:seasonal:get-all'),
      upsert:   (stat: unknown) => ipcRenderer.invoke('db:seasonal:upsert', stat),
    },
    wealth: {
      insert:    (point: unknown)            => ipcRenderer.invoke('db:wealth:insert', point),
      getRange:  (from: number, to: number)  => ipcRenderer.invoke('db:wealth:get-range', from, to),
      getLatest: (limit: number)             => ipcRenderer.invoke('db:wealth:get-latest', limit),
      clear:     ()                          => ipcRenderer.invoke('db:wealth:clear'),
    },
    filters: {
      getAll:     ()                                  => ipcRenderer.invoke('db:filters:get-all'),
      insert:     (filter: unknown)                   => ipcRenderer.invoke('db:filters:insert', filter),
      update:     (filter: unknown)                   => ipcRenderer.invoke('db:filters:update', filter),
      delete:     (id: string)                        => ipcRenderer.invoke('db:filters:delete', id),
      setEnabled: (id: string, enabled: boolean)      => ipcRenderer.invoke('db:filters:set-enabled', id, enabled),
    },
  },
});
