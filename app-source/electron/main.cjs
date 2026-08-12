const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, Notification, nativeTheme } = require('electron')
const path = require('node:path')
const { JsonStorage } = require('./storage.cjs')
const { DouyinService } = require('./douyin-service.cjs')
const { AiService } = require('./ai-service.cjs')
const { checkUpdate } = require('./update-service.cjs')

let mainWindow
let tray
let storage
let douyin
let ai
let isQuitting = false
let ownsBytedanceProtocol = false

// 防止未捕获异常导致应用直接退出：记录到日志并继续运行。
process.on('uncaughtException', (error) => {
  try {
    const entry = { id: Date.now(), at: new Date().toISOString(), type: 'crash', message: '未捕获异常', detail: { error: String(error?.stack || error?.message || error) } }
    storage?.addLog?.(entry)
  } catch {}
})
process.on('unhandledRejection', (reason) => {
  try {
    const entry = { id: Date.now(), at: new Date().toISOString(), type: 'crash', message: '未处理的 Promise 拒绝', detail: { error: String(reason?.stack || reason?.message || reason) } }
    storage?.addLog?.(entry)
  } catch {}
})

const BYTEDANCE_PROTOCOL = 'bytedance'
const assetPath = (name) => path.join(__dirname, '..', 'dist', name)
const isBytedanceUrl = (value) => typeof value === 'string' && /^bytedance:/i.test(value)
const hasBytedanceUrl = (argv) => argv.some(isBytedanceUrl)
const hasSingleInstanceLock = app.requestSingleInstanceLock()

function imageOrFallback(...names) {
  for (const name of names) {
    const image = nativeImage.createFromPath(assetPath(name))
    if (!image.isEmpty()) return image
  }
  return nativeImage.createEmpty()
}

if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', (_event, argv) => {
  // Douyin probes its desktop protocol repeatedly. Consume those launches silently.
  if (hasBytedanceUrl(argv)) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
})

function createWindow() {
  const settings = storage?.get()?.settings || {}
  const appIcon = assetPath('app-icon.png')
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 680,
    // Win11 Fluent：窗口背景跟随系统明暗（纯色主题，不使用系统 Mica）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    icon: appIcon,
    title: '抖音回复助手',
    autoHideMenuBar: true,
    show: !settings.startMinimized,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!/^file:/i.test(url)) event.preventDefault()
  })
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:;"],
      },
    })
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.on('close', (event) => {
    const minimizeToTray = storage?.get()?.settings?.minimizeToTray !== false
    if (!isQuitting && minimizeToTray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
}

function applySystemSettings(settings = {}) {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchOnStartup), openAsHidden: Boolean(settings.startMinimized) })
  }
}

function notifyAutomationEvent(event) {
  const settings = storage?.get()?.settings || {}
  if (!settings.desktopNotifications || !Notification.isSupported() || event?.type !== 'log') return
  const type = String(event.payload?.type || '')
  const failed = /fail|error/i.test(type)
  const succeeded = /sent|success|answered/i.test(type)
  if ((failed && settings.notifyOnFailure === false) || (succeeded && settings.notifyOnSuccess === false)) return
  if (!failed && !succeeded) return
  new Notification({
    title: failed ? '抖音回复助手任务失败' : '抖音回复助手任务完成',
    body: event.payload?.message || (failed ? '请打开抖音回复助手查看失败原因' : '任务已执行完成'),
    silent: !settings.soundNotifications,
  }).show()
}

function createTray() {
  const icon = imageOrFallback('tray-icon.png', 'app-icon.png')
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('抖音回复助手')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示抖音回复助手', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

ipcMain.handle('app:info', () => ({
  name: '抖音回复助手',
  version: app.getVersion(),
  platform: process.platform,
}))

// 在线检查更新：查询 GitHub Releases 最新版本，返回 { ok, hasUpdate, latestVersion, releaseUrl, assetUrl, ... }
ipcMain.handle('app:check-update', async () => {
  try {
    return { ok: true, ...(await checkUpdate(app.getVersion())) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('app:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url)
  return false
})

function getDouyinService() {
  if (!douyin) throw new Error('抖音登录服务尚未初始化，请重启抖音回复助手')
  return douyin
}

ipcMain.handle('douyin:open-login', () => getDouyinService().openLogin())
ipcMain.handle('douyin:status', () => getDouyinService().getStatus())
ipcMain.handle('douyin:logout', () => getDouyinService().logout())
ipcMain.handle('douyin:sync-contacts', () => getDouyinService().syncContacts())
ipcMain.handle('douyin:learn-contact', (_event, name) => getDouyinService().learnConversation(name))
ipcMain.handle('douyin:send-message', (_event, { name, text }) => getDouyinService().sendMessage(name, text))
ipcMain.handle('douyin:send-task', (_event, { name, task }) => getDouyinService().sendTask(name, task))
ipcMain.handle('douyin:start-inquiry', (_event, payload) => getDouyinService().startInquiry(payload || {}))
ipcMain.handle('automation:get-state', () => storage.get())
ipcMain.handle('automation:update', (_event, config) => {
  if (!storage) throw new Error('本机配置尚未加载，请重试')
  const next = storage.update(config || {})
  if (config?.settings) applySystemSettings(next.settings)
  douyin?.startWorker()
  return { ok: true, state: next }
})

// AI 服务 IPC:统一捕获异常;除 ai:test-provider 返回 { ok: false, message } 外,
// 其余均返回 { ok: false, error }
function registerAiHandlers() {
  const guarded = (handler, errorKey = 'error') => async (_event, payload) => {
    try {
      return await handler(payload)
    } catch (error) {
      return { ok: false, [errorKey]: error.message }
    }
  }
  ipcMain.handle('ai:save-provider', guarded((provider) => ai.saveProvider(provider)))
  ipcMain.handle('ai:delete-provider', guarded((index) => ai.deleteProvider(index)))
  ipcMain.handle('ai:set-primary-provider', guarded((index) => ai.setPrimaryProvider(index)))
  ipcMain.handle('ai:test-provider', guarded((index) => ai.test(index), 'message'))
  ipcMain.handle('ai:draft', guarded((payload) => ai.draft(payload)))
  ipcMain.handle('ai:get-skills', guarded(() => ({ ok: true, skills: storage.get().aiSkills || [] })))
  ipcMain.handle('ai:save-skills', guarded((skills) => ai.saveSkills(skills)))
  ipcMain.handle('ai:import-skills', guarded((rawText) => ai.importSkills(rawText)))
  ipcMain.handle('ai:clear-learning', guarded((name) => {
    if (typeof name !== 'string' || !name) throw new Error('缺少联系人名称')
    const state = storage.get()
    const contacts = (state.contacts || []).map((contact) => {
      if (contact.name !== name || !contact.learning) return contact
      const next = { ...contact }
      delete next.learning
      return next
    })
    storage.update({ contacts })
    return { ok: true, name }
  }))
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  if (process.platform === 'win32') {
    app.setAppUserModelId('douyin-reply-assistant.desktop')
    ownsBytedanceProtocol = app.setAsDefaultProtocolClient(BYTEDANCE_PROTOCOL)
  }
  storage = new JsonStorage(app.getPath('userData'))
  applySystemSettings(storage.get().settings)
  ai = new AiService(storage)
  registerAiHandlers()
  douyin = new DouyinService({
    storage,
    ai,
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('douyin:event', event)
      notifyAutomationEvent(event)
    },
  })
  createWindow()
  createTray()
  douyin.startWorker()
  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
    else createWindow()
  })
})

app.on('window-all-closed', () => {
  if (isQuitting || process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  isQuitting = true
  try { await douyin?.destroy() } catch { /* ignore quit-time errors */ }
  if (ownsBytedanceProtocol) {
    app.removeAsDefaultProtocolClient(BYTEDANCE_PROTOCOL)
    ownsBytedanceProtocol = false
  }
})
