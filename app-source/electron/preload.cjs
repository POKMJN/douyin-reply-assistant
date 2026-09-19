const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopApp', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  douyin: {
    openLogin: () => ipcRenderer.invoke('douyin:open-login'),
    getStatus: () => ipcRenderer.invoke('douyin:status'),
    logout: () => ipcRenderer.invoke('douyin:logout'),
    syncContacts: () => ipcRenderer.invoke('douyin:sync-contacts'),
    learnContact: (name) => ipcRenderer.invoke('douyin:learn-contact', name),
    sendMessage: (name, text) => ipcRenderer.invoke('douyin:send-message', { name, text }),
    sendTask: (name, task) => ipcRenderer.invoke('douyin:send-task', { name, task }),
  },
  automation: {
    getState: () => ipcRenderer.invoke('automation:get-state'),
    update: (config) => ipcRenderer.invoke('automation:update', config),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: () => ipcRenderer.invoke('accounts:add'),
    switch: (accountId) => ipcRenderer.invoke('accounts:switch', accountId),
    rename: (accountId, name) => ipcRenderer.invoke('accounts:rename', { accountId, name }),
    logout: (accountId) => ipcRenderer.invoke('accounts:logout', accountId),
    wipe: (accountId) => ipcRenderer.invoke('accounts:wipe', accountId),
    activeState: () => ipcRenderer.invoke('accounts:active-state'),
    onChanged: (listener) => {
      const handler = (_event, payload) => listener(payload)
      ipcRenderer.on('account:changed', handler)
      return () => ipcRenderer.removeListener('account:changed', handler)
    },
  },
  ai: {
    saveProvider: (provider) => ipcRenderer.invoke('ai:save-provider', provider),
    deleteProvider: (name) => ipcRenderer.invoke('ai:delete-provider', name),
    setPrimaryProvider: (name) => ipcRenderer.invoke('ai:set-primary-provider', name),
    testProvider: (index) => ipcRenderer.invoke('ai:test-provider', index),
    fetchModels: (payload) => ipcRenderer.invoke('ai:fetch-models', payload),
    normalizeBaseUrl: (value) => ipcRenderer.invoke('ai:normalize-base-url', value),
    draft: (payload) => ipcRenderer.invoke('ai:draft', payload),
    draftSpark: (payload) => ipcRenderer.invoke('ai:draft-spark', payload),
    trainLearn: (payload) => ipcRenderer.invoke('train:learn', payload),
    getSkills: () => ipcRenderer.invoke('ai:get-skills'),
    saveSkills: (skills) => ipcRenderer.invoke('ai:save-skills', skills),
    importSkills: (rawText) => ipcRenderer.invoke('ai:import-skills', rawText),
    clearLearning: (name) => ipcRenderer.invoke('ai:clear-learning', name),
  },
  onDouyinEvent: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('douyin:event', handler)
    return () => ipcRenderer.removeListener('douyin:event', handler)
  },
})
