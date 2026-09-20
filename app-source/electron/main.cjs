const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, Notification, nativeTheme, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { JsonStorage, normalizeContact } = require('./storage.cjs')
const { SharedProvidersStore } = require('./providers-store.cjs')
const { DouyinService } = require('./automation.cjs')
const { AiService, fetchWeatherContext, fetchHotTopicsCached, hotTopicForSparkCached, normalizeBaseUrl } = require('./ai-service.cjs')
const { checkUpdate } = require('./update-service.cjs')

let mainWindow
let tray
let providersStore = null
let activeAccount = null
// 多账号并发服务注册表：accountId -> { storage, ai, douyin }。
// 所有账号的 worker 常驻并发；切换账号只改变界面展示目标。
const services = new Map()
let isQuitting = false
let ownsBytedanceProtocol = false

function getActiveServices() {
  return (activeAccount && services.get(activeAccount)) || null
}
function getActiveStorage() {
  return getActiveServices()?.storage || null
}

// 未捕获异常记录到日志但不退出：桌面自动化应用要尽量活着
process.on('uncaughtException', (error) => {
  try {
    getActiveStorage()?.addLog?.({ id: Date.now(), at: new Date().toISOString(), type: 'crash', message: '未捕获异常', detail: { error: String(error?.stack || error?.message || error) } })
  } catch {}
})
process.on('unhandledRejection', (reason) => {
  try {
    getActiveStorage()?.addLog?.({ id: Date.now(), at: new Date().toISOString(), type: 'crash', message: '未处理的 Promise 拒绝', detail: { error: String(reason?.stack || reason?.message || reason) } })
  } catch {}
})

const BYTEDANCE_PROTOCOL = 'bytedance'
const assetPath = (name) => path.join(__dirname, '..', 'dist', name)
const hasBytedanceUrl = (argv) => argv.some((value) => typeof value === 'string' && /^bytedance:/i.test(value))
const hasSingleInstanceLock = app.requestSingleInstanceLock()

// 抖音页面高频探测 bytedance:// 协议，每个探测拉起一个短命进程；
// 拿不到单实例锁立即 exit(0)，避免进程堆积吃满内存。
if (!hasSingleInstanceLock) app.exit(0)

// 隐藏聊天页自动播放对方视频会常驻吃 CPU，禁止无手势自动播放
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required')

// 内存压缩优化：
// 1. 限制 V8 堆老生代上限为 256MB 并开启 expose-gc，促使引擎积极垃圾回收，防止堆无限制膨胀
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --expose-gc')

// 2. 限制渲染子进程数，指示 Chromium 合并辅助进程，避免过多独立子进程常驻
app.commandLine.appendSwitch('renderer-process-limit', '3')

// 3. 裁剪无用后台组件与网络预加载，关闭后台投屏/诊断/翻译
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,Translate')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-domain-reliability')

// 4. GPU 显存与视频缓冲裁剪：后台隐藏视频不需要超大帧缓冲与额外着色器缓存
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// Windows 系统级内存工作集轻量修剪（调用 psapi.dll!EmptyWorkingSet 刷出物理工作集）
const TRIM_PS_SCRIPT = `
$p = Get-Process -Name '抖音回复助手' -ErrorAction SilentlyContinue
if ($p) {
  $d = @'
using System;
using System.Runtime.InteropServices;
public static class WinMem {
  [DllImport("psapi.dll")]
  public static extern int EmptyWorkingSet(IntPtr h);
}
'@
  if (-not ([System.Management.Automation.PSTypeName]'WinMem').Type) {
    try { Add-Type -TypeDefinition $d } catch {}
  }
  foreach ($x in $p) {
    try { [WinMem]::EmptyWorkingSet($x.Handle) } catch {}
  }
}
`
const TRIM_B64_CMD = Buffer.from(TRIM_PS_SCRIPT, 'utf16le').toString('base64')

function trimAppWorkingSet() {
  if (process.platform !== 'win32') return
  try {
    if (typeof global.gc === 'function') global.gc()
    const cp = require('node:child_process')
    cp.exec(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${TRIM_B64_CMD}`, { windowsHide: true }, () => {})
  } catch {}
}

function imageOrFallback(...names) {
  for (const name of names) {
    const image = nativeImage.createFromPath(assetPath(name))
    if (!image.isEmpty()) return image
  }
  return nativeImage.createEmpty()
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  }
  if (!mainWindow) return
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  // Windows 前台锁定绕过：置顶唤醒并聚焦后解除置顶
  mainWindow.setAlwaysOnTop(true)
  mainWindow.focus()
  mainWindow.setAlwaysOnTop(false)
}

app.on('second-instance', (_event, argv) => {
  if (hasBytedanceUrl(argv)) return // 协议探测启动，静默吞掉
  showMainWindow()
})

function createWindow() {
  const settings = getActiveStorage()?.get()?.settings || {}
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    icon: assetPath('app-icon.png'),
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
  mainWindow.once('ready-to-show', () => {
    if (!settings.startMinimized) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.on('close', (event) => {
    if (!isQuitting && getActiveStorage()?.get()?.settings?.minimizeToTray !== false) {
      event.preventDefault()
      mainWindow.hide()
      setTimeout(trimAppWorkingSet, 1500)
    }
  })
}

function applySystemSettings(settings = {}) {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchOnStartup), openAsHidden: Boolean(settings.startMinimized) })
  }
}

// 桌面通知：按"产生事件的账号"自己的通知设置过滤
function notifyAutomationEvent(event, accountId = activeAccount) {
  const svc = accountId ? services.get(accountId) : null
  const settings = svc?.storage?.get()?.settings || {}
  if (!settings.desktopNotifications || !Notification.isSupported() || event?.type !== 'log') return
  const type = String(event.payload?.type || '')
  if (type === 'verification_required' || type === 'verification_cleared') {
    new Notification({
      title: type === 'verification_required' ? '抖音回复助手需要人工验证' : '抖音回复助手验证已通过',
      body: event.payload?.message || (type === 'verification_required' ? '请在登录窗口完成安全验证，自动回复已暂停' : '自动回复已恢复'),
      silent: false,
    }).show()
    return
  }
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
    { label: '显示抖音回复助手', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

ipcMain.handle('app:info', () => ({
  name: '抖音回复助手',
  version: app.getVersion(),
  platform: process.platform,
}))

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
  const svc = getActiveServices()
  if (!svc?.douyin) throw new Error('抖音登录服务尚未初始化，请重启抖音回复助手')
  return svc.douyin
}

// ---- 多账号管理 ----
function accountRoot() {
  return path.join(app.getPath('userData'), 'accounts')
}
function accountIndexPath() {
  return path.join(app.getPath('userData'), 'accounts.json')
}
function readAccountIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(accountIndexPath(), 'utf8'))
    const list = Array.isArray(raw.list) ? raw.list.filter((item) => item && item.id) : []
    return { active: typeof raw.active === 'string' ? raw.active : (list[0]?.id || null), list }
  } catch {
    return { active: null, list: [] }
  }
}
function writeAccountIndex(index) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(accountIndexPath(), JSON.stringify(index, null, 2), 'utf8')
}
function accountSummary(accountId) {
  try {
    const file = path.join(accountRoot(), accountId, 'state.json')
    if (!fs.existsSync(file)) return { contacts: 0 }
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { contacts: Array.isArray(state.contacts) ? state.contacts.length : 0 }
  } catch {
    return { contacts: 0 }
  }
}
function accountPartition(accountId) {
  // 默认账号沿用旧 partition，迁移后旧登录态不丢失
  return accountId === 'default' ? 'persist:douyin-account' : `persist:douyin-account-${accountId}`
}

// 每账号 storage 统一经共享模型列表视图包装：所有账号读写同一份 providers.json
function makeSharedProvidersView(baseStorage) {
  return {
    get() {
      const state = baseStorage.get()
      return { ...state, providers: providersStore ? providersStore.get() : (state.providers || []) }
    },
    update(patch) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'providers')) {
        const { providers, ...rest } = patch
        if (rest && Object.keys(rest).length) baseStorage.update(rest)
        if (providersStore) providersStore.save(providers)
        return this.get()
      }
      baseStorage.update(patch)
      return this.get()
    },
    addLog: (entry) => baseStorage.addLog(entry),
  }
}

function startAccountServices(accountId) {
  if (services.has(accountId)) return services.get(accountId)
  const dir = path.join(accountRoot(), accountId)
  fs.mkdirSync(dir, { recursive: true })
  const wrappedStorage = makeSharedProvidersView(new JsonStorage(dir))
  const ai = new AiService(wrappedStorage)
  const entry = { storage: wrappedStorage, ai, douyin: null }
  entry.douyin = new DouyinService({
    storage: entry.storage,
    ai: entry.ai,
    partition: accountPartition(accountId),
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('douyin:event', { ...event, accountId })
      notifyAutomationEvent(event, accountId)
    },
  })
  entry.douyin.startWorker()
  services.set(accountId, entry)
  return entry
}

function stopAccountServices(accountId) {
  const entry = services.get(accountId)
  if (!entry) return
  try { entry.douyin?.destroy() } catch {}
  services.delete(accountId)
}

function activateAccount(accountId) {
  if (!services.has(accountId)) startAccountServices(accountId)
  activeAccount = accountId
  const entry = getActiveServices()
  if (entry) applySystemSettings(entry.storage.get().settings)
  return entry
}

async function clearAccount(accountId, kind) {
  if (!accountId) throw new Error('账号不存在')
  const index = readAccountIndex()
  if (!index.list.some((item) => item.id === accountId)) throw new Error('账号不存在')
  if (kind === 'logout') {
    await session.fromPartition(accountPartition(accountId)).clearStorageData()
    const entry = services.get(accountId)
    if (entry?.douyin) {
      entry.douyin.lastSeen.clear()
      entry.douyin.lastSent.clear()
    }
    return { ok: true, kind: 'logout' }
  }
  if (kind === 'wipe') {
    stopAccountServices(accountId)
    await session.fromPartition(accountPartition(accountId)).clearStorageData()
    fs.rmSync(path.join(accountRoot(), accountId), { recursive: true, force: true })
    const next = readAccountIndex()
    const list = next.list.filter((item) => item.id !== accountId)
    const active = next.active === accountId ? (list[0]?.id || null) : next.active
    writeAccountIndex({ active, list })
    if (activeAccount === accountId && active) activateAccount(active)
    if (!activeAccount && active) activateAccount(active)
    return { ok: true, kind: 'wipe', active, accounts: list.map((item) => ({ ...item, ...accountSummary(item.id) })) }
  }
  throw new Error('未知的清除类型')
}

function listAccounts() {
  const index = readAccountIndex()
  return {
    active: index.active,
    accounts: index.list.map((item) => ({ ...item, ...accountSummary(item.id) })),
  }
}

// ---- IPC ----
ipcMain.handle('douyin:open-login', () => getDouyinService().openLogin())
ipcMain.handle('douyin:status', () => getDouyinService().getStatus())
ipcMain.handle('douyin:logout', () => getDouyinService().logout())
ipcMain.handle('douyin:sync-contacts', () => getDouyinService().syncContacts())
ipcMain.handle('douyin:learn-contact', (_event, name) => getDouyinService().learnConversation(name))
ipcMain.handle('douyin:send-message', (_event, { name, text }) => getDouyinService().sendMessage(name, text))
ipcMain.handle('douyin:send-task', (_event, { name, task }) => getDouyinService().sendTask(name, task))

ipcMain.handle('accounts:list', () => listAccounts())
ipcMain.handle('accounts:add', () => {
  const id = `acc-${Date.now().toString(36)}`
  const name = `账号 ${new Date().toLocaleDateString('zh-CN')} ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  const index = readAccountIndex()
  index.list.push({ id, name })
  index.active = id
  writeAccountIndex(index)
  activateAccount(id)
  return { ok: true, active: id, accounts: listAccounts().accounts }
})
ipcMain.handle('accounts:switch', (_event, accountId) => {
  const index = readAccountIndex()
  if (!index.list.some((item) => item.id === accountId)) throw new Error('账号不存在')
  index.active = accountId
  writeAccountIndex(index)
  activateAccount(accountId)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account:changed', { active: accountId })
  return { ok: true, active: accountId, state: getActiveStorage().get() }
})
ipcMain.handle('accounts:rename', (_event, { accountId, name }) => {
  const index = readAccountIndex()
  const item = index.list.find((entry) => entry.id === accountId)
  if (!item) throw new Error('账号不存在')
  item.name = String(name || '').trim() || item.name
  writeAccountIndex(index)
  return { ok: true, accounts: listAccounts().accounts }
})
ipcMain.handle('accounts:logout', async (_event, accountId) => clearAccount(accountId, 'logout'))
ipcMain.handle('accounts:wipe', async (_event, accountId) => clearAccount(accountId, 'wipe'))
ipcMain.handle('accounts:active-state', () => ({ active: activeAccount, state: getActiveStorage()?.get() ?? null }))

ipcMain.handle('automation:get-state', () => {
  const entry = getActiveServices()
  if (!entry) throw new Error('本机配置尚未加载，请重启抖音回复助手')
  return entry.storage.get()
})
ipcMain.handle('automation:update', (_event, config) => {
  const entry = getActiveServices()
  if (!entry) throw new Error('本机配置尚未加载，请重试')
  const next = entry.storage.update(config || {})
  if (config?.settings) applySystemSettings(next.settings)
  entry.douyin?.startWorker()
  return { ok: true, state: next }
})

// AI 服务 IPC：统一捕获异常
function registerAiHandlers() {
  const guarded = (handler, errorKey = 'error') => async (_event, payload) => {
    try {
      return await handler(payload)
    } catch (error) {
      return { ok: false, [errorKey]: error.message }
    }
  }
  ipcMain.handle('ai:save-provider', guarded((provider) => getActiveServices().ai.saveProvider(provider)))
  ipcMain.handle('ai:delete-provider', guarded((name) => getActiveServices().ai.deleteProvider(name)))
  ipcMain.handle('ai:set-primary-provider', guarded((name) => getActiveServices().ai.setPrimaryProvider(name)))
  ipcMain.handle('ai:test-provider', guarded((index) => getActiveServices().ai.test(index), 'message'))
  ipcMain.handle('ai:fetch-models', guarded((payload) => getActiveServices().ai.fetchModels(payload), 'message'))
  // 接口地址实时预览：复用主进程同一套归一化逻辑，前端不重复实现，避免规则漂移
  ipcMain.handle('ai:normalize-base-url', (_event, value) => {
    try { return { ok: true, baseUrl: normalizeBaseUrl(value) } } catch (error) { return { ok: false, message: error.message } }
  })
  ipcMain.handle('ai:draft', guarded((payload) => getActiveServices().ai.draft(payload)))
  // 训练场：用户示范自己的回复方式，AI 学习（样例 + 风格统计 + 对话历史）
  ipcMain.handle('train:learn', guarded(async (payload) => {
    const entry = getActiveServices()
    if (!entry) throw new Error('本机配置尚未加载，请重启抖音回复助手')
    const name = String(payload?.name || '').trim()
    if (!name) throw new Error('缺少训练对象名称')
    // 训练对象不存在时先创建（虚拟联系人，不影响真实联系人）
    const before = entry.storage.get()
    if (!(before.contacts || []).some((c) => c.name === name)) {
      const created = normalizeContact({ id: name, name, profile: { relationship: payload?.relationship || '训练对象' } })
      entry.storage.update({ contacts: [...(before.contacts || []), created] })
    }
    if (payload?.incoming) {
      entry.douyin.recordConversationMessage(name, 'contact', String(payload.incoming).slice(0, 300), { id: name, name }, { human: true })
    }
    let learned = false
    let examplesCount = 0
    if (payload?.userText) {
      // 用户示范：进对话历史 + 风格统计（human:true），并进入"本人说话样例"（prompt 最高优先级）
      const updated = entry.douyin.recordConversationMessage(name, 'me', String(payload.userText).slice(0, 200), { id: name, name }, { human: true })
      const after = entry.storage.get()
      const contacts = [...(after.contacts || [])]
      const idx = contacts.findIndex((c) => c.name === name)
      if (idx >= 0) {
        const profile = { ...(contacts[idx].profile || {}) }
        const examples = (profile.examples || []).filter((item) => item !== payload.userText)
        examples.push(String(payload.userText).trim())
        profile.examples = examples.slice(-12)
        contacts[idx] = { ...contacts[idx], profile }
        entry.storage.update({ contacts })
        examplesCount = profile.examples.length
      }
      learned = true
    } else if (payload?.acceptAiText) {
      // 直接采用 AI 原文：只进对话历史，不进风格统计（防止 AI 学自己）
      entry.douyin.recordConversationMessage(name, 'me', String(payload.acceptAiText).slice(0, 200), { id: name, name }, { human: false })
    }
    const after = entry.storage.get()
    const trained = (after.contacts || []).find((c) => c.name === name)
    return {
      ok: true, learned, examplesCount,
      styleSummary: trained?.learning?.ownerStyle?.summary || '样本不足',
      historyCount: trained?.learning?.messages?.length || 0,
    }
  }))
  // AI 拟一条"今日播报"问候（预览，不发送）：抓取天气/热点 → 续火花文案链路。
  // 供任务页预览与对话理解基准（spark-sim）驱动。
  ipcMain.handle('ai:draft-spark', guarded(async (payload) => {
    const entry = getActiveServices()
    if (!entry) throw new Error('本机配置尚未加载，请重启抖音回复助手')
    const name = String(payload?.name || '').trim()
    if (!name) throw new Error('缺少联系人名称')
    const state = entry.storage.get()
    const contact = (state.contacts || []).find((c) => c.name === name) || { id: name, name, profile: {}, learning: { messages: payload?.history || [], facts: [], topicLog: [], mediaLog: [] } }
    if (Array.isArray(payload?.history) && contact.learning) contact.learning.messages = payload.history
    let weather = ''
    let hotTopic = ''
    try { await fetchHotTopicsCached() } catch { /* 抓取失败则热点段落自动跳过 */ }
    try { weather = await fetchWeatherContext(entry.storage) } catch { weather = '' }
    try { hotTopic = hotTopicForSparkCached() } catch { hotTopic = '' }
    const result = await entry.ai.draftSparkMessage({ contact, task: payload?.task || {}, weather, hotTopic })
    return { ...result, weatherUsed: weather, hotTopicUsed: hotTopic }
  }))
  ipcMain.handle('ai:get-skills', guarded(() => ({ ok: true, skills: getActiveStorage().get().aiSkills || [] })))
  ipcMain.handle('ai:save-skills', guarded((skills) => getActiveServices().ai.saveSkills(skills)))
  ipcMain.handle('ai:import-skills', guarded((rawText) => getActiveServices().ai.importSkills(rawText)))
  ipcMain.handle('ai:clear-learning', guarded((name) => {
    if (typeof name !== 'string' || !name) throw new Error('缺少联系人名称')
    const entry = getActiveServices()
    const state = entry.storage.get()
    const contacts = (state.contacts || []).map((contact) => {
      if (contact.name !== name || !contact.learning) return contact
      const next = { ...contact }
      delete next.learning
      return next
    })
    entry.storage.update({ contacts })
    return { ok: true, name }
  }))
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  if (process.platform === 'win32') {
    app.setAppUserModelId('douyin-reply-assistant.desktop')
    ownsBytedanceProtocol = app.setAsDefaultProtocolClient(BYTEDANCE_PROTOCOL)
  }

  // 账号索引；首次运行把旧版根 state.json 迁移为 default 账号
  let index = readAccountIndex()
  if (!index.list.length) {
    const legacyState = path.join(app.getPath('userData'), 'state.json')
    const defaultId = 'default'
    const dir = path.join(accountRoot(), defaultId)
    fs.mkdirSync(dir, { recursive: true })
    if (fs.existsSync(legacyState) && !fs.existsSync(path.join(dir, 'state.json'))) {
      try { fs.copyFileSync(legacyState, path.join(dir, 'state.json')) } catch {}
    }
    index = { active: defaultId, list: [{ id: defaultId, name: '默认账号' }] }
    writeAccountIndex(index)
  }
  providersStore = new SharedProvidersStore(app.getPath('userData'))
  for (const item of index.list) startAccountServices(item.id)
  activeAccount = (index.active && services.has(index.active)) ? index.active : (index.list[0]?.id || null)
  getActiveStorage()?.addLog?.({ type: 'app_boot', message: `抖音回复助手 v${app.getVersion()} 已启动`, detail: { version: app.getVersion() } })
  registerAiHandlers()
  createWindow()
  createTray()
  // 定时执行轻量工作集修剪（启动 30 秒后首跑，之后每 15 分钟一次，配合 global.gc 保持低内存常驻）
  setTimeout(trimAppWorkingSet, 30000)
  setInterval(trimAppWorkingSet, 15 * 60 * 1000)
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (isQuitting || process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  isQuitting = true
  for (const entry of services.values()) {
    try { await entry.douyin?.destroy() } catch { /* ignore quit-time errors */ }
  }
  if (ownsBytedanceProtocol) {
    app.removeAsDefaultProtocolClient(BYTEDANCE_PROTOCOL)
    ownsBytedanceProtocol = false
  }
})
