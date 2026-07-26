const fs = require('node:fs')
const path = require('node:path')

const defaults = {
  automation: { autoReply: false, paused: false, rules: [], sparks: [], inquiries: [], dailyLimit: 30, blacklist: [], aiDisabledContacts: [] },
  contacts: [],
  providers: [],
  profiles: [],
  logs: [],
  sendHistory: [],
  settings: {
    launchOnStartup: false, startMinimized: false, minimizeToTray: true, confirmBeforeSend: true,
    desktopNotifications: true, soundNotifications: false, notifyOnSuccess: true, notifyOnFailure: true,
    autoLearnContacts: true, refreshInterval: '5', quietHours: false, quietStart: '23:00', quietEnd: '07:00',
    videoReplyEnabled: true, videoRecognitionEnabled: true, videoLowConfidenceReply: true, videoAnalysisFirst: true, videoRecognitionStrength: 'standard',
    saveLogs: true, logRetention: '30', showAiModelLabel: true,
  },
}

const normalizeVideoShareItems = (task) => {
  const raw = Array.isArray(task?.videos) && task.videos.length
    ? task.videos
    : String(task?.videoList || task?.message || '').split(/\r?\n/)
  return raw.map((item) => {
    if (typeof item === 'string') {
      const text = item.trim()
      const url = (text.match(/https?:\/\/\S+/i) || [''])[0].replace(/[，,。.;；]+$/, '')
      const withoutUrl = url ? text.replace(url, '') : text
      const parts = withoutUrl.split(/\s*(?:\||｜| - | -- |：|:)\s*/).map((part) => part.trim()).filter(Boolean)
      return { url, title: parts[0] || '', note: parts.slice(1).join(' ') || parts[0] || '' }
    }
    return {
      url: String(item?.url || '').trim(),
      title: String(item?.title || '').trim(),
      note: String(item?.note || item?.summary || '').trim(),
    }
  }).filter((item) => /^https?:\/\//i.test(item.url))
}

const normalizeVideoShareCategories = (value) => {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，、;；|]+/)
  return [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))]
}

const fixLegacyText = (value) => {
  if (typeof value !== 'string') return value
  return value
    .replace(/^Auto reply disabled for (.+)$/u, '已跳过 $1：该联系人已关闭 AI 自动回复')
    .replace(/^Sent a message to (.+)$/u, '已向 $1 发送消息')
    .replace(/^Captured media from (.+)$/u, '已捕获 $1 的媒体画面')
    .replace(/鏄嚜宸卞彂鐨勶紝璺宠繃/g, '是自己发的，跳过')
    .replace(/浠婂ぉ宸叉湁鍙戦€佽褰曪紝鏈鏃犻渶琛ョ画/g, '今天已有发送记录，本次无需补续')
}

const fixLegacyLogValue = (value) => {
  if (typeof value === 'string') return fixLegacyText(value)
  if (Array.isArray(value)) return value.map(fixLegacyLogValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fixLegacyLogValue(item)]))
  }
  return value
}

const fixLegacyLogs = (state) => ({
  ...state,
  logs: Array.isArray(state.logs) ? state.logs.map((entry) => fixLegacyLogValue(entry)) : [],
})

const migrateVideoShareTasks = (state) => {
  const automation = state.automation || {}
  const sparks = Array.isArray(automation.sparks) ? automation.sparks : []
  const contacts = Array.isArray(state.contacts) ? state.contacts : []
  const byName = new Map(contacts.map((contact) => [contact.name, contact]))
  const nextSparks = []
  for (const task of sparks) {
    if (String(task?.kind || '') !== 'videoShare') {
      nextSparks.push(task)
      continue
    }
    const contact = byName.get(task.name)
    if (!contact) continue
    const profile = { ...(contact.profile || {}) }
    const existing = profile.videoShare || {}
    profile.videoShare = {
      ...existing,
      enabled: true,
      windowStart: task.windowStart || task.time || existing.windowStart || '12:00',
      windowEnd: task.windowEnd || existing.windowEnd || '22:30',
      maxPerDay: task.maxPerDay || existing.maxPerDay || 3,
      discoveryMode: task.discoveryMode || existing.discoveryMode || 'auto',
      categories: normalizeVideoShareCategories(task.categories).length ? normalizeVideoShareCategories(task.categories) : (existing.categories || []),
      discoveryQuery: task.discoveryQuery || task.keywords || task.topics || existing.discoveryQuery || '',
      videoList: task.videoList || task.message || existing.videoList || '',
      videos: normalizeVideoShareItems(task).length ? normalizeVideoShareItems(task) : (existing.videos || []),
      nextRunAt: task.nextRunAt || existing.nextRunAt || '',
      lastAttemptAt: task.lastAttemptAt || existing.lastAttemptAt || 0,
      lastRunDate: task.lastRunDate || existing.lastRunDate || '',
      videoShareState: task.videoShareState || existing.videoShareState,
    }
    byName.set(contact.name, { ...contact, profile })
  }
  return {
    ...state,
    contacts: contacts.map((contact) => byName.get(contact.name) || contact),
    automation: { ...automation, sparks: nextSparks },
  }
}

class JsonStorage {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'state.json')
    this.state = this.read()
  }

  read() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      const savedAutomation = saved.automation || {}
      // Older builds accidentally sent all top-level patches through the
      // automation IPC handler. Fold those fields back into their proper
      // locations when the app starts so existing data is not lost.
      const nestedAutomation = savedAutomation.automation || {}
      const contacts = (saved.contacts && saved.contacts.length)
        ? saved.contacts
        : (savedAutomation.contacts || [])
      const legacyAiDisabledContacts = Array.isArray(savedAutomation.aiDisabledContacts)
        ? savedAutomation.aiDisabledContacts
        : (savedAutomation.blacklist || [])
      const automation = {
        ...defaults.automation,
        ...savedAutomation,
        ...nestedAutomation,
        aiDisabledContacts: legacyAiDisabledContacts,
        // Previous builds used blacklist for the per-contact AI switch,
        // which also blocked spark tasks. The dedicated field fixes that.
        blacklist: Array.isArray(savedAutomation.aiDisabledContacts) ? (savedAutomation.blacklist || []) : [],
      }
      delete automation.contacts
      delete automation.automation
      const settings = { ...defaults.settings, ...(saved.settings || {}) }
      if (!Object.prototype.hasOwnProperty.call(saved.settings || {}, 'videoRecognitionEnabled')) {
        settings.videoRecognitionEnabled = settings.videoReplyEnabled !== false
      }
      settings.videoReplyEnabled = settings.videoRecognitionEnabled
      return fixLegacyLogs(migrateVideoShareTasks({
        ...structuredClone(defaults),
        ...saved,
        settings,
        contacts,
        automation,
        sendHistory: Array.isArray(saved.sendHistory)
          ? saved.sendHistory
          : (saved.logs || [])
            .filter((entry) => entry.type === 'message_sent' && entry.at && entry.detail?.name)
            .map((entry) => ({ at: entry.at, name: entry.detail.name })),
      }))
    } catch {
      return structuredClone(defaults)
    }
  }

  get() {
    return structuredClone(this.state)
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
    const tempPath = `${this.filePath}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), 'utf8')
      fs.renameSync(tempPath, this.filePath)
    } catch (writeError) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch { /* ignore cleanup errors */ }
      // If the primary path is still readable, keep the old state rather than crashing
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
      .slice(0, 200)
    return this.update({ logs })
  }
}

module.exports = { JsonStorage }
