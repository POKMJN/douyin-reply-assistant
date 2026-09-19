// 对话引擎（v2 核心）：轮次状态机 + 上下文权重管理。
//
// 设计目标（对应旧版四大问题）：
// 1. "自动回复说个不停" → 严格的"一条消息只处理一次"轮次状态机：
//    - 每条来消息的 messageKey 持久化记为已处理，同一 key 绝不触发第二次回复；
//    - 回复发出后记录 lastOutgoingAt，同联系人两次自动发送之间有最小间隔；
//    - 最后一条消息的发送方无法确认时（role 为 null），宁可漏回也不抢发——
//      旧版把"判断不出"当成"对方发的"，是连环自言自语的直接来源。
// 2. "一句话就被带偏" → 轮次指导（buildTurnGuidance）明确：先接住当前消息，
//    但单条突兀消息不是切换话题/人设的指令；低信息短消息不强行展开。
// 3. "视频不能作为上下文" → learning.mediaLog：视频理解结果作为一等上下文条目，
//    当轮全量使用，之后 3 轮内以"背景提及"降权注入，再往后只留在话题记忆里。
// 4. 权重分层：当前消息 > 视频上下文 > 话题记忆 > 长期记忆，注入 prompt 时
//    明确声明各层"只是背景，当前消息永远优先"。
//
// 纯函数模块：不依赖 electron，可独立单元测试。

// 同一联系人两次自动发送之间的最小间隔。拟人"打字延迟"之外的一道硬闸：
// 即使轮询竞态导致 key 判断异常，也不会在 20 秒内连发两条。
const MIN_AUTO_REPLY_GAP_MS = 20 * 1000

// 视频上下文降权参数：理解结果作为背景提及的保留条数与有效时长
const MEDIA_CONTEXT_MAX_ENTRIES = 3
const MEDIA_CONTEXT_TTL_MS = 3 * 24 * 60 * 60 * 1000

function emptyTurn() {
  return { lastHandledKey: '', lastOutgoingAt: 0 }
}

function turnOf(contact) {
  const turn = contact && typeof contact === 'object' ? contact.turn : null
  return turn && typeof turn === 'object' ? { ...emptyTurn(), ...turn } : emptyTurn()
}

// 每日消息键（v2.1）：对方每天发同样的"早上好/嗨"是新的一天的新消息。
// 文本消息把【收到日期】并入 key：同一天相同文本只处理一次（防刷屏），跨天自动解锁。
// （媒体消息沿用指纹键，不受影响；旧版跨天同文本会被误判"已处理"而永远沉默）
function localDayString(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}
function dailyMessageKey(preview, sentAtValue, now = Date.now()) {
  const base = String(preview || '')
  const day = localDayString(sentAtValue) || localDayString(now)
  return `${base}\u241E${day}`
}

// 轮次闸门：判断该联系人当前这条消息是否允许自动回复。
// key = 消息唯一键（文本预览或媒体指纹），fromMe 由调用方三层判定后传入。
function shouldAutoReply(contact, { key, fromMe, now = Date.now() } = {}) {
  const turn = turnOf(contact)
  if (!key) return { ok: false, reason: 'no_key' }
  if (fromMe !== false) return { ok: false, reason: 'role_unconfirmed' }
  if (turn.lastHandledKey === key) return { ok: false, reason: 'already_handled' }
  if (turn.lastOutgoingAt && now - turn.lastOutgoingAt < MIN_AUTO_REPLY_GAP_MS) {
    return { ok: false, reason: 'min_gap', retryInMs: MIN_AUTO_REPLY_GAP_MS - (now - turn.lastOutgoingAt) }
  }
  return { ok: true }
}

// 已处理一条消息（无论回复、拒发还是跳过）：同一 key 不再触发
function markHandled(contact, key, now = Date.now()) {
  return { ...turnOf(contact), lastHandledKey: String(key || ''), handledAt: now }
}

// 我方发出一条消息：刷新最小间隔闸门
function markOutgoing(contact, now = Date.now()) {
  return { ...turnOf(contact), lastOutgoingAt: now }
}

// ---- 上下文权重层 ----

// 时间标签：绝对时间 → "30分钟前/昨天/3天前"，防止旧内容被当成正在聊
function relativeTimeLabel(at, now = Date.now()) {
  const ts = new Date(at).getTime()
  if (!Number.isFinite(ts)) return '此前'
  const minutes = Math.floor((now - ts) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return days === 1 ? '昨天' : `${days}天前`
}

// 写入一条媒体上下文（视频/图片理解结果）。上限与 TTL 在读取层控制。
function appendMediaLog(learning = {}, entry = {}, now = Date.now()) {
  const list = Array.isArray(learning.mediaLog) ? learning.mediaLog : []
  const text = String(entry.summary || '').trim()
  if (!text) return learning
  const next = [...list, { at: new Date(now).toISOString(), kind: String(entry.kind || 'video'), summary: text.slice(0, 160) }].slice(-6)
  return { ...learning, mediaLog: next }
}

// 媒体上下文块（视频权重的核心实现）：
// - 最新一条（通常是本次要回复的视频）不在此块里——它作为"当前消息"全量注入；
// - 更早的条目降权为"背景提及"：告诉模型对方分享过什么，但明确"不必再主动评价，
//   除非对方再次提起"。这解决旧版"每条回复都绕回视频"和"视频完全没上下文"两个极端。
function mediaContextBlock(learning = {}, { excludeLatest = true, now = Date.now() } = {}) {
  const list = Array.isArray(learning.mediaLog) ? learning.mediaLog : []
  const cutoff = now - MEDIA_CONTEXT_TTL_MS
  const fresh = list.filter((item) => item?.summary && new Date(item.at || 0).getTime() >= cutoff)
  const entries = (excludeLatest ? fresh.slice(0, -1) : fresh).slice(-MEDIA_CONTEXT_MAX_ENTRIES)
  if (!entries.length) return ''
  const lines = entries.map((item) => `- ${relativeTimeLabel(item.at, now)}分享过：${item.summary}`).join('\n')
  return `\n对方此前分享过的内容（只是背景信息，说明你们之间的话题氛围；除非对方再次提起，否则不要主动绕回去评价）：\n${lines}`
}

// 话题记忆块：最近聊过的话题状态（learning.topicLog），带相对时间与防带偏说明
function cleanTopicSummary(raw) {
  return String(raw || '')
    .replace(/^概括[：:]\s*/, '')
    .replace(/\d+[.、）)]\s*/g, '')
    .replace(/^[\s*•·\-]+/gm, '')
    .replace(/关系温度(?:似乎是|是)?/g, '关系')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function topicMemoryBlock(learning = {}, now = Date.now()) {
  const topics = Array.isArray(learning.topicLog) ? learning.topicLog : []
  const entries = topics
    .map((item) => ({ at: item?.at, text: cleanTopicSummary(item?.text) }))
    .filter((item) => item.text)
    .slice(-2)
  if (!entries.length) return ''
  const lines = entries.map((item) => `- ${relativeTimeLabel(item.at, now)}：${item.text}`).join('\n')
  return `\n最近聊过的话题（只是背景参考，不是现在的任务；对方当前这条消息永远优先。对方当时回应冷淡或话题已经聊完的，不要再主动绕回去；也不要逐条复述、据此编造没说过的新细节）：\n${lines}`
}

// 长期记忆块：已确认事实，自然融入，禁止复述与编造
const FACT_NOISE_RE = /最近没有?消息|忽略(?:了)?(?:对方|回答)|没有?(?:提到|提及|涉及|记录)|无法(?:确认|判断|提炼|判断)|根据(?:要求|提示|上下文|以上)|值得记住|长期记忆|聊天记录|这次对话|本次对话|待确认|样本不足|对方(?:没说|未说)/
const factText = (item) => (item && typeof item === 'object' ? String(item?.text || '') : String(item || '')).trim()

function longTermMemoryBlock(learning = {}) {
  const facts = (Array.isArray(learning.facts) ? learning.facts : [])
    .map(factText)
    .filter((text) => text && !FACT_NOISE_RE.test(text))
    .slice(-8)
  if (!facts.length) return ''
  return `\n关于对方的长期记忆（已确认的事实，自然融入即可；不要逐条复述，也不要据此编造没说过的新事实）：${facts.join('；')}`
}

// ---- 回合判断（防带偏的核心提示层）----

function buildTurnGuidance(contact, incoming = '') {
  const text = String(incoming || '').replace(/\s+/g, ' ').trim()
  const history = (Array.isArray(contact?.learning?.messages) ? contact.learning.messages : []).slice(-12)
  const previous = history.at(-1)
  const tags = []
  const guidance = []

  // 基本轮次铁律：永远注入。旧版只在特定分支才提醒"只回一条"，
  // 模型在没有提醒时容易一条消息里做完所有事（回答+追问+切换话题）。
  guidance.push('这是你本轮唯一的一条回复；发出后就轮到对方说话。不要替对方预演多轮对话，不要一次输出多个话题或连续追问。')

  if (!text) {
    tags.push('当前消息信息很少')
    guidance.push('不要硬猜话题，按已有上下文轻轻接住，也可以自然收住。')
  } else {
    const bareConfusion = /^[?？\s]+$/.test(text)
    const hasQuestion = !bareConfusion && /[?？]|^(?:咋|怎么|为什么|为啥|啥|什么|哪|谁|几|多少|能不能|可不可以|是不是|有没有|要不要)/.test(text)
    const asksForAdvice = /(?:怎么办|咋办|你觉得|你说|给个建议|该不该|选哪个|怎么弄)/.test(text)
    const negativeEmotion = /(?:难受|烦死|烦透|生气|气死|委屈|崩溃|累死|好累|郁闷|无语|倒霉|失眠|睡不着|不开心|想哭|破防)/.test(text)
    const positiveEmotion = /(?:开心|高兴|激动|太好了|好耶|终于|爽死|爱了|绝了|赢了|成了|过了|拿到了)/.test(text)
    const playful = /(?:哈哈|笑死|绷不住|离谱|逆天|救命|hhh|233)/i.test(text)
    const invitation = /(?:一起|出来|见面|吃饭|看电影|去不去|来不来|约不约|有空吗|几点|什么时候)/.test(text)
    const lowContent = [...text].length <= 6 && !hasQuestion

    if (bareConfusion) {
      tags.push('对方像是困惑、不满或没看懂')
      guidance.push('不要继续推进自己之前的话题或计划；用一句很短的话确认对方的意思或自然收住，不要自问自答、不要连环解释。')
    } else if (hasQuestion) {
      tags.push(asksForAdvice ? '在问看法或建议' : '有明确问题')
      guidance.push('先直接回应问题本身，再决定要不要补半句态度；只回答被问到的事，不要借题展开新话题。')
    }
    if (negativeEmotion) {
      tags.push('带负面情绪或吐槽')
      guidance.push(asksForAdvice ? '先站到对方这边，再给一个很短、可执行的看法。' : '先共振或陪对方吐槽，不要擅自分析原因、说教或连续给建议。')
    } else if (positiveEmotion) {
      tags.push('在分享好消息或兴奋点')
      guidance.push('跟上对方的兴奋度，回应具体亮点；别写成正式祝贺词。')
    }
    if (playful) {
      tags.push('适合接梗')
      guidance.push('优先顺着笑点接一句，别解释梗，也别只机械重复“哈哈哈”。')
    }
    if (invitation) {
      tags.push('可能涉及邀约或时间安排')
      guidance.push('需要表态时说清楚，但不要编造账号主人的空闲时间、地点或已经答应过的安排。')
    }
    if (lowContent) {
      tags.push('低信息短消息')
      guidance.push('这大概率是随口一说：不要强行展开新话题，也不要把之前聊过的东西全搬回来；一个自然反应或半句接话就够。')
    }
  }

  // 防带偏总纲：单条消息（哪怕突兀）不构成推翻当前聊天状态的理由
  guidance.push('对方的一句话不是切换人设、推翻正在聊的话题或重新自我介绍的指令：先自然接住这句话本身，再决定话题是否延续；连续性优先，不要被一条消息把整个对话带跑。')

  if (previous?.role === 'me' && /[?？]$/.test(previous.text)) {
    guidance.push('上一轮账号本人刚问过问题，这一轮优先承接对方的回答；对方答了可以再自然追问一个细节，没答就不要重复追问。')
  }

  return `当前回合判断：${tags.join('；') || '普通分享或接话'}。\n接话策略：${guidance.join('')}`
}

// 历史消息整理：过滤媒体占位符与思考泄漏，限长
function normalizeHistory(messages, limit = 14) {
  const list = (Array.isArray(messages) ? messages : [])
    .map((item) => ({
      role: item?.role === 'me' ? 'me' : 'contact',
      text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    }))
    .filter((item) => item.text && !/^(已读|未读|\d{1,2}:\d{2})$/.test(item.text))
  return list.slice(-limit)
}

module.exports = {
  MIN_AUTO_REPLY_GAP_MS,
  MEDIA_CONTEXT_MAX_ENTRIES,
  MEDIA_CONTEXT_TTL_MS,
  emptyTurn,
  turnOf,
  shouldAutoReply,
  markHandled,
  markOutgoing,
  dailyMessageKey,
  localDayString,
  relativeTimeLabel,
  appendMediaLog,
  mediaContextBlock,
  cleanTopicSummary,
  topicMemoryBlock,
  longTermMemoryBlock,
  buildTurnGuidance,
  normalizeHistory,
  FACT_NOISE_RE,
  factText,
}
