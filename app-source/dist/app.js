const D = window.desktopApp || {}

const defaults = {
  automation: { autoReply: false, rules: [], sparks: [], inquiries: [], dailyLimit: 30, blacklist: [], aiDisabledContacts: [], paused: false },
  contacts: [],
  providers: [],
  logs: [],
  appearance: { theme: 'light', fontSize: 'medium', accentColor: '#2f7fd8', backgroundColor: '#eef2f5', motion: 'standard', defaultTone: '' },
  settings: {
    launchOnStartup: false, startMinimized: false, minimizeToTray: true, confirmBeforeSend: true,
    desktopNotifications: true, soundNotifications: false, notifyOnSuccess: true, notifyOnFailure: true,
    autoLearnContacts: true, refreshInterval: '5', quietHours: false, quietStart: '23:00', quietEnd: '07:00',
    videoReplyEnabled: true, videoRecognitionEnabled: true, videoLowConfidenceReply: true, videoAnalysisFirst: true, videoRecognitionStrength: 'standard',
    saveLogs: true, logRetention: '30', showAiModelLabel: true, aiReplyDraftOnly: false,
  },
}

const state = {
  section: 'contacts',
  contactTab: 'profile',
  data: structuredClone(defaults),
  selected: null,
  notice: '',
  providerEditing: null,
  sparkEditing: null,
  activity: { tone: 'idle', title: '就绪', detail: '等待操作' },
}

const VIDEO_SHARE_CATEGORIES = [
  '搞笑反转',
  '猫狗萌宠',
  '美食探店',
  '电影剪辑',
  '游戏高能',
  '音乐现场',
  '健身运动',
  '情感共鸣',
  '知识科普',
  '旅行风景',
  '穿搭美妆',
  '生活日常',
  '科技数码',
  '动漫二次元',
  '热点话题',
  '治愈解压',
]

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

const localDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const sparkMessageOptions = (task) => {
  const raw = Array.isArray(task?.messages) && task.messages.length
    ? task.messages
    : String(task?.message || '').split(/\r?\n/)
  return raw.map((item) => String(item || '').trim()).filter(Boolean)
}

const sparkMessageText = (task) => sparkMessageOptions(task).join('\n')

const DEFAULT_SPARK_MESSAGES = [
  '今天也来续个火花呀～',
  '想你啦，来续个火花',
  '今日份火花打卡',
  '路过冒个泡，火花别断～',
  '来啦来啦，续上今天的火花',
  '忙也记得回我一下～',
  '今天过得怎么样？',
  '给你递一朵小火花',
  '保持联系，火花继续',
  '今天也要开心一点',
  '我来补个今日份消息',
  '看到就回我一下呗',
  '火花续上，心情也续上',
  '今天有啥新鲜事吗？',
  '别让火花偷偷熄灭啦',
  '晚点聊，先把火花续上',
  '打个卡，证明我还在',
  '今日份问候到达',
]

const normalizeVideoShareItems = (task) => {
  const raw = Array.isArray(task?.videos) && task.videos.length
    ? task.videos
    : String(task?.videoList || task?.message || '').split(/\r?\n/)
  return raw.map((item) => {
    if (typeof item === 'string') {
      const text = item.trim()
      const url = (text.match(/https?:\/\/\S+/i) || [''])[0]?.replace(/[，,。.;；]+$/, '') || ''
      const withoutUrl = url ? text.replace(url, '') : text
      const parts = withoutUrl.split(/\s*(?:\||｜| - | -- |：|:)\s*/).map((part) => part.trim()).filter(Boolean)
      return { url, title: parts[0] || '', note: parts.slice(1).join(' ') || parts[0] || '' }
    }
    return { url: String(item?.url || '').trim(), title: String(item?.title || '').trim(), note: String(item?.note || item?.summary || '').trim() }
  }).filter((item) => /^https?:\/\//i.test(item.url))
}

const videoShareText = (task) => normalizeVideoShareItems(task)
  .map((item) => `${item.url}${item.title || item.note ? ` | ${item.title || item.note}${item.title && item.note ? ` | ${item.note}` : ''}` : ''}`)
  .join('\n')

const videoShareDiscoveryText = (task) => String(task?.discoveryQuery || task?.keywords || task?.topics || '').trim()

const normalizeVideoShareCategories = (value) => {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，、;；|]+/)
  return [...new Set(raw
    .map((item) => String(item || '').replace(/\s+/g, '').trim())
    .filter((item) => VIDEO_SHARE_CATEGORIES.includes(item)))]
}

const videoShareCategoryChips = (videoShare = {}) => {
  const selected = new Set(normalizeVideoShareCategories(videoShare.categories))
  const stats = videoShare.videoShareState?.categoryStats || {}
  return `<div class="video-category-grid">${VIDEO_SHARE_CATEGORIES.map((category) => {
    const active = selected.has(category)
    const stat = stats[category] || {}
    const replied = Number(stat.replied || 0)
    const sent = Number(stat.sent || 0)
    const meta = replied ? `${replied} 次回应` : (sent ? `${sent} 次尝试` : '')
    return `<button type="button" class="video-category-chip ${active ? 'active' : ''}" data-video-share-category="${esc(category)}" aria-pressed="${active ? 'true' : 'false'}"><span>${esc(category)}</span>${meta ? `<em>${esc(meta)}</em>` : ''}</button>`
  }).join('')}</div>`
}

const dailySparkMessage = (task, value = new Date()) => {
  const options = sparkMessageOptions(task)
  if (!options.length) return String(task?.message || '').trim()
  const date = value instanceof Date ? value : new Date(value)
  const indexForDate = (day) => {
    const key = `${localDateKey(day)}:${task?.id ?? ''}:${task?.name ?? ''}`
    let hash = 0
    for (let index = 0; index < key.length; index += 1) {
      hash = Math.imul(hash ^ key.charCodeAt(index), 16777619) >>> 0
    }
    return hash % options.length
  }
  const todayIndex = indexForDate(date)
  if (options.length > 1) {
    const yesterday = new Date(date)
    yesterday.setDate(yesterday.getDate() - 1)
    if (todayIndex === indexForDate(yesterday)) return options[(todayIndex + 1) % options.length]
  }
  return options[todayIndex]
}

let notifyTimer = null
function notify(message) {
  if (notifyTimer) clearTimeout(notifyTimer)
  state.notice = message
  render()
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    if (state.notice === message) {
      state.notice = ''
      document.querySelector('.notice')?.remove()
    }
  }, 2800)
}

function activeProvider() {
  return state.data.providers?.[0] || null
}

function providerLabel(provider = activeProvider()) {
  return provider ? `${provider.name || '模型'} · ${provider.model || '未命名模型'}` : '未选择模型'
}

function renderActivityBar() {
  const activity = state.activity || { tone: 'idle', title: '就绪', detail: '等待操作' }
  return `<div class="activity-bar" data-tone="${esc(activity.tone || 'idle')}">
    <div class="activity-pulse"><i></i></div>
    <div class="activity-copy"><strong>${esc(activity.title || '就绪')}</strong><span>${esc(activity.detail || '等待操作')}</span></div>
    <div class="activity-meta"><span>${state.data.connected ? '抖音已连接' : '等待扫码登录'}</span><span>${esc(providerLabel())}</span></div>
  </div>`
}

function setActivity(title, detail = '', tone = 'idle') {
  state.activity = { title, detail, tone }
  const bar = document.querySelector('.activity-bar')
  if (!bar) return
  bar.dataset.tone = tone
  const titleEl = bar.querySelector('.activity-copy strong')
  const detailEl = bar.querySelector('.activity-copy span')
  if (titleEl) titleEl.textContent = title
  if (detailEl) detailEl.textContent = detail
}

function setDraftStatus(title, detail = '', tone = 'idle') {
  const status = document.getElementById('message-status')
  if (status) {
    status.dataset.tone = tone
    status.innerHTML = `<strong>${esc(title)}</strong><span>${esc(detail)}</span>`
  }
  setActivity(title, detail, tone)
}

async function load() {
  try {
    const saved = await D.automation.getState()
    state.data = { ...structuredClone(defaults), ...saved }
    state.data.automation = { ...defaults.automation, ...(saved.automation || {}) }
    state.data.appearance = { ...defaults.appearance, ...(saved.appearance || {}) }
    if (state.data.appearance.accentColor === '#e95d48') state.data.appearance.accentColor = defaults.appearance.accentColor
    if (state.data.appearance.backgroundColor === '#cdf2ff') {
      state.data.appearance.backgroundColor = state.data.appearance.theme === 'dark' ? '#172338' : defaults.appearance.backgroundColor
    }
    const status = await D.douyin?.getStatus()
    state.data.connected = Boolean(status?.connected)
  } catch {
    state.data = structuredClone(defaults)
  }
  applyAppearance()
  render()
}

const appearanceThemes = [['light','浅色','#f6f7f9'],['dark','暗色','#0d1117'],['warm','暖色','#fdf9f3'],['forest','森系','#f4faf6']]
const appearanceAccents = ['#2f7fd8','#16a187','#e95d48','#8b5cf6','#e07b39','#db2777']
const appearanceBackgrounds = ['#eef2f5','#e2edf7','#e7f1ec','#fff3df','#f1ebfa','#f8eaef','#f7f8fa','#e8f3f5']
const appearanceMotions = [['quiet','极简','尽量减少界面动效'],['standard','标准','轻量切换和反馈'],['expressive','轻快','更明显的状态响应']]

function applyAppearance() {
  const ap = { ...defaults.appearance, ...(state.data.appearance || {}) }
  const root = document.documentElement
  const safeHex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback
  root.setAttribute('data-theme', ap.theme || defaults.appearance.theme)
  root.setAttribute('data-font-size', ['small', 'medium', 'large'].includes(ap.fontSize) ? ap.fontSize : defaults.appearance.fontSize)
  root.setAttribute('data-motion', ['quiet', 'standard', 'expressive'].includes(ap.motion) ? ap.motion : defaults.appearance.motion)
  root.style.setProperty('--accent', ap.accentColor || defaults.appearance.accentColor)
  root.style.setProperty('--pcl4-user-bg', safeHex(ap.backgroundColor, defaults.appearance.backgroundColor))
}

function douyinIcon(kind = 'note') {
  const paths = {
    contacts: '<path d="M5 18c1.6-3 4-4.5 7-4.5s5.4 1.5 7 4.5"/><circle cx="12" cy="8" r="3.2"/><path d="M4 21h16"/>',
    sparks: '<path d="M13 2 6 13h5l-1 9 8-13h-5l1-7Z"/><path d="M4 18h4m8 0h4"/>',
    strategies: '<path d="M5 6h12a2 2 0 0 1 0 4H9a2 2 0 0 0 0 4h10"/><path d="m16 11 3 3-3 3"/>',
    providers: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M7 10h10M7 14h6"/><path d="M9 19v3m6-3v3"/>',
    settings: '<rect x="5" y="6" width="14" height="12" rx="2"/><path d="M8 10h2m3 0h3M8 14h8"/><circle cx="19" cy="5" r="2"/>',
    audit: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h3"/><path d="m15 16 2 2 4-5"/>',
    note: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M7 11h10"/><path d="M8 18v3m4-3v3m4-3v3"/>',
  }
  return `<span class="douyin-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[kind] || paths.note}</svg></span>`
}

function settingsView() {
  const s = { ...defaults.settings, ...(state.data.settings || {}) }
  const a = { ...defaults.automation, ...(state.data.automation || {}) }
  const ap = { ...defaults.appearance, ...(state.data.appearance || {}) }
  const checked = (key) => s[key] ? 'checked' : ''
  const automationChecked = (key) => a[key] ? 'checked' : ''
  const automationNames = (key) => (a[key] || []).join('\n')
  return shell(header('设置', '集中管理启动、自动化、通知和本地数据偏好。', '<button class="btn" data-export-settings>导出配置</button><button class="btn danger" data-reset-settings>恢复默认</button>') + `<div class="settings-grid">
    <section class="panel settings-section"><div class="panel-head"><div><h2>应用行为</h2><p>决定应用启动和发送时的交互方式</p></div></div><div class="settings-list">
      <label class="setting-row"><span><strong>开机自动启动</strong><small>登录 Windows 后自动打开续声</small></span><input type="checkbox" data-setting="launchOnStartup" ${checked('launchOnStartup')} /></label>
      <label class="setting-row"><span><strong>启动时最小化</strong><small>启动后直接进入托盘，不打扰当前工作</small></span><input type="checkbox" data-setting="startMinimized" ${checked('startMinimized')} /></label>
      <label class="setting-row"><span><strong>关闭窗口时最小化到托盘</strong><small>保留后台监听和定时任务</small></span><input type="checkbox" data-setting="minimizeToTray" ${checked('minimizeToTray')} /></label>
      <label class="setting-row"><span><strong>发送前确认</strong><small>手动发送消息前显示确认提示</small></span><input type="checkbox" data-setting="confirmBeforeSend" ${checked('confirmBeforeSend')} /></label>
      <label class="setting-row"><span><strong>向对方显示 AI 模型</strong><small>AI 回复前加上当前模型名称；关闭后只发送自然正文</small></span><input type="checkbox" data-setting="showAiModelLabel" ${checked('showAiModelLabel')} /></label>
    </div></section>
    <section class="panel settings-section"><div class="panel-head"><div><h2>自动化</h2><p>自动回复可直接在联系人页控制栏操作，这里管理辅助行为</p></div></div><div class="settings-list">
      <label class="setting-row"><span><strong>只生成建议回复</strong><small>像豆包一样只给出回复建议，不写入输入框也不发送</small></span><input type="checkbox" data-setting="aiReplyDraftOnly" ${checked('aiReplyDraftOnly')} /></label>
      <label class="setting-row"><span><strong>自动学习联系人</strong><small>生成回复前读取近期对话，改善语气匹配</small></span><input type="checkbox" data-setting="autoLearnContacts" ${checked('autoLearnContacts')} /></label>
      <label class="setting-field"><span><strong>联系人刷新频率</strong><small>后台检查新消息的间隔</small></span><select data-setting="refreshInterval"><option value="5" ${s.refreshInterval==='5'?'selected':''}>5 秒</option><option value="15" ${s.refreshInterval==='15'?'selected':''}>15 秒</option><option value="30" ${s.refreshInterval==='30'?'selected':''}>30 秒</option><option value="60" ${s.refreshInterval==='60'?'selected':''}>1 分钟</option><option value="300" ${s.refreshInterval==='300'?'selected':''}>5 分钟</option></select></label>
      <label class="setting-row"><span><strong>打开视频识别</strong><small>自动回复遇到视频、图片或分享卡片时读取可确认的媒体内容</small></span><input type="checkbox" data-setting="videoRecognitionEnabled" ${checked('videoRecognitionEnabled')} /></label>
      <label class="setting-field"><span><strong>视频识别强度</strong><small>轻量抓封面和开头帧；标准读取音频、评论和关键帧；增强使用高清多帧+深度理解</small></span><select data-setting="videoRecognitionStrength"><option value="light" ${s.videoRecognitionStrength==='light'?'selected':''}>轻量</option><option value="standard" ${s.videoRecognitionStrength==='standard'?'selected':''}>标准</option><option value="deep" ${s.videoRecognitionStrength==='deep'?'selected':''}>增强</option></select></label>
      <label class="setting-row"><span><strong>低置信度保守回复</strong><small>只有封面或截图时允许生成克制回复；关闭后直接跳过</small></span><input type="checkbox" data-setting="videoLowConfidenceReply" ${checked('videoLowConfidenceReply')} /></label>
      <label class="setting-row"><span><strong>先理解再回复</strong><small>先让视觉模型整理画面要点，再生成最终私信</small></span><input type="checkbox" data-setting="videoAnalysisFirst" ${checked('videoAnalysisFirst')} /></label>
      <label class="setting-row"><span><strong>多候选择优回复</strong><small>生成2条不同风格的候选，评分选最自然的一条再发送</small></span><input type="checkbox" data-setting="multiCandidateReply" ${checked('multiCandidateReply')} data-feature="multi-candidate" /></label>
      <div class="setting-field"><span><strong>视频识别回复</strong><small>查看自动识别视频、图片和分享卡片的说明</small></span><button class="btn" data-video-reply-info>查看详情</button></div>
      <label class="setting-row"><span><strong>免打扰时段</strong><small>该时段内不自动回复和发送续火花</small></span><input type="checkbox" data-setting="quietHours" ${checked('quietHours')} /></label>
      <div class="cols settings-times"><label>开始时间<input type="time" data-setting="quietStart" value="${esc(s.quietStart)}" /></label><label>结束时间<input type="time" data-setting="quietEnd" value="${esc(s.quietEnd)}" /></label></div>
      <label class="setting-field setting-textarea"><span><strong>完全跳过联系人</strong><small>这些联系人不会收到自动回复、续火花或自动视频分享；每行一个昵称</small></span><textarea data-automation-list="blacklist" rows="3" placeholder="联系人昵称">${esc(automationNames('blacklist'))}</textarea></label>
    </div></section>
    <section class="panel settings-section"><div class="panel-head"><div><h2>通知</h2><p>选择哪些事件需要提醒你</p></div></div><div class="settings-list">
      <label class="setting-row"><span><strong>桌面通知</strong><small>任务执行和连接状态变化时显示系统通知</small></span><input type="checkbox" data-setting="desktopNotifications" ${checked('desktopNotifications')} /></label>
      <label class="setting-row"><span><strong>提示音</strong><small>收到通知时播放轻提示音</small></span><input type="checkbox" data-setting="soundNotifications" ${checked('soundNotifications')} /></label>
      <label class="setting-row"><span><strong>成功时提醒</strong><small>自动回复或续火花发送成功后提醒</small></span><input type="checkbox" data-setting="notifyOnSuccess" ${checked('notifyOnSuccess')} /></label>
      <label class="setting-row"><span><strong>失败时提醒</strong><small>登录失效、发送失败或模型错误时提醒</small></span><input type="checkbox" data-setting="notifyOnFailure" ${checked('notifyOnFailure')} /></label>
    </div></section>
    <section class="panel settings-section appearance-settings"><div class="panel-head"><div><h2>外观与语气</h2><p>统一管理界面显示和默认回复风格</p></div></div>
      <div class="settings-subsection"><strong>主题</strong><div class="theme-grid">${appearanceThemes.map(([id, label, bg]) => `<button class="theme-card ${ap.theme===id?'active':''}" data-theme-set="${id}"><span class="swatch" style="background:${bg}"></span><span>${label}</span></button>`).join('')}</div></div>
      <div class="settings-subsection"><strong>字体大小</strong><div class="font-size-row"><button class="font-size-btn ${ap.fontSize==='small'?'active':''}" data-font-set="small"><b>Aa</b><span class="demo">小</span></button><button class="font-size-btn ${ap.fontSize==='medium'?'active':''}" data-font-set="medium"><b>Aa</b><span class="demo">中</span></button><button class="font-size-btn ${ap.fontSize==='large'?'active':''}" data-font-set="large"><b>Aa</b><span class="demo">大</span></button></div></div>
      <div class="settings-subsection"><strong>动画效果</strong><div class="motion-row">${appearanceMotions.map(([id, label, desc]) => `<button class="motion-btn ${ap.motion===id?'active':''}" data-motion-set="${id}"><b>${label}</b><span>${desc}</span></button>`).join('')}</div></div>
      <div class="settings-subsection"><strong>强调色</strong><div class="theme-color-row">${appearanceAccents.map(c => `<button class="theme-color-dot ${ap.accentColor===c?'active':''}" data-accent-set="${c}" style="background:${c};color:${c}" aria-label="选择强调色 ${c}"></button>`).join('')}</div></div>
      <div class="settings-subsection tone-setting"><label>默认 AI 语气<input id="default-tone" list="tone-presets" value="${esc(ap.defaultTone || '')}" placeholder="自动跟随语境" autocomplete="off" /></label><button class="btn primary" data-save-default-tone>保存</button></div>
    </section>
    <section class="panel settings-section"><div class="panel-head"><div><h2>隐私与数据</h2><p>控制运行记录在本机的保存方式</p></div></div><div class="settings-list">
      <label class="setting-row"><span><strong>保存运行记录</strong><small>保留 AI 调用、发送结果和失败原因</small></span><input type="checkbox" data-setting="saveLogs" ${checked('saveLogs')} /></label>
      <label class="setting-field"><span><strong>记录保留时间</strong><small>超过时间的记录会在下次启动时清理</small></span><select data-setting="logRetention"><option value="7" ${s.logRetention==='7'?'selected':''}>7 天</option><option value="30" ${s.logRetention==='30'?'selected':''}>30 天</option><option value="90" ${s.logRetention==='90'?'selected':''}>90 天</option><option value="0" ${s.logRetention==='0'?'selected':''}>永久保留</option></select></label>
      <div class="settings-actions"><button class="btn danger" data-clear-logs>清空运行记录</button><span class="muted">当前 ${state.data.logs?.length || 0} 条</span></div>
    </div></section>
  </div>`)
}

function bindSettings() {
  bindAppearance()
  document.querySelectorAll('[data-automation-setting]').forEach((control) => {
    control.onchange = async () => {
      const key = control.dataset.automationSetting
      let value = control.type === 'checkbox' ? control.checked : control.value
      if (key === 'dailyLimit') {
        value = Number(value)
        if (!Number.isInteger(value) || value < 1 || value > 500) return notify('每日上限请输入 1 到 500 之间的整数')
      }
      await save({ automation: { ...defaults.automation, ...(state.data.automation || {}), [key]: value } }, '自动化设置已保存')
    }
  })
  document.querySelectorAll('[data-automation-list]').forEach((control) => {
    control.onchange = async () => {
      const key = control.dataset.automationList
      const names = [...new Set(control.value.split(/[\r\n,，、]+/).map((name) => name.trim()).filter(Boolean))]
      await save({ automation: { ...defaults.automation, ...(state.data.automation || {}), [key]: names } }, '自动化名单已保存')
    }
  })
  document.querySelectorAll('[data-setting]').forEach((control) => {
    control.onchange = async () => {
      const key = control.dataset.setting
      const value = control.type === 'checkbox' ? control.checked : control.value
      const nextSettings = { ...defaults.settings, ...(state.data.settings || {}), [key]: value }
      if (key === 'videoRecognitionEnabled') nextSettings.videoReplyEnabled = value
      await save({ settings: nextSettings }, '设置已保存')
    }
  })
  document.querySelector('[data-clear-logs]')?.addEventListener('click', async () => {
    if (!state.data.logs?.length || confirm('确定清空全部运行记录吗？')) await save({ logs: [] }, '运行记录已清空')
  })
  document.querySelector('[data-reset-settings]')?.addEventListener('click', async () => {
    if (!confirm('确定恢复所有设置的默认值吗？')) return
    await save({ settings: structuredClone(defaults.settings), appearance: structuredClone(defaults.appearance) }, '设置已恢复默认')
    applyAppearance()
  })
  document.querySelector('[data-export-settings]')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ settings: state.data.settings || defaults.settings, appearance: state.data.appearance || defaults.appearance }, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `续声设置-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    notify('配置文件已导出')
  })
  document.querySelector('[data-video-reply-info]')?.addEventListener('click', () => {
    alert([
      '视频识别回复说明',
      '',
      '自动回复遇到视频、图片或分享卡片时，会先抓取最新一条对方消息的画面帧；标准和增强强度还会尽量读取视频音频与公开视频页评论。',
      '',
      '轻量：抓封面和开头帧，速度最快；标准：画面 + 音频 + 评论；增强：高清多帧+深度理解。',
      '',
      '新增"多候选择优回复"：对视频消息先生成2条不同风格的回复，经过评分（具体性、自然度、长度、语气）选出最自然的一条再发送。'
    ].join('\n'))
  })
}

function bindAppearance() {
  const datalist = document.querySelector('#tone-presets')
  if (!datalist) {
    const dl = document.createElement('datalist')
    dl.id = 'tone-presets'
    dl.innerHTML = '<option value="自动跟随语境"><option value="随意口语"><option value="温暖亲切"><option value="简短精炼"><option value="幽默活泼"><option value="温柔体贴"><option value="认真正式"><option value="撒娇可爱"><option value="高冷简洁"><option value="热情开朗"><option value="沉着冷静"><option value="毒舌吐槽"><option value="文艺诗意"><option value="憨厚老实"><option value="霸道直接"><option value="二次元风格"><option value="学术严谨"><option value="长辈语气"><option value="恭恭敬敬"><option value="职场正式"><option value="兄弟义气"><option value="暧昧撩人"><option value="卖萌装傻"><option value="官方客服"><option value="颓废丧系"><option value="阳光开朗大男孩"><option value="盐系冷淡"><option value="甜系软妹"><option value="知性优雅"><option value="直球坦率"><option value="腹黑机智">'
    document.body.appendChild(dl)
  }
  const toneSetting = document.querySelector('.appearance-settings .tone-setting')
  if (toneSetting && !document.querySelector('[data-background-custom]')) {
    const ap = { ...defaults.appearance, ...(state.data.appearance || {}) }
    const currentBg = /^#[0-9a-f]{6}$/i.test(ap.backgroundColor || '') ? ap.backgroundColor : defaults.appearance.backgroundColor
    const section = document.createElement('div')
    section.className = 'settings-subsection background-setting'
    section.innerHTML = '<strong>背景色</strong><div class="theme-color-row">' + appearanceBackgrounds.map((color) => '<button class="theme-color-dot ' + (currentBg === color ? 'active' : '') + '" data-background-set="' + color + '" style="background:' + color + ';color:' + color + '" aria-label="选择背景色 ' + color + '"></button>').join('') + '<label class="custom-color-field">自定义<input type="color" data-background-custom value="' + esc(currentBg) + '" /></label></div>'
    toneSetting.before(section)
  }
  document.querySelectorAll('[data-theme-set]').forEach(el => { el.onclick = async () => {
    const theme = el.dataset.themeSet
    const current = state.data.appearance.backgroundColor || defaults.appearance.backgroundColor
    const backgroundColor = theme === 'dark' && current === defaults.appearance.backgroundColor
      ? '#172338'
      : (state.data.appearance.theme === 'dark' && current === '#172338' ? defaults.appearance.backgroundColor : current)
    state.data.appearance = { ...state.data.appearance, theme, backgroundColor }
    await save({ appearance: state.data.appearance }, '主题已更新')
    applyAppearance()
  }})
  document.querySelectorAll('[data-font-set]').forEach(el => { el.onclick = async () => {
    const fontSize = el.dataset.fontSet
    state.data.appearance = { ...state.data.appearance, fontSize }
    applyAppearance()
    await save({ appearance: state.data.appearance }, '字体大小已调整')
  }})
  document.querySelectorAll('[data-motion-set]').forEach(el => { el.onclick = async () => {
    const motion = el.dataset.motionSet
    state.data.appearance = { ...state.data.appearance, motion }
    applyAppearance()
    await save({ appearance: state.data.appearance }, '动画效果已更新')
  }})
  document.querySelectorAll('[data-accent-set]').forEach(el => { el.onclick = async () => {
    const accentColor = el.dataset.accentSet
    state.data.appearance = { ...state.data.appearance, accentColor }
    applyAppearance()
    await save({ appearance: state.data.appearance }, '强调色已更新')
  }})
  document.querySelectorAll('[data-background-set]').forEach(el => { el.onclick = async () => {
    const backgroundColor = el.dataset.backgroundSet
    state.data.appearance = { ...state.data.appearance, backgroundColor }
    applyAppearance()
    await save({ appearance: state.data.appearance }, '背景色已更新')
    render()
  }})
  document.querySelectorAll('[data-background-custom]').forEach(el => { el.onchange = async () => {
    const backgroundColor = el.value
    state.data.appearance = { ...state.data.appearance, backgroundColor }
    applyAppearance()
    await save({ appearance: state.data.appearance }, '自定义背景色已更新')
    render()
  }})
  const saveToneBtn = document.querySelector('[data-save-default-tone]')
  if (saveToneBtn) saveToneBtn.onclick = async () => {
    const defaultTone = document.getElementById('default-tone').value.trim()
    state.data.appearance = { ...state.data.appearance, defaultTone }
    await save({ appearance: state.data.appearance }, defaultTone ? `默认语气已设为：${defaultTone}` : '默认语气已重置')
  }
}

async function save(patch, message = '已保存到本机') {
  state.data = { ...state.data, ...patch }
  try {
    const result = await D.automation.update(patch)
    if (result?.state) state.data = { ...state.data, ...result.state }
    notify(message)
  } catch (error) {
    notify(`保存失败：${error.message}`)
  }
}

function nav() {
  const items = [
    ['contacts', '联系人', 'contacts'],
    ['sparks', '续火花', 'sparks'],
    ['strategies', '回复策略', 'strategies'],
    ['providers', '模型设置', 'providers'],
    ['settings', '设置', 'settings'],
    ['audit', '运行记录', 'audit'],
  ]
  return items.map(([id, label, icon]) => `<button class="${state.section === id ? 'active' : ''}" data-nav="${id}">${douyinIcon(icon)}<span>${label}</span></button>`).join('')
}

function shell(content) {
  return `<div class="app">
    <aside class="side">
      <div class="brand">${douyinIcon('note')}<span>续声</span></div>
      <nav class="nav">${nav()}</nav>
      <div class="side-foot">
        <div class="status"><i class="dot ${state.data.connected ? 'on' : ''}"></i>${state.data.connected ? '抖音已连接' : '等待扫码登录'}</div>
        <div class="side-note">本机运行 · 即时监听新消息</div>
      </div>
    </aside>
    <main class="main"><div class="main-content ${state.pageMotion ? 'pcl-page-enter' : ''}">${content}</div>${renderActivityBar()}</main>
    ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ''}
  </div>`
}

function header(title, description, actions = '') {
  return `<div class="top"><div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`
}

function contactList(contacts, selected, disabled) {
  if (!contacts.length) return '<div class="empty">登录抖音后同步联系人</div>'
  return `<div class="contact-list">${contacts.map((contact) => {
    const aiEnabled = !disabled.has(contact.name)
    return `<div class="contact-row ${selected?.name === contact.name ? 'selected' : ''}">
      <button class="contact-select" data-select="${esc(contact.name)}">
        <span class="avatar">${esc(contact.name.slice(0, 1))}</span>
        <span class="row-main"><strong>${esc(contact.name)}</strong><span>${esc(contact.preview || '暂无消息')}</span></span>
      </button>
      <button class="ai-switch ${aiEnabled ? 'enabled' : 'disabled'}" data-toggle-contact-ai="${esc(contact.name)}" aria-pressed="${aiEnabled}" title="${aiEnabled ? '点击后禁止 AI 自动回复此联系人' : '点击后允许 AI 自动回复此联系人'}">
        <i></i><span>${aiEnabled ? '允许 AI' : '禁止 AI'}</span>
      </button>
    </div>`
  }).join('')}</div>`
}

function contactProfile(contact, aiEnabled) {
  const profile = contact.profile || {}
  const videoShare = profile.videoShare || {}
  const learnedCount = Number(contact.learning?.messages?.length || 0)
  const learnedAt = contact.learning?.updatedAt ? new Date(contact.learning.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  const videoShareItems = normalizeVideoShareItems(videoShare)
  const videoShareDiscovery = videoShareDiscoveryText(videoShare)
  const videoShareCategories = normalizeVideoShareCategories(videoShare.categories)
  const videoShareNext = videoShare.nextRunAt ? new Date(videoShare.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : ''
  const videoShareLabel = videoShare.enabled
    ? `已选 ${videoShareCategories.length} 个类型${videoShareDiscovery ? ` · 补充 ${esc(videoShareDiscovery.split(/[\n,，、;；]+/).filter(Boolean).length)} 条` : ''}${videoShareItems.length ? ` · 备用 ${videoShareItems.length} 个` : ''}${videoShareNext ? ` · 下次 ${esc(videoShareNext)}` : ''}`
    : '关闭时不会主动发视频'
  return `<div class="contact-detail-head">
      <div><h2>${esc(contact.name)}</h2><p>${learnedCount ? `已学习 ${learnedCount} 条对话 · ${esc(learnedAt)}` : '尚未学习历史对话'}</p></div>
      <div class="contact-state-stack"><span class="ai-state ${aiEnabled ? 'on' : 'off'}">${aiEnabled ? '允许 AI 自动回复' : '已禁止 AI 自动回复'}</span><span class="ai-state ${videoShare.enabled ? 'on' : 'off'}">${videoShare.enabled ? '随机视频已开' : '随机视频关闭'}</span></div>
    </div>
    <div class="tabs">
      <button class="${state.contactTab === 'profile' ? 'active' : ''}" data-contact-tab="profile">联系人设置</button>
      <button class="${state.contactTab === 'draft' ? 'active' : ''}" data-contact-tab="draft">手动拟回复</button>
      <button class="${state.contactTab === 'inquiry' ? 'active' : ''}" data-contact-tab="inquiry">话题代问</button>
    </div>
    ${state.contactTab === 'draft' ? draftEditor(contact) : state.contactTab === 'inquiry' ? inquiryEditor(contact) : `<div class="form">
      <div class="profile-sections">
        <section class="profile-group">
          <div class="group-head"><strong>关系和说话方式</strong><span>决定 AI 怎么称呼、怎么接话</span></div>
          <div class="cols">
            <label>称呼<input id="p-call" value="${esc(profile.call || '')}" placeholder="例如：阿琳" /></label>
            <label>关系<input id="p-rel" value="${esc(profile.relationship || '')}" placeholder="朋友 / 同事" /></label>
          </div>
          <label>性格、聊天方式、兴趣<textarea id="p-personality" placeholder="例如：慢热、喜欢短句、少用表情">${esc(profile.personality || '')}</textarea></label>
          <div class="cols">
            <label>回复频率<select id="p-frequency">
              <option value="instant" ${(profile.frequency||'instant')==='instant'?'selected':''}>即时回复</option>
              <option value="30s" ${profile.frequency==='30s'?'selected':''}>至少间隔30秒</option>
              <option value="60s" ${profile.frequency==='60s'?'selected':''}>至少间隔1分钟</option>
              <option value="300s" ${profile.frequency==='300s'?'selected':''}>至少间隔5分钟</option>
              <option value="3600s" ${profile.frequency==='3600s'?'selected':''}>至少间隔1小时</option>
            </select></label>
            <label>语气偏向<input id="p-tone" list="tone-presets" value="${esc(profile.tone || '')}" placeholder="自动跟随语境" autocomplete="off" /></label>
          </div>
          <label>语气样例<textarea id="p-examples" placeholder="每行一条参考回复">${esc((profile.examples || []).join('\n'))}</textarea></label>
        </section>
        <section class="profile-group">
          <div class="group-head"><strong>边界和注意事项</strong><span>减少不合适的主动发挥</span></div>
          <label>回复禁区<textarea id="p-boundary" placeholder="例如：不主动聊收入、不在深夜发送">${esc(profile.boundary || '')}</textarea></label>
          <label>回复注意事项<textarea id="p-notes" placeholder="例如：别提前男友、每次回复都关心一下身体">${esc(profile.notes || '')}</textarea></label>
        </section>
        <section class="profile-group contact-video-share ${videoShare.enabled ? 'enabled' : ''}">
          <div class="group-head"><strong>主动随机视频</strong><span>${videoShareLabel}</span></div>
          <label class="setting-row video-share-toggle"><span><strong>自动找视频并分享</strong><small>按时间窗自己搜索合适视频，再发给这个联系人</small></span><input id="p-video-share-enabled" type="checkbox" ${videoShare.enabled ? 'checked' : ''} /></label>
          <div class="cols">
            <label>开始时间<input id="p-video-share-start" type="time" value="${esc(videoShare.windowStart || '12:00')}" /></label>
            <label>结束时间<input id="p-video-share-end" type="time" value="${esc(videoShare.windowEnd || '22:30')}" /></label>
          </div>
          <label>每天最多<input id="p-video-share-max" type="number" min="1" max="10" step="1" value="${Math.max(1, Math.min(10, Number(videoShare.maxPerDay || 3)))}" /></label>
          <div class="video-category-block">
            <div class="video-category-head"><strong>视频类型</strong><span>先选大方向，系统会根据之后的回应自动调高更合适的类型</span></div>
            ${videoShareCategoryChips(videoShare)}
          </div>
          <label>补充方向<span class="form-hint">可选。每行一个更细的兴趣、关键词或内容方向；会和上面的类型一起用于搜索</span><textarea id="p-video-share-query" placeholder="下班后轻松一点&#10;不太吵的电影剪辑&#10;运动恢复小技巧">${esc(videoShareDiscovery)}</textarea></label>
          <label>备用链接<span class="form-hint">可选。自动搜索失败时才使用，每行一个视频链接</span><textarea id="p-video-share-list" placeholder="https://v.douyin.com/xxxx/ | 后面那个停顿很好笑">${esc(videoShareText(videoShare))}</textarea></label>
        </section>
      </div>
      <div class="form-actions split profile-savebar"><button class="btn" data-learn-contact="${esc(contact.name)}">学习当前对话</button><button class="btn primary" data-save-profile="${esc(contact.name)}">保存联系人设置</button></div>
    </div>`}`
}

function draftEditor(contact) {
  const activity = state.activity || { tone: 'idle', title: '等待输入', detail: '生成后会显示当前模型、耗时和发送状态' }
  return `<div class="form">
    <label>对方的消息<textarea id="incoming" placeholder="输入或粘贴对方发来的内容">${esc(contact.preview || '')}</textarea></label>
    <label>视频地址（可选）<input id="videoUrl" placeholder="仅在需要分析视频时填写" /></label>
    <div class="message-status" id="message-status" data-tone="${esc(activity.tone || 'idle')}"><strong>${esc(activity.title || '等待输入')}</strong><span>${esc(activity.detail || '生成后会显示当前模型、耗时和发送状态')}</span></div>
    <div class="form-actions"><button class="btn primary" data-draft>生成 AI 回复</button></div>
    <div id="reply" class="reply">等待生成</div>
    <div class="form-actions split"><span class="muted">发送前请检查回复内容</span><button class="btn" data-send>发送这条回复</button></div>
  </div>`
}

function contactsView() {
  const contacts = state.data.contacts || []
  const disabled = new Set(state.data.automation.aiDisabledContacts || [])
  const selected = contacts.find((contact) => contact.name === state.selected) || contacts[0]
  if (selected) state.selected = selected.name
  const providersReady = Boolean(state.data.providers?.length)
  const globalEnabled = Boolean(state.data.automation.autoReply)
  return shell(
    header('联系人', '统一管理 AI 自动回复、联系人资料和手动回复。', '<button class="btn" data-login>登录抖音</button><button class="btn primary" data-sync>同步联系人</button>') +
    `<section class="control-bar">
      <div class="control-summary"><strong>AI 自动回复</strong><span>${providersReady ? `${state.data.providers.length} 个模型已配置` : '请先配置模型'}</span></div>
      <div class="automation-toggles"><label class="master-switch"><input type="checkbox" data-auto ${globalEnabled ? 'checked' : ''} /><span></span><b>${globalEnabled ? '运行中' : '已关闭'}</b></label><button class="btn ${state.data.automation.paused ? 'primary' : 'ghost'}" data-toggle-pause>${state.data.automation.paused ? '恢复回复' : '暂停回复'}</button></div>
      <div class="limit-controls">
        <div class="reply-policy"><strong>一问一答</strong><span>对方发来新消息后才自动回复 1 条</span></div>
        <label>每日上限<input id="setting-daily" type="number" min="1" max="500" step="1" value="${Number(state.data.automation.dailyLimit ?? 30)}" /><span>条</span></label>
        <button class="btn" data-save-limits>保存</button>
      </div>
    </section>
    <div class="workspace-grid">
      <section class="panel contacts-panel">
        <div class="panel-head"><div><h2>联系人</h2><p>${contacts.length} 位，右侧按钮单独控制 AI</p></div></div>
        ${contactList(contacts, selected, disabled)}
      </section>
      <section class="panel detail-panel">${selected ? contactProfile(selected, !disabled.has(selected.name)) : '<div class="empty">请先同步联系人</div>'}</section>
    </div>`
  )
}

function refreshSelectedContact() {
  const contacts = state.data.contacts || []
  const disabled = new Set(state.data.automation.aiDisabledContacts || [])
  const selected = contacts.find((contact) => contact.name === state.selected) || contacts[0]
  if (selected) state.selected = selected.name
  const detailPanel = document.querySelector('.detail-panel')
  if (!detailPanel) return render()
  detailPanel.innerHTML = selected ? contactProfile(selected, !disabled.has(selected.name)) : '<div class="empty">请先同步联系人</div>'
  document.querySelectorAll('.contact-row').forEach((row) => {
    const button = row.querySelector('[data-select]')
    row.classList.toggle('selected', button?.dataset.select === state.selected)
  })
  bindContacts()
}

function sparksView() {
  const tasks = state.data.automation.sparks || []
  const contacts = state.data.contacts || []
  const editingIndex = Number.isInteger(state.sparkEditing) && state.sparkEditing >= 0 && state.sparkEditing < tasks.length ? state.sparkEditing : null
  const editing = editingIndex === null ? null : tasks[editingIndex]
  const contactNames = [...new Set([...(editing?.name ? [editing.name] : []), ...contacts.map((contact) => contact.name)])]
  const selectedName = editing?.name || contacts[0]?.name || ''
  const kind = editing?.kind || 'emoji'
  const emojiName = editing?.emojiName || '早上好'
  const enabled = editing?.enabled !== false
  const messageText = sparkMessageText(editing) || DEFAULT_SPARK_MESSAGES.join('\n')
  const sparkSummary = (task) => task.kind === 'emoji'
    ? `表情包：${esc(task.emojiName || '早上好')}`
    : task.kind === 'combo'
      ? `${sparkMessageOptions(task).length > 1 ? `${sparkMessageOptions(task).length} 条随机文案 · 今日：${esc(dailySparkMessage(task))}` : esc(dailySparkMessage(task) || '文字')} + 表情包：${esc(task.emojiName || '早上好')}`
      : sparkMessageOptions(task).length > 1
        ? `${sparkMessageOptions(task).length} 条随机文案 · 今日：${esc(dailySparkMessage(task))}`
        : esc(dailySparkMessage(task) || '')
  return shell(header('续火花', '每天到点检查是否已和该联系人发送过消息；未发送才自动补发，失败会重试。') + `<div class="grid">
    <section class="panel span-5"><div class="panel-head"><div><h2>${editing ? '编辑任务' : '新增任务'}</h2><p>文字可一行一条，系统每天自动随机取一条</p></div></div>
      <div class="form">
        <label>联系人<select id="spark-name">${contactNames.length ? contactNames.map((name) => `<option value="${esc(name)}" ${name === selectedName ? 'selected' : ''}>${esc(name)}</option>`).join('') : '<option value="">请先同步联系人</option>'}</select></label>
        <div class="cols"><label>类型<select id="spark-kind"><option value="emoji" ${kind === 'emoji' ? 'selected' : ''}>表情包</option><option value="text" ${kind === 'text' ? 'selected' : ''}>文字</option><option value="combo" ${kind === 'combo' ? 'selected' : ''}>文字 + 表情包</option></select></label><label>表情包<select id="spark-emoji"><option ${emojiName === '早上好' ? 'selected' : ''}>早上好</option><option ${emojiName === '晚上好' ? 'selected' : ''}>晚上好</option><option ${emojiName === '早点睡' ? 'selected' : ''}>早点睡</option><option ${emojiName === '续火花' ? 'selected' : ''}>续火花</option></select></label></div>
        <div class="cols"><label>时间<input id="spark-time" type="time" value="${esc(editing?.time || '20:00')}" /></label><label>状态<select id="spark-enabled"><option value="true" ${enabled ? 'selected' : ''}>启用</option><option value="false" ${enabled ? '' : 'selected'}>停用</option></select></label></div>
        <label>文字内容<span class="form-hint">每行一条，文字或“文字 + 表情包”任务会按日期随机发送其中一条</span><textarea id="spark-message" placeholder="今天也来续个火花呀～&#10;想你啦，来续个火花&#10;今日份火花打卡">${esc(messageText)}</textarea></label>
        <div class="form-actions">${editing ? '<button class="btn" data-cancel-spark>取消编辑</button>' : ''}<button class="btn primary" data-save-spark ${contactNames.length ? '' : 'disabled'}>${editing ? '保存修改' : '保存任务'}</button></div>
      </div>
    </section>
    <section class="panel span-7"><div class="panel-head"><div><h2>任务列表</h2><p>${tasks.length} 个任务 · 已开启自动检测补续</p></div></div>
      ${tasks.length ? `<div class="list">${tasks.map((task, index) => `<div class="row ${editingIndex === index ? 'editing-row' : ''}"><div class="row-main"><strong>${esc(task.name)}</strong><span>每天 ${esc(task.time)} · ${sparkSummary(task)}</span></div>${task.lastRunDate === localDateKey() ? '<span class="tag">今日已完成</span>' : ''}<span class="tag">${task.kind === 'combo' ? '组合' : task.kind === 'emoji' ? '表情包' : '文字'}</span><span class="tag ${task.enabled ? '' : 'off'}">${task.enabled ? '启用' : '停用'}</span><div class="task-actions"><button class="btn ghost" data-edit-spark="${index}">编辑</button><button class="btn ghost" data-run-spark="${index}">立即发送</button><button class="btn ghost" data-toggle-spark="${index}">${task.enabled ? '停用' : '启用'}</button><button class="btn ghost danger" data-delete-spark="${index}">删除</button></div></div>`).join('')}</div>` : '<div class="empty">还没有续火花任务</div>'}
    </section>
  </div>`)
}

function inquiryEditor(contact) {
  const inquiries = (state.data.automation?.inquiries || []).filter((item) => item.name === contact.name).slice(0, 10)
  const status = (item) => item.status === 'answered' ? '已收到回复' : '等待回复'
  return `<div class="form">
    <label>想了解的问题<textarea id="inquiry-question" placeholder="例如：他最近是不是在准备换工作？"></textarea></label>
    <div class="form-actions split"><span class="muted">AI 会组织成一条自然聊天消息；收到对方下一条回复后只在本机整理结果。</span><button class="btn primary" data-start-inquiry>发起代问</button></div>
    <div class="list">${inquiries.length ? inquiries.map((item) => `<div class="row"><div class="row-main"><strong>${esc(status(item))}</strong><span>问题：${esc(item.question || '')}</span><span>发送：${esc(item.asked || '')}</span>${item.status === 'answered' ? `<span>对方：${esc(item.answer || '')}</span><span>摘要：${esc(item.report || '正在整理')}</span>` : '<span>等待该联系人下一条消息</span>'}</div><span class="tag ${item.status === 'answered' ? '' : 'off'}">${esc(status(item))}</span></div>`).join('') : '<div class="empty">还没有发起话题代问</div>'}</div>
  </div>`
}

function providersView() {
  const providers = state.data.providers || []
  const editing = state.providerEditing === null ? null : providers[state.providerEditing]
  return shell(header('模型设置', `当前默认：${providerLabel()}`) + `<div class="grid">
    <section class="panel span-5"><div class="panel-head"><div><h2>当前模型</h2><p>${providers.length} 个提供商 · 默认使用置顶模型</p></div></div>
      ${providers.length ? `<div class="list">${providers.map((provider, index) => `<div class="row provider-row ${index === 0 ? 'active-provider' : ''}"><div class="row-main"><strong>${esc(provider.name)}</strong><span>${esc(provider.model)} · ${esc(provider.baseUrl)}</span></div>${index === 0 ? '<span class="tag">默认</span>' : `<button class="btn ghost" data-primary-provider="${index}">设为默认</button>`}<button class="btn ghost" data-test-provider="${index}">测试</button><button class="btn ghost" data-edit-provider="${index}">编辑</button><button class="btn ghost danger" data-delete-provider="${index}">删除</button></div>`).join('')}</div>` : '<div class="empty">还没有配置模型</div>'}
    </section>
    <section class="panel span-7"><div class="panel-head"><div><h2>${editing ? `编辑 ${esc(editing.name)}` : '添加模型'}</h2><p>API Key 在本机加密保存</p></div></div>
      <div class="form"><div class="cols"><label>名称<input id="provider-name" value="${esc(editing?.name || '')}" placeholder="MaxTab" /></label><label>模型<input id="provider-model" value="${esc(editing?.model || '')}" placeholder="gpt-5.5" /></label></div>
      <label>接口地址<input id="provider-url" value="${esc(editing?.baseUrl || '')}" placeholder="https://api.example.com/v1" /></label>
      <label>API Key<input id="provider-key" type="password" placeholder="${editing ? '留空会保留原密钥' : '只在本机加密保存'}" /></label>
      <label>能力<select id="provider-cap"><option value="text">文本</option><option value="vision" ${editing?.capabilities?.includes('vision') ? 'selected' : ''}>文本 + 图片</option></select></label>
      <div class="form-actions">${editing ? '<button class="btn" data-cancel-provider>取消</button>' : ''}<button class="btn primary" data-save-provider>${editing ? '保存修改' : '保存模型'}</button></div></div>
    </section>
  </div>`)
}

function strategiesView() {
  const automation = state.data.automation || defaults.automation
  const rules = automation.rules || []
  return shell(header('回复策略', '关键词话术优先命中，未命中时再交给 AI 生成。') + `<div class="grid">
    <section class="panel span-12"><div class="panel-head"><div><h2>关键词话术</h2><p>${rules.length} 条规则，按列表顺序匹配</p></div></div>
      <div class="form strategy-form">
        <label>关键词<input id="rule-keywords" placeholder="多个关键词用逗号分隔，例如：在吗，睡了吗" /></label>
        <label>固定回复<textarea id="rule-reply" placeholder="命中任一关键词后发送的内容"></textarea></label>
        <div class="form-actions"><button class="btn primary" data-save-rule>添加规则</button></div>
      </div>
      ${rules.length ? `<div class="list rule-list">${rules.map((rule, index) => `<div class="row"><div class="row-main"><strong>${esc((rule.keywords || []).join(' / '))}</strong><span>${esc(rule.replyText || '')}</span></div><span class="tag ${rule.enabled === false ? 'off' : ''}">${rule.enabled === false ? '停用' : '启用'}</span><button class="btn ghost" data-toggle-rule="${index}">${rule.enabled === false ? '启用' : '停用'}</button><button class="btn ghost danger" data-delete-rule="${index}">删除</button></div>`).join('')}</div>` : '<div class="empty rule-empty">还没有话术规则，未命中的消息会使用 AI。</div>'}
    </section>
  </div>`)
}

function auditView() {
  const logs = state.data.logs || []
  return shell(header('运行记录', '查看 AI 调用、自动发送和失败原因。', '<button class="btn" data-refresh>刷新</button>') + `<section class="panel">
    ${logs.length ? `<div class="timeline">${logs.map((entry) => { const detail = entry.detail || {}; const modelTag = detail.aiLabel || (detail.ai ? `AI · ${detail.model || '当前模型'}` : ''); return `<div class="event"><time>${new Date(entry.at).toLocaleString('zh-CN', { hour12: false })}</time><div><b>${esc(entry.message || entry.type)}</b><div class="muted">${esc(modelTag || detail.error || detail.name || '')}</div></div></div>` }).join('')}</div>` : '<div class="empty">暂无运行记录</div>'}
  </section>`)
}

function bindCommon() {
  document.querySelectorAll('[data-nav]').forEach((button) => { button.onclick = () => {
    if (state.section === button.dataset.nav) return
    state.pageMotion = 'route'
    state.section = button.dataset.nav
    render()
  } })
  document.querySelectorAll('[data-login]').forEach((button) => { button.onclick = async () => {
    button.disabled = true
    try { const result = await D.douyin.openLogin(); notify(result?.ok ? '已打开抖音登录窗口' : (result?.error || '登录失败')) }
    catch (error) { notify(`登录失败：${error.message}`) }
  } })
  document.querySelectorAll('[data-sync]').forEach((button) => { button.onclick = async () => {
    button.disabled = true
    try {
      const result = await D.douyin.syncContacts()
      if (!result?.contacts) throw new Error('请先登录抖音')
      state.data.contacts = result.contacts
      await save({ contacts: result.contacts }, `已同步 ${result.contacts.length} 位联系人`)
    } catch (error) { notify(`同步失败：${error.message}`) }
  } })
  document.querySelectorAll('[data-refresh]').forEach((button) => { button.onclick = load })
}

function bindContacts() {
  document.querySelectorAll('[data-select]').forEach((button) => { button.onclick = () => { state.selected = button.dataset.select; refreshSelectedContact() } })
  document.querySelectorAll('[data-contact-tab]').forEach((button) => { button.onclick = () => { state.contactTab = button.dataset.contactTab; render() } })
  const inquiryButton = document.querySelector('[data-start-inquiry]')
  if (inquiryButton) inquiryButton.onclick = async () => {
    const question = document.getElementById('inquiry-question')?.value.trim()
    const contact = state.data.contacts.find((item) => item.name === state.selected)
    if (!contact || !question) return notify('请选择联系人并填写想了解的问题')
    if (state.data.settings?.confirmBeforeSend !== false && !confirm(`让 AI 自然组织问题并发送给“${contact.name}”吗？`)) return
    inquiryButton.disabled = true
    setActivity('正在发起话题代问', `联系人：${contact.name}`, 'busy')
    try {
      const result = await D.douyin.startInquiry(contact.name, question)
      if (!result?.ok || !result.inquiry) throw new Error(result?.error || '发起失败')
      const inquiries = [result.inquiry, ...(state.data.automation.inquiries || []).filter((item) => item.id !== result.inquiry.id)]
      state.data.automation = { ...state.data.automation, inquiries }
      setActivity('话题代问已发出', `等待 ${contact.name} 回复`, 'ok')
      notify('问题已发出，收到回复后会在此处显示摘要')
      render()
    } catch (error) {
      setActivity('话题代问失败', error.message, 'error')
      notify(`发起失败：${error.message}`)
    } finally { inquiryButton.disabled = false }
  }
  const auto = document.querySelector('[data-auto]')
  if (auto) auto.onchange = () => save({ automation: { ...state.data.automation, autoReply: auto.checked } }, auto.checked ? 'AI 自动回复已启动' : 'AI 自动回复已暂停')
  const saveLimits = document.querySelector('[data-save-limits]')
  if (saveLimits) saveLimits.onclick = async () => {
    const dailyLimit = Number(document.getElementById('setting-daily').value)
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 500) return notify('每日上限请输入 1 到 500 之间的整数')
    await save({ automation: { ...state.data.automation, dailyLimit } }, '每日发送上限已保存并立即生效')
  }
  document.querySelectorAll('[data-toggle-contact-ai]').forEach((button) => { button.onclick = async () => {
    const name = button.dataset.toggleContactAi
    const disabled = new Set(state.data.automation.aiDisabledContacts || [])
    if (disabled.has(name)) disabled.delete(name); else disabled.add(name)
    await save({ automation: { ...state.data.automation, aiDisabledContacts: [...disabled] } }, disabled.has(name) ? `已禁止 AI 自动回复 ${name}` : `已允许 AI 自动回复 ${name}`)
  } })
  const pauseBtn = document.querySelector('[data-toggle-pause]')
  if (pauseBtn) pauseBtn.onclick = async () => {
    const paused = !state.data.automation.paused
    await save({ automation: { ...state.data.automation, paused } }, paused ? '自动回复已暂停，点击恢复继续' : '自动回复已恢复')
  }
  document.querySelectorAll('[data-video-share-category]').forEach((button) => {
    button.onclick = () => {
      const active = !button.classList.contains('active')
      button.classList.toggle('active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
  })
  const profileButton = document.querySelector('[data-save-profile]')
  if (profileButton) profileButton.onclick = async () => {
    const contact = state.data.contacts.find((item) => item.name === profileButton.dataset.saveProfile)
    const previousShare = contact.profile?.videoShare || {}
    const categories = [...document.querySelectorAll('[data-video-share-category].active')]
      .map((button) => button.dataset.videoShareCategory)
      .filter(Boolean)
    const discoveryQuery = document.getElementById('p-video-share-query')?.value || ''
    const videoList = document.getElementById('p-video-share-list')?.value || ''
    const videos = normalizeVideoShareItems({ message: videoList })
    const videoShare = {
      ...previousShare,
      enabled: Boolean(document.getElementById('p-video-share-enabled')?.checked),
      windowStart: document.getElementById('p-video-share-start')?.value || '12:00',
      windowEnd: document.getElementById('p-video-share-end')?.value || '22:30',
      maxPerDay: Math.max(1, Math.min(10, Number(document.getElementById('p-video-share-max')?.value || 3))),
      discoveryMode: 'auto',
      categories,
      discoveryQuery,
      videoList,
      videos,
    }
    const scheduleChanged = previousShare.enabled !== videoShare.enabled
      || previousShare.windowStart !== videoShare.windowStart
      || previousShare.windowEnd !== videoShare.windowEnd
      || previousShare.maxPerDay !== videoShare.maxPerDay
      || JSON.stringify(normalizeVideoShareCategories(previousShare.categories)) !== JSON.stringify(videoShare.categories)
      || (previousShare.discoveryQuery || '') !== videoShare.discoveryQuery
      || (previousShare.videoList || '') !== videoShare.videoList
    if (scheduleChanged) {
      videoShare.nextRunAt = ''
      videoShare.lastAttemptAt = 0
      videoShare.videoShareState = undefined
      videoShare.lastRunDate = ''
    }
    contact.profile = {
      ...(contact.profile || {}),
      call: document.getElementById('p-call').value,
      relationship: document.getElementById('p-rel').value,
      personality: document.getElementById('p-personality').value,
      boundary: document.getElementById('p-boundary').value,
      notes: document.getElementById('p-notes')?.value || '',
      frequency: document.getElementById('p-frequency')?.value || 'instant',
      tone: document.getElementById('p-tone')?.value || '',
      examples: document.getElementById('p-examples').value.split(/\n+/).map((item) => item.trim()).filter(Boolean),
      videoShare,
    }
    await save({ contacts: state.data.contacts }, '联系人设置已保存')
  }
  const learnButton = document.querySelector('[data-learn-contact]')
  if (learnButton) learnButton.onclick = async () => {
    learnButton.disabled = true
    notify('正在读取并学习当前对话…')
    try {
      const result = await D.douyin.learnContact(learnButton.dataset.learnContact)
      if (!result?.ok || !result.contact) throw new Error(result?.error || '学习失败')
      const index = state.data.contacts.findIndex((item) => item.name === result.contact.name)
      if (index >= 0) state.data.contacts[index] = result.contact
      notify(`已学习 ${result.learnedMessages} 条对话`)
    } catch (error) { notify(`学习失败：${error.message}`) }
  }
  const draftButton = document.querySelector('[data-draft]')
  const sendButton = document.querySelector('[data-send]')
  if (draftButton) draftButton.onclick = async () => {
    const incoming = document.getElementById('incoming').value.trim()
    if (!incoming) return notify('请先输入对方的消息')
    draftButton.disabled = true
    if (sendButton) sendButton.disabled = true
    const replyBox = document.getElementById('reply')
    if (replyBox) replyBox.textContent = '正在准备生成…'
    let contact = state.data.contacts.find((item) => item.name === state.selected)
    try {
      if (state.data.settings?.autoLearnContacts !== false) {
        setDraftStatus('正在学习当前对话', `联系人：${contact.name}`, 'busy')
        try {
          const learned = await D.douyin.learnContact(contact.name)
          if (learned?.contact) {
            contact = learned.contact
            const index = state.data.contacts.findIndex((item) => item.name === contact.name)
            if (index >= 0) state.data.contacts[index] = contact
          }
        } catch {
          setDraftStatus('学习跳过，继续生成', '未能读取当前对话，正在使用已有资料', 'busy')
        }
      }
      setDraftStatus('模型正在生成回复', `使用：${providerLabel()}`, 'busy')
      if (replyBox) replyBox.textContent = 'AI 正在生成回复，请稍等…'
      const result = await D.ai.draft({ contact, incoming, videoUrl: document.getElementById('videoUrl').value.trim() })
      if (!result?.ok && result?.error) throw new Error(result.error)
      const text = result?.labeledText || result?.text || result?.error || '生成失败，请检查模型设置'
      if (replyBox) replyBox.textContent = text
      setDraftStatus('回复已生成', `${result?.aiLabel || providerLabel()} · ${result?.elapsedMs ? `${Math.round(result.elapsedMs / 1000)} 秒` : '可检查后发送'}`, 'ok')
    } catch (error) {
      if (replyBox) replyBox.textContent = `生成失败：${error.message}`
      setDraftStatus('生成失败', error.message, 'error')
    } finally {
      draftButton.disabled = false
      if (sendButton) sendButton.disabled = false
    }
  }
  if (sendButton) sendButton.onclick = async () => {
    const text = document.getElementById('reply').textContent.trim()
    if (!text || text === '等待生成') return notify('请先生成回复')
    if (sendButton.disabled || text === '正在准备生成…' || text === 'AI 正在生成回复，请稍等…') return notify('请等待回复生成完成')
    const contact = state.data.contacts.find((item) => item.name === state.selected)
    if (state.data.settings?.confirmBeforeSend !== false && !confirm(`确定向“${contact.name}”发送这条回复吗？`)) return
    sendButton.disabled = true
    setDraftStatus('正在发送消息', `联系人：${contact.name}`, 'busy')
    try {
      await D.douyin.sendMessage(contact.name, text)
      setDraftStatus('消息已发送', `已发送给 ${contact.name}`, 'ok')
      notify('消息已发送')
    }
    catch (error) {
      setDraftStatus('发送失败', error.message, 'error')
      notify(`发送失败：${error.message}`)
    } finally {
      sendButton.disabled = false
    }
  }
}

function bindSparks() {
  const add = document.querySelector('[data-save-spark]')
  if (add) add.onclick = async () => {
    const kind = document.getElementById('spark-kind').value
    const messages = document.getElementById('spark-message').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    const task = { id: Date.now(), name: document.getElementById('spark-name').value, time: document.getElementById('spark-time').value, kind, emojiName: document.getElementById('spark-emoji').value, message: messages[0] || '', messages, enabled: document.getElementById('spark-enabled').value === 'true', autoFill: true }
    if (!task.name || !task.time || ((task.kind === 'text' || task.kind === 'combo') && !messages.length)) return notify('请完整填写任务')
    const sparks = [...(state.data.automation.sparks || [])]
    const editingIndex = Number.isInteger(state.sparkEditing) && state.sparkEditing >= 0 && state.sparkEditing < sparks.length ? state.sparkEditing : null
    if (editingIndex === null) {
      sparks.push(task)
    } else {
      const previous = sparks[editingIndex]
      sparks[editingIndex] = { ...previous, ...task, id: previous.id || task.id }
      state.sparkEditing = null
    }
    await save({ automation: { ...state.data.automation, sparks } }, editingIndex === null ? '续火花任务已保存' : '续火花任务已更新')
  }
  document.querySelector('[data-cancel-spark]')?.addEventListener('click', () => { state.sparkEditing = null; render() })
  document.querySelectorAll('[data-edit-spark]').forEach((button) => { button.onclick = () => { state.sparkEditing = Number(button.dataset.editSpark); render() } })
  document.querySelectorAll('[data-toggle-spark]').forEach((button) => { button.onclick = async () => {
    const sparks = [...state.data.automation.sparks]
    const index = Number(button.dataset.toggleSpark)
    sparks[index] = { ...sparks[index], enabled: !sparks[index].enabled }
    await save({ automation: { ...state.data.automation, sparks } })
  } })
  document.querySelectorAll('[data-delete-spark]').forEach((button) => { button.onclick = async () => {
    const sparks = [...state.data.automation.sparks]
    const index = Number(button.dataset.deleteSpark)
    sparks.splice(index, 1)
    if (state.sparkEditing === index) state.sparkEditing = null
    await save({ automation: { ...state.data.automation, sparks } }, '任务已删除')
  } })
  document.querySelectorAll('[data-run-spark]').forEach((button) => { button.onclick = async () => {
    const task = state.data.automation.sparks[Number(button.dataset.runSpark)]
    const todayMessage = dailySparkMessage(task)
    const content = task.kind === 'emoji' ? `表情包：${task.emojiName}` : task.kind === 'combo' ? `${todayMessage}\n表情包：${task.emojiName}` : todayMessage
    if (state.data.settings?.confirmBeforeSend !== false && !confirm(`立即向“${task.name}”发送：\n\n${content}`)) return
    button.disabled = true
    setActivity('正在发送续火花', `${task.name} · ${task.kind === 'combo' ? '文字 + 表情包' : task.kind === 'emoji' ? '表情包' : '文字'}`, 'busy')
    try { await D.douyin.sendTask(task.name, task); setActivity('续火花已发送', `${task.name} · ${content.replace(/\n/g, ' / ')}`, 'ok'); notify('消息已发送') }
    catch (error) { setActivity('续火花发送失败', error.message, 'error'); notify(`发送失败：${error.message}`) }
    finally { button.disabled = false }
  } })
}

function bindProviders() {
  document.querySelectorAll('[data-edit-provider]').forEach((button) => { button.onclick = () => { state.providerEditing = Number(button.dataset.editProvider); render() } })
  document.querySelectorAll('[data-primary-provider]').forEach((button) => { button.onclick = async () => {
    const index = Number(button.dataset.primaryProvider)
    button.disabled = true
    const result = await D.ai.setPrimaryProvider(index)
    if (!result?.ok) { button.disabled = false; return notify(result?.error || '默认模型设置失败') }
    state.data.providers = result.providers
    state.providerEditing = null
    setActivity('默认模型已切换', providerLabel(state.data.providers[0]), 'ok')
    render()
  } })
  document.querySelectorAll('[data-test-provider]').forEach((button) => { button.onclick = async () => {
    setActivity('正在测试模型', providerLabel(state.data.providers?.[Number(button.dataset.testProvider)]), 'busy')
    const result = await D.ai.testProvider(Number(button.dataset.testProvider))
    setActivity(result?.ok ? '模型连接成功' : '模型连接失败', result?.ok ? providerLabel(state.data.providers?.[Number(button.dataset.testProvider)]) : (result?.message || '请检查模型配置'), result?.ok ? 'ok' : 'error')
    notify(result?.ok ? '模型连接成功' : (result?.message || '模型连接失败'))
  } })
  document.querySelectorAll('[data-delete-provider]').forEach((button) => { button.onclick = async () => {
    const index = Number(button.dataset.deleteProvider)
    if (!confirm(`确定删除“${state.data.providers[index].name}”吗？`)) return
    const result = await D.ai.deleteProvider(index)
    if (!result?.ok) return notify(result?.error || '删除失败')
    state.data.providers = result.providers
    state.providerEditing = null
    notify('模型已删除')
  } })
  const cancel = document.querySelector('[data-cancel-provider]')
  if (cancel) cancel.onclick = () => { state.providerEditing = null; render() }
  const saveButton = document.querySelector('[data-save-provider]')
  if (saveButton) saveButton.onclick = async () => {
    const provider = { name: document.getElementById('provider-name').value.trim(), model: document.getElementById('provider-model').value.trim(), baseUrl: document.getElementById('provider-url').value.trim(), apiKey: document.getElementById('provider-key').value, capabilities: [document.getElementById('provider-cap').value] }
    if (state.providerEditing !== null) provider.index = state.providerEditing
    if (!provider.name || !provider.model || !provider.baseUrl) return notify('请填写名称、模型和接口地址')
    const result = await D.ai.saveProvider(provider)
    if (!result?.ok) return notify(result?.error || '保存失败')
    state.data.providers = result.providers
    state.providerEditing = null
    notify('模型设置已保存')
  }
}

function bindStrategies() {
  const updateRules = (rules, message) => save({ automation: { ...state.data.automation, rules } }, message)
  const add = document.querySelector('[data-save-rule]')
  if (add) add.onclick = async () => {
    const keywords = document.getElementById('rule-keywords').value.split(/[,，\n]+/).map((value) => value.trim()).filter(Boolean)
    const replyText = document.getElementById('rule-reply').value.trim()
    if (!keywords.length || !replyText) return notify('请填写关键词和固定回复')
    await updateRules([...(state.data.automation.rules || []), { id: Date.now(), keywords, replyText, enabled: true }], '话术规则已添加')
  }
  document.querySelectorAll('[data-toggle-rule]').forEach((button) => { button.onclick = async () => {
    const rules = [...(state.data.automation.rules || [])]
    const index = Number(button.dataset.toggleRule)
    rules[index] = { ...rules[index], enabled: rules[index].enabled === false }
    await updateRules(rules, rules[index].enabled ? '话术规则已启用' : '话术规则已停用')
  } })
  document.querySelectorAll('[data-delete-rule]').forEach((button) => { button.onclick = async () => {
    const rules = [...(state.data.automation.rules || [])]
    rules.splice(Number(button.dataset.deleteRule), 1)
    await updateRules(rules, '话术规则已删除')
  } })
}

function render() {
  if (state.section === 'appearance') state.section = 'settings'
  const views = { contacts: contactsView, sparks: sparksView, strategies: strategiesView, providers: providersView, settings: settingsView, audit: auditView }
  document.getElementById('app').innerHTML = (views[state.section] || contactsView)()
  const hadPageMotion = Boolean(state.pageMotion)
  state.pageMotion = ''
  bindCommon()
  if (state.section === 'contacts') bindContacts()
  if (state.section === 'sparks') bindSparks()
  if (state.section === 'strategies') bindStrategies()
  if (state.section === 'providers') bindProviders()
  if (state.section === 'settings') bindSettings()
  if (hadPageMotion) setTimeout(() => document.querySelector('.main-content')?.classList.remove('pcl-page-enter'), 240)
}

D.onDouyinEvent?.(({ type, payload }) => {
  if (type === 'contacts') state.data.contacts = payload?.contacts || []
  if (type === 'inquiries') state.data.automation = { ...state.data.automation, inquiries: payload?.inquiries || [] }
  if (type === 'log') state.data.logs = [payload, ...(state.data.logs || [])].slice(0, 200)
})

load()
