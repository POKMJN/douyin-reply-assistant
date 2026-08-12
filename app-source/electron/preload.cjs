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
    startInquiry: (name, question) => ipcRenderer.invoke('douyin:start-inquiry', { name, question }),
  },
  automation: {
    getState: () => ipcRenderer.invoke('automation:get-state'),
    update: (config) => ipcRenderer.invoke('automation:update', config),
  },
  ai: {
    saveProvider: (provider) => ipcRenderer.invoke('ai:save-provider', provider),
    deleteProvider: (index) => ipcRenderer.invoke('ai:delete-provider', index),
    setPrimaryProvider: (index) => ipcRenderer.invoke('ai:set-primary-provider', index),
    testProvider: (index) => ipcRenderer.invoke('ai:test-provider', index),
    draft: (payload) => ipcRenderer.invoke('ai:draft', payload),
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
