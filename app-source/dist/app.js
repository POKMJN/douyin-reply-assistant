const D = window.desktopApp || {}

const defaults = {
  automation: { autoReply: false, rules: [], sparks: [], inquiries: [], dailyLimit: 30, blacklist: [], aiDisabledContacts: [], paused: false },
  contacts: [],
  providers: [],
  logs: [],
  appearance: { theme: 'auto', fontSize: 'medium', accentColor: '#0067c0', defaultTone: '' },
  settings: {
    launchOnStartup: false, startMinimized: false, minimizeToTray: true, confirmBeforeSend: true,
    desktopNotifications: true, soundNotifications: false, notifyOnSuccess: true, notifyOnFailure: true,
    autoLearnContacts: true, refreshInterval: '5', quietHours: false, quietStart: '23:00', quietEnd: '07:00',
    videoReplyEnabled: true, videoRecognitionEnabled: true, videoLowConfidenceReply: true, videoAnalysisFirst: true, videoRecognitionStrength: 'standard',
    saveLogs: true, logRetention: '30', showAiModelLabel: true, failoverEnabled: true, blur: false,
  },
}

const state = {
  section: 'contacts',
  contactTab: 'profile',
  data: structuredClone(defaults),
  selected: null,
  notice: '',
  quietRender: false,
  providerEditing: null,
  sparkEditing: null,
  compactSettings: false,
  logFilter: { q: '', name: '', type: '' },
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

let eventRenderTimer = null
function isFormControlActive() {
  const tag = String(document.activeElement?.tagName || '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function requestEventRender() {
  if (eventRenderTimer) return
  eventRenderTimer = setTimeout(() => {
    eventRenderTimer = null
    if (isFormControlActive()) {
      requestEventRender()
      return
    }
    render({ quiet: true })
  }, isFormControlActive() ? 800 : 0)
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
    const status = await D.douyin?.getStatus()
    state.data.connected = Boolean(status?.connected)
  } catch {
    state.data = structuredClone(defaults)
  }
  applyAppearance()
  render()
}

const appearanceThemes = [['auto','跟随系统','#f3f3f3'],['light','浅色','#f3f3f3'],['dark','暗色','#202020'],['warm','暖色','#fdf9f3'],['forest','森系','#f4faf6']]
const appearanceAccents = ['#0067c0','#3f6fd8','#2d8a5e','#8b5cf6','#e07b39','#db2777']

function applyAppearance() {
  const ap = state.data.appearance || {}
  // auto=跟随系统（prefers-color-scheme）；warm/forest 旧主题归一到 Fluent 浅色
  const theme = ap.theme || 'auto'
  document.documentElement.setAttribute('data-theme', theme === 'warm' || theme === 'forest' ? 'light' : theme)
  if (ap.accentColor) document.documentElement.style.setProperty('--accent', ap.accentColor)
  // 高斯模糊强度：默认 20px，开启后提到 42px（由 .blur-on 类驱动，CSS 在 enhancements.css）
  document.documentElement.style.setProperty('--blur-strong', state.data.settings?.blur === true ? '42px' : '20px')
}

function douyinIcon(kind = 'note') {
  const paths = {
    contacts: '<path d="M5 18c1.6-3 4-4.5 7-4.5s5.4 1.5 7 4.5"/><circle cx="12" cy="8" r="3.2"/><path d="M4 21h16"/>',
    sparks: '<path d="M13 2 6 13h5l-1 9 8-13h-5l1-7Z"/><path d="M4 18h4m8 0h4"/>',
    drafts: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M9 12h6"/><path d="M12 9v6"/>',
    providers: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M7 10h10M7 14h6"/><path d="M9 19v3m6-3v3"/>',
    settings: '<rect x="5" y="6" width="14" height="12" rx="2"/><path d="M8 10h2m3 0h3M8 14h8"/><circle cx="19" cy="5" r="2"/>',
    audit: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h3"/><path d="m15 16 2 2 4-5"/>',
    persona: '<path d="M12 3a4 4 0 0 0-4 4v1a3 3 0 0 0-1 5.8V17a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-3.2A3 3 0 0 0 16 8V7a4 4 0 0 0-4-4Z"/><path d="M9 9h1m4 0h1M9 13h1m4 0h1M10 21v-1m4 1v-1"/>',
    cat: '<path d="M12 3.5 8 6.8a6.5 6.5 0 0 0-3.5 5.7V16a4 4 0 0 0 4 4h7a4 4 0 0 0 4-4v-3.5A6.5 6.5 0 0 0 16 6.8L12 3.5Z"/><path d="M8.5 6.2 7 2.8M15.5 6.2 17 2.8"/><path d="M10 11h.01M14 11h.01M10 14.2c1.2 1 2.8 1 4 0"/><path d="M5.5 12.8h-2M6.8 15.4l-1.8 1M18.5 12.8h2M17.2 15.4l1.8 1"/>',
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
  return shell(header('设置', '集中管理启动、自动化、通知和本地数据偏好。', '<button class="btn" data-compact-settings>' + (state.compactSettings ? '恢复宽松布局' : '紧凑布局') + '</button><button class="btn" data-export-settings>导出配置</button><button class="btn danger" data-reset-settings>恢复默认</button>') + `<div class="settings-grid${state.compactSettings ? ' compact-settings' : ''}">
    <section class="panel settings-section"><div class="panel-head"><div><h2>应用与通知</h2><p>启动方式、发送交互与系统提醒</p></div></div><div class="settings-list">
      <label class="setting-row"><span><strong>开机自动启动</strong><small>登录 Windows 后自动打开抖音回复助手</small></span><input type="checkbox" data-setting="launchOnStartup" ${checked('launchOnStartup')} /></label>
      <label class="setting-row"><span><strong>启动时最小化</strong><small>启动后直接进入托盘，不打扰当前工作</small></span><input type="checkbox" data-setting="startMinimized" ${checked('startMinimized')} /></label>
      <label class="setting-row"><span><strong>关闭窗口时最小化到托盘</strong><small>保留后台监听和定时任务</small></span><input type="checkbox" data-setting="minimizeToTray" ${checked('minimizeToTray')} /></label>
      <label class="setting-row"><span><strong>发送前确认</strong><small>手动发送消息前显示确认提示</small></span><input type="checkbox" data-setting="confirmBeforeSend" ${checked('confirmBeforeSend')} /></label>
      <label class="setting-row"><span><strong>向对方显示 AI 模型</strong><small>AI 回复前加上当前模型名称；关闭后只发送自然正文</small></span><input type="checkbox" data-setting="showAiModelLabel" ${checked('showAiModelLabel')} /></label>
      <label class="setting-row"><span><strong>桌面通知</strong><small>任务执行和连接状态变化时显示系统通知</small></span><input type="checkbox" data-setting="desktopNotifications" ${checked('desktopNotifications')} /></label>
      <label class="setting-row"><span><strong>提示音</strong><small>收到通知时播放轻提示音</small></span><input type="checkbox" data-setting="soundNotifications" ${checked('soundNotifications')} /></label>
      <label class="setting-row"><span><strong>成功时提醒</strong><small>自动回复或续火花发送成功后提醒</small></span><input type="checkbox" data-setting="notifyOnSuccess" ${checked('notifyOnSuccess')} /></label>
      <label class="setting-row"><span><strong>失败时提醒</strong><small>登录失效、发送失败或模型错误时提醒</small></span><input type="checkbox" data-setting="notifyOnFailure" ${checked('notifyOnFailure')} /></label>
      <div class="setting-row"><span><strong>在线更新</strong><small>检查 GitHub Releases 是否有新版本</small></span><span class="settings-actions"><button class="btn" data-check-update>检查更新</button></span></div>
    </div></section>
    <section class="panel settings-section"><div class="panel-head"><div><h2>自动化</h2><p>控制自动回复、联系人学习、同步频率和免打扰时段</p></div></div><div class="settings-list">
      <label class="setting-row"><span><strong>AI 自动回复</strong><small>全局开启后，联系人页仍可单独禁用某个人的 AI 回复</small></span><input type="checkbox" data-automation-setting="autoReply" ${automationChecked('autoReply')} /></label>
      <label class="setting-row"><span><strong>AI 回复先拟草稿</strong><small>AI 生成的回复不直接发送，进入「AI 草稿」列表由你确认或修改后再手动发送</small></span><input type="checkbox" data-setting="aiReplyDraftOnly" ${checked('aiReplyDraftOnly')} /></label>
      <label class="setting-row"><span><strong>长期记忆</strong><small>自动从对话中提炼对方的重要事实（工作、家人、兴趣等），回复与续火花时自然引用</small></span><input type="checkbox" data-setting="longTermMemory" ${checked('longTermMemory')} /></label>
      <label class="setting-row"><span><strong>临时暂停自动回复</strong><small>暂停期间不会消耗对方新消息，恢复后仍可处理</small></span><input type="checkbox" data-automation-setting="paused" ${automationChecked('paused')} /></label>
      <label class="setting-field"><span><strong>每日发送上限</strong><small>限制自动回复、续火花和视频分享的当日总发送量</small></span><input class="setting-number" type="number" min="1" max="500" step="1" data-automation-setting="dailyLimit" value="${Number(a.dailyLimit ?? 30)}" /></label>
      <label class="setting-row"><span><strong>自动学习联系人</strong><small>生成回复前读取近期对话，改善语气匹配</small></span><input type="checkbox" data-setting="autoLearnContacts" ${checked('autoLearnContacts')} /></label>
      <label class="setting-field"><span><strong>联系人刷新频率</strong><small>后台检查新消息的间隔</small></span><select data-setting="refreshInterval"><option value="5" ${s.refreshInterval==='5'?'selected':''}>5 秒</option><option value="15" ${s.refreshInterval==='15'?'selected':''}>15 秒</option><option value="30" ${s.refreshInterval==='30'?'selected':''}>30 秒</option><option value="60" ${s.refreshInterval==='60'?'selected':''}>1 分钟</option><option value="300" ${s.refreshInterval==='300'?'selected':''}>5 分钟</option></select></label>
      <label class="setting-row"><span><strong>打开视频识别</strong><small>自动回复遇到视频、图片或分享卡片时读取可确认的媒体内容</small></span><input type="checkbox" data-setting="videoRecognitionEnabled" ${checked('videoRecognitionEnabled')} /></label>
      <label class="setting-field"><span><strong>视频识别强度</strong><small>新增公开页模式：只读视频文案和评论，不读取封面、画面或音频</small></span><select data-setting="videoRecognitionStrength"><option value="light" ${s.videoRecognitionStrength==='light'?'selected':''}>轻量</option><option value="standard" ${s.videoRecognitionStrength==='standard'?'selected':''}>标准</option><option value="deep" ${s.videoRecognitionStrength==='deep'?'selected':''}>增强</option><option value="comments20" ${s.videoRecognitionStrength==='comments20'?'selected':''}>文案 + 评论20条</option><option value="comments30" ${s.videoRecognitionStrength==='comments30'?'selected':''}>文案 + 评论30条</option></select></label>
      <label class="setting-row"><span><strong>低置信度保守回复</strong><small>只有封面或截图时允许生成克制回复；关闭后直接跳过</small></span><input type="checkbox" data-setting="videoLowConfidenceReply" ${checked('videoLowConfidenceReply')} /></label>
      <label class="setting-row"><span><strong>先理解再回复</strong><small>先让视觉模型整理画面要点，再生成最终私信</small></span><input type="checkbox" data-setting="videoAnalysisFirst" ${checked('videoAnalysisFirst')} /></label>
      <div class="setting-field"><span><strong>视频识别回复</strong><small>查看自动识别视频、图片和分享卡片的说明</small></span><button class="btn" data-video-reply-info>了解</button></div>
      <label class="setting-row"><span><strong>免打扰时段</strong><small>该时段内不自动回复和发送续火花</small></span><input type="checkbox" data-setting="quietHours" ${checked('quietHours')} /></label>
      <div class="cols settings-times"><label>开始时间<input type="time" data-setting="quietStart" value="${esc(s.quietStart)}" /></label><label>结束时间<input type="time" data-setting="quietEnd" value="${esc(s.quietEnd)}" /></label></div>
      <label class="setting-field setting-textarea"><span><strong>完全跳过联系人</strong><small>这些联系人不会收到自动回复、续火花或自动视频分享；每行一个昵称</small></span><textarea data-automation-list="blacklist" rows="3" placeholder="联系人昵称">${esc(automationNames('blacklist'))}</textarea></label>
    </div></section>
    <section class="panel settings-section"><div class="panel-head"><div><h2>AI Skills</h2><p>自定义提示词模块，按场景注入 AI 回复；支持导入导出</p></div></div>
      <div class="settings-list">
        <div class="ai-skills-toolbar"><button class="btn" data-skill-import>导入 JSON</button><button class="btn" data-skill-export>导出全部</button><button class="btn primary" data-skill-add>添加 Skill</button></div>
        <div id="ai-skills-list" class="ai-skills-list"></div>
        <details class="ai-skills-box" id="ai-skills-import-box"><summary>粘贴 JSON 导入</summary>
          <textarea id="ai-skills-import-text" rows="4" placeholder='[{"name":"语言判断","target":"chat","instruction":"先判断对方语气再回复"}]'></textarea>
          <div class="settings-actions"><button class="btn primary" data-skill-import-confirm>确认导入</button><span class="muted">同名 Skill 会覆盖更新；enabled 默认开启</span></div>
        </details>
        <details class="ai-skills-box" id="ai-skills-form"><summary>手动添加 Skill</summary>
          <div class="cols"><label>名称<input id="skill-name" placeholder="如：语言判断" maxlength="50" /></label><label>适用场景<select id="skill-target"><option value="chat">聊天回复</option><option value="video">视频/评论</option><option value="share">视频分享语</option><option value="all">全部场景</option></select></label></div>
          <label class="setting-textarea">指令内容<textarea id="skill-instruction" rows="4" placeholder="给 AI 的指令，例如：先判断对方这句话的真实语气再回应，反讽就顺着接住" maxlength="2000"></textarea></label>
          <div class="settings-actions"><button class="btn primary" data-skill-add-confirm>添加</button><span class="muted">指令会追加到对应场景的 AI 提示词末尾</span></div>
        </details>
      </div>
    </section>
    <section class="panel settings-section appearance-settings"><div class="panel-head"><div><h2>外观与语气</h2><p>统一管理界面显示和默认回复风格</p></div></div>
      <div class="settings-subsection"><strong>主题</strong><div class="theme-grid">${appearanceThemes.map(([id, label, bg]) => `<button class="theme-card ${ap.theme===id?'active':''}" data-theme-set="${id}"><span class="swatch" style="background:${bg}"></span><span>${label}</span></button>`).join('')}</div></div>
      <div class="settings-subsection"><strong>字体大小</strong><div class="font-size-row"><button class="font-size-btn ${ap.fontSize==='small'?'active':''}" data-font-set="small"><b>Aa</b><span class="demo">小</span></button><button class="font-size-btn ${ap.fontSize==='medium'?'active':''}" data-font-set="medium"><b>Aa</b><span class="demo">中</span></button><button class="font-size-btn ${ap.fontSize==='large'?'active':''}" data-font-set="large"><b>Aa</b><span class="demo">大</span></button></div></div>
      <div class="settings-subsection"><strong>强调色</strong><div class="theme-color-row">${appearanceAccents.map(c => `<button class="theme-color-dot ${ap.accentColor===c?'active':''}" data-accent-set="${c}" style="background:${c};color:${c}" aria-label="选择强调色 ${c}"></button>`).join('')}</div></div>
      <div class="settings-subsection tone-setting"><label>默认 AI 语气<input id="default-tone" list="tone-presets" value="${esc(ap.defaultTone || '')}" placeholder="自动跟随语境" autocomplete="off" /></label><button class="btn primary" data-save-default-tone>保存</button></div>
      <div class="settings-subsection blur-setting"><label class="setting-row"><span><strong>界面高斯模糊</strong><small>对侧栏与面板背景应用更强的高斯模糊效果，视觉更柔和</small></span><input type="checkbox" data-setting="blur" ${checked('blur')} /></label></div>
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
  document.querySelector('[data-compact-settings]')?.addEventListener('click', () => {
    state.compactSettings = !state.compactSettings
    render()
  })
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
      if (key === 'blur') applyAppearance()
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
    link.download = `抖音回复助手设置-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    notify('配置文件已导出')
  })
  document.querySelector('[data-check-update]')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget
    btn.disabled = true
    btn.textContent = '检查中…'
    try {
      const result = await desktopApp.checkUpdate()
      if (!result?.ok) throw new Error(result?.error || '检查更新失败')
      if (result.hasUpdate) {
        notify(`发现新版本 ${result.latestVersion}`)
        if (confirm(`发现新版本 ${result.latestVersion}\n\n是否打开下载页面？`)) desktopApp.openExternal(result.releaseUrl)
      } else {
        const info = await desktopApp.getInfo()
        notify(`当前 v${info.version} 已是最新版本`)
      }
    } catch (error) {
      notify(error.message || '检查更新失败，请稍后重试')
    } finally {
      btn.disabled = false
      btn.textContent = '检查更新'
    }
  })
  document.querySelector('[data-video-reply-info]')?.addEventListener('click', () => {
    alert([
      '视频识别回复说明',
      '',
      '自动回复遇到视频、图片或分享卡片时，会按所选强度读取可确认的信息；公开页模式只读取视频标题、文案和评论，不抓封面、画面或音频。',
      '',
      '轻量：只抓画面，速度最快；标准：画面 + 音频 + 少量评论；增强：画面 + 音频 + 更多评论；文案 + 评论20条/30条：只读公开视频页文案和评论。如果公开视频页、音频或评论不可用，会自动退回可确认的信息，避免编造内容。'
    ].join('\n'))
  })
  bindAiSkills()
}

const SKILL_TARGET_LABELS = { chat: '聊天', video: '视频/评论', share: '分享语', all: '全部' }

function renderAiSkills() {
  const box = document.getElementById('ai-skills-list')
  if (!box) return
  const skills = state.data.aiSkills || []
  if (!skills.length) {
    box.innerHTML = '<div class="muted">还没有 Skill。可导入 JSON，或点击「添加 Skill」写一条自定义指令。</div>'
    return
  }
  box.innerHTML = skills.map((skill, index) => `
    <div class="ai-skill-item">
      <label class="ai-skill-toggle" title="启用/停用"><input type="checkbox" data-skill-toggle="${index}" ${skill.enabled === false ? '' : 'checked'} /></label>
      <div class="ai-skill-main">
        <div class="ai-skill-head"><strong>${esc(skill.name)}</strong><span class="ai-skill-tag">${SKILL_TARGET_LABELS[skill.target] || '全部'}</span></div>
        <div class="ai-skill-desc">${esc(skill.instruction)}</div>
      </div>
      <button class="btn danger btn-sm" data-skill-delete="${index}">删除</button>
    </div>`).join('')
}

function bindAiSkills() {
  renderAiSkills()
  document.querySelector('[data-skill-import]')?.addEventListener('click', () => { const box = document.getElementById('ai-skills-import-box'); if (box) box.open = !box.open })
  document.querySelector('[data-skill-add]')?.addEventListener('click', () => { const form = document.getElementById('ai-skills-form'); if (form) form.open = !form.open })
  document.querySelector('[data-skill-import-confirm]')?.addEventListener('click', async () => {
    const text = document.getElementById('ai-skills-import-text')?.value || ''
    if (!text.trim()) return notify('请先粘贴要导入的 JSON')
    const result = await D.ai.importSkills(text)
    if (!result?.ok) return notify(result?.error || '导入失败')
    state.data.aiSkills = result.skills
    renderAiSkills()
    document.getElementById('ai-skills-import-text').value = ''
    notify(`成功导入 ${result.imported} 个 Skill`)
  })
  document.querySelector('[data-skill-export]')?.addEventListener('click', () => {
    const text = JSON.stringify(state.data.aiSkills || [], null, 2)
    navigator.clipboard?.writeText(text)
    notify('全部 Skill 的 JSON 已复制到剪贴板')
  })
  document.querySelector('[data-skill-add-confirm]')?.addEventListener('click', async () => {
    const name = (document.getElementById('skill-name')?.value || '').trim()
    const instruction = (document.getElementById('skill-instruction')?.value || '').trim()
    const target = document.getElementById('skill-target')?.value || 'all'
    if (!name) return notify('请填写 Skill 名称')
    if (!instruction) return notify('请填写指令内容')
    const skills = [...(state.data.aiSkills || []), { name, target, instruction, enabled: true }]
    const result = await D.ai.saveSkills(skills)
    if (!result?.ok) return notify(result?.error || '保存失败')
    state.data.aiSkills = result.skills
    renderAiSkills()
    document.getElementById('skill-name').value = ''
    document.getElementById('skill-instruction').value = ''
    notify('Skill 已添加')
  })
  document.getElementById('ai-skills-list')?.addEventListener('change', async (event) => {
    const toggle = event.target.closest('[data-skill-toggle]')
    if (!toggle) return
    const index = Number(toggle.dataset.skillToggle)
    const skills = [...(state.data.aiSkills || [])]
    skills[index] = { ...skills[index], enabled: toggle.checked }
    const result = await D.ai.saveSkills(skills)
    if (result?.ok) { state.data.aiSkills = result.skills; notify(toggle.checked ? 'Skill 已启用' : 'Skill 已停用') }
    else renderAiSkills()
  })
  document.getElementById('ai-skills-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-skill-delete]')
    if (!button) return
    const index = Number(button.dataset.skillDelete)
    const skills = (state.data.aiSkills || []).filter((_, i) => i !== index)
    const result = await D.ai.saveSkills(skills)
    if (result?.ok) { state.data.aiSkills = result.skills; renderAiSkills(); notify('Skill 已删除') }
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
  document.querySelectorAll('[data-theme-set]').forEach(el => { el.onclick = async () => {
    const theme = el.dataset.themeSet
    state.data.appearance = { ...state.data.appearance, theme }
    await save({ appearance: state.data.appearance }, '主题已更新')
    applyAppearance()
  }})
  document.querySelectorAll('[data-font-set]').forEach(el => { el.onclick = async () => {
    const fontSize = el.dataset.fontSet
    state.data.appearance = { ...state.data.appearance, fontSize }
    await save({ appearance: state.data.appearance }, '字体大小已调整')
  }})
  document.querySelectorAll('[data-accent-set]').forEach(el => { el.onclick = async () => {
    const accentColor = el.dataset.accentSet
    state.data.appearance = { ...state.data.appearance, accentColor }
    document.documentElement.style.setProperty('--accent', accentColor)
    await save({ appearance: state.data.appearance }, '强调色已更新')
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
    ['drafts', 'AI 草稿', 'drafts'],
    ['providers', '模型设置', 'providers'],
    ['audit', '运行记录', 'audit'],
    ['persona', '行为池', 'persona'],
    ['settings', '设置', 'settings'],
  ]
  return items.map(([id, label, icon]) => `<button class="${state.section === id ? 'active' : ''}" data-nav="${id}">${douyinIcon(icon)}<span>${label}</span></button>`).join('')
}

function shell(content) {
  return `<div class="app${state.quietRender ? ' quiet-render' : ''}${state.data.settings?.blur === true ? ' blur-on' : ''}">
    <aside class="side">
      <div class="brand"><img class="brand-cat" src="./app-icon.png" alt="" /><span>抖音回复助手</span></div>
      <nav class="nav">${nav()}</nav>
      <div class="side-foot">
        <div class="status"><i class="dot ${state.data.connected ? 'on' : ''}"></i>${state.data.connected ? '抖音已连接' : '等待扫码登录'}</div>
        <div class="side-note">本机运行 · 即时监听新消息</div>
      </div>
    </aside>
    <main class="main"><div class="main-content">${content}</div>${renderActivityBar()}</main>
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
  const learnedCount = Number(contact.learning?.messages?.length || 0)
  const learnedAt = contact.learning?.updatedAt ? new Date(contact.learning.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  return `<div class="contact-detail-head">
      <div><h2>${esc(contact.name)}</h2><p>${learnedCount ? `已学习 ${learnedCount} 条对话 · ${esc(learnedAt)}` : '尚未学习历史对话'}</p></div>
      <div class="contact-state-stack"><span class="ai-state ${aiEnabled ? 'on' : 'off'}">${aiEnabled ? '允许 AI 自动回复' : '已禁止 AI 自动回复'}</span></div>
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
  const messageText = kind === 'aiSpark' ? (sparkMessageText(editing) || '') : (sparkMessageText(editing) || DEFAULT_SPARK_MESSAGES.join('\n'))
  const sparkSummary = (task) => task.kind === 'aiSpark'
    ? `AI 每天根据行为池自动生成${task.message ? ` · 备用文案：${esc(task.message)}` : ''}`
    : task.kind === 'emoji'
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
        <div class="cols"><label>类型<select id="spark-kind"><option value="aiSpark" ${kind === 'aiSpark' ? 'selected' : ''}>AI 智能续火花</option><option value="emoji" ${kind === 'emoji' ? 'selected' : ''}>表情包</option><option value="text" ${kind === 'text' ? 'selected' : ''}>文字</option><option value="combo" ${kind === 'combo' ? 'selected' : ''}>文字 + 表情包</option></select></label><label>表情包<select id="spark-emoji"><option ${emojiName === '早上好' ? 'selected' : ''}>早上好</option><option ${emojiName === '晚上好' ? 'selected' : ''}>晚上好</option><option ${emojiName === '早点睡' ? 'selected' : ''}>早点睡</option><option ${emojiName === '续火花' ? 'selected' : ''}>续火花</option></select></label></div>
        <div class="cols"><label>时间<input id="spark-time" type="time" value="${esc(editing?.time || '20:00')}" /></label><label>状态<select id="spark-enabled"><option value="true" ${enabled ? 'selected' : ''}>启用</option><option value="false" ${enabled ? '' : 'selected'}>停用</option></select></label></div>
        <label>${kind === 'aiSpark' ? '提示与备用文案' : '文字内容'}<span class="form-hint">${kind === 'aiSpark' ? '可留空：AI 会从行为池（该联系人近期聊天与说话风格）每天自动生成；生成失败时使用此文案' : '每行一条，文字或“文字 + 表情包”任务会按日期随机发送其中一条'}</span><textarea id="spark-message" placeholder="${kind === 'aiSpark' ? '例如：昨天聊的那个话题后来怎么样了？' : '今天也来续个火花呀～&#10;想你啦，来续个火花&#10;今日份火花打卡'}">${esc(messageText)}</textarea></label>
        <div class="form-actions">${editing ? '<button class="btn" data-cancel-spark>取消编辑</button>' : ''}<button class="btn primary" data-save-spark ${contactNames.length ? '' : 'disabled'}>${editing ? '保存修改' : '保存任务'}</button></div>
      </div>
    </section>
    <section class="panel span-7"><div class="panel-head"><div><h2>任务列表</h2><p>${tasks.length} 个任务 · 已开启自动检测补续</p></div></div>
      ${tasks.length ? `<div class="list">${tasks.map((task, index) => `<div class="row ${editingIndex === index ? 'editing-row' : ''}"><div class="row-main"><strong>${esc(task.name)}</strong><span>每天 ${esc(task.time)} · ${sparkSummary(task)}</span></div>${task.lastRunDate === localDateKey() ? '<span class="tag">今日已完成</span>' : ''}<span class="tag">${task.kind === 'aiSpark' ? 'AI 智能' : task.kind === 'combo' ? '组合' : task.kind === 'emoji' ? '表情包' : '文字'}</span><span class="tag ${task.enabled ? '' : 'off'}">${task.enabled ? '启用' : '停用'}</span><div class="task-actions"><button class="btn ghost" data-edit-spark="${index}">编辑</button><button class="btn ghost" data-run-spark="${index}">立即发送</button><button class="btn ghost" data-toggle-spark="${index}">${task.enabled ? '停用' : '启用'}</button><button class="btn ghost danger" data-delete-spark="${index}">删除</button></div></div>`).join('')}</div>` : '<div class="empty">还没有续火花任务</div>'}
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
  const failoverEnabled = state.data.settings?.failoverEnabled !== false
  return shell(header('模型设置', `当前默认：${providerLabel()}`) + `<div class="grid">
    <section class="panel span-5"><div class="panel-head"><div><h2>当前模型</h2><p>${providers.length} 个提供商 · 默认使用置顶模型</p></div></div>
      ${providers.length ? `<div class="list">${providers.map((provider, index) => `<div class="row provider-row ${index === 0 ? 'active-provider' : ''}"><div class="row-main"><strong>${esc(provider.name)}</strong><span>${esc(provider.model)} · ${esc(provider.baseUrl)}</span></div>${index === 0 ? '<span class="tag">默认</span>' : `<button class="btn ghost" data-primary-provider="${index}">设为默认</button>`}<button class="btn ghost" data-test-provider="${index}">测试</button><button class="btn ghost" data-edit-provider="${index}">编辑</button><button class="btn ghost danger" data-delete-provider="${index}">删除</button></div>`).join('')}</div>` : '<div class="empty">还没有配置模型</div>'}
      <div class="setting-row" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)"><span><strong>主模型失败自动切换</strong><small>默认模型连接或生成失败时，按列表顺序自动尝试下一个模型（A→B→…）；关闭后只使用默认模型</small></span><input type="checkbox" data-failover ${failoverEnabled ? 'checked' : ''} /></div>
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

// 日志类型 → [中文处理行为标签, 徽章色(ok/warn/error)]
const LOG_LABELS = {
  message_sent: ['消息已发送', 'ok'],
  send_error: ['发送失败', 'error'],
  send_blocked: ['发送被阻止', 'warn'],
  auto_skip: ['跳过（自己发送）', 'warn'],
  auto_blocked: ['自动回复被阻止', 'warn'],
  ai_error: ['AI 调用失败', 'error'],
  ai_backoff: ['AI 调用暂缓', 'warn'],
  ai_unavailable: ['AI 暂不可用', 'error'],
  ai_empty: ['AI 无可用回复', 'warn'],
  ai_reply_rejected: ['AI 回复被拒绝', 'warn'],
  ai_draft: ['已拟回复草稿', 'warn'],
  ai_reply_skipped: ['AI 回复已跳过', 'warn'],
  ai_provider_failed: ['模型服务失败', 'error'],
  ai_multi_candidate: ['生成多候选回复', 'ok'],
  ai_natural_rewrite_failed: ['自然改写失败', 'error'],
  ai_media_analysis_failed: ['媒体分析失败', 'error'],
  ai_media_analysis_unavailable: ['媒体分析不可用', 'warn'],
  ai_video_share_draft: ['视频分享草稿', 'warn'],
  audio_transcription_failed: ['语音转写失败', 'error'],
  language_learned: ['学习对话风格', 'ok'],
  media_text_fallback: ['媒体转文本回退', 'warn'],
  media_skipped: ['跳过媒体', 'warn'],
  media_audio_transcribed: ['语音已转文字', 'ok'],
  media_audio_unavailable: ['语音转写不可用', 'warn'],
  inquiry_sent: ['话题代问已发出', 'ok'],
  inquiry_answered: ['代问已收到回复', 'ok'],
  inquiry_failed: ['话题代问失败', 'error'],
  spark_sent: ['续火花已发送', 'ok'],
  spark_fill_skipped: ['续火花跳过', 'warn'],
  spark_fill_failed: ['续火花补发失败', 'error'],
  ai_spark_draft: ['AI 续火花文案', 'ok'],
  ai_spark_fallback: ['AI 续火花回退', 'warn'],
  ai_draft_pending: ['AI 草稿待确认', 'warn'],
  ai_facts_mined: ['长期记忆已更新', 'ok'],
  worker_watchdog: ['任务执行超时', 'error'],
  video_captured: ['已捕获视频', 'ok'],
  video_unreadable: ['视频不可读', 'warn'],
  video_low_confidence: ['视频识别低置信', 'warn'],
  video_comments_captured: ['已捕获评论', 'ok'],
  video_comments_unavailable: ['评论不可用', 'warn'],
  video_public_context_ready: ['公开上下文就绪', 'ok'],
  video_share_sent: ['视频分享已发送', 'ok'],
  video_share_failed: ['视频分享失败', 'error'],
  video_share_caption_fallback: ['视频文案回退', 'warn'],
  video_share_discovery_fallback: ['视频发现回退', 'warn'],
  video_hook_debug: ['视频钩子调试', 'warn'],
  video_url_capture_debug: ['视频地址捕获', 'warn'],
  worker_error: ['工作进程错误', 'error'],
  crash: ['未捕获异常', 'error'],
}

// 提取日志的“最终结果”文案；无结果返回 null
function logResult(detail = {}) {
  if (detail.error) return { text: String(detail.error), tone: 'error' }
  if (detail.text) return { text: String(detail.text), tone: '' }
  if (detail.answer != null) return { text: `对方回复：${String(detail.answer)}${detail.report ? `\n摘要：${String(detail.report)}` : ''}`, tone: '' }
  if (detail.messages != null) return { text: `已学习 ${detail.messages} 条对话`, tone: '' }
  if (detail.question) return { text: `问题：${String(detail.question)}`, tone: '' }
  if (detail.aiLabel) return { text: String(detail.aiLabel), tone: 'muted' }
  return null
}

function auditView() {
  const logs = state.data.logs || []
  const filter = state.logFilter || { q: '', name: '', type: '' }
  // 收集联系人下拉选项（从日志里实际出现过的联系人 + 现有联系人）
  const contactOptions = [...new Set([
    ...logs.map((entry) => entry.detail?.name || '').filter(Boolean),
    ...(state.data.contacts || []).map((contact) => contact.name),
  ])].sort((a, b) => a.localeCompare(b, 'zh'))
  const typeOptions = Object.entries(LOG_LABELS)
    .filter(([key]) => key !== 'crash' && key !== 'worker_error')
    .sort((a, b) => a[1][0].localeCompare(b[1][0], 'zh'))
  const keyword = filter.q.trim().toLowerCase()
  const filtered = logs.filter((entry) => {
    if (filter.name && entry.detail?.name !== filter.name) return false
    if (filter.type && entry.type !== filter.type) return false
    if (keyword) {
      const haystack = `${entry.message || ''} ${entry.type || ''} ${entry.detail?.name || ''} ${entry.detail?.error || ''} ${entry.detail?.text || ''} ${entry.detail?.answer || ''} ${entry.detail?.report || ''} ${entry.detail?.preview || ''}`.toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
  return shell(header('运行记录', '每条记录在一个框内展示：捕捉到的账号、处理行为与最终结果。', '<button class="btn" data-refresh>刷新</button>') + `<section class="panel">
    <div class="log-filter-bar">
      <input id="log-filter-q" type="search" placeholder="搜索关键词（消息内容、错误信息…）" value="${esc(filter.q)}" />
      <select id="log-filter-name"><option value="">全部联系人</option>${contactOptions.map((name) => `<option value="${esc(name)}" ${filter.name === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>
      <select id="log-filter-type"><option value="">全部类型</option>${typeOptions.map(([key, [label]]) => `<option value="${key}" ${filter.type === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
      <span class="log-filter-count">${filtered.length} / ${logs.length} 条</span>
    </div>
    ${filtered.length ? `<div class="timeline">${filtered.map((entry) => {
      const detail = entry.detail || {}
      const [label, tone] = LOG_LABELS[entry.type] || [entry.message || entry.type, 'warn']
      const account = detail.name ? detail.name : '系统'
      const result = logResult(detail)
      const time = new Date(entry.at).toLocaleString('zh-CN', { hour12: false })
      const source = detail.aiLabel || (detail.ai ? `AI · ${detail.model || '当前模型'}` : '')
      return `<div class="log-card">
        <div class="log-field">
          <span class="log-field-label">账号</span>
          <div class="log-account"><span class="log-account-avatar">${esc(account.slice(0, 1))}</span><strong>${esc(account)}</strong><time>${esc(time)}</time></div>
        </div>
        <div class="log-field">
          <span class="log-field-label">行为</span>
          <span class="log-action-badge ${tone}">${esc(label)}</span>
        </div>
        ${result ? `<div class="log-result"><span class="log-field-label">结果</span><div class="log-result-text ${result.tone}">${esc(result.text)}${source ? `<div class="muted" style="margin-top:4px">${esc(source)}</div>` : ''}</div></div>` : ''}
      </div>`
    }).join('')}</div>` : (logs.length ? '<div class="empty">没有符合筛选条件的记录</div>' : '<div class="empty">暂无运行记录</div>')}
  </section>`)
}

function draftsView() {
  const drafts = state.data.pendingDrafts || []
  const pending = drafts.filter((draft) => draft.status === 'pending')
  const sent = drafts.filter((draft) => draft.status === 'sent' || draft.status === 'discarded')
  return shell(header('AI 草稿', '开启「AI 回复先拟草稿」后，AI 生成的回复会先到这里由你确认或修改，确认后才会发送。', '<button class="btn" data-draft-clear>清空已处理</button>') + `<section class="panel">
    <div class="panel-head"><div><h2>待确认（${pending.length}）</h2><p>点击「发送」立即发送；也可编辑内容后发送</p></div></div>
    ${pending.length ? `<div class="list">${pending.map((draft, index) => `<div class="draft-card" data-draft-id="${draft.id}">
      <div class="draft-meta"><strong>${esc(draft.name)}</strong><time>${esc(new Date(draft.at).toLocaleString('zh-CN', { hour12: false }))}</time>${draft.model ? `<span class="tag">${esc(draft.model)}</span>` : ''}</div>
      ${draft.incoming ? `<div class="draft-incoming"><span class="muted">对方：</span>${esc(draft.incoming)}</div>` : ''}
      <textarea data-draft-text="${index}" rows="2">${esc(draft.text)}</textarea>
      <div class="form-actions"><button class="btn ghost danger" data-draft-discard="${draft.id}">丢弃</button><button class="btn primary" data-draft-send="${draft.id}">发送</button></div>
    </div>`).join('')}</div>` : '<div class="empty">暂无待确认的草稿</div>'}
  </section>
  ${sent.length ? `<section class="panel"><div class="panel-head"><div><h2>已处理（${sent.length}）</h2><p>已发送或已丢弃的草稿</p></div></div><div class="list">${sent.slice(0, 30).map((draft) => `<div class="draft-card done"><div class="draft-meta"><strong>${esc(draft.name)}</strong><time>${esc(new Date(draft.at).toLocaleString('zh-CN', { hour12: false }))}</time><span class="tag ${draft.status === 'sent' ? '' : 'off'}">${draft.status === 'sent' ? '已发送' : '已丢弃'}</span></div><div class="draft-text">${esc(draft.text)}</div></div>`).join('')}</div></section>` : ''}`)
}

function personaView() {
  const contacts = state.data.contacts || []
  const learned = contacts.filter((contact) => contact.learning && (contact.learning.messages?.length || contact.learning.contactStyle || contact.learning.ownerStyle))
  const totalMessages = learned.reduce((sum, contact) => sum + Number(contact.learning?.messages?.length || 0), 0)
  const head = header('行为池', '聚合展示从对话与视频中学习到的行为特征——这就是当前 AI 回复时的“行为池”。')
  if (!learned.length) {
    return shell(head + `<section class="panel"><div class="persona-empty"><strong>尚未学习任何对话</strong><span>保持自动回复运行并开启自动学习后，系统会从与联系人的对话中提炼风格。</span></div></section>`)
  }
  return shell(head + `<div class="persona-hero">
      <strong><span class="persona-icon">${douyinIcon('persona')}</span>当前行为池由 ${learned.length} 位联系人的学习塑造</strong>
      <span>共聚合 ${totalMessages} 条学习到的对话 · 对方风格影响“如何接话”，我的风格影响“如何说话”。</span>
    </div>
    <div class="persona-list">${learned.map((contact) => {
      const learning = contact.learning || {}
      const messages = learning.messages || []
      const contactStyle = learning.contactStyle || {}
      const ownerStyle = learning.ownerStyle || {}
      const videoInsights = learning.videoInsights || []
      const facts = learning.facts || []
      const updatedAt = learning.updatedAt ? new Date(learning.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''
      return `<div class="persona-card">
        <div class="persona-head">
          <span class="persona-avatar">${esc(contact.name.slice(0, 1))}</span>
          <div class="persona-head-main"><strong>${esc(contact.name)}</strong><span>已学习 ${messages.length} 条对话${updatedAt ? ` · 更新于 ${esc(updatedAt)}` : ''}</span></div>
          <button class="btn ghost danger" data-clear-persona="${esc(contact.name)}">清除学习</button>
        </div>
        <div class="persona-styles">
          <div class="persona-style"><span class="persona-style-label">对方风格</span><span class="persona-style-chip ${contactStyle.summary ? '' : 'empty'}">${esc(contactStyle.summary || '尚未提炼')}</span></div>
          <div class="persona-style"><span class="persona-style-label">我的风格</span><span class="persona-style-chip ${ownerStyle.summary ? '' : 'empty'}">${esc(ownerStyle.summary || '尚未提炼')}</span></div>
        </div>
        ${facts.length ? `<div class="persona-style"><span class="persona-style-label">长期记忆</span><div class="persona-facts">${facts.slice(-10).map((fact) => `<span class="persona-fact">${esc(fact)}</span>`).join('')}</div></div>` : ''}
        ${videoInsights.length ? `<div class="persona-style"><span class="persona-style-label">视频洞察</span><div class="persona-insights">${videoInsights.slice(-6).reverse().map((item) => `<div class="persona-insight"><time>${esc(new Date(item.at).toLocaleDateString('zh-CN'))}</time><span>${esc(item.insight)}</span></div>`).join('')}</div></div>` : ''}
        ${messages.length ? `<details class="persona-details"><summary>查看学习到的对话（${messages.length} 条）</summary><div class="persona-messages">${messages.map((msg) => {
          const isMe = msg.role === 'me'
          return `<div class="persona-msg ${isMe ? 'me' : 'contact'}"><span class="who">${isMe ? '我' : esc(contact.name)}</span><span class="text">${esc(msg.text)}</span></div>`
        }).join('')}</div></details>` : ''}
      </div>`
    }).join('')}</div>`)
}

function bindPersona() {
  document.querySelectorAll('[data-clear-persona]').forEach((button) => {
    button.onclick = async () => {
      const name = button.dataset.clearPersona
      if (!confirm(`确定清除“${name}”的全部学习记录吗？此操作不可恢复。`)) return
      button.disabled = true
      try {
        const result = await D.ai.clearLearning(name)
        if (!result?.ok) throw new Error(result?.error || '清除失败')
        state.data.contacts = state.data.contacts.map((contact) => (contact.name === name ? { ...contact, learning: undefined } : contact))
        notify('已清除该联系人的学习记录')
        render()
      } catch (error) {
        notify(`清除失败：${error.message}`)
        button.disabled = false
      }
    }
  })
}

function bindCommon() {
  document.querySelectorAll('[data-nav]').forEach((button) => { button.onclick = () => { state.section = button.dataset.nav; render() } })
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
  // 运行记录筛选：关键词/联系人/类型
  const q = document.getElementById('log-filter-q')
  if (q) q.oninput = () => { state.logFilter.q = q.value; render({ quiet: true }) }
  const nameFilter = document.getElementById('log-filter-name')
  if (nameFilter) nameFilter.onchange = () => { state.logFilter.name = nameFilter.value; render({ quiet: true }) }
  const typeFilter = document.getElementById('log-filter-type')
  if (typeFilter) typeFilter.onchange = () => { state.logFilter.type = typeFilter.value; render({ quiet: true }) }
}

function bindContacts() {
  document.querySelectorAll('[data-select]').forEach((button) => { button.onclick = () => { state.selected = button.dataset.select; render() } })
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
    const content = task.kind === 'emoji' ? `表情包：${task.emojiName}` : task.kind === 'combo' ? `${todayMessage}\n表情包：${task.emojiName}` : task.kind === 'aiSpark' ? `AI 每天根据行为池自动生成${task.message ? `（备用文案：${task.message}）` : ''}` : todayMessage
    if (state.data.settings?.confirmBeforeSend !== false && !confirm(`立即向“${task.name}”发送：\n\n${content}`)) return
    button.disabled = true
    const kindLabel = task.kind === 'combo' ? '文字 + 表情包' : task.kind === 'emoji' ? '表情包' : task.kind === 'aiSpark' ? 'AI 智能续火花' : '文字'
    setActivity('正在发送续火花', `${task.name} · ${kindLabel}`, 'busy')
    try { await D.douyin.sendTask(task.name, task); setActivity('续火花已发送', `${task.name} · ${(task.kind === 'aiSpark' ? 'AI 生成' : content).replace(/\n/g, ' / ')}`, 'ok'); notify('消息已发送') }
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
  const failover = document.querySelector('[data-failover]')
  if (failover) failover.onchange = async () => {
    const settings = { ...(state.data.settings || {}), failoverEnabled: failover.checked }
    state.data.settings = settings
    await save({ settings }, failover.checked ? '已开启模型自动切换' : '已关闭模型自动切换')
  }
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

function bindDrafts() {
  document.querySelector('[data-draft-clear]')?.addEventListener('click', async () => {
    const drafts = (state.data.pendingDrafts || []).filter((draft) => draft.status === 'pending')
    await save({ pendingDrafts: drafts }, '已清空已处理的草稿')
  })
  document.querySelectorAll('[data-draft-send]').forEach((button) => { button.onclick = async () => {
    const id = Number(button.dataset.draftSend)
    const card = document.querySelector(`[data-draft-id="${id}"]`)
    const textarea = card?.querySelector('textarea')
    const text = (textarea?.value || '').trim()
    if (!text) return notify('草稿内容为空，无法发送')
    const draft = (state.data.pendingDrafts || []).find((item) => item.id === id)
    if (!draft) return notify('草稿不存在')
    if (state.data.settings?.confirmBeforeSend !== false && !confirm(`确定向“${draft.name}”发送这条回复吗？\n\n${text}`)) return
    button.disabled = true
    try {
      await D.douyin.sendMessage(draft.name, text)
      const drafts = (state.data.pendingDrafts || []).map((item) => item.id === id ? { ...item, status: 'sent', sentAt: new Date().toISOString() } : item)
      state.data.pendingDrafts = drafts
      await save({ pendingDrafts: drafts }, `已向 ${draft.name} 发送`)
    } catch (error) {
      notify(`发送失败：${error.message}`)
      button.disabled = false
    }
  } })
  document.querySelectorAll('[data-draft-discard]').forEach((button) => { button.onclick = async () => {
    const id = Number(button.dataset.draftDiscard)
    if (!confirm('确定丢弃这条草稿吗？')) return
    const drafts = (state.data.pendingDrafts || []).map((item) => item.id === id ? { ...item, status: 'discarded' } : item)
    await save({ pendingDrafts: drafts }, '草稿已丢弃')
  } })
}

function render(options = {}) {
  state.quietRender = Boolean(options.quiet)
  if (state.section === 'appearance') state.section = 'settings'
  const views = { contacts: contactsView, sparks: sparksView, drafts: draftsView, providers: providersView, settings: settingsView, audit: auditView, persona: personaView }
  document.getElementById('app').innerHTML = (views[state.section] || contactsView)()
  bindCommon()
  if (state.section === 'contacts') bindContacts()
  if (state.section === 'sparks') bindSparks()
  if (state.section === 'drafts') bindDrafts()
  if (state.section === 'providers') bindProviders()
  if (state.section === 'settings') bindSettings()
  if (state.section === 'persona') bindPersona()
}

D.onDouyinEvent?.(({ type, payload }) => {
  let shouldRender = false
  if (type === 'contacts') {
    state.data.contacts = payload?.contacts || []
    shouldRender = state.section === 'contacts'
  }
  if (type === 'inquiries') {
    state.data.automation = { ...state.data.automation, inquiries: payload?.inquiries || [] }
    shouldRender = shouldRender || state.section === 'contacts'
  }
  if (type === 'drafts') {
    state.data.pendingDrafts = payload?.drafts || []
    shouldRender = shouldRender || state.section === 'drafts'
  }
  if (type === 'log') {
    state.data.logs = [payload, ...(state.data.logs || [])].slice(0, 200)
    shouldRender = shouldRender || state.section === 'audit'
  }
  if (type === 'status') {
    state.data.connected = Boolean(payload?.connected)
    shouldRender = true
  }
  if (shouldRender) requestEventRender()
})

load()
