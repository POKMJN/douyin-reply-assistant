const fs = require('node:fs')
const path = require('node:path')

// v2 数据模型。相对 v0.7.x 的变化：
// - 移除：话题库(topicPool)、话题代问(inquiries)、视频分享(videoShare)、远程面板配置、
//   外观自定义（字号/强调色/背景色/动效/模糊）——均属死代码或性能负担。
// - 新增：contacts[].turn（轮次状态机持久化状态）、learning.mediaLog（视频上下文权重层）。
// - 旧字段在 read() 迁移时剥离，联系人学习数据（messages/facts/topicLog/styleMessages）完整保留。
const defaults = {
  version: 2,
  automation: { autoReply: false, paused: false, sparks: [], dailyLimit: 30, maxPerContactDaily: 12, blacklist: [], aiDisabledContacts: [] },
  contacts: [],
  providers: [],
  aiSkills: [],
  logs: [],
  sendHistory: [],
  pendingDrafts: [],
  proactiveState: { date: '', sentToday: 0, lastSentAt: 0, sentContacts: [] },
  lastSeenPairs: [],
  lastSentPairs: [],
  appearance: { theme: 'auto', defaultTone: '' },
  settings: {
    launchOnStartup: false, startMinimized: false, minimizeToTray: true, confirmBeforeSend: true,
    desktopNotifications: true, soundNotifications: false, notifyOnSuccess: true, notifyOnFailure: true,
    autoLearnContacts: true, refreshInterval: '5', quietHours: false, quietStart: '23:00', quietEnd: '07:00',
    // 媒体识别（沿用旧字段名，automation 层零改动复用）
    videoReplyEnabled: true, videoRecognitionEnabled: true, videoLowConfidenceReply: true, videoAnalysisFirst: true, videoRecognitionMode: 'smart',
    // v2 默认关闭多候选：单候选 + 一次自然化重写足够，减少一半 API 调用与延迟
    multiCandidateReply: false,
    // 双消息（允许而非必须）：每次回复按此概率补一条更短的随口话；0 = 关闭
    twoMessageChance: 0.35,
    // 续火花"今日播报"天气城市（留空按 IP 自动定位）
    weatherCity: '',
    saveLogs: true, logRetention: '30', showAiModelLabel: true, aiReplyDraftOnly: false, failoverEnabled: true,
    longTermMemory: true,
    proactiveChat: { enabled: false, maxPerDay: 2, windowStart: '10:00', windowEnd: '22:00', minIntervalMinutes: 180, sendToDraft: false },
  },
}

const emptyTurn = () => ({ lastHandledKey: '', lastOutgoingAt: 0 })

// 联系人规范化：补齐 turn / profile / learning 缺失字段，剥离已下线功能的残留数据
function normalizeContact(contact) {
  if (!contact || typeof contact !== 'object' || !contact.name) return null
  const profile = { ...(contact.profile || {}) }
  delete profile.videoShare
  const learning = { ...(contact.learning || {}) }
  return {
    ...contact,
    profile,
    learning: {
      ...learning,
      messages: Array.isArray(learning.messages) ? learning.messages : [],
      topicLog: Array.isArray(learning.topicLog) ? learning.topicLog : [],
      mediaLog: Array.isArray(learning.mediaLog) ? learning.mediaLog : [],
      facts: Array.isArray(learning.facts) ? learning.facts : [],
    },
    turn: { ...emptyTurn(), ...(contact.turn || {}) },
  }
}

// 历史日志净化：旧版本写入的启动消息带内部构建标记，对用户无意义且不该出现在界面
const cleanLegacyLogValue = (value) => {
  if (typeof value === 'string') return value.replace(/（重构版[^）]*）/g, '').replace(/rebuild\S*/gi, '').trim()
  if (Array.isArray(value)) return value.map(cleanLegacyLogValue)
  if (value && typeof value === 'object') {
    // build 字段整体删除（内部构建标记，不面向用户）
    const { build: _build, ...rest } = value
    return Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, cleanLegacyLogValue(item)]))
  }
  return value
}
const cleanLegacyLogEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return entry
  return cleanLegacyLogValue({ ...entry })
}

// 迁移：旧版 state.json → v2。宽容读取（旧字段存在即剥离），学习数据原样保留。
function migrateLegacy(input) {
  const saved = input && typeof input === 'object' ? input : {}
  const legacyAutomation = saved.automation || {}
  const automation = {
    ...defaults.automation,
    autoReply: Boolean(legacyAutomation.autoReply),
    paused: Boolean(legacyAutomation.paused),
    sparks: Array.isArray(legacyAutomation.sparks)
      ? legacyAutomation.sparks.filter((task) => task && String(task.kind || 'text') !== 'videoShare' && task.name)
      : [],
    dailyLimit: Number(legacyAutomation.dailyLimit) || defaults.automation.dailyLimit,
    maxPerContactDaily: Number(legacyAutomation.maxPerContactDaily) || defaults.automation.maxPerContactDaily,
    blacklist: Array.isArray(legacyAutomation.blacklist) ? legacyAutomation.blacklist : [],
    aiDisabledContacts: Array.isArray(legacyAutomation.aiDisabledContacts) ? legacyAutomation.aiDisabledContacts : [],
  }
  const appearance = { theme: saved.appearance?.theme === 'dark' ? 'dark' : (saved.appearance?.theme === 'light' ? 'light' : 'auto'), defaultTone: String(saved.appearance?.defaultTone || '') }
  const contacts = (Array.isArray(saved.contacts) ? saved.contacts : []).map(normalizeContact).filter(Boolean)
  return {
    ...structuredClone(defaults),
    contacts,
    providers: Array.isArray(saved.providers) ? saved.providers : [],
    aiSkills: Array.isArray(saved.aiSkills) ? saved.aiSkills : [],
    logs: (Array.isArray(saved.logs) ? saved.logs : []).slice(0, 200).map(cleanLegacyLogEntry),
    sendHistory: Array.isArray(saved.sendHistory) ? saved.sendHistory : [],
    pendingDrafts: Array.isArray(saved.pendingDrafts) ? saved.pendingDrafts.slice(0, 50) : [],
    proactiveState: saved.proactiveState && typeof saved.proactiveState === 'object' ? saved.proactiveState : structuredClone(defaults.proactiveState),
    lastSeenPairs: Array.isArray(saved.lastSeenPairs) ? saved.lastSeenPairs : [],
    lastSentPairs: Array.isArray(saved.lastSentPairs) ? saved.lastSentPairs : [],
    appearance,
    automation,
    settings: { ...defaults.settings, ...(saved.settings || {}) },
  }
}

class JsonStorage {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'state.json')
    // 启动时滚动备份上一会话状态（保留 2 代）：数据损坏时可回滚
    this.backupPreviousState()
    this.state = this.read()
  }

  backupPreviousState() {
    try {
      if (!fs.existsSync(this.filePath)) return
      const dir = path.dirname(this.filePath)
      const prev = path.join(dir, 'state.prev.json')
      const prev2 = path.join(dir, 'state.prev2.json')
      try { if (fs.existsSync(prev)) fs.copyFileSync(prev, prev2) } catch { /* 轮转失败不阻塞启动 */ }
      try { fs.copyFileSync(this.filePath, prev) } catch { /* 备份失败不阻塞启动 */ }
    } catch { /* 备份失败不阻塞启动 */ }
  }

  read() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (saved && Number(saved.version) === 2) {
        // v2 快路径：补齐新增字段后返回
        const base = migrateLegacy(saved)
        return base
      }
      return migrateLegacy(saved || {})
    } catch {
      return structuredClone(defaults)
    }
  }

  get() {
    return { ...this.state }
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
    const tempPath = `${this.filePath}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(tempPath, JSON.stringify(this.state), 'utf8')
      fs.renameSync(tempPath, this.filePath)
    } catch (writeError) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch { /* ignore */ }
      // 主文件仍可读时保留旧状态，不让写盘失败拖垮运行中的进程
      try { JSON.parse(fs.readFileSync(this.filePath, 'utf8')); return this.get() } catch {}
      throw writeError
    }
    return this.get()
  }

  addLog(entry) {
    const settings = { ...defaults.settings, ...(this.state.settings || {}) }
    if (!settings.saveLogs) return this.get()
    const retentionDays = Math.max(0, Number(settings.logRetention) || 0)
    const cutoff = retentionDays ? Date.now() - (retentionDays * 24 * 60 * 60 * 1000) : 0
    const logs = [{ id: Date.now(), at: new Date().toISOString(), ...entry }, ...(this.state.logs || [])]
      .filter((item) => !cutoff || new Date(item.at).getTime() >= cutoff)
      .slice(0, 150)
    return this.update({ logs })
  }
}

module.exports = { JsonStorage, defaults, migrateLegacy, normalizeContact, emptyTurn }
