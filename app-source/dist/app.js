// v2 渲染层：无框架、无动画、事件全量委托。
// 可靠性设计：
// - 所有按钮通过单一 document 级 click 委托 + data-act 分发表处理，重渲染不会丢失监听；
// - 异步操作期间按钮自动禁用（busy），避免重复提交导致的"点了没反应"；
// - 设置项通过 data-path 声明存储路径，change 事件自动保存，无需依赖渲染时机。
//
// 渲染分层（修复"滚动被重置/下拉自动关闭"）：
// - 结构渲染 render()：仅在切换页面、切换联系人、打开/关闭编辑表单时执行，并保持滚动位置；
// - 数据补丁 refreshDynamic()：后台事件（轮询同步/日志/状态）只替换列表容器，
//   带"焦点保护"（容器内有输入焦点就跳过）和"滚动保持"（替换前后恢复 scrollTop），
//   表单区域永远不被后台事件触碰——展开中的下拉选项不会被销毁。
const api = window.desktopApp

const LOG_LABELS = {
  message_sent: '发送消息', send_error: '发送失败', send_blocked: '发送受限',
  auto_skip: '跳过（自己发的）', auto_blocked: '已拉黑跳过', auto_recheck: '暂缓重查', worker_error: '轮询异常', worker_watchdog: '轮询看门狗',
  ai_error: 'AI 调用失败', ai_backoff: 'AI 退避', ai_unavailable: 'AI 不可用', ai_empty: 'AI 空回复', ai_reply_rejected: 'AI 拒发', ai_reply_skipped: 'AI 判断不回复', ai_draft: 'AI 草稿', ai_draft_pending: '草稿待确认', ai_natural_rewrite_failed: '重写失败', ai_provider_failed: '模型切换', ai_provider_cooldown: '模型降级',
  media_text_fallback: '媒体转文本', media_skipped: '媒体跳过', media_audio_transcribed: '音频已转写', media_audio_unavailable: '音频不可用', audio_transcription_failed: '转写失败', ai_media_analysis_failed: '媒体理解失败', ai_media_analysis_unavailable: '媒体理解不可用', video_unreadable: '视频不可读', media_captured: '媒体已捕获', video_public_context_ready: '视频上下文就绪',
  language_learned: '会话学习', ai_facts_mined: '长期记忆更新', ai_topic_summarized: '话题状态更新',
  spark_sent: '问候已发送', spark_fill_skipped: '问候跳过', spark_fill_failed: '问候失败', ai_spark_draft: '问候文案', ai_spark_fallback: '问候回退',
  ai_companion_draft: '伴聊草稿', companion_sent: '伴聊已发送', companion_error: '伴聊失败',
  verification_required: '需要安全验证', verification_cleared: '验证已通过',
  memory_hygiene: '内存自动优化',
  crash: '异常', app_boot: '启动',
}

const SECTION_TITLES = { chat: '对话', train: '训练场', drafts: '草稿', tasks: '任务', models: '模型', logs: '运行记录', settings: '设置' }

const S = {
  section: 'chat',
  info: null,
  accounts: { active: null, accounts: [] },
  data: null, // automation state 镜像
  status: { connected: false },
  selected: '', // 当前查看的联系人名
  contactSearch: '',
  notice: null,
  noticeTimer: null,
  logFilter: { type: '', keyword: '' },
  providerEditing: null, // null 关闭；-1 新建；>=0 编辑
  modelOptions: [], // 拉取到的模型 ID 候选（仅当前表单，不落库）
  modelFetchMsg: '', // 拉取状态提示文案
  basePreviewTimer: null,
  sparkEditing: null, // null 关闭；'new' 新建
  lastDraftsCount: -1,
  weatherPreview: '',
  train: { name: '', log: [], draft: null, lastIncoming: '' },
}

// ---- 工具 ----
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }) } catch { return '' } }
const isTypingIn = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')

// 提示条：只更新顶栏提示元素，绝不触发整页渲染
function showNotice(message, kind = 'ok') {
  S.notice = { message, kind }
  const el = document.getElementById('topbar-notice')
  if (el) el.outerHTML = `<div id="topbar-notice" class="notice ${kind}">${esc(message)}</div>`
  else render()
  clearTimeout(S.noticeTimer)
  if (kind !== 'err') S.noticeTimer = setTimeout(() => {
    S.notice = null
    const node = document.getElementById('topbar-notice')
    if (node) node.outerHTML = '<div id="topbar-notice" style="display:none"></div>'
  }, 2600)
}

// 数据补丁：替换容器 innerHTML，但
// 1) 容器内存在输入焦点（正在打字/选择了下拉）→ 跳过本次补丁，等下一个事件；
// 2) 替换前后保持 scrollTop，滚动位置不丢。
function patchContainer(id, html) {
  const el = document.getElementById(id)
  if (!el) return false
  if (el.contains(document.activeElement) && isTypingIn(document.activeElement)) return false
  const scrollTop = el.scrollTop
  el.innerHTML = html
  el.scrollTop = scrollTop
  return true
}

// 保存/恢复整个视图的滚动位置（结构渲染用；按 section 记忆，切页归零）
const scrollMemory = { section: null, values: [] }
function captureScrolls() {
  if (scrollMemory.section === S.section) {
    scrollMemory.values = [...document.querySelectorAll('.view, .list-scroll, .contact-detail')].map((el) => ({ cls: el.className, top: el.scrollTop }))
  } else {
    scrollMemory.section = S.section
    scrollMemory.values = []
  }
}
function restoreScrolls() {
  for (const saved of scrollMemory.values) {
    const el = [...document.querySelectorAll('.view, .list-scroll, .contact-detail')].find((node) => node.className === saved.cls)
    if (el) el.scrollTop = saved.top
  }
}

// 结构渲染：切页 / 换联系人 / 表单开关时执行
function render() {
  if (!S.data) return
  applyTheme()
  captureScrolls()
  const draftsCount = (S.data.pendingDrafts || []).length
  S.lastDraftsCount = draftsCount
  const navItems = [
    ['chat', '对话'], ['train', '训练场'], ['drafts', `草稿${draftsCount ? ` <span class="rail-badge">${draftsCount}</span>` : ''}`],
    ['tasks', '任务'], ['models', '模型'], ['logs', '运行记录'], ['settings', '设置'],
  ]
  const views = { chat: chatView, train: trainView, drafts: draftsView, tasks: tasksView, models: modelsView, logs: logsView, settings: settingsView }
  document.getElementById('app').innerHTML = `
    <div class="layout">
      <div class="rail">
        <div class="rail-brand">抖音回复助手<small>v${esc(S.info?.version || '')}</small></div>
        <div class="rail-nav">
          ${navItems.map(([key, label]) => `<button class="rail-item ${S.section === key ? 'active' : ''}" data-act="nav" data-args="${esc(JSON.stringify({ section: key }))}"><span>${label}</span></button>`).join('')}
        </div>
        <div class="rail-bottom">
          <div class="field"><label>当前账号</label><select data-act-change="switch-account">
            ${(S.accounts.accounts || []).map((a) => `<option value="${esc(a.id)}" ${S.accounts.active === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select></div>
        </div>
      </div>
      <div class="main">
        <div class="topbar">
          <h2>${SECTION_TITLES[S.section] || ''}</h2>
          ${S.notice ? `<div id="topbar-notice" class="notice ${S.notice.kind}">${esc(S.notice.message)}</div>` : '<div id="topbar-notice" style="display:none"></div>'}
        </div>
        <div class="view">${views[S.section] ? views[S.section]() : ''}</div>
      </div>
    </div>`
  restoreScrolls()
  // 模型表单打开时，重算一次接口地址预览（render 会重建 DOM）
  if (document.getElementById('pv-base')) refreshBasePreview()
}

// 数据补丁：后台事件只刷新动态区域，绝不触碰表单
let dynamicTimer = null
function queueDynamic() {
  if (dynamicTimer) return
  dynamicTimer = setTimeout(() => {
    dynamicTimer = null
    refreshDynamic()
  }, 300)
}

function refreshDynamic() {
  if (!S.data) return
  applyTheme()
  // 顶栏状态徽标
  const pills = statusPills()
  patchContainer('topbar-status', pills)
  // 侧栏草稿角标
  const draftsCount = (S.data.pendingDrafts || []).length
  if (draftsCount !== S.lastDraftsCount) {
    S.lastDraftsCount = draftsCount
    const item = document.querySelector('.rail-item[data-args*="drafts"] span')
    if (item) item.innerHTML = `草稿${draftsCount ? ` <span class="rail-badge">${draftsCount}</span>` : ''}`
  }
  // 当前页面的列表区域
  if (S.section === 'chat') {
    const searchEl = document.getElementById('contact-search')
    if (searchEl) S.contactSearch = searchEl.value
    patchContainer('contact-list-scroll', contactListItems())
    const contact = (S.data.contacts || []).find((c) => c.name === S.selected)
    const summary = document.getElementById('learn-summary')
    if (summary && contact) {
      const learning = contact.learning || {}
      summary.textContent = `最近消息 ${learning.messages?.length || 0} 条 · 长期记忆 ${learning.facts?.length || 0} 条 · 话题记录 ${learning.topicLog?.length || 0} 条 · 视频上下文 ${learning.mediaLog?.length || 0} 条`
    }
    const hint = document.getElementById('manual-hint')
    if (hint && contact) hint.textContent = contact.preview ? `对方最近：${String(contact.preview).slice(0, 40)}` : ''
    patchContainer('chat-actions', chatActions())
  } else if (S.section === 'drafts') {
    patchContainer('drafts-list', draftsList())
  } else if (S.section === 'tasks') {
    patchContainer('sparks-list', sparksList())
  } else if (S.section === 'models') {
    patchContainer('providers-list', providersList())
  } else if (S.section === 'logs') {
    patchContainer('logs-list', logsList())
  }
}

function statusPills() {
  return `<span class="pill ${S.status.connected ? 'ok' : 'err'}">${S.status.connected ? '已登录' : '未登录'}</span>
    ${S.status.verification ? '<span class="pill err">需要安全验证</span>' : ''}`
}

// ---- 数据加载 ----
async function loadAll() {
  try {
    const [info, accounts, state] = await Promise.all([api.getInfo(), api.accounts.list(), api.automation.getState()])
    S.info = info
    S.accounts = accounts
    S.data = state
    const status = await api.douyin.getStatus().catch(() => ({ connected: false }))
    S.status = status
    if (!S.selected && state.contacts?.length) S.selected = state.contacts[0].name
    render()
  } catch (error) {
    document.getElementById('app').innerHTML = `<div class="empty">初始化失败：${esc(error.message)}</div>`
  }
}

api.onDouyinEvent((event) => {
  if (!S.data || (event.accountId && event.accountId !== S.accounts.active)) return
  const { type, payload } = event
  if (type === 'contacts' && Array.isArray(payload?.contacts)) S.data.contacts = payload.contacts
  else if (type === 'drafts' && Array.isArray(payload?.drafts)) S.data.pendingDrafts = payload.drafts
  else if (type === 'log' && payload) S.data.logs = [payload, ...(S.data.logs || [])].slice(0, 150)
  else if (type === 'verification') S.status.verification = Boolean(payload?.required)
  queueDynamic()
})

api.accounts.onChanged(async () => {
  S.accounts = await api.accounts.list()
  S.data = await api.automation.getState()
  render()
})

setInterval(async () => {
  const status = await api.douyin.getStatus().catch(() => null)
  if (status) { S.status = status; queueDynamic() }
}, 30000)

// 主题应用
function applyTheme() {
  const theme = S.data?.appearance?.theme || 'auto'
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

// ---- 视图片段 ----
function contactListItems() {
  const contacts = (S.data.contacts || []).filter((c) => !S.contactSearch || String(c.name || '').includes(S.contactSearch))
  if (!contacts.length) return '<div class="empty">暂无联系人<br/><span class="muted">打开登录窗口并进入私信页后，点击"同步联系人"</span></div>'
  return contacts.map((contact) => {
    const active = contact.name === S.selected ? ' active' : ''
    const disabled = (S.data.automation.aiDisabledContacts || []).includes(contact.name)
    const unread = contact.unread ? '<span class="ci-unread">未读</span>' : ''
    return `<button class="contact-item${active}" data-act="select-contact" data-args="${esc(JSON.stringify({ name: contact.name }))}">
      <span class="ci-top"><span class="ci-name">${esc(contact.name)}${disabled ? ' <span class="muted">(AI关)</span>' : ''}</span>${unread}</span>
      <span class="ci-preview">${esc(contact.preview || '')}</span>
    </button>`
  }).join('')
}

function chatActions() {
  const auto = S.data.automation
  return `
    <button class="btn ${auto.autoReply && !auto.paused ? 'primary' : ''}" data-act="toggle-auto">${auto.autoReply ? '自动回复：开' : '自动回复：关'}</button>
    <button class="btn ${auto.paused ? 'danger' : ''}" data-act="toggle-pause" ${auto.autoReply ? '' : 'disabled'}>${auto.paused ? '已暂停，点击恢复' : '暂停自动回复'}</button>
    <button class="btn" data-act="open-login">打开登录窗口</button>
    <button class="btn" data-act="sync-contacts">同步联系人</button>
    ${statusPills()}`
}

function contactDetail(contact) {
  const profile = contact?.profile || {}
  const learning = contact?.learning || {}
  const aiOff = (S.data.automation.aiDisabledContacts || []).includes(S.selected)
  const blacked = (S.data.automation.blacklist || []).includes(S.selected)
  if (!contact) return '<div class="empty">从左侧选择一个联系人</div>'
  return `
    <div class="panel">
      <h3>联系人 · ${esc(contact.name)}</h3>
      <div class="row" style="margin-bottom:10px">
        <button class="btn small ${aiOff ? '' : 'primary'}" data-act="toggle-contact-ai" data-args='${esc(JSON.stringify({ name: contact.name }))}'>${aiOff ? '允许 AI 回复' : '禁止 AI 回复'}</button>
        <button class="btn small ${blacked ? 'danger' : ''}" data-act="toggle-contact-black" data-args='${esc(JSON.stringify({ name: contact.name }))}'>${blacked ? '移出黑名单' : '加入黑名单'}</button>
        <button class="btn small" data-act="learn-contact" data-args='${esc(JSON.stringify({ name: contact.name }))}'>学习聊天记录</button>
        <button class="btn small danger" data-act="clear-learning" data-args='${esc(JSON.stringify({ name: contact.name }))}'>清除学习数据</button>
      </div>
      <div class="grid2">
        <div class="field"><label>关系</label><input data-cf="relationship" value="${esc(profile.relationship || '')}" placeholder="如：大学同学" /></div>
        <div class="field"><label>平时称呼</label><input data-cf="call" value="${esc(profile.call || '')}" placeholder="如：老王" /></div>
        <div class="field"><label>性格与喜好</label><input data-cf="personality" value="${esc(profile.personality || '')}" placeholder="帮 AI 了解对方" /></div>
        <div class="field"><label>语气风格</label><input data-cf="tone" value="${esc(profile.tone || '')}" placeholder="留空自动跟随语境" /></div>
        <div class="field"><label>不能碰的话题</label><input data-cf="boundary" value="${esc(profile.boundary || '')}" /></div>
        <div class="field"><label>回复间隔</label><select data-cf="frequency">
          ${[['instant', '立即'], ['30s', '30 秒'], ['60s', '1 分钟'], ['300s', '5 分钟'], ['3600s', '1 小时']].map(([v, t]) => `<option value="${v}" ${(profile.frequency || 'instant') === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field" style="grid-column:1/-1"><label>备注（回复时的额外注意事项）</label><input data-cf="notes" value="${esc(profile.notes || '')}" /></div>
        <div class="field" style="grid-column:1/-1"><label>本人说话样例（每行一条，优先级最高）</label><textarea data-cf="examples">${esc((profile.examples || []).join('\n'))}</textarea></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" data-act="save-profile">保存资料</button>
        <span class="muted" id="learn-summary">最近消息 ${learning.messages?.length || 0} 条 · 长期记忆 ${learning.facts?.length || 0} 条 · 话题记录 ${learning.topicLog?.length || 0} 条 · 视频上下文 ${learning.mediaLog?.length || 0} 条</span>
      </div>
    </div>
    <div class="panel">
      <h3>手动发送</h3>
      <div class="field"><textarea id="manual-text" placeholder="输入要发送的内容"></textarea></div>
      <div class="row" style="margin-top:8px">
        <button class="btn primary" data-act="manual-send">发送</button>
        <button class="btn" data-act="ai-draft">AI 拟回复</button>
        <span class="muted" id="manual-hint">${contact.preview ? `对方最近：${esc(String(contact.preview).slice(0, 40))}` : ''}</span>
      </div>
    </div>`
}

function chatView() {
  return `<div class="split">
    <div class="contact-list">
      <div style="padding:10px;border-bottom:1px solid var(--border)">
        <div class="field"><input id="contact-search" placeholder="搜索联系人" value="${esc(S.contactSearch)}" /></div>
      </div>
      <div class="list-scroll" id="contact-list-scroll">${contactListItems()}</div>
    </div>
    <div class="contact-detail">
      <div class="row" id="chat-actions" style="margin-bottom:12px">${chatActions()}</div>
      ${contactDetail((S.data.contacts || []).find((c) => c.name === S.selected))}
    </div>
  </div>`
}

function draftsList() {
  const drafts = S.data.pendingDrafts || []
  if (!drafts.length) return '<div class="empty">暂无待确认草稿<br/><span class="muted">在设置中开启"草稿模式"后，AI 回复会先到这里等你确认</span></div>'
  return drafts.map((d) => `
    <div class="card">
      <div class="card-head"><strong>${esc(d.name)}</strong><span class="muted">${fmtTime(d.at)}</span>
        ${d.model ? `<span class="pill">${esc(d.model)}</span>` : ''}<span class="spacer"></span>
        <button class="btn small primary" data-act="draft-send" data-args='${esc(JSON.stringify({ id: d.id }))}'>发送</button>
        <button class="btn small danger" data-act="draft-discard" data-args='${esc(JSON.stringify({ id: d.id }))}'>丢弃</button>
      </div>
      ${d.incoming ? `<div class="muted" style="margin-bottom:6px">对方：${esc(String(d.incoming).slice(0, 80))}</div>` : ''}
      <div class="field"><textarea data-draft-text="${d.id}">${esc(d.text)}</textarea></div>
    </div>`).join('')
}

function draftsView() {
  return `<div id="drafts-list">${draftsList()}</div>`
}

function sparksList() {
  const sparks = S.data.automation.sparks || []
  const kindLabel = { aiSpark: 'AI', text: '文字', emoji: '表情', combo: '组合' }
  if (!sparks.length) return '<div class="empty" style="padding:20px">还没有定时任务</div>'
  return sparks.map((task, index) => `
    <div class="card">
      <div class="card-head">
        <strong>${esc(task.name || '')}</strong>
        <span class="pill">${kindLabel[task.kind] || task.kind || '文字'} ${esc(task.time || '')}</span>
        ${task.lastRunDate ? `<span class="muted">上次执行 ${esc(task.lastRunDate)}</span>` : ''}
        <span class="spacer"></span>
        <button class="btn small" data-act="spark-toggle" data-args='${esc(JSON.stringify({ index }))}'>${task.enabled ? '停用' : '启用'}</button>
        <button class="btn small" data-act="spark-edit" data-args='${esc(JSON.stringify({ id: String(task.__id ?? task.name ?? index) }))}'>编辑</button>
        <button class="btn small" data-act="spark-send-now" data-args='${esc(JSON.stringify({ index }))}'>立即发送</button>
        <button class="btn small danger" data-act="spark-delete" data-args='${esc(JSON.stringify({ index }))}'>删除</button>
      </div>
      ${task.message ? `<div class="muted">${esc(String(task.message).slice(0, 80))}</div>` : ''}
    </div>`).join('')
}

function sparkEditForm() {
  if (S.sparkEditing === null) return ''
  const sparks = S.data.automation.sparks || []
  const task = S.sparkEditing === 'new' ? { kind: 'text', time: '09:00', enabled: true } : sparks.find((t) => String(t.__id ?? t.name ?? '') === String(S.sparkEditing)) || {}
  return `<div class="panel">
    <h3>${S.sparkEditing === 'new' ? '新建任务' : '编辑任务'}</h3>
    <div class="grid3">
      <div class="field"><label>联系人名称</label><input id="spark-name" value="${esc(task.name || '')}" /></div>
      <div class="field"><label>类型</label><select id="spark-kind">
        ${[['aiSpark', 'AI 智能问候'], ['text', '固定文字'], ['emoji', '表情'], ['combo', '文字+表情']].map(([v, t]) => `<option value="${v}" ${(task.kind || 'text') === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
      <div class="field"><label>每天发送时间</label><input id="spark-time" value="${esc(task.time || '09:00')}" placeholder="HH:MM" /></div>
      <div class="field" style="grid-column:1/-1"><label>文字内容（AI 类型可留空作为兜底文案）</label><input id="spark-message" value="${esc(task.message || '')}" /></div>
      <div class="field"><label>表情名称（emoji/combo 类型）</label><input id="spark-emoji" value="${esc(task.emojiName || '早上好')}" /></div>
      <div class="field"><label>AI 额外提示（可选）</label><input id="spark-note" value="${esc(task.aiNote || '')}" /></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" data-act="spark-save" data-args='${esc(JSON.stringify({ id: S.sparkEditing }))}'>保存任务</button>
      <button class="btn" data-act="spark-cancel">取消</button>
    </div>
  </div>`
}

function tasksView() {
  const pc = S.data.settings.proactiveChat || {}
  return `
    ${sparkEditForm()}
    <div class="panel">
      <div class="row"><h3 style="margin:0">定时问候任务（原"续火花"）</h3><span class="spacer"></span>
        <button class="btn small" data-act="spark-preview">AI 拟一条预览（不发送）</button>
        <button class="btn small primary" data-act="spark-new">新建任务</button></div>
      <div id="sparks-list">${sparksList()}</div>
    </div>
    <div class="panel">
      <h3>AI 伴聊（低频主动开场）</h3>
      <div class="grid3">
        <div class="field"><label>开关</label><select data-path="settings.proactiveChat.enabled">
          <option value="off" ${!pc.enabled ? 'selected' : ''}>关闭</option>
          <option value="on" ${pc.enabled ? 'selected' : ''}>开启</option>
        </select></div>
        <div class="field"><label>每天最多</label><input data-path="settings.proactiveChat.maxPerDay" value="${esc(pc.maxPerDay ?? 2)}" /></div>
        <div class="field"><label>最小间隔（分钟）</label><input data-path="settings.proactiveChat.minIntervalMinutes" value="${esc(pc.minIntervalMinutes ?? 180)}" /></div>
        <div class="field"><label>活跃时段开始</label><input data-path="settings.proactiveChat.windowStart" value="${esc(pc.windowStart || '10:00')}" /></div>
        <div class="field"><label>活跃时段结束</label><input data-path="settings.proactiveChat.windowEnd" value="${esc(pc.windowEnd || '22:00')}" /></div>
        <div class="field"><label>先拟草稿</label><select data-path="settings.proactiveChat.sendToDraft">
          <option value="off" ${!pc.sendToDraft ? 'selected' : ''}>直接发送</option>
          <option value="on" ${pc.sendToDraft ? 'selected' : ''}>先拟草稿</option>
        </select></div>
      </div>
      <div class="muted" style="margin-top:8px">伴聊会给较久未联系的朋友发一条自然的开场消息；每天有总量与间隔限制，不会刷屏。</div>
    </div>`
}

function providersList() {
  const providers = S.data.providers || []
  if (!providers.length) return '<div class="empty" style="padding:20px">还没有配置模型。AI 回复需要至少一个 OpenAI 兼容接口。</div>'
  return providers.map((p, index) => `
    <div class="card">
      <div class="card-head">
        <strong>${esc(p.name)}</strong>
        <span class="pill">${esc(p.model)}</span>
        ${(p.capabilities || []).includes('vision') ? '<span class="pill ok">视觉</span>' : ''}
        <span class="spacer"></span>
        <button class="btn small" data-act="provider-test" data-args='${esc(JSON.stringify({ index }))}'>测试</button>
        <button class="btn small" data-act="provider-edit" data-args='${esc(JSON.stringify({ index }))}'>编辑</button>
        <button class="btn small" data-act="provider-primary" data-args='${esc(JSON.stringify({ name: p.name }))}'>设为主模型</button>
        <button class="btn small danger" data-act="provider-delete" data-args='${esc(JSON.stringify({ name: p.name }))}'>删除</button>
      </div>
      <div class="muted">${esc(p.baseUrl || '')}</div>
    </div>`).join('')
}

function providerForm() {
  if (S.providerEditing === null) return ''
  const p = S.providerEditing >= 0 ? (S.data.providers || [])[S.providerEditing] || {} : {}
  return `<div class="panel">
    <h3>${S.providerEditing >= 0 ? `编辑：${esc(p.name || '')}` : '添加模型接口'}</h3>
    <div class="grid2">
      <div class="field"><label>名称</label><input id="pv-name" value="${esc(p.name || '')}" placeholder="如：主力模型" /></div>
      <div class="field"><label>接口地址</label><input id="pv-base" value="${esc(p.baseUrl || '')}" placeholder="如：https://api.deepseek.com/v1" />
        <div class="muted" id="pv-base-preview"></div></div>
      <div class="field"><label>API Key（留空保持不变）</label><input id="pv-key" type="password" value="" placeholder="sk-..." /></div>
      <div class="field"><label>模型 ID</label>
        <div class="row" style="gap:6px">
          <input id="pv-model" list="pv-model-list" value="${esc(p.model || '')}" placeholder="填好地址和 Key 后点右侧获取，或手动填写" style="flex:1" />
          <button class="btn small" data-act="provider-fetch-models">获取模型列表</button>
        </div>
        <datalist id="pv-model-list">${(S.modelOptions || []).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
        <div class="muted" id="pv-model-status">${esc(S.modelFetchMsg || '')}</div>
      </div>
      <div class="field"><label>能力</label><label class="check"><input type="checkbox" id="pv-vision" ${((p.capabilities || []).includes('vision')) ? 'checked' : ''}/> 支持图片/视频识别</label></div>
      <div class="field"><label>音频转写模型（可选）</label><input id="pv-trans" value="${esc(p.transcriptionModel || '')}" placeholder="whisper-1" /></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" data-act="provider-save" data-args='${esc(JSON.stringify({ index: S.providerEditing }))}'>保存</button>
      <button class="btn" data-act="provider-cancel">取消</button>
    </div>
  </div>`
}

// 接口地址实时预览：调用主进程同一套归一化逻辑，显示最终会请求的地址
async function refreshBasePreview() {
  const input = document.getElementById('pv-base')
  const box = document.getElementById('pv-base-preview')
  if (!input || !box) return
  const value = input.value.trim()
  if (!value) { box.textContent = ''; box.className = 'muted'; return }
  try {
    const result = await api.ai.normalizeBaseUrl(value)
    if (result?.ok) {
      box.textContent = `实际请求地址：${result.baseUrl}/chat/completions`
      box.className = 'muted ok'
    } else {
      box.textContent = result?.message || '接口地址格式不正确'
      box.className = 'muted err'
    }
  } catch {
    box.textContent = ''
    box.className = 'muted'
  }
}

function queueBasePreview() {
  clearTimeout(S.basePreviewTimer)
  S.basePreviewTimer = setTimeout(() => { refreshBasePreview() }, 250)
}

// 把拉取到的模型 ID 填进 datalist（直接改 DOM，不重渲染，避免丢失已填内容）
function applyModelOptions(list) {
  const dl = document.getElementById('pv-model-list')
  if (dl) dl.innerHTML = (list || []).map((m) => `<option value="${esc(m)}"></option>`).join('')
}

function setModelStatus(text, kind = '') {
  const box = document.getElementById('pv-model-status')
  if (!box) return
  box.textContent = text || ''
  box.className = kind ? `muted ${kind}` : 'muted'
}

function modelsView() {
  return `
    ${providerForm()}
    <div class="panel">
      <div class="row"><h3 style="margin:0">模型列表（多账号共享，按顺序故障转移）</h3><span class="spacer"></span>
        <label class="check"><input type="checkbox" data-path="settings.failoverEnabled" ${S.data.settings.failoverEnabled !== false ? 'checked' : ''}/> 启用备用模型切换</label>
        <button class="btn small primary" data-act="provider-new">添加模型</button></div>
      <div id="providers-list">${providersList()}</div>
    </div>`
}

function logsList() {
  const logs = S.data.logs || []
  const f = S.logFilter
  const filtered = logs.filter((entry) => {
    if (f.type && entry.type !== f.type) return false
    if (f.keyword) {
      const hay = `${entry.message || ''} ${JSON.stringify(entry.detail || {})}`.toLowerCase()
      if (!hay.includes(f.keyword.toLowerCase())) return false
    }
    return true
  })
  if (!filtered.length) return '<div class="empty">没有匹配的记录</div>'
  return filtered.map((entry) => `
    <div class="log-item">
      <div class="log-head">
        <span class="log-type">${LOG_LABELS[entry.type] || entry.type}</span>
        <span class="log-time">${fmtTime(entry.at)}</span>
      </div>
      <div>${esc(entry.message || '')}</div>
      ${entry.detail && Object.keys(entry.detail).length ? `<div class="log-detail">${esc(JSON.stringify(entry.detail).slice(0, 300))}</div>` : ''}
    </div>`).join('')
}

// ---- 训练场 ----
function trainBubble(m) {
  if (m.role === 'contact') return `<div class="muted" style="margin:8px 0">对方：${esc(m.text)}</div>`
  if (m.role === 'ai') return `<div style="margin:8px 0;color:var(--text-dim)">AI 拟：${esc(m.text)}</div>`
  if (m.role === 'me') return `<div style="margin:8px 0"><strong>你${m.learned ? '（已学习 ✓）' : ''}：</strong>${esc(m.text)}</div>`
  return ''
}

function trainView() {
  const contacts = S.data.contacts || []
  const name = S.train.name
  const contact = contacts.find((c) => c.name === name)
  const examples = contact?.profile?.examples || []
  const learning = contact?.learning || {}
  const styleSummary = learning.ownerStyle?.summary || '样本不足（多示范几条就会开始积累）'
  return `
    <div class="panel">
      <h3>训练对象</h3>
      <div class="row">
        <div class="field" style="width:280px"><label>选择联系人（真实或虚拟均可）</label>
          <select id="train-contact">
            <option value="">选择…</option>
            ${contacts.map((c) => `<option value="${esc(c.name)}" ${name === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            ${name && !contacts.some((c) => c.name === name) ? `<option value="${esc(name)}" selected>${esc(name)}（虚拟）</option>` : ''}
          </select>
        </div>
        <button class="btn" data-act="train-new-contact">新建训练对象</button>
        ${name ? `<span class="muted">已学样例 <strong>${examples.length}</strong> 条 · 历史消息 ${learning.messages?.length || 0} 条 · 当前风格：${esc(styleSummary)}</span>` : ''}
      </div>
    </div>
    ${name ? `
    <div class="panel">
      <h3>对话练习（纯本地学习，不发送给任何人）</h3>
      <div id="train-transcript" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:10px;background:var(--panel-2)">
        ${S.train.log.length ? S.train.log.map(trainBubble).join('') : '<div class="muted">流程：输入一句"对方发的消息" → 让 AI 拟回复 → 你改成自己的语气确认。反复练习，自动回复就会模仿你的说法。</div>'}
      </div>
      <div class="row" style="margin-top:10px">
        <input id="train-incoming" style="flex:1;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:7px 9px" placeholder="对方发的消息，如：在干嘛呢" />
        <button class="btn" data-act="train-incoming">对方说 →</button>
      </div>
      ${S.train.draft !== null ? `
        <div class="field" style="margin-top:10px"><label>AI 拟回复（可直接采用；或改成你的语气点"学习"——改动会被记为你的示范）</label>
        <textarea id="train-draft">${esc(S.train.draft)}</textarea></div>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" data-act="train-learn">✓ 就这样说，学习它</button>
          <button class="btn" data-act="train-accept">直接采用（不学习语气）</button>
          <button class="btn" data-act="train-redraft">重新拟一条</button>
        </div>` : `
        <div class="row" style="margin-top:10px">
          <button class="btn primary" data-act="train-draft">让 AI 拟回复</button>
        </div>`}
    </div>
    <div class="muted">学习去向：① 你的示范进入该联系人的"本人说话样例"（自动回复时的最高优先级模仿对象）；② 句长/标点/语气词等风格统计照常累积；③ 对话历史照常累积供上下文。AI 自己的原文不会被当成你的语气（防止 AI 学自己）。</div>` : ''}
  `
}

function logsView() {
  const logs = S.data.logs || []
  const types = [...new Set(logs.map((l) => l.type))].sort()
  return `
    <div class="panel">
      <div class="row">
        <div class="field" style="width:220px"><label>类型</label><select id="log-type">
          <option value="">全部</option>
          ${types.map((t) => `<option value="${esc(t)}" ${S.logFilter.type === t ? 'selected' : ''}>${LOG_LABELS[t] || t}</option>`).join('')}
        </select></div>
        <div class="field" style="flex:1"><label>关键词</label><input id="log-keyword" value="${esc(S.logFilter.keyword)}" placeholder="搜索消息内容 / 联系人" /></div>
      </div>
    </div>
    <div class="panel"><div id="logs-list">${logsList()}</div></div>`
}

function settingsView() {
  const st = S.data.settings
  const accounts = S.accounts.accounts || []
  return `
    <div class="panel">
      <h3>通用</h3>
      <div class="grid3">
        <div class="field"><label>主题</label><select data-path="appearance.theme">
          ${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, t]) => `<option value="${v}" ${(S.data.appearance.theme || 'auto') === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field"><label>默认语气</label><input data-path="appearance.defaultTone" value="${esc(S.data.appearance.defaultTone || '')}" placeholder="留空自动跟随语境" /></div>
        <div class="field"><label>开机自启</label><select data-path="settings.launchOnStartup">
          <option value="off" ${!st.launchOnStartup ? 'selected' : ''}>关闭</option><option value="on" ${st.launchOnStartup ? 'selected' : ''}>开启</option>
        </select></div>
        <div class="field"><label>静默启动</label><select data-path="settings.startMinimized">
          <option value="off" ${!st.startMinimized ? 'selected' : ''}>关闭（正常弹出主窗口）</option><option value="on" ${st.startMinimized ? 'selected' : ''}>开启（静默最小化到托盘）</option>
        </select></div>
        <div class="field"><label>关闭窗口时</label><select data-path="settings.minimizeToTray">
          <option value="on" ${st.minimizeToTray !== false ? 'selected' : ''}>最小化到托盘</option><option value="off" ${st.minimizeToTray === false ? 'selected' : ''}>退出程序</option>
        </select></div>
      </div>
    </div>
    <div class="panel">
      <h3>回复行为</h3>
      <div class="grid3">
        <div class="field"><label>每日总上限</label><input data-path="automation.dailyLimit" value="${esc(S.data.automation.dailyLimit ?? 30)}" /></div>
        <div class="field"><label>单联系人每日上限</label><input data-path="automation.maxPerContactDaily" value="${esc(S.data.automation.maxPerContactDaily ?? 12)}" /></div>
        <div class="field"><label>第二条消息（连发）</label><select data-path="settings.twoMessageChance">
          <option value="0" ${Number(st.twoMessageChance) === 0 ? 'selected' : ''}>关闭</option>
          <option value="0.35" ${Math.abs(Number(st.twoMessageChance ?? 0.35) - 0.35) < 0.01 ? 'selected' : ''}>偶尔（35%）</option>
          <option value="0.6" ${Math.abs(Number(st.twoMessageChance) - 0.6) < 0.01 ? 'selected' : ''}>经常（60%）</option>
        </select></div>
        <div class="field"><label>轮询间隔（秒，空闲自动降频）</label><input data-path="settings.refreshInterval" value="${esc(st.refreshInterval || '5')}" /></div>
        <div class="field"><label>AI 回复先拟草稿</label><select data-path="settings.aiReplyDraftOnly">
          <option value="off" ${!st.aiReplyDraftOnly ? 'selected' : ''}>关闭（自动发送）</option><option value="on" ${st.aiReplyDraftOnly ? 'selected' : ''}>开启（去草稿页确认）</option>
        </select></div>
        <div class="field"><label>消息标注 AI 模型</label><select data-path="settings.showAiModelLabel">
          <option value="on" ${st.showAiModelLabel !== false ? 'selected' : ''}>显示【AI·模型】前缀</option><option value="off" ${st.showAiModelLabel === false ? 'selected' : ''}>不显示</option>
        </select></div>
        <div class="field"><label>免打扰时段</label><select data-path="settings.quietHours">
          <option value="off" ${!st.quietHours ? 'selected' : ''}>关闭</option><option value="on" ${st.quietHours ? 'selected' : ''}>开启</option>
        </select></div>
        <div class="field"><label>免打扰开始</label><input data-path="settings.quietStart" value="${esc(st.quietStart || '23:00')}" /></div>
        <div class="field"><label>免打扰结束</label><input data-path="settings.quietEnd" value="${esc(st.quietEnd || '07:00')}" /></div>
      </div>
    </div>
    <div class="panel">
      <h3>媒体识别（对方发视频/图片时）</h3>
      <div class="grid3">
        <div class="field"><label>视频回复</label><select data-path="settings.videoReplyEnabled">
          <option value="on" ${st.videoReplyEnabled !== false ? 'selected' : ''}>开启</option><option value="off" ${st.videoReplyEnabled === false ? 'selected' : ''}>关闭</option>
        </select></div>
        <div class="field"><label>天气城市（续火花今日播报，留空自动定位）</label>
          <div class="row" style="gap:6px">
            <input data-path="settings.weatherCity" id="setting-weather-city" value="${esc(st.weatherCity || '')}" placeholder="如：银川" style="flex:1" />
            <button class="btn small" data-act="test-weather">测试天气</button>
          </div>
          ${S.weatherPreview ? `<div class="muted" style="margin-top:4px;font-size:12px;color:var(--text-dim)">${esc(S.weatherPreview)}</div>` : ''}
        </div>
        <div class="field"><label>识别模式</label><select data-path="settings.videoRecognitionMode">
          <option value="smart" ${st.videoRecognitionMode !== 'comments' && st.videoRecognitionMode !== 'lite' ? 'selected' : ''}>智能（先理解再回复）</option>
          <option value="comments" ${st.videoRecognitionMode === 'comments' ? 'selected' : ''}>轻量（仅文案与评论）</option>
          <option value="lite" ${st.videoRecognitionMode === 'lite' ? 'selected' : ''}>极简（仅文字）</option>
        </select></div>
      </div>
      <div class="muted" style="margin-top:8px">智能模式会截取关键帧 + 转写音频 + 读取公开页文案，理解结果会作为后续对话的上下文背景保留（视频上下文）。</div>
    </div>
    <div class="panel">
      <h3>学习与记忆</h3>
      <div class="grid3">
        <div class="field"><label>长期记忆</label><select data-path="settings.longTermMemory">
          <option value="on" ${st.longTermMemory !== false ? 'selected' : ''}>开启（自动提炼对方信息）</option><option value="off" ${st.longTermMemory === false ? 'selected' : ''}>关闭</option>
        </select></div>
        <div class="field"><label>自动学习新联系人</label><select data-path="settings.autoLearnContacts">
          <option value="on" ${st.autoLearnContacts !== false ? 'selected' : ''}>开启</option><option value="off" ${st.autoLearnContacts === false ? 'selected' : ''}>关闭</option>
        </select></div>
        <div class="field"><label>运行记录保留（天）</label><input data-path="settings.logRetention" value="${esc(st.logRetention || '30')}" /></div>
        <div class="field"><label>写入运行记录</label><select data-path="settings.saveLogs">
          <option value="on" ${st.saveLogs !== false ? 'selected' : ''}>开启</option><option value="off" ${st.saveLogs === false ? 'selected' : ''}>关闭</option>
        </select></div>
      </div>
    </div>
    <div class="panel">
      <h3>通知</h3>
      <div class="grid3">
        <div class="field"><label>桌面通知</label><select data-path="settings.desktopNotifications">
          <option value="on" ${st.desktopNotifications !== false ? 'selected' : ''}>开启</option><option value="off" ${st.desktopNotifications === false ? 'selected' : ''}>关闭</option>
        </select></div>
        <div class="field"><label>提示音</label><select data-path="settings.soundNotifications">
          <option value="off" ${!st.soundNotifications ? 'selected' : ''}>关闭</option><option value="on" ${st.soundNotifications ? 'selected' : ''}>开启</option>
        </select></div>
        <div class="field"><label>失败时通知</label><select data-path="settings.notifyOnFailure">
          <option value="on" ${st.notifyOnFailure !== false ? 'selected' : ''}>开启</option><option value="off" ${st.notifyOnFailure === false ? 'selected' : ''}>关闭</option>
        </select></div>
      </div>
    </div>
    <div class="panel">
      <h3>账号管理</h3>
      <div class="row" style="margin-bottom:10px">
        <button class="btn" data-act="account-add">添加账号</button>
      </div>
      ${accounts.map((a) => `
        <div class="card">
          <div class="card-head">
            <strong>${esc(a.name)}</strong>
            <span class="pill">${a.contacts || 0} 位联系人</span>
            ${S.accounts.active === a.id ? '<span class="pill ok">当前</span>' : ''}
            <span class="spacer"></span>
            ${S.accounts.active !== a.id ? `<button class="btn small" data-act="account-switch" data-args='${esc(JSON.stringify({ id: a.id }))}'>切换</button>` : ''}
            <button class="btn small" data-act="account-rename" data-args='${esc(JSON.stringify({ id: a.id, name: a.name }))}'>重命名</button>
            <button class="btn small" data-act="account-logout" data-args='${esc(JSON.stringify({ id: a.id }))}'>退出登录</button>
            <button class="btn small danger" data-act="account-wipe" data-args='${esc(JSON.stringify({ id: a.id }))}'>删除账号</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="panel">
      <h3>关于</h3>
      <div class="muted">
        抖音回复助手 v${esc(S.info?.version || '')} · Electron ${esc(S.info?.version || '')}<br/>
        AI 回复由你自配的 OpenAI 兼容接口提供；所有数据保存在本机。<br/>
        <button class="btn small" data-act="check-update" style="margin-top:8px">检查更新</button>
      </div>
    </div>`
}

// ---- 状态保存 ----
async function saveState(patch, silent = false) {
  try {
    const result = await api.automation.update(patch)
    S.data = result.state
    if (!silent) showNotice('已保存')
    applyTheme()
    queueDynamic()
  } catch (error) {
    showNotice(`保存失败：${error.message}`, 'err')
  }
}

// ---- 动作分发（单一委托点，杜绝按钮失联）----
const ACTIONS = {
  nav({ section }) { S.section = section; render() },
  'select-contact'({ name }) { S.selected = name; render() },
  async 'toggle-auto'() {
    await saveState({ automation: { ...S.data.automation, autoReply: !S.data.automation.autoReply } })
  },
  async 'toggle-pause'() {
    await saveState({ automation: { ...S.data.automation, paused: !S.data.automation.paused } })
  },
  async 'open-login'() {
    await api.douyin.openLogin()
    showNotice('登录窗口已打开（如被遮挡请在任务栏查找）')
  },
  async 'sync-contacts'(args, btn) {
    await run(btn, async () => {
      await api.douyin.syncContacts()
      showNotice('联系人已同步')
    })
  },
  async 'toggle-contact-ai'({ name }) {
    const list = new Set(S.data.automation.aiDisabledContacts || [])
    list.has(name) ? list.delete(name) : list.add(name)
    await saveState({ automation: { ...S.data.automation, aiDisabledContacts: [...list] } })
  },
  async 'toggle-contact-black'({ name }) {
    const list = new Set(S.data.automation.blacklist || [])
    list.has(name) ? list.delete(name) : list.add(name)
    await saveState({ automation: { ...S.data.automation, blacklist: [...list] } })
  },
  async 'learn-contact'({ name }, btn) {
    await run(btn, async () => {
      await api.douyin.learnContact(name)
      showNotice(`已学习 ${name} 的聊天记录`)
    })
  },
  async 'clear-learning'({ name }) {
    if (!confirm(`确定清除 ${name} 的全部学习数据？`)) return
    await api.ai.clearLearning(name)
    S.data = await api.automation.getState()
    showNotice('学习数据已清除')
    render()
  },
  async 'save-profile'(args, btn) {
    await run(btn, async () => {
      const contact = (S.data.contacts || []).find((c) => c.name === S.selected)
      if (!contact) return
      const profile = { ...(contact.profile || {}) }
      document.querySelectorAll('[data-cf]').forEach((el) => {
        const key = el.dataset.cf
        profile[key] = key === 'examples' ? el.value.split('\n').map((v) => v.trim()).filter(Boolean) : el.value.trim()
      })
      const contacts = (S.data.contacts || []).map((c) => (c.name === S.selected ? { ...c, profile } : c))
      await saveState({ contacts }, true)
      showNotice('资料已保存')
    })
  },
  async 'manual-send'(args, btn) {
    await run(btn, async () => {
      const text = document.getElementById('manual-text')?.value.trim()
      if (!text) throw new Error('内容为空')
      await api.douyin.sendMessage(S.selected, text)
      document.getElementById('manual-text').value = ''
      showNotice('已发送')
    })
  },
  async 'ai-draft'(args, btn) {
    await run(btn, async () => {
      const contact = (S.data.contacts || []).find((c) => c.name === S.selected)
      const result = await api.ai.draft({ contact, incoming: contact?.preview || '' })
      if (result?.skipped) { showNotice(result.rejected ? 'AI 拒绝生成该回复' : 'AI 判断当前不适合回复', 'err'); return }
      if (!result?.text) throw new Error(result?.error || 'AI 没有返回内容')
      const box = document.getElementById('manual-text')
      box.value = result.text
      showNotice(`已生成草稿（${result.model}），请确认后发送`)
    })
  },
  async 'draft-send'({ id }, btn) {
    await run(btn, async () => {
      const draft = (S.data.pendingDrafts || []).find((d) => d.id === id)
      if (!draft) return
      const text = document.querySelector(`[data-draft-text="${id}"]`)?.value.trim() || draft.text
      await api.douyin.sendMessage(draft.name, text)
      await saveState({ pendingDrafts: (S.data.pendingDrafts || []).filter((d) => d.id !== id) }, true)
      showNotice('草稿已发送')
    })
  },
  async 'draft-discard'({ id }) {
    if (!confirm('丢弃这条草稿？')) return
    await saveState({ pendingDrafts: (S.data.pendingDrafts || []).filter((d) => d.id !== id) }, true)
  },
  'spark-new'() { S.sparkEditing = 'new'; render() },
  async 'spark-preview'(args, btn) {
    await run(btn, async () => {
      const sparks = S.data.automation.sparks || []
      const name = await askText('为谁预览 AI 问候？（不会发送）', sparks[0]?.name || S.selected || '')
      if (!name) return
      const history = (S.data.contacts || []).find((c) => c.name === name)?.learning?.messages || []
      const r = await api.ai.draftSpark({ name, history })
      if (!r?.ok) throw new Error(r?.error || '生成失败')
      showNotice(`今日播报预览：${r.text}`)
    })
  },
  'spark-cancel'() { S.sparkEditing = null; render() },
  'spark-edit'({ id }) { S.sparkEditing = id; render() },
  async 'spark-save'({ id }, btn) {
    await run(btn, async () => {
      const name = document.getElementById('spark-name').value.trim()
      if (!name) throw new Error('联系人名称不能为空')
      const task = {
        kind: document.getElementById('spark-kind').value,
        name,
        time: document.getElementById('spark-time').value.trim() || '09:00',
        message: document.getElementById('spark-message').value.trim(),
        emojiName: document.getElementById('spark-emoji').value.trim() || '早上好',
        aiNote: document.getElementById('spark-note').value.trim(),
        enabled: true,
      }
      const sparks = [...(S.data.automation.sparks || [])]
      if (id === 'new') sparks.push(task)
      else {
        const index = sparks.findIndex((t, i) => String(t.__id ?? t.name ?? i) === String(id))
        if (index >= 0) sparks[index] = { ...sparks[index], ...task }
        else sparks.push(task)
      }
      S.sparkEditing = null
      await saveState({ automation: { ...S.data.automation, sparks } })
      render()
    })
  },
  async 'spark-toggle'({ index }) {
    const sparks = [...(S.data.automation.sparks || [])]
    sparks[index] = { ...sparks[index], enabled: !sparks[index].enabled }
    await saveState({ automation: { ...S.data.automation, sparks } }, true)
  },
  async 'spark-delete'({ index }) {
    if (!confirm('删除这个任务？')) return
    const sparks = (S.data.automation.sparks || []).filter((_, i) => i !== index)
    await saveState({ automation: { ...S.data.automation, sparks } }, true)
  },
  async 'spark-send-now'({ index }, btn) {
    await run(btn, async () => {
      const task = (S.data.automation.sparks || [])[index]
      if (!task) return
      await api.douyin.sendTask(task.name, task)
      showNotice(`已向 ${task.name} 发送`)
    })
  },
  'provider-new'() { S.providerEditing = -1; S.modelOptions = []; S.modelFetchMsg = ''; render() },
  'provider-cancel'() { S.providerEditing = null; S.modelOptions = []; S.modelFetchMsg = ''; render() },
  'provider-edit'({ index }) { S.providerEditing = index; S.modelOptions = []; S.modelFetchMsg = ''; render() },
  async 'provider-fetch-models'(_, btn) {
    const baseInput = document.getElementById('pv-base')
    if (!baseInput) return
    const baseUrl = baseInput.value.trim()
    const apiKey = document.getElementById('pv-key')?.value || ''
    const index = S.providerEditing
    if (!baseUrl) { setModelStatus('请先填写接口地址', 'err'); return }
    if (btn) { btn.disabled = true; btn.textContent = '获取中…' }
    setModelStatus('正在获取模型列表…')
    try {
      const result = await api.ai.fetchModels({ baseUrl, apiKey, index: index >= 0 ? index : undefined })
      if (result?.ok) {
        S.modelOptions = result.models || []
        applyModelOptions(S.modelOptions)
        S.modelFetchMsg = result.message || `已获取 ${S.modelOptions.length} 个模型`
        setModelStatus(`${S.modelFetchMsg}，可下拉选择或手动输入`, 'ok')
      } else {
        S.modelFetchMsg = result?.message || '获取模型列表失败'
        setModelStatus(S.modelFetchMsg, 'err')
      }
    } catch (error) {
      setModelStatus(error?.message || '获取模型列表失败', 'err')
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '获取模型列表' }
    }
  },
  async 'provider-save'({ index }, btn) {
    await run(btn, async () => {
      const name = document.getElementById('pv-name').value.trim()
      const model = document.getElementById('pv-model').value.trim()
      const baseUrl = document.getElementById('pv-base').value.trim()
      const apiKey = document.getElementById('pv-key').value
      if (!name || !model || !baseUrl) throw new Error('名称、模型和接口地址不能为空')
      const capabilities = document.getElementById('pv-vision').checked ? ['vision'] : []
      const transcriptionModel = document.getElementById('pv-trans').value.trim()
      const result = await api.ai.saveProvider({ index: index >= 0 ? index : undefined, name, model, baseUrl, apiKey, capabilities, transcriptionModel })
      S.data.providers = result.providers
      S.providerEditing = null
      showNotice('模型已保存')
      render()
    })
  },
  async 'provider-test'({ index }, btn) {
    await run(btn, async () => {
      const result = await api.ai.testProvider(index)
      showNotice(result?.ok ? '连接成功' : `测试失败：${result?.message || '未知错误'}`, result?.ok ? 'ok' : 'err')
    })
  },
  async 'provider-primary'({ name }) {
    const result = await api.ai.setPrimaryProvider(name)
    S.data.providers = result.providers
    showNotice(`${name} 已设为主模型`)
    render()
  },
  async 'provider-delete'({ name }) {
    if (!confirm(`删除模型 ${name}？`)) return
    const result = await api.ai.deleteProvider(name)
    S.data.providers = result.providers
    render()
  },
  async 'account-add'() {
    if (!confirm('添加一个新账号？添加后请在登录窗口扫码登录。')) return
    const result = await api.accounts.add()
    S.accounts = { active: result.active, accounts: result.accounts }
    S.data = await api.automation.getState()
    render()
  },
  async 'account-switch'({ id }) {
    const result = await api.accounts.switch(id)
    S.accounts = await api.accounts.list()
    S.data = result.state
    S.selected = ''
    render()
  },
  async 'account-rename'({ id, name }) {
    const next = await askText('新的账号名称', name)
    if (!next || next === name) return
    const result = await api.accounts.rename(id, next)
    S.accounts = { active: S.accounts.active, accounts: result.accounts }
    render()
  },
  async 'account-logout'({ id }) {
    if (!confirm('退出该账号的抖音登录态？')) return
    await api.accounts.logout(id)
    S.status = await api.douyin.getStatus().catch(() => ({ connected: false }))
    showNotice('已退出登录')
    refreshDynamic()
  },
  async 'account-wipe'({ id }) {
    if (!confirm('删除该账号的全部数据（登录态、联系人、学习数据）？此操作不可恢复！')) return
    const result = await api.accounts.wipe(id)
    S.accounts = { active: result.active, accounts: result.accounts }
    S.data = await api.automation.getState()
    render()
  },
  // ---- 训练场 ----
  async 'train-new-contact'(args, btn) {
    await run(btn, async () => {
      const name = await askText('训练对象名称（虚拟联系人，不会真的发消息）', '训练·朋友')
      if (!name) return
      S.train.name = name
      S.train.log = []
      S.train.draft = null
      await api.trainLearn({ name, relationship: '训练对象' }).catch(() => null)
      S.data = await api.automation.getState()
      render()
    })
  },
  async 'train-incoming'(args, btn) {
    await run(btn, async () => {
      const text = document.getElementById('train-incoming')?.value.trim()
      if (!text) throw new Error('先输入对方要说的消息')
      S.train.log.push({ role: 'contact', text })
      S.train.lastIncoming = text
      S.train.draft = null
      const r = await api.trainLearn({ name: S.train.name, incoming: text })
      if (r?.historyCount !== undefined) {
        const contact = (S.data.contacts || []).find((c) => c.name === S.train.name)
        if (contact) contact.learning = contact.learning || {}
      }
      render()
      document.getElementById('train-incoming')?.focus()
    })
  },
  async 'train-draft'(args, btn) {
    await run(btn, async () => {
      const incoming = S.train.lastIncoming
      if (!incoming) throw new Error('先输入对方发的消息')
      const contact = (S.data.contacts || []).find((c) => c.name === S.train.name) || { id: S.train.name, name: S.train.name, profile: { relationship: '训练对象' }, learning: { messages: [], facts: [], topicLog: [], mediaLog: [] } }
      const result = await api.ai.draft({ contact, incoming })
      if (result?.skipped) { showNotice(result.rejected ? 'AI 拒绝生成' : 'AI 没有生成内容', 'err'); return }
      if (!result?.text) throw new Error(result?.error || 'AI 没有返回内容')
      S.train.draft = result.text
      S.train.log.push({ role: 'ai', text: result.text })
      render()
    })
  },
  async 'train-learn'(args, btn) {
    await run(btn, async () => {
      const edited = document.getElementById('train-draft')?.value.trim()
      if (!edited) throw new Error('内容为空')
      const r = await api.trainLearn({ name: S.train.name, incoming: S.train.lastIncoming, userText: edited })
      S.train.log.push({ role: 'me', text: edited, learned: true })
      S.train.draft = null
      S.data = await api.automation.getState()
      render()
      showNotice(`已学习 ✓（样例 ${r?.examplesCount ?? '?'} 条 · 风格：${r?.styleSummary || '积累中'}）`)
    })
  },
  async 'train-accept'(args, btn) {
    await run(btn, async () => {
      const draft = document.getElementById('train-draft')?.value.trim()
      if (!draft) throw new Error('内容为空')
      await api.trainLearn({ name: S.train.name, acceptAiText: draft })
      S.train.log.push({ role: 'me', text: draft, learned: false })
      S.train.draft = null
      render()
      showNotice('已采用（语气未学习——AI 原文不进风格统计）')
    })
  },
  async 'train-redraft'(args, btn) {
    await run(btn, async () => {
      const incoming = S.train.lastIncoming
      if (!incoming) throw new Error('先输入对方发的消息')
      const contact = (S.data.contacts || []).find((c) => c.name === S.train.name) || { id: S.train.name, name: S.train.name, profile: { relationship: '训练对象' }, learning: { messages: [], facts: [], topicLog: [], mediaLog: [] } }
      const result = await api.ai.draft({ contact, incoming })
      if (!result?.text) throw new Error(result?.error || 'AI 没有返回内容')
      S.train.draft = result.text
      S.train.log.push({ role: 'ai', text: result.text })
      render()
    })
  },

  async 'test-weather'(args, btn) {
    await run(btn, async () => {
      const input = document.getElementById('setting-weather-city')
      const city = (input ? input.value : (S.data?.settings?.weatherCity || '')).trim()
      showNotice(city ? `正在查询「${city}」天气...` : '正在查询当前定位天气...')
      const res = await api.ai.getWeather(city)
      if ((res?.success || res?.ok) && res.text) {
        S.weatherPreview = `实时天气：${res.text}`
        showNotice(`获取成功：${res.text}`)
      } else {
        S.weatherPreview = `获取失败：${res?.error || '无法解析天气'}`
        showNotice(S.weatherPreview, 'err')
      }
      render()
    })
  },

  async 'check-update'(args, btn) {
    await run(btn, async () => {
      const result = await api.checkUpdate()
      showNotice(result?.hasUpdate ? `发现新版本 ${result.latestVersion}，请到 GitHub 下载` : '当前已是最新版本')
    })
  },
}

// 轻量文本输入弹层（Electron 不支持 window.prompt）
function askText(title, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:99'
    overlay.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;width:360px">
      <div style="margin-bottom:8px;font-weight:600">${esc(title)}</div>
      <input id="asktext-input" style="width:100%;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:7px 9px" value="${esc(defaultValue)}" />
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button class="btn" id="asktext-cancel">取消</button>
        <button class="btn primary" id="asktext-ok">确定</button>
      </div>
    </div>`
    document.body.appendChild(overlay)
    const input = overlay.querySelector('#asktext-input')
    input.focus(); input.select()
    const close = (value) => { overlay.remove(); resolve(value) }
    overlay.querySelector('#asktext-ok').onclick = () => close(input.value.trim())
    overlay.querySelector('#asktext-cancel').onclick = () => close(null)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value.trim()); if (e.key === 'Escape') close(null) })
  })
}

// 异步动作包装：执行期间禁用按钮
async function run(btn, fn) {
  if (btn) btn.disabled = true
  try {
    await fn()
  } catch (error) {
    showNotice(error.message || String(error), 'err')
  } finally {
    if (btn) btn.disabled = false
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]')
  if (!target || target.disabled) return
  const action = ACTIONS[target.dataset.act]
  if (!action) return
  let args = {}
  try { args = target.dataset.args ? JSON.parse(target.dataset.args) : {} } catch { args = {} }
  Promise.resolve(action(args, target)).catch((error) => showNotice(error.message || String(error), 'err'))
})

// 设置项自动保存（data-path）
document.addEventListener('change', async (event) => {
  const el = event.target
  // 账号切换
  if (el.matches('[data-act-change="switch-account"]')) {
    ACTIONS['account-switch']({ id: el.value })
    return
  }
  if (el.matches('#train-contact')) {
    S.train.name = el.value
    S.train.log = []
    S.train.draft = null
    render()
    return
  }
  if (el.matches('#log-type')) { S.logFilter.type = el.value; patchContainer('logs-list', logsList()); return }
  if (!el.matches('[data-path]')) return
  const path = el.dataset.path
  let value = el.value
  if (el.type === 'checkbox') value = el.checked
  else if (el.tagName === 'SELECT') value = value === 'on' ? true : value === 'off' ? false : value
  else if (/^\d+(\.\d+)?$/.test(value) && /Chance|Limit|Interval|Minutes|Retention|PerDay/.test(path)) value = Number(value)
  const patch = {}
  setPath(patch, path, value)
  await saveState(patch)
})

// 文本输入实时过滤（只刷新列表容器，不打断输入）
document.addEventListener('input', (event) => {
  const el = event.target
  if (el.matches('#contact-search')) {
    S.contactSearch = el.value
    patchContainer('contact-list-scroll', contactListItems())
    return
  }
  if (el.matches('#log-keyword')) {
    S.logFilter.keyword = el.value
    patchContainer('logs-list', logsList())
    return
  }
  if (el.matches('#pv-base')) { queueBasePreview(); return }
})

// 接口地址 / API Key 失焦后自动拉取模型列表（防抖，不打断输入）
let modelAutoTimer = null
document.addEventListener('focusout', (event) => {
  const el = event.target
  if (!el || !el.matches || !el.matches('#pv-base, #pv-key')) return
  const baseUrl = (document.getElementById('pv-base')?.value || '').trim()
  const key = document.getElementById('pv-key')?.value || ''
  if (!baseUrl) return
  // 没有 Key、也不是编辑已有模型（可用已存 Key）时不自动拉取，避免无谓报错
  if (!key && !(S.providerEditing >= 0)) return
  clearTimeout(modelAutoTimer)
  modelAutoTimer = setTimeout(() => { ACTIONS['provider-fetch-models']({}, null) }, 400)
})

function setPath(root, path, value) {
  const keys = path.split('.')
  let node = root
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!node[keys[i]] || typeof node[keys[i]] !== 'object') node[keys[i]] = {}
    node = node[keys[i]]
  }
  node[keys.at(-1)] = value
}

loadAll()
