const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { BrowserWindow, session } = require('electron')

const CHAT_URL = 'https://www.douyin.com/chat?isPopup=1'
const PARTITION = 'persist:douyin-account'
const AUTOMATION_POLL_MS = 1000
const SPARK_RETRY_MS = 5 * 60 * 1000
const VIDEO_SHARE_HARD_DAILY_LIMIT = 10
const VIDEO_SHARE_DEFAULT_DAILY_LIMIT = 3
const VIDEO_SHARE_MIN_INTERVAL_MS = 45 * 60 * 1000
const VIDEO_SHARE_ENGAGEMENT_WINDOW_MS = 72 * 60 * 60 * 1000
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const normalizeEditorText = (text) => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
const MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024
const AUDIO_TRANSCRIPTION_SECONDS = 90
const CHAT_MESSAGE_ROW_SELECTOR = '[class*="MessageItem"], [class*="messageItem"], [data-e2e*="message-item"], [data-e2e*="messageItem"]'
const CHAT_MESSAGE_MEDIA_SELECTOR = '[class*="sticker"], [class*="emoji"], [class*="imageMsg"], [class*="mediaMsg"], [class*="cardMsg"]'

function pickLatestChatMessageRole(candidates, { editorRect, innerWidth = 0 } = {}) {
  const divider = editorRect ? editorRect.left + (editorRect.width / 2) : innerWidth * 0.65
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter((item) => item && item.withinMessageRow === true && item.rect && item.rect.width > 0 && item.rect.height > 0)
    .sort((left, right) => right.rect.top - left.rect.top)
  if (!rows.length) return null
  const last = rows[0]
  if (last.me === true) return 'me'
  if (last.them === true) return 'contact'
  return last.rect.left + (last.rect.width / 2) > divider ? 'me' : 'contact'
}

const tempPath = (prefix, extension) => path.join(
  os.tmpdir(),
  `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`,
)

const existingExecutable = (candidate) => {
  try {
    if (!candidate) return ''
    const stat = fs.statSync(candidate)
    return stat.isFile() ? candidate : ''
  } catch (_) {
    return ''
  }
}

const findFfmpegPath = () => {
  const candidates = []
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'ffmpeg.exe'),
      path.join(process.resourcesPath, 'ffmpeg'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'ffmpeg.exe'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'ffmpeg'),
    )
  }
  candidates.push(
    path.join(process.cwd(), 'ffmpeg.exe'),
    path.join(process.cwd(), 'ffmpeg'),
    path.join(process.cwd(), 'resources', 'ffmpeg.exe'),
    path.join(process.cwd(), 'resources', 'ffmpeg'),
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg'),
    path.join(__dirname, '..', 'ffmpeg.exe'),
    path.join(__dirname, '..', 'ffmpeg'),
    path.join(__dirname, '..', '..', 'ffmpeg.exe'),
    path.join(__dirname, '..', '..', 'ffmpeg'),
  )
  for (const candidate of candidates) {
    const found = existingExecutable(candidate)
    if (found) return found
  }
  const executableNames = process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat', 'ffmpeg']
    : ['ffmpeg']
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames) {
      const found = existingExecutable(path.join(dir, name))
      if (found) return found
    }
  }
  return ''
}

const runProcess = (file, args, { timeoutMs = 90000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true })
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (error, result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) reject(error)
    else resolve(result)
  }
  const timer = setTimeout(() => {
    const error = new Error('ffmpeg audio extraction timed out')
    error.code = 'PROCESS_TIMEOUT'
    child.kill('SIGKILL')
    finish(error)
  }, timeoutMs)
  child.stdout.on('data', (chunk) => { if (stdout.length < 4000) stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk.toString('utf8') })
  child.on('error', (error) => finish(error))
  child.on('close', (code) => {
    if (code === 0) return finish(null, { stdout, stderr })
    const tail = stderr.trim().slice(-800)
    finish(new Error(`ffmpeg exited with code ${code}${tail ? `: ${tail}` : ''}`))
  })
})

const safeMediaExtension = (value) => {
  try {
    const extension = path.extname(new URL(value).pathname).toLowerCase()
    return /^\.(?:mp4|mov|m4v|webm|mkv|ts|m3u8)$/i.test(extension) ? extension : '.mp4'
  } catch (_) {
    return '.mp4'
  }
}

const downloadFile = (url, filePath, headers = {}, redirectCount = 0) => new Promise((resolve, reject) => {
  if (redirectCount > 5) return reject(new Error('video download redirected too many times'))
  const target = new URL(url)
  const client = target.protocol === 'https:' ? https : http
  const request = client.request(target, { method: 'GET', headers, timeout: 30000 }, (response) => {
    const status = Number(response.statusCode || 0)
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.resume()
      const nextUrl = new URL(response.headers.location, target).toString()
      downloadFile(nextUrl, filePath, headers, redirectCount + 1).then(resolve, reject)
      return
    }
    if (status < 200 || status >= 300) {
      response.resume()
      reject(new Error(`video download failed with HTTP ${status}`))
      return
    }
    const output = fs.createWriteStream(filePath)
    let bytes = 0
    let failed = false
    const fail = (error) => {
      if (failed) return
      failed = true
      response.destroy()
      output.destroy()
      try { fs.rmSync(filePath, { force: true }) } catch (_) {}
      reject(error)
    }
    response.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_VIDEO_DOWNLOAD_BYTES) {
        fail(new Error('video file is too large to transcribe'))
        return
      }
      if (!output.write(chunk)) response.pause()
    })
    output.on('drain', () => response.resume())
    response.on('end', () => {
      if (failed) return
      output.end(() => resolve({ filePath, bytes }))
    })
    response.on('error', fail)
    output.on('error', fail)
  })
  request.on('timeout', () => request.destroy(new Error('video download timed out')))
  request.on('error', reject)
  request.end()
})

const downloadToTemp = async (url, headers = {}) => {
  const filePath = tempPath('xusheng-video', safeMediaExtension(url))
  await downloadFile(url, filePath, headers)
  return filePath
}

const ffmpegHeaderArgs = (headers = {}) => {
  const lines = Object.entries(headers)
    .filter(([, value]) => String(value || '').trim())
    .map(([key, value]) => `${key}: ${String(value).replace(/\r?\n/g, ' ')}`)
  return lines.length ? ['-headers', `${lines.join('\r\n')}\r\n`] : []
}

const extractAudioWithFfmpeg = async (ffmpegPath, input, outputPath, headers = {}) => {
  const networkInput = /^https?:\/\//i.test(input)
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error']
  if (networkInput) args.push('-rw_timeout', '20000000', ...ffmpegHeaderArgs(headers))
  args.push(
    '-t', String(AUDIO_TRANSCRIPTION_SECONDS),
    '-i', input,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    outputPath,
  )
  await runProcess(ffmpegPath, args, { timeoutMs: 120000 })
  return outputPath
}

const extractAudioTrack = async ({ ffmpegPath, videoUrl, outputPath, headers = {} }) => {
  let directError
  try {
    await extractAudioWithFfmpeg(ffmpegPath, videoUrl, outputPath, headers)
    return { source: 'direct_url' }
  } catch (error) {
    directError = error
  }
  const downloadedPath = await downloadToTemp(videoUrl, headers)
  try {
    await extractAudioWithFfmpeg(ffmpegPath, downloadedPath, outputPath)
    return { source: 'downloaded_video' }
  } catch (error) {
    error.message = `${error.message}; direct_url_error=${directError.message}`
    throw error
  } finally {
    try { fs.rmSync(downloadedPath, { force: true }) } catch (_) {}
  }
}

const mediaRequestHeaders = async (url, win) => {
  const headers = {
    Accept: '*/*',
    Referer: 'https://www.douyin.com/',
    'User-Agent': 'Mozilla/5.0',
  }
  try {
    const userAgent = typeof win?.webContents?.getUserAgent === 'function' ? win.webContents.getUserAgent() : ''
    if (userAgent) headers['User-Agent'] = userAgent
  } catch (_) {}
  try {
    const cookieSession = typeof session?.fromPartition === 'function'
      ? session.fromPartition(PARTITION)
      : session?.defaultSession
    const cookies = await cookieSession?.cookies?.get?.({ url })
    if (Array.isArray(cookies) && cookies.length) {
      headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }
  } catch (_) {}
  return headers
}

const normalizeVideoRecognitionStrength = (value) => {
  const key = String(value || 'standard').toLowerCase()
  return ['light', 'standard', 'deep', 'comments20', 'comments30'].includes(key) ? key : 'standard'
}

const videoRecognitionOptions = (settings = {}) => {
  const strength = normalizeVideoRecognitionStrength(settings.videoRecognitionStrength)
  const presets = {
    light: { strength, maxFrames: 1, audio: false, commentLimit: 0, commentWaitMs: 0 },
    standard: { strength, maxFrames: 3, audio: true, commentLimit: 3, commentWaitMs: 3000 },
    deep: { strength, maxFrames: 9, audio: true, commentLimit: 12, commentWaitMs: 6500, frameDetail: 'high', imageMaxSize: 960, jpegQuality: 72 },
    comments20: { strength, maxFrames: 0, audio: false, commentLimit: 20, commentWaitMs: 6500, commentScrolls: 4, publicPageOnly: true },
    comments30: { strength, maxFrames: 0, audio: false, commentLimit: 30, commentWaitMs: 8500, commentScrolls: 6, publicPageOnly: true },
  }
  return presets[strength] || presets.standard
}

const normalizeCommentContext = (value = {}, limit = 5) => {
  const source = value && typeof value === 'object' ? value : {}
  const comments = (Array.isArray(source.comments) ? source.comments : Array.isArray(source.videoComments) ? source.videoComments : [])
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 2)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, Math.max(0, Math.min(30, Math.floor(Number(limit) || 0))))
  return {
    videoPageTitle: String(source.title || source.videoPageTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    videoPageAuthor: String(source.author || source.videoPageAuthor || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    videoPageDescription: String(source.description || source.videoPageDescription || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    videoComments: comments,
    videoCommentSource: String(source.source || ''),
    videoCommentError: String(source.error || ''),
  }
}
const localDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const timeToMinutes = (value) => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return Number.POSITIVE_INFINITY
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
    ? hours * 60 + minutes
    : Number.POSITIVE_INFINITY
}

const minutesToDate = (minutes, value = new Date()) => {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return date
}

const sparkMessageOptions = (task) => {
  const raw = Array.isArray(task?.messages) && task.messages.length
    ? task.messages
    : String(task?.message || '').split(/\r?\n/)
  return raw.map((item) => String(item || '').trim()).filter(Boolean)
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

const resolveSparkTask = (task, value = new Date()) => {
  const message = dailySparkMessage(task, value)
  return message ? { ...task, message } : { ...task }
}

const isVideoShareTask = (task) => ['videoShare', 'video'].includes(String(task?.kind || ''))

const videoShareDailyLimit = (task) => {
  const raw = Math.floor(Number(task?.maxPerDay ?? task?.dailyLimit ?? VIDEO_SHARE_DEFAULT_DAILY_LIMIT) || VIDEO_SHARE_DEFAULT_DAILY_LIMIT)
  return Math.max(1, Math.min(VIDEO_SHARE_HARD_DAILY_LIMIT, raw))
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
      tags: Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    }
  }).filter((item) => /^https?:\/\//i.test(item.url)).slice(0, 200)
}

const videoShareItemKey = (item) => `${item.url}|${item.title || ''}|${item.note || ''}`

const normalizeVideoShareCategories = (value) => {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，、;；|]+/)
  const selected = raw
    .map((item) => String(item || '').replace(/\s+/g, '').trim())
    .filter((item) => VIDEO_SHARE_CATEGORIES.includes(item))
  return [...new Set(selected)]
}

const videoShareCategoryStats = (contact = {}, task = {}) => {
  const profile = contact?.profile || {}
  return task?.videoShareState?.categoryStats
    || profile.videoShare?.videoShareState?.categoryStats
    || {}
}

const videoShareCategoryScore = (category, stats = {}) => {
  const stat = stats[category] || {}
  const sent = Number(stat.sent || 0)
  const replied = Number(stat.replied || 0)
  return replied * 5 + (sent ? replied / sent : 0) - sent * 0.12
}

const inferVideoShareCategory = (video = {}, task = {}) => {
  const selected = normalizeVideoShareCategories(task?.categories)
  const direct = normalizeVideoShareCategories([video.category, ...(Array.isArray(video.tags) ? video.tags : [])])[0]
  if (direct && (!selected.length || selected.includes(direct))) return direct
  const text = [video.searchTerm, video.title, video.note, video.summary].map((item) => String(item || '')).join(' ')
  return selected.find((category) => text.includes(category)) || selected[0] || direct || ''
}

const videoShareTermCategory = (term, task = {}) => {
  const value = String(term || '')
  return normalizeVideoShareCategories(task?.categories).find((category) => value === category || value.includes(category) || category.includes(value)) || ''
}

const freshVideoShareState = (state = {}, today = localDateKey()) => ({
  ...state,
  date: today,
  sentToday: state?.date === today ? Number(state.sentToday || 0) : 0,
  usedVideoKeys: Array.isArray(state?.usedVideoKeys) ? state.usedVideoKeys : [],
  categoryStats: state?.categoryStats || {},
})

const videoShareStateAfterSend = (previousState = {}, video = {}, task = {}, now = new Date(), today = localDateKey(now), sentToday = 0, usedVideoKeys = []) => {
  const category = inferVideoShareCategory(video, task)
  const sentAt = new Date(now).toISOString()
  const categoryStats = { ...(previousState.categoryStats || {}) }
  if (category) {
    const stat = categoryStats[category] || {}
    categoryStats[category] = {
      ...stat,
      sent: Number(stat.sent || 0) + 1,
      replied: Number(stat.replied || 0),
      lastSentAt: sentAt,
      lastUrl: video.url || '',
    }
  }
  return {
    ...previousState,
    date: today,
    sentToday,
    usedVideoKeys,
    categoryStats,
    lastShared: {
      at: sentAt,
      category,
      url: video.url || '',
      searchTerm: video.searchTerm || '',
      engaged: false,
    },
  }
}

const videoShareDiscoveryTerms = (contact = {}, task = {}) => {
  const profile = contact?.profile || {}
  const stats = videoShareCategoryStats(contact, task)
  const categories = normalizeVideoShareCategories(task.categories || profile.videoShare?.categories)
    .sort((left, right) => videoShareCategoryScore(right, stats) - videoShareCategoryScore(left, stats))
  const raw = [
    categories,
    task.discoveryQuery,
    task.keywords,
    task.topics,
    profile.videoShare?.discoveryQuery,
    profile.videoShare?.keywords,
    profile.videoShare?.topics,
    profile.personality,
    profile.tone,
  ]
  const splitTerms = raw.flatMap((value) => {
    if (Array.isArray(value)) return value
    return String(value || '').split(/[\r\n,，;；、/|]+/)
  })
  const terms = splitTerms
    .map((item) => String(item || '').replace(/https?:\/\/\S+/ig, '').replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 2 && item.length <= 40)
  const unique = [...new Set(terms)].slice(0, 8)
  return unique.length ? unique : ['轻松有趣短视频', '生活日常', '搞笑反转']
}

const videoShareSearchUrl = (term) => `https://www.douyin.com/search/${encodeURIComponent(term)}?type=video`

const fallbackVideoShareCaption = (video = {}) => {
  const note = String(video.note || video.summary || video.title || '').replace(/\s+/g, ' ').trim()
  if (!note) return '这个我感觉你可能会喜欢'
  return note.length <= 24 ? `这个点挺有意思，${note}` : `这个里面有个点挺有意思，${note.slice(0, 22)}`
}

const scheduleNextVideoShareAt = (task, value = new Date()) => {
  const now = value instanceof Date ? new Date(value) : new Date(value)
  let start = timeToMinutes(task?.windowStart || task?.time || '12:00')
  let end = timeToMinutes(task?.windowEnd || task?.endTime || '22:30')
  if (!Number.isFinite(start)) start = 12 * 60
  if (!Number.isFinite(end)) end = 22 * 60 + 30
  if (end <= start) end = 23 * 60 + 59
  const current = now.getHours() * 60 + now.getMinutes()
  if (current > end) return ''
  const hasSentToday = Number(task?.videoShareState?.sentToday || 0) > 0
  const intervalMinutes = hasSentToday ? Math.ceil(VIDEO_SHARE_MIN_INTERVAL_MS / 60000) : 0
  const earliest = Math.max(start, current + intervalMinutes)
  if (earliest > end) return ''
  const selected = earliest + Math.floor(Math.random() * (end - earliest + 1))
  return minutesToDate(selected, now).toISOString()
}

const normalizeHistoryMessage = (item) => ({
  role: item?.role === 'me' ? 'me' : 'contact',
  text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
})

const contactMessageKey = (contact) => String(contact?.messageKey || contact?.preview || '')

const CONVERSATION_TIME_RE = /^(?:刚刚|昨天|今天|星期[一二三四五六日天]|\d{1,2}:\d{2}|\d+(?:分钟|小时|天)前|\d{1,2}月\d{1,2}日)$/

function extractConversationTimeLabel(lines, explicitTime = '') {
  const explicit = String(explicitTime || '').replace(/\s+/g, ' ').trim()
  if (explicit && CONVERSATION_TIME_RE.test(explicit)) return explicit
  return (Array.isArray(lines) ? lines : [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .find((value, index) => index > 0 && CONVERSATION_TIME_RE.test(value)) || ''
}

function weekdayNumber(label) {
  const key = String(label || '').replace(/^星期/, '')
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[key]
}

function resolveConversationSentAt(label, nowValue = new Date()) {
  const text = String(label || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const now = nowValue instanceof Date ? new Date(nowValue.getTime()) : new Date(nowValue)
  if (Number.isNaN(now.getTime())) return ''
  if (text === '刚刚') return now.toISOString()
  let match = text.match(/^(\d+)(分钟|小时|天)前$/)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2]
    const ms = unit === '分钟' ? amount * 60_000 : unit === '小时' ? amount * 60 * 60_000 : amount * 24 * 60 * 60_000
    return new Date(now.getTime() - ms).toISOString()
  }
  match = text.match(/^(\d{1,2}):(\d{2})$/)
  if (match) {
    const date = new Date(now.getTime())
    date.setHours(Number(match[1]), Number(match[2]), 0, 0)
    if (date.getTime() - now.getTime() > 5 * 60_000) date.setDate(date.getDate() - 1)
    return date.toISOString()
  }
  if (text === '今天') {
    const date = new Date(now.getTime())
    date.setHours(0, 0, 0, 0)
    return date.toISOString()
  }
  if (text === '昨天') {
    const date = new Date(now.getTime())
    date.setDate(date.getDate() - 1)
    date.setHours(0, 0, 0, 0)
    return date.toISOString()
  }
  const weekday = weekdayNumber(text)
  if (weekday !== undefined) {
    const date = new Date(now.getTime())
    const diff = (date.getDay() - weekday + 7) % 7 || 7
    date.setDate(date.getDate() - diff)
    date.setHours(0, 0, 0, 0)
    return date.toISOString()
  }
  match = text.match(/^(\d{1,2})月(\d{1,2})日$/)
  if (match) {
    const date = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]), 0, 0, 0, 0)
    if (date.getTime() - now.getTime() > 24 * 60 * 60_000) date.setFullYear(date.getFullYear() - 1)
    return date.toISOString()
  }
  return ''
}

function conversationTimeMeta(contact, now = new Date()) {
  const label = String(contact?.sentAtLabel || contact?.timeLabel || '').trim()
  const sentAt = contact?.sentAt || resolveConversationSentAt(label, now)
  return { sentAtLabel: label, sentAt }
}

const isVideoPreview = (value) => /(?:\[?视频\]?|发来一个视频|分享(?:了)?视频|分享(?:了)?作品|video|短视频|视频卡片|来自视频|播放|[▶⏵]|\d{1,3}["秒]?\s*$|作品|看这个|你看看|发来了一段)/i.test(String(value || ''))
const mediaPreviewKind = (value) => {
  const text = String(value || '')
  if (isVideoPreview(text)) return 'video'
  if (/(?:\[?媒体\]?|媒体卡片|分享\s*@|分享\s*\[?\s*评论\s*\]?|分享.{0,24}评论|来自视频)/i.test(text)) return 'share'
  if (/(?:\[?图集\]?|分享\[图集\]|相册)/i.test(text)) return 'album'
  if (/(?:\[?图片\]?|照片|photo|image)/i.test(text)) return 'image'
  if (/(?:\[?动图\]?|GIF)/i.test(text)) return 'gif'
  if (/(?:\[?表情\]?|表情包|emoji)/i.test(text)) return 'sticker'
  if (/(?:分享(?:了)?(?:链接|商品|直播|音乐|作品)|\[分享\])/i.test(text)) return 'share'
  return ''
}

const normalizeCapturedMedia = (value, hintedKind = '') => {
  const source = value && typeof value === 'object' ? value : {}
  const frameLimit = Math.max(0, Math.min(9, Math.floor(Number(source.maxFrames ?? source.frameLimit ?? 3) || 0)))
  const frames = (Array.isArray(value) ? value : Array.isArray(source.frames) ? source.frames : [])
    .map((frame) => String(frame || '').trim())
    .filter((frame) => /^data:image\/(?:jpeg|png|webp);base64,/i.test(frame) || /^https?:\/\//i.test(frame))
    .slice(0, frameLimit)
  const mediaKind = String(source.mediaKind || hintedKind || (source.detectedVideo ? 'video' : frames.length ? 'media' : '') || '')
  const decodedVideoFrames = Math.max(0, Math.floor(Number(source.decodedVideoFrames || 0) || 0))
  const detectedVideo = Boolean(source.detectedVideo || mediaKind === 'video')
  const videoReady = source.videoReady === true || decodedVideoFrames > 0
  const hasPublicContext = Boolean(
    String(source.videoPageTitle || source.title || '').trim()
      || String(source.videoPageDescription || source.description || '').trim()
      || (Array.isArray(source.videoComments) && source.videoComments.length)
      || (Array.isArray(source.comments) && source.comments.length)
  )
  const confidence = String(source.confidence || (
    !frames.length ? (hasPublicContext ? 'medium' : 'none') : detectedVideo ? (videoReady ? 'high' : 'low') : mediaKind === 'share' ? 'medium' : 'medium'
  ))
  const commentContext = normalizeCommentContext(source, source.videoComments?.length || source.comments?.length || 0)
  return {
    frames,
    maxFrames: frameLimit,
    frameDetail: String(source.frameDetail || ''),
    mediaKind,
    detectedVideo,
    videoReady,
    decodedVideoFrames,
    videoAddressFound: Boolean(source.videoAddressFound),
    videoPageUrlFound: Boolean(source.videoPageUrlFound),
    posterFound: Boolean(source.posterFound),
    captureSource: String(source.captureSource || ''),
    audioTranscript: String(source.audioTranscript || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    audioTranscriptionSource: String(source.audioTranscriptionSource || ''),
    audioTranscriptionModel: String(source.audioTranscriptionModel || ''),
    audioTranscriptionError: String(source.audioTranscriptionError || ''),
    ...commentContext,
    confidence,
    reason: String(source.reason || ''),
  }
}

const modelMediaRect = (rect = {}, { stripBottom = true } = {}) => {
  const x = Math.max(0, Math.floor(Number(rect.x ?? rect.left ?? 0) || 0))
  const y = Math.max(0, Math.floor(Number(rect.y ?? rect.top ?? 0) || 0))
  const width = Math.max(1, Math.ceil(Number(rect.width || 0) || 0))
  const rawHeight = Math.max(1, Math.ceil(Number(rect.height || 0) || 0))
  const height = stripBottom ? Math.max(1, Math.ceil(rawHeight * 0.84)) : rawHeight
  return { x, y, width, height }
}

const hasPublicMediaContext = (media = {}) => Boolean(
  String(media.videoPageTitle || '').trim()
    || String(media.videoPageDescription || '').trim()
    || (Array.isArray(media.videoComments) && media.videoComments.length)
)

const shouldUseVideoFrameFallback = (recognition = {}, mediaCapture = {}) => (
  recognition.publicPageOnly !== true && !mediaCapture.frames?.length
)

function extractConversationPreview(lines, explicitPreview = '', explicitStreak = '') {
  const preview = String(explicitPreview || '').replace(/\s+/g, ' ').trim()
  if (preview) return preview.slice(0, 180)

  const normalized = (Array.isArray(lines) ? lines : [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const streak = String(explicitStreak || '').trim()
  const metadataNumberIndex = normalized.findIndex((value, index) => index > 0 && index <= 2 && /^\d{1,4}$/.test(value))
  return normalized.filter((value, index) => {
    if (index === 0 || value === streak || index === metadataNumberIndex) return false
    return !/^(?:刚刚|昨天|今天|星期[一二三四五六日天]|\d{1,2}:\d{2}|\d+(?:分钟|小时|天)前|已读|未读)$/.test(value)
  }).join(' ').slice(0, 180)
}

function extractStreakCount(explicitStreak = '', lines = []) {
  const explicit = String(explicitStreak || '').match(/\d+/)
  if (explicit) return Number(explicit[0])
  const labelled = (Array.isArray(lines) ? lines : []).find((value) => /鐏姳|杩炵画\s*\d+\s*澶﹟^\d+\s*澶?/.test(String(value)))
  return Number((String(labelled || '').match(/\d+/) || [0])[0])
}

function mergeMessageHistory(previous, visible) {
  const oldMessages = (Array.isArray(previous) ? previous : []).map(normalizeHistoryMessage).filter((item) => item.text)
  const newMessages = (Array.isArray(visible) ? visible : []).map(normalizeHistoryMessage).filter((item) => item.text)
  const same = (left, right) => left.role === right.role && left.text === right.text
  let overlap = 0
  const maximum = Math.min(oldMessages.length, newMessages.length)
  for (let size = maximum; size > 0; size -= 1) {
    if (oldMessages.slice(-size).every((item, index) => same(item, newMessages[index]))) {
      overlap = size
      break
    }
  }
  return [...oldMessages, ...newMessages.slice(overlap)].slice(-80)
}

const EDITOR_SELECTOR = `[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder], [class*="chat" i] [contenteditable="true"], [class*="message" i] [contenteditable="true"], textarea[placeholder], [contenteditable="true"]`

const FIND_SEND_TARGET_JS = `(() => {
  const editorSelector = ${JSON.stringify(EDITOR_SELECTOR)}
  const visible = (node) => {
    if (!node) return false
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return rect.width >= 16 && rect.height >= 16 && rect.bottom > 0 && rect.top < innerHeight && style.visibility !== 'hidden' && style.display !== 'none' && node.getAttribute('aria-disabled') !== 'true' && !node.disabled
  }
  const center = (node) => {
    const rect = node.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), rect }
  }
  const editor = document.querySelector(editorSelector)
  const editorRect = editor?.getBoundingClientRect?.()
  const known = [...document.querySelectorAll('.e2e-send-msg-btn, [class*="messageMsgInputpublishBtn"], [class*="send" i], [class*="publish" i], [aria-label*="发送"], [title*="发送"]')].find(visible)
  if (known) return center(known)

  if (editorRect) {
    const candidates = [...document.querySelectorAll('button, [role="button"], [aria-label], [title], svg, div, span')]
      .map((node) => {
        let target = node.closest('button, [role="button"], [aria-label], [title]') || node
        for (let depth = 0; target && depth < 4 && !visible(target); depth += 1) target = target.parentElement
        if (!visible(target)) return null
        const rect = target.getBoundingClientRect()
        const text = [target.innerText, target.getAttribute('aria-label'), target.getAttribute('title'), target.className].join(' ')
        const overlapsEditor = rect.bottom >= editorRect.top - 24 && rect.top <= editorRect.bottom + 24
        const rightOfEditor = rect.left >= editorRect.left + Math.min(160, editorRect.width * 0.35)
        const inBottomComposer = rect.top >= innerHeight - 140 && rect.right >= innerWidth - 240
        const looksSend = /(发送|send|publish|submit|arrow|up)/i.test(text)
        if (!overlapsEditor && !inBottomComposer && !looksSend) return null
        if (/文件|表情|emoji|folder|image|attach|图片|相册/i.test(text)) return null
        const score = (looksSend ? 60 : 0) + (rightOfEditor ? 30 : 0) + (inBottomComposer ? 30 : 0) + rect.right / 100
        return { target, rect, score }
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || right.rect.right - left.rect.right)
    if (candidates[0]) return center(candidates[0].target)

    return { x: Math.round(Math.min(innerWidth - 36, Math.max(editorRect.right + 36, innerWidth - 64))), y: Math.round(editorRect.top + editorRect.height / 2), fallback: 'editor-right-coordinate' }
  }

  return null
})()`

class DouyinService {
  constructor({ storage, emit, ai }) {
    this.storage = storage
    this.emit = emit
    this.ai = ai
    this.window = null
    this.discoveryWindow = null
    this.pollTimer = null
    this.polling = false
    this.lastSeen = new Map()
    this.lastLimitNotice = new Map()
    this.lastSkipNotice = new Map()
    this.blockedContacts = new Set()
    const savedSeen = (this.storage?.get().lastSeenPairs || []).filter(p => Date.now() - p.at < 86400000)
    savedSeen.forEach(p => this.lastSeen.set(p.name, p.preview))
    const savedPairs = (this.storage?.get().lastSentPairs || []).filter(p => Date.now() - p.at < 86400000)
    this.lastSent = new Map(savedPairs.map(p => [p.name, p.text]))
    this.lastSentAt = new Map(savedPairs.map(p => [p.name, Number(p.at) || Date.now()]))
    this.lastReplyTime = new Map()
  }

  persistLastSentPairs() {
    if (!this.storage?.update) return
    const now = Date.now()
    const pairs = [...this.lastSent].map(([name, text]) => ({ name, text, at: this.lastSentAt.get(name) || now }))
    this.storage.update({ lastSentPairs: pairs })
  }

  rememberSelfPreview(name, preview) {
    const target = String(name || '').trim()
    const text = String(preview || '').replace(/\s+/g, ' ').trim()
    if (!target || !text) return
    this.lastSent.set(target, text)
    this.lastSentAt.set(target, Date.now())
    this.persistLastSentPairs()
  }

  findFfmpegPath() {
    return findFfmpegPath()
  }

  async mediaRequestHeaders(url, win) {
    return mediaRequestHeaders(url, win)
  }

  async extractAudioTrack(options) {
    return extractAudioTrack(options)
  }

  async transcribeCapturedMediaAudio(media, name, win) {
    if (!media?.isVideo || !media.videoUrl || !this.ai?.transcribeAudio) return {}
    const ffmpegPath = this.findFfmpegPath()
    if (!ffmpegPath) {
      this.log('media_audio_unavailable', `${name} 视频音频未转写：未找到 ffmpeg`, { name, reason: 'missing_ffmpeg' })
      return { audioTranscriptionError: 'missing_ffmpeg' }
    }
    const audioPath = tempPath('xusheng-audio', '.wav')
    try {
      const headers = await this.mediaRequestHeaders(media.videoUrl, win)
      const extracted = await this.extractAudioTrack({ ffmpegPath, videoUrl: media.videoUrl, outputPath: audioPath, headers })
      const transcript = await this.ai.transcribeAudio({ filePath: audioPath, mimeType: 'audio/wav', language: 'zh' })
      const text = String(transcript?.text || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
      if (!text) throw new Error('audio transcription returned empty text')
      this.log('media_audio_transcribed', `已转写 ${name} 的视频音频`, {
        name,
        source: extracted.source || '',
        model: transcript.model || '',
        provider: transcript.provider || '',
      })
      return {
        audioTranscript: text,
        audioTranscriptionSource: extracted.source || 'video_audio',
        audioTranscriptionModel: transcript.model || '',
      }
    } catch (error) {
      this.log('media_audio_unavailable', `${name} 视频音频未转写`, { name, error: error.message })
      return { audioTranscriptionError: error.message || 'audio_transcription_failed' }
    } finally {
      try { fs.rmSync(audioPath, { force: true }) } catch (_) {}
    }
  }

  async readVideoCommentContext(media, name, options = {}) {
    const limit = Math.max(0, Math.min(30, Math.floor(Number(options.commentLimit || 0) || 0)))
    if (!limit || !media?.shareUrl) return {}
    const scrolls = Math.max(1, Math.min(8, Math.floor(Number(options.commentScrolls || 1) || 1)))
    const win = this.ensureDiscoveryWindow()
    try {
      await win.loadURL(media.shareUrl)
      await sleep(Math.max(1800, Number(options.commentWaitMs || 3000)))
      await win.webContents.executeJavaScript(`(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
        const visible = (node) => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        const nodes = [...document.querySelectorAll('button, [role="button"], [aria-label], [title], div, span')]
        const target = nodes.map((node) => {
          const text = normalize([node.innerText, node.getAttribute('aria-label'), node.getAttribute('title'), node.className, node.getAttribute('data-e2e')].join(' '))
          if (!visible(node) || !/(评论|comment)/i.test(text) || /(发表评论|写评论|输入|搜索|查看更多回复)/.test(text)) return null
          const clickTarget = node.closest('button, [role="button"]') || node
          const rect = clickTarget.getBoundingClientRect()
          const score = (/^评论$/.test(text) ? 10 : 0) + (/comment/i.test(text) ? 4 : 0) + (clickTarget.tagName === 'BUTTON' ? 2 : 0)
          return { node: clickTarget, score, y: rect.top }
        }).filter(Boolean).sort((left, right) => right.score - left.score || left.y - right.y)[0]?.node
        if (target) target.click()
        return Boolean(target)
      })()`).catch(() => false)
      await sleep(Math.max(600, Math.floor(Number(options.commentWaitMs || 3000) / 2)))
      for (let index = 0; index < scrolls; index += 1) {
        await win.webContents.executeJavaScript(`(() => {
          try {
            const scrollers = [...document.querySelectorAll('[class*="comment" i], [data-e2e*="comment" i], [role="dialog"], main, body')]
              .filter((node) => node && node.scrollHeight > node.clientHeight + 50)
              .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))
            const target = scrollers[0] || document.scrollingElement || document.documentElement
            target.scrollBy(0, Math.max(320, innerHeight * 0.55))
          } catch {}
          return true
        })()`).catch(() => false)
        await sleep(Math.max(350, Math.floor(Number(options.commentWaitMs || 3000) / (scrolls + 2))))
      }
      const context = await win.webContents.executeJavaScript(`(() => {
        const limit = ${JSON.stringify(limit)}
        const normalize = (value, max = 220) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max)
        const meta = (selector) => normalize(document.querySelector(selector)?.content || document.querySelector(selector)?.getAttribute('content') || '', 180)
        const title = normalize(meta('meta[property="og:title"]') || meta('meta[name="title"]') || document.title, 120)
        const description = normalize(meta('meta[property="og:description"]') || meta('meta[name="description"]'), 500)
        const author = normalize(document.querySelector('[data-e2e*="author"], [class*="author" i], [class*="user" i]')?.innerText || '', 60)
        const bad = /(发表评论|写评论|输入评论|登录|扫码|打开抖音|点击查看|分享|收藏|点赞|展开|收起|回复|查看更多|全部评论|暂无评论|相关搜索|搜索|广告|举报)/i
        const textOf = (node) => normalize([
          node.innerText,
          node.getAttribute('aria-label'),
          node.getAttribute('title'),
        ].find(Boolean) || '', 180)
        const selectors = [
          '[data-e2e*="comment"]',
          '[class*="comment" i]',
          '[class*="reply" i]',
          '[role="listitem"]',
          'li',
        ]
        const nodes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
        const comments = []
        for (const node of nodes) {
          const text = textOf(node)
          if (text.length < 3 || text.length > 180) continue
          if (bad.test(text)) continue
          if (title && (text === title || title.includes(text))) continue
          if (description && description.includes(text) && text.length < 12) continue
          if (/^\\d+$/.test(text) || /^[\\d.万wW]+$/.test(text)) continue
          if (comments.some((item) => item === text || item.includes(text) || text.includes(item))) continue
          comments.push(text)
          if (comments.length >= limit) break
        }
        return { title, description, author, comments, source: location.href }
      })()`).catch((error) => ({ error: error.message }))
      const normalized = normalizeCommentContext(context, limit)
      if (normalized.videoComments.length || normalized.videoPageTitle || normalized.videoPageDescription) {
        this.log('video_comments_captured', `已读取 ${name} 的视频公开页评论`, {
          name,
          comments: normalized.videoComments.length,
          titleFound: Boolean(normalized.videoPageTitle),
        })
      }
      return { ...normalized, videoPageUrlFound: true }
    } catch (error) {
      this.log('video_comments_unavailable', `${name} 视频评论未读取`, { name, error: error.message })
      return { videoCommentError: error.message || 'video_comments_unavailable', videoPageUrlFound: Boolean(media?.shareUrl) }
    }
  }

  ensureWindow(show = false) {
    if (this.window && !this.window.isDestroyed()) {
      if (show) this.window.show()
      return this.window
    }

    this.window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      show,
      title: '鎶栭煶璐﹀彿鐧诲綍 路 缁０',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    // Douyin pages sometimes advertise a Windows-only `bytedance:` deep link.
    // It is not needed for web automation and Windows otherwise shows a Store dialog.
    this.window.webContents.on('will-navigate', (event, url) => {
      if (/^bytedance:/i.test(url)) event.preventDefault()
    })
    this.window.webContents.on('will-redirect', (event, url) => {
      if (/^bytedance:/i.test(url)) event.preventDefault()
    })
    this.window.webContents.on('will-frame-navigate', (event, details) => {
      if (/^bytedance:/i.test(details.url)) event.preventDefault()
    })
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      return /^bytedance:/i.test(url) ? { action: 'deny' } : { action: 'allow' }
    })
    this.window.on('close', (event) => {
      if (!this.window.__forceClose) {
        event.preventDefault()
        this.window.hide()
      }
    })
    this.window.loadURL(CHAT_URL)
    return this.window
  }

  ensureDiscoveryWindow() {
    if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) return this.discoveryWindow
    this.discoveryWindow = new BrowserWindow({
      width: 980,
      height: 760,
      show: false,
      title: 'Douyin video discovery',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    const denyDeepLink = (event, url) => {
      if (/^bytedance:/i.test(url)) event.preventDefault()
    }
    this.discoveryWindow.webContents.on('will-navigate', denyDeepLink)
    this.discoveryWindow.webContents.on('will-redirect', denyDeepLink)
    this.discoveryWindow.webContents.on('will-frame-navigate', (event, details) => denyDeepLink(event, details.url))
    this.discoveryWindow.webContents.setWindowOpenHandler(({ url }) => (/^bytedance:/i.test(url) ? { action: 'deny' } : { action: 'deny' }))
    return this.discoveryWindow
  }

  async openLogin() {
    const win = this.ensureWindow(true)
    if (!win.webContents.getURL().startsWith('https://www.douyin.com/')) await win.loadURL(CHAT_URL)
    win.focus()
    return { ok: true }
  }

  async logout() {
    await session.fromPartition(PARTITION).clearStorageData()
    if (this.window && !this.window.isDestroyed()) await this.window.loadURL(CHAT_URL)
    this.lastSeen.clear()
    this.lastSent.clear()
    this.lastSentAt.clear()
    this.emitEvent('status', await this.getStatus())
    return { ok: true }
  }

  async getStatus() {
    const cookies = await session.fromPartition(PARTITION).cookies.get({ url: 'https://www.douyin.com' })
    // Douyin has used several equivalent session cookie names over time.
    const connected = cookies.some(({ name }) => [
      'sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss',
      'passport_auth_status', 'passport_auth_status_ss',
    ].includes(name))
    return {
      connected,
      mode: 'local-browser',
      accountWindowOpen: Boolean(this.window && !this.window.isDestroyed()),
      message: connected ? 'Douyin login is saved' : 'Open the login window and scan the QR code',
    }
  }

  async waitForChatReady(timeout = 15000) {
    const win = this.ensureWindow(false)
    if (!win.webContents.getURL().startsWith('https://www.douyin.com/chat')) await win.loadURL(CHAT_URL)
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('[class*="conversationConversationListwrapper"], [class*="messageEditorimChatEditorContainer"]'))`).catch(() => false)
      if (ready) return win
      await sleep(700)
    }
    throw new Error('抖音聊天页面未加载完成，请在登录窗口确认已经登录并进入私信页')
  }

  async syncContacts() {
    const win = await this.waitForChatReady()
    const contacts = await win.webContents.executeJavaScript(`(() => {
      const wrapper = document.querySelector('[class*="conversationConversationListwrapper"]')
      if (!wrapper) return []
      const extractConversationPreview = ${extractConversationPreview.toString()}
      const CONVERSATION_TIME_RE = ${CONVERSATION_TIME_RE.toString()}
      const extractConversationTimeLabel = ${extractConversationTimeLabel.toString()}
      const extractStreakCount = ${extractStreakCount.toString()}
      const nodes = [...wrapper.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
      const seen = new Set()
      return nodes.map((node) => {
        const lines = (node.innerText || '').split(/\\n+/).map(v => v.trim()).filter(Boolean)
        const image = node.querySelector('img')
        const name = lines[0] || ''
        if (!name || name.length > 40 || seen.has(name)) return null
        seen.add(name)
        const previewNode = node.querySelector('[class*="ConversationItemHinttextBox"]')
        const timeNode = node.querySelector('[class*="time" i], [class*="date" i], [class*="ConversationItemtime" i]')
        const streakNode = node.querySelector('[class*="commonStreaknormalText"]')
        const streakText = streakNode?.innerText || streakNode?.textContent || ''
        let preview = extractConversationPreview(lines, previewNode?.innerText || previewNode?.textContent || '', streakText)
        const sentAtLabel = extractConversationTimeLabel(lines, timeNode?.innerText || timeNode?.textContent || '')
        const mediaHint = node.querySelector('video, [class*="video" i], [class*="player" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i]')
        if (mediaHint && !/(?:视频|图集|图片|动图|表情|分享|作品|播放|▶|⏵|媒体)/i.test(preview)) preview = '[媒体] ' + (preview || '复合消息')
        const fire = extractStreakCount(streakText, lines)
        const fromMe = lines.slice(1).some(l => /^你[：:]/.test(l.trim())) ? true : null
        const unreadNode = node.querySelector('[class*="unread" i], [data-e2e*="unread" i], [aria-label*="未读"]')
        const unread = (unreadNode?.innerText || unreadNode?.textContent || unreadNode?.getAttribute('aria-label') || '').trim()
        const messageKey = unread ? preview + '\u241f' + unread : preview
        return { id: name, name, avatar: image?.src || '', fire, preview, messageKey, fromMe, sentAtLabel }
      }).filter(Boolean)
    })()`)
    const savedContacts = this.storage.get().contacts || []
    const savedByName = new Map(savedContacts.map((contact) => [contact.name, contact]))
    const contactsWithTime = contacts.map((contact) => ({ ...contact, ...conversationTimeMeta(contact) }))
    const mergedContacts = contactsWithTime.map((contact) => ({
      ...(savedByName.get(contact.name) || {}),
      ...contact,
    }))
    this.emitEvent('contacts', { contacts: mergedContacts })
    return { ok: true, contacts: mergedContacts }
  }

  async selectConversation(name) {
    const win = await this.waitForChatReady()
    const point = await win.webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(name)}
      const wrapper = document.querySelector('[class*="conversationConversationListwrapper"]')
      if (!wrapper) return null
      const rows = [...wrapper.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
      const row = rows.find(node => ((node.innerText || '').split(/\\n+/)[0] || '').trim() === target)
        || rows.find(node => (node.innerText || '').includes(target))
      if (!row) return null
      const rect = row.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (!point) throw new Error(`没有在当前私信列表中找到联系人：${name}`)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
    const started = Date.now()
    let usedDomFallback = false
    while (Date.now() - started < 5000) {
      const selected = await win.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        return Boolean(editor && !document.querySelector('[class*="RightPanelEmpty"]'))
      })()`).catch(() => false)
      if (selected) return win
      if (!usedDomFallback && Date.now() - started >= 600) {
        usedDomFallback = true
        await win.webContents.executeJavaScript(`(() => {
          const target = ${JSON.stringify(name)}
          const rows = [...document.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
          const row = rows.find(node => ((node.innerText || '').split(/\\n+/)[0] || '').trim() === target)
          if (!row) return false
          row.click()
          return true
        })()`).catch(() => false)
      }
      await sleep(200)
    }
    throw new Error(`点击联系人后抖音没有打开右侧聊天面板：${name}`)
  }

  // Capture the complete latest incoming media bubble. Douyin share cards often
  // contain a poster image, text and nested video nodes, so selecting the last
  // <img> or <video> alone can capture an avatar or a sticker instead.
  async captureLatestIncomingMedia(name, recognitionOptions = {}) {
    const recognition = { ...videoRecognitionOptions(this.storage.get().settings || {}), ...(recognitionOptions || {}) }
    const maxFrames = Math.max(0, Math.min(9, Math.floor(Number(recognition.maxFrames ?? 3) || 0)))
    const shouldCaptureFrames = maxFrames > 0 && recognition.publicPageOnly !== true
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const media = await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-xusheng-media-capture]').forEach((node) => node.removeAttribute('data-xusheng-media-capture'))
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const selector = '[class*="MessageItem"], [class*="messageItem"], [data-e2e*="message-item"], [data-e2e*="messageItem"], [class*="sticker"], [class*="emoji"], [class*="imageMsg"], [class*="mediaMsg"], [class*="cardMsg"]'
      const all = [...document.querySelectorAll(selector)]
      const rows = all.filter((node) => !all.some((parent) => parent !== node && parent.contains(node)))
        .map((node) => {
          const rect = node.getBoundingClientRect()
          let signature = ''
          for (let parent = node, depth = 0; parent && depth < 6; parent = parent.parentElement, depth += 1) signature += ' ' + String(parent.className || '')
          const selfByClass = /MessageItemTextisFromMe|isFromMe|(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
          const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
          const mediaNode = node.querySelector('video, img, [style*="background-image"], [class*="video" i], [class*="image" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i]')
          if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return null
          const roleNode = mediaNode || node
          const mediaRect = roleNode.getBoundingClientRect()
          const center = mediaRect.left + mediaRect.width / 2
          const divider = editorRect ? editorRect.left + editorRect.width / 2 : innerWidth * 0.65
          const role = selfByClass ? 'me' : contactByClass ? 'contact' : center > divider ? 'me' : 'contact'
          const video = node.querySelector('video')
          const videoCandidate = video || node.querySelector('[class*="video" i], [class*="player" i], [class*="play" i]')
          const poster = video?.poster || node.querySelector('img')?.currentSrc || node.querySelector('img')?.src || ''
          const videoUrl = video?.currentSrc || video?.src || video?.querySelector('source')?.src || ''
          const shareUrl = (() => {
            const urlPattern = /(?:https?:\\/\\/v\\.douyin\\.com\\/[^\\s"'<>]+|https?:\\/\\/[^\\s"'<>]*douyin\\.com\\/(?:video|note|share)\\/[^\\s"'<>]+|\\/video\\/\\d+|\\/note\\/\\d+|\\/share\\/[^\\s"'<>]+)/i
            const values = []
            const collect = (item) => {
              const text = String(item || '')
              const match = text.match(urlPattern)
              if (match) values.push(match[0])
            }
            const nodes = [node, ...node.querySelectorAll('*')]
            for (const item of nodes) {
              for (const attr of ['href', 'src', 'data-href', 'data-url', 'data-share-url', 'data-video-url', 'data-item-url', 'data-link', 'aria-label', 'title']) {
                collect(item.getAttribute?.(attr))
              }
              collect(item.dataset ? Object.values(item.dataset).join(' ') : '')
            }
            collect(node.innerText)
            collect(node.outerHTML)
            for (const raw of values) {
              try { return new URL(raw, location.href).href } catch {}
            }
            return ''
          })()
          if (!mediaNode && !shareUrl) return null
          const shareTitle = String(node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
          const videoRect = video?.getBoundingClientRect()
          return { node, rect, role, top: rect.top, video, videoCandidate, poster, videoUrl, videoRect, shareUrl, shareTitle }
        }).filter((item) => item && item.role === 'contact').sort((left, right) => left.top - right.top)
      const selected = rows.at(-1)
      if (!selected) return null
      selected.node.scrollIntoView({ block: 'center', inline: 'nearest' })
      selected.node.setAttribute('data-xusheng-media-capture', 'latest')
      const rect = selected.node.getBoundingClientRect()
      const videoAfterScroll = selected.node.querySelector('video')
      const videoRectAfterScroll = videoAfterScroll?.getBoundingClientRect()
      return {
        isVideo: Boolean(videoAfterScroll || selected.videoCandidate),
        duration: videoAfterScroll && Number.isFinite(videoAfterScroll.duration) ? videoAfterScroll.duration : 0,
        videoUrl: /^https?:\\/\\//i.test(selected.videoUrl || '') ? selected.videoUrl : '',
        shareUrl: /^https?:\\/\\//i.test(selected.shareUrl || '') ? selected.shareUrl : '',
        shareTitle: selected.shareTitle || '',
        posterUrl: /^https?:\\/\\//i.test(selected.poster || '') ? selected.poster : '',
        videoRect: videoRectAfterScroll ? {
          x: Math.max(0, Math.floor(videoRectAfterScroll.x)),
          y: Math.max(0, Math.floor(videoRectAfterScroll.y)),
          width: Math.max(1, Math.ceil(Math.min(videoRectAfterScroll.right, innerWidth) - Math.max(0, videoRectAfterScroll.x))),
          height: Math.max(1, Math.ceil(Math.min(videoRectAfterScroll.bottom, innerHeight) - Math.max(0, videoRectAfterScroll.y))),
        } : null,
        rect: {
          x: Math.max(0, Math.floor(rect.x - 8)),
          y: Math.max(0, Math.floor(rect.y - 8)),
          width: Math.max(1, Math.ceil(Math.min(rect.right + 8, innerWidth) - Math.max(0, rect.x - 8))),
          height: Math.max(1, Math.ceil(Math.min(rect.bottom + 8, innerHeight) - Math.max(0, rect.y - 8))),
        },
      }
    })()`).catch(() => null)
    if (!media?.rect?.width || !media?.rect?.height) return normalizeCapturedMedia({ frames: [], mediaKind: 'media', confidence: 'none', reason: 'no_visible_media_bubble' })
    const frames = []
    const capture = async (rect = media.rect) => {
      const image = await win.webContents.capturePage(rect)
      if (image.isEmpty()) return
      const size = image.getSize()
      const imageMaxSize = Math.max(320, Math.min(1280, Math.floor(Number(recognition.imageMaxSize || 640) || 640)))
      const jpegQuality = Math.max(45, Math.min(90, Math.floor(Number(recognition.jpegQuality || 58) || 58)))
      const scale = Math.min(1, imageMaxSize / size.width, imageMaxSize / size.height)
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }) : image
      const frame = `data:image/jpeg;base64,${resized.toJPEG(jpegQuality).toString('base64')}`
      if (frame.length <= 420_000 && !frames.includes(frame)) frames.push(frame)
    }
    const seek = async (ratio) => win.webContents.executeJavaScript(`new Promise((resolve) => {
      const video = document.querySelector('[data-xusheng-media-capture="latest"] video')
      if (!video) return resolve(false)
      video.pause(); video.muted = true
      const seekNow = () => {
        if (!Number.isFinite(video.duration) || video.duration <= 0) return resolve(false)
        const done = () => { video.removeEventListener('seeked', done); resolve(true) }
        video.addEventListener('seeked', done, { once: true })
        setTimeout(done, 1500)
        video.currentTime = Math.max(0, Math.min(video.duration - 0.05, video.duration * ${Number(ratio)}))
      }
      const source = video.currentSrc || video.src || video.querySelector('source')?.src || ''
      if (video.readyState < 1 && /^https?:\\/\\//i.test(source)) {
        try { video.src = source; video.load() } catch {}
      } else {
        try { video.load() } catch {}
      }
      if (Number.isFinite(video.duration) && video.duration > 0 && video.readyState >= 1) return seekNow()
      const ready = () => { video.removeEventListener('loadedmetadata', ready); seekNow() }
      video.addEventListener('loadedmetadata', ready, { once: true })
      setTimeout(() => { video.removeEventListener('loadedmetadata', ready); seekNow() }, 2500)
    })`).catch(() => false)
    let decodedVideoFrames = 0
    if (!shouldCaptureFrames) {
      // Public-page modes intentionally avoid screenshots, posters and video frames.
    } else if (media.isVideo) {
      await capture(media.rect)
      const ratios = maxFrames > 1
        ? Array.from({ length: maxFrames - 1 }, (_, index) => (index + 1) / maxFrames)
        : []
      for (const ratio of ratios) {
        if (await seek(ratio)) {
          await capture(modelMediaRect(media.videoRect || media.rect))
          decodedVideoFrames += 1
        }
      }
    } else {
      await capture()
    }
    // A poster URL is often the cleanest key frame for a Douyin share card.
    // Keep the full video URL out of model payloads because standard
    // OpenAI-compatible chat endpoints do not accept video_url parts.
    if (shouldCaptureFrames && media.posterUrl && frames.length < maxFrames && !frames.includes(media.posterUrl)) frames.push(media.posterUrl)
    this.log(recognition.publicPageOnly === true ? 'video_public_context_attempted' : 'media_captured', recognition.publicPageOnly === true ? `已尝试读取 ${name} 的视频公开页文案和评论` : `Captured media from ${name}`, { name, frames: Math.min(frames.length, maxFrames), video: media.isVideo, videoAddressFound: Boolean(media.videoUrl), videoPageUrlFound: Boolean(media.shareUrl), posterFound: shouldCaptureFrames && Boolean(media.posterUrl), strength: recognition.strength || 'standard', publicPageOnly: recognition.publicPageOnly === true })
    const [audioMeta, commentMeta] = await Promise.all([
      recognition.audio === false || recognition.publicPageOnly === true ? Promise.resolve({}) : this.transcribeCapturedMediaAudio(media, name, win),
      this.readVideoCommentContext(media, name, recognition),
    ])
    const result = normalizeCapturedMedia({
      frames: frames.slice(0, maxFrames),
      maxFrames,
      frameDetail: recognition.frameDetail || '',
      mediaKind: media.isVideo ? 'video' : 'media',
      detectedVideo: media.isVideo,
      videoReady: media.isVideo && decodedVideoFrames > 0,
      decodedVideoFrames,
      videoAddressFound: Boolean(media.videoUrl),
      videoPageUrlFound: Boolean(media.shareUrl),
      posterFound: shouldCaptureFrames && Boolean(media.posterUrl),
      captureSource: 'message_bubble',
      confidence: shouldCaptureFrames ? (media.isVideo ? (decodedVideoFrames > 0 ? 'high' : frames.length ? 'low' : 'none') : (frames.length ? 'medium' : 'none')) : (commentMeta.videoComments?.length || commentMeta.videoPageDescription || commentMeta.videoPageTitle ? 'medium' : 'none'),
      reason: shouldCaptureFrames ? (media.isVideo && decodedVideoFrames <= 0 ? 'video_not_decoded' : '') : 'public_page_only',
      videoPageTitle: media.shareTitle || '',
      ...commentMeta,
      ...audioMeta,
    })
    return result
  }

  async captureLatestIncomingVideo(name) {
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const media = await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-xusheng-video-capture]').forEach((node) => node.removeAttribute('data-xusheng-video-capture'))
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const candidates = [...document.querySelectorAll('video, img, [style*="background-image"]')].map((node) => {
        const rect = node.getBoundingClientRect()
        let signature = ''
        let parent = node
        for (let depth = 0; parent && depth < 7; parent = parent.parentElement, depth += 1) signature += ' ' + String(parent.className || '')
        const looksLikeMedia = node.tagName === 'VIDEO' || /video|player|play|image|photo|picture|album|gallery|sticker|emoji|gif|share|card|content/i.test(signature) || /background-image/i.test(node.getAttribute('style') || '')
        const looksLikeAvatar = /avatar|userhead|headimage|profilephoto/i.test(signature)
        if (!looksLikeMedia || looksLikeAvatar || rect.width < 72 || rect.height < 48 || rect.bottom <= 0 || rect.top >= innerHeight) return null
        const selfByClass = /MessageItemTextisFromMe|(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : innerWidth * 0.65
        const fromMe = selfByClass || (!contactByClass && center > divider)
        if (fromMe) return null
        return { node, rect, isVideo: node.tagName === 'VIDEO', top: rect.top }
      }).filter(Boolean).sort((left, right) => left.top - right.top)
      const selected = candidates.at(-1)
      if (!selected) return null
      selected.node.setAttribute('data-xusheng-video-capture', 'latest')
      const rect = selected.rect
      return {
        isVideo: selected.isVideo,
        duration: selected.isVideo && Number.isFinite(selected.node.duration) ? selected.node.duration : 0,
        rect: {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(1, Math.ceil(Math.min(rect.right, innerWidth) - Math.max(0, rect.x))),
          height: Math.max(1, Math.ceil(Math.min(rect.bottom, innerHeight) - Math.max(0, rect.y))),
        },
      }
    })()`).catch(() => null)
    if (!media?.rect?.width || !media?.rect?.height) return []

    const frames = []
    const capture = async () => {
      const image = await win.webContents.capturePage(media.rect)
      if (image.isEmpty()) return
      const size = image.getSize()
      const scale = Math.min(1, 448 / size.width, 320 / size.height)
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }) : image
      const frame = `data:image/jpeg;base64,${resized.toJPEG(52).toString('base64')}`
      if (frame.length <= 180_000 && !frames.includes(frame)) frames.push(frame)
    }
    const seek = async (ratio) => win.webContents.executeJavaScript(`new Promise((resolve) => {
      const video = document.querySelector('[data-xusheng-video-capture="latest"]')
      if (!video || video.tagName !== 'VIDEO' || !Number.isFinite(video.duration) || video.duration <= 0) return resolve(false)
      video.pause(); video.muted = true
      const done = () => { video.removeEventListener('seeked', done); resolve(true) }
      video.addEventListener('seeked', done, { once: true })
      setTimeout(done, 1500)
      video.currentTime = Math.max(0, Math.min(video.duration - 0.05, video.duration * ${Number(ratio)}))
    })`).catch(() => false)

    if (media.isVideo && media.duration > 0) {
      for (const ratio of [0.08, 0.5, 0.88]) {
        await seek(ratio)
        await capture()
      }
    } else {
      await capture()
    }
    this.log('video_captured', `Captured video frames from ${name}`, { name, frames: frames.length })
    return frames.slice(0, 3)
  }

  async learnConversation(name) {
    if (!name) throw new Error('Select a contact')
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const visibleMessages = await win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const primary = [...document.querySelectorAll('[class*="MessageItemTextcontainer"]')]
      const candidates = primary.length ? primary : [...document.querySelectorAll('[class*="messageItem"], [data-e2e*="message-item"]')]
      const rows = candidates.filter((node, index) => {
        const rect = node.getBoundingClientRect()
        if (!rect.width || !rect.height) return false
        return !candidates.some((other, otherIndex) => otherIndex !== index && other.parentElement === node && other.getBoundingClientRect().height >= rect.height * 0.7)
      }).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      const messages = []
      for (const node of rows) {
        const raw = (node.innerText || '').split(/\\n+/).map((part) => part.trim()).filter(Boolean)
        const text = raw.filter((part) => !/^(已读|未读|\\d{1,2}:\\d{2}|昨天|今天)$/.test(part)).join(' ').replace(/\\s+/g, ' ').trim()
        if (!text || text.length > 500) continue
        let signature = ''
        for (let current = node, depth = 0; current && depth < 4; current = current.parentElement, depth += 1) signature += ' ' + String(current.className || '')
        const selfByClass = /MessageItemTextisFromMe/i.test(signature) || /(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const bubble = node.querySelector('[class*="content"], [class*="text"], [class*="bubble"]') || node
        const rect = bubble.getBoundingClientRect()
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : window.innerWidth * 0.65
        const role = selfByClass ? 'me' : contactByClass ? 'contact' : center > divider ? 'me' : 'contact'
        const last = messages[messages.length - 1]
        if (!last || last.role !== role || last.text !== text) messages.push({ role, text })
      }
      return messages.slice(-40)
    })()`).catch((error) => { throw new Error('Failed to read chat history: ' + error.message) })
    if (!visibleMessages.length) throw new Error('当前会话没有可学习的文字消息')

    const state = this.storage.get()
    const contacts = [...(state.contacts || [])]
    const index = contacts.findIndex((contact) => contact.name === name)
    const current = index >= 0 ? contacts[index] : { id: name, name }
    const messages = mergeMessageHistory(current.learning?.messages, visibleMessages)
    const learning = this.ai?.analyzeConversation
      ? this.ai.analyzeConversation(messages)
      : { messages, updatedAt: new Date().toISOString() }
    const updated = { ...current, learning }
    if (index >= 0) contacts[index] = updated
    else contacts.push(updated)
    this.storage.update({ contacts })
    this.emitEvent('contacts', { contacts })
    this.log('language_learned', `Updated chat style for ${name}`, { name, messages: messages.length })
    return { ok: true, contact: updated, learnedMessages: messages.length }
  }

  async captureVisibleMessages(win) {
    if (!win || win.isDestroyed?.()) return []
    return win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const primary = [...document.querySelectorAll('[class*="MessageItemTextcontainer"]')]
      const candidates = primary.length ? primary : [...document.querySelectorAll('[class*="messageItem"], [data-e2e*="message-item"]')]
      const rows = candidates.filter((node, index) => {
        const rect = node.getBoundingClientRect()
        if (!rect.width || !rect.height) return false
        return !candidates.some((other, otherIndex) => otherIndex !== index && other.parentElement === node && other.getBoundingClientRect().height >= rect.height * 0.7)
      }).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      const messages = []
      for (const node of rows) {
        const raw = (node.innerText || '').split(/\\n+/).map((part) => part.trim()).filter(Boolean)
        const text = raw.filter((part) => !/^(已读|未读|\\d{1,2}:\\d{2}|昨天|今天)$/.test(part)).join(' ').replace(/\\s+/g, ' ').trim()
        if (!text || text.length > 500) continue
        let signature = ''
        for (let current = node, depth = 0; current && depth < 4; current = current.parentElement, depth += 1) signature += ' ' + String(current.className || '')
        const selfByClass = /MessageItemTextisFromMe/i.test(signature) || /(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const bubble = node.querySelector('[class*="content"], [class*="text"], [class*="bubble"]') || node
        const rect = bubble.getBoundingClientRect()
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : window.innerWidth * 0.65
        const role = selfByClass ? 'me' : contactByClass ? 'contact' : center > divider ? 'me' : 'contact'
        const last = messages[messages.length - 1]
        if (!last || last.role !== role || last.text !== text) messages.push({ role, text })
      }
      return messages.slice(-20).map(m => ({ role: m.role, text: m.text }))
    })()`).catch(() => [])
  }

  recordConversationMessage(name, role, text, fallbackContact = {}) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    if (!name || !value || !this.storage?.update) return fallbackContact
    const state = this.storage.get()
    const contacts = [...(state.contacts || [])]
    const index = contacts.findIndex((contact) => contact.name === name)
    const current = index >= 0 ? contacts[index] : { ...fallbackContact, id: fallbackContact.id || name, name }
    const messages = mergeMessageHistory(current.learning?.messages, [{ role, text: value }])
    const learning = this.ai?.analyzeConversation
      ? this.ai.analyzeConversation(messages)
      : { messages, updatedAt: new Date().toISOString() }
    const updated = { ...current, learning }
    if (index >= 0) contacts[index] = updated
    else contacts.push(updated)
    this.storage.update({ contacts })
    this.emitEvent('contacts', { contacts })
    return updated
  }

  recordVideoShareEngagement(name, messageKey = '') {
    if (!name || !this.storage?.update) return null
    const state = this.storage.get()
    const contacts = [...(state.contacts || [])]
    const index = contacts.findIndex((contact) => contact.name === name)
    if (index < 0) return null
    const contact = contacts[index]
    const videoShare = contact.profile?.videoShare
    const currentState = videoShare?.videoShareState
    const lastShared = currentState?.lastShared
    if (!lastShared?.category || lastShared.engaged) return contact
    const sharedAt = new Date(lastShared.at || 0).getTime()
    if (!Number.isFinite(sharedAt) || Date.now() - sharedAt > VIDEO_SHARE_ENGAGEMENT_WINDOW_MS) return contact
    const categoryStats = { ...(currentState.categoryStats || {}) }
    const stat = categoryStats[lastShared.category] || {}
    const engagedAt = new Date().toISOString()
    categoryStats[lastShared.category] = {
      ...stat,
      sent: Number(stat.sent || 0),
      replied: Number(stat.replied || 0) + 1,
      lastRepliedAt: engagedAt,
    }
    const updated = {
      ...contact,
      profile: {
        ...(contact.profile || {}),
        videoShare: {
          ...videoShare,
          videoShareState: {
            ...currentState,
            categoryStats,
            lastShared: {
              ...lastShared,
              engaged: true,
              engagedAt,
              messageKey: String(messageKey || ''),
            },
          },
        },
      },
    }
    contacts[index] = updated
    this.storage.update({ contacts })
    this.emitEvent('contacts', { contacts })
    return updated
  }

  async waitForEditor(win, timeout = 8000) {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const editor = await win.webContents.executeJavaScript(`(() => {
        const node = document.querySelector('${EDITOR_SELECTOR}')
        return node ? { tag: node.tagName, disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'), placeholder: node.getAttribute('placeholder') || node.getAttribute('data-placeholder') || '' } : null
      })()`).catch(() => null)
      if (editor && !editor.disabled) return editor
      await sleep(400)
    }
    throw new Error('已找到联系人，但没有找到可用的私信输入框')
  }

  async sendCurrentInput(win) {
    const before = await win.webContents.executeJavaScript(`(() => ({
      text: (() => { const editor = document.querySelector('${EDITOR_SELECTOR}'); return editor ? ('value' in editor ? editor.value : editor.innerText) : '' })(),
    }))()`).catch((error) => { throw new Error(`发送前读取输入框失败：${error.message}`) })
    if (!normalizeEditorText(before.text)) throw new Error('Cannot send an empty message')
    const point = await win.webContents.executeJavaScript(FIND_SEND_TARGET_JS).catch((error) => { throw new Error(`点击发送按钮失败：${error.message}`) })
    if (!point) throw new Error('Could not find the send button')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
    // Douyin usually clears the editor quickly after a successful send. Poll so
    // fast sends return immediately while still allowing slow acknowledgements.
    const started = Date.now()
    let after = { text: before.text }
    while (Date.now() - started < 5000) {
      await sleep(250)
      after = await win.webContents.executeJavaScript(`(() => ({
        text: (() => { const editor = document.querySelector('${EDITOR_SELECTOR}'); return editor ? ('value' in editor ? editor.value : editor.innerText) : '' })(),
      }))()`).catch((error) => { throw new Error(`发送后读取输入框失败：${error.message}`) })
      if (!normalizeEditorText(after.text)) return
    }
    throw new Error(`Douyin did not confirm the message was sent; send point=(${point.x}, ${point.y})`)
  }

  async sendEmoji(name, emojiName = '\u65e9\u4e0a\u597d') {
    if (!name || !emojiName) throw new Error('联系人和表情名称不能为空')
    this.assertCanSend(name)
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const beforeCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.MessageItemEmojiimage').length`)
    const opened = await win.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('.messageMsgInputiconAction')
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (!opened) throw new Error('没有找到抖音表情按钮')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: opened.x, y: opened.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: opened.x, y: opened.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: opened.x, y: opened.y })
    await sleep(800)
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const items = [...document.querySelectorAll('.emojiEmojiItememojiItem')]
      const item = items.find((node) => (node.innerText || '').trim() === ${JSON.stringify(emojiName)})
      const target = item?.querySelector('.emojiEmojiItemimgBox')
      if (!target) return false
      target.click()
      return true
    })()`)
    if (!clicked) throw new Error(`没有找到“${emojiName}”表情包`)
    const started = Date.now()
    let sent = false
    while (Date.now() - started < 4000) {
      sent = await win.webContents.executeJavaScript(`(() => {
        const count = document.querySelectorAll('.MessageItemEmojiimage').length
        const panelClosed = !document.querySelector('.componentsemojiim-saas-modal')
        return panelClosed && count > ${Number(beforeCount)}
      })()`)
      if (sent) break
      await sleep(250)
    }
    if (!sent) throw new Error(`Douyin did not confirm emoji "${emojiName}" was sent`)
    this.rememberSelfPreview(name, `[${emojiName}]`)
    this.lastReplyTime.set(name, Date.now())
    this.recordSuccessfulSend(name, 'emoji')
    this.log('message_sent', `Sent emoji "${emojiName}" to ${name}`, { name, emoji: emojiName })
    return { ok: true, kind: 'emoji', emojiName }
  }

  async sendTask(name, task) {
    const effectiveTask = resolveSparkTask(task)
    if (isVideoShareTask(effectiveTask)) return this.sendVideoShareTask(name, effectiveTask)
    if (effectiveTask?.kind === 'emoji') return this.sendEmoji(name, effectiveTask.emojiName || '\u65e9\u4e0a\u597d')
    if (effectiveTask?.kind === 'combo') {
      await this.sendMessage(name, effectiveTask?.message || '', { source: 'spark_combo_text', allowedDrafts: sparkMessageOptions(effectiveTask) })
      const emoji = await this.sendEmoji(name, effectiveTask.emojiName || '\u65e9\u4e0a\u597d')
      return { ok: true, kind: 'combo', emojiName: emoji.emojiName, message: effectiveTask?.message || '' }
    }
    return this.sendMessage(name, effectiveTask?.message || '', { source: 'spark_text', allowedDrafts: sparkMessageOptions(effectiveTask) })
  }

  async startInquiry({ name, question }) {
    const target = String(name || '').trim()
    const wanted = String(question || '').trim()
    if (!target || !wanted) throw new Error('联系人和问题不能为空')
    if (!this.ai?.planInquiry) throw new Error('The configured model does not support inquiry planning')
    const state = this.storage.get()
    const contact = (state.contacts || []).find((item) => item.name === target) || { id: target, name: target }
    const planned = await this.ai.planInquiry({ contact, question: wanted })
    const text = String(planned?.labeledText || planned?.question || planned?.text || '').trim()
    if (!text) throw new Error('AI 没有生成可发送的问题')
    await this.sendMessage(target, text, { source: 'inquiry', ai: true, model: planned.model || '', provider: planned.provider || '', aiLabel: planned.aiLabel || '' })
    const latest = this.storage.get()
    const inquiries = [...(latest.automation?.inquiries || [])]
    const inquiry = { id: Date.now(), name: target, question: wanted, asked: text, createdAt: new Date().toISOString(), status: 'waiting', model: planned.model || '', provider: planned.provider || '' }
    inquiries.unshift(inquiry)
    this.storage.update({ automation: { ...latest.automation, inquiries: inquiries.slice(0, 100) } })
    this.emitEvent('inquiries', { inquiries: [inquiry, ...inquiries.slice(1)] })
    this.log('inquiry_sent', `已向 ${target} 发起话题代问`, { name: target, inquiryId: inquiry.id, model: inquiry.model, provider: inquiry.provider })
    return { ok: true, inquiry }
  }

  selectVideoShareItem(task) {
    const items = normalizeVideoShareItems(task)
    if (!items.length) throw new Error('视频分享任务没有可发送的视频链接')
    const used = new Set(Array.isArray(task?.videoShareState?.usedVideoKeys) ? task.videoShareState.usedVideoKeys : [])
    const fresh = items.filter((item) => !used.has(videoShareItemKey(item)))
    const pool = fresh.length ? fresh : items
    const selected = pool[Math.floor(Math.random() * pool.length)]
    return { ...selected, category: inferVideoShareCategory(selected, task) }
  }

  async discoverVideoShareItem(contact = {}, task = {}) {
    const terms = videoShareDiscoveryTerms(contact, task)
    const used = new Set(Array.isArray(task?.videoShareState?.usedVideoKeys) ? task.videoShareState.usedVideoKeys : [])
    const win = this.ensureDiscoveryWindow()
    for (const term of terms) {
      await win.loadURL(videoShareSearchUrl(term))
      await sleep(2500)
      const candidates = await win.webContents.executeJavaScript(`(() => {
        const normalize = (value, limit = 120) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit)
        const anchors = [...document.querySelectorAll('a[href]')]
        const rows = anchors.map((anchor) => {
          let url = ''
          try { url = new URL(anchor.getAttribute('href') || '', location.href).href } catch { return null }
          if (!/douyin\\.com\\/(?:video|note)\\//i.test(url) && !/\\/video\\/\\d+/i.test(url)) return null
          const card = anchor.closest('[data-e2e], li, section, article, div') || anchor
          const title = normalize(anchor.innerText || anchor.getAttribute('aria-label') || anchor.title || card.innerText || '', 90)
          const note = normalize(card.innerText || title, 160)
          const tags = [...card.querySelectorAll('[class*="tag"], [data-e2e*="tag"], a[href*="search"]')]
            .map((node) => normalize(node.innerText, 18))
            .filter(Boolean)
            .slice(0, 6)
          return { url: url.split(/[?#]/)[0], title, note, tags }
        }).filter(Boolean)
        const seen = new Set()
        return rows.filter((item) => {
          if (!item.url || seen.has(item.url)) return false
          seen.add(item.url)
          return true
        }).slice(0, 12)
      })()`).catch(() => [])
      const fresh = candidates.find((item) => !used.has(videoShareItemKey(item)))
      const selected = fresh || candidates[0]
      if (selected?.url) return { ...selected, searchTerm: term, category: videoShareTermCategory(term, task), source: 'douyin_search' }
    }
    throw new Error('没有在抖音搜索到合适的视频')
  }

  async resolveVideoShareItem(name, task, contact) {
    const items = normalizeVideoShareItems(task)
    const discoveryMode = String(task?.discoveryMode || 'auto')
    if (discoveryMode !== 'manual') {
      try {
        const discovered = await this.discoverVideoShareItem(contact, task)
        if (discovered?.url) return discovered
      } catch (error) {
        if (!items.length) throw error
        this.log('video_share_discovery_fallback', `${name} video discovery failed; using fallback links`, { name, error: error.message })
      }
    }
    if (items.length) return this.selectVideoShareItem(task)
    throw new Error('视频分享任务没有可发送的视频链接')
  }

  async clickPagePoint(win, point, fallbackMessage) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(fallbackMessage)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
  }

  async waitForPagePoint(win, script, fallbackMessage, timeout = 9000) {
    const started = Date.now()
    let lastError = ''
    while (Date.now() - started < timeout) {
      const result = await win.webContents.executeJavaScript(script).catch((error) => {
        lastError = error.message
        return null
      })
      if ((result && Number.isFinite(result.x) && Number.isFinite(result.y)) || result?.ok) return result
      if (result?.error) lastError = result.error
      await sleep(300)
    }
    throw new Error(lastError || fallbackMessage)
  }

  async sendNativeVideoShare(name, video, caption = '', metadata = {}) {
    const target = String(name || '').trim()
    const url = String(video?.url || '').trim()
    if (!target || !/^https?:\/\//i.test(url)) throw new Error('联系人和视频链接不能为空')
    this.assertCanSend(target)

    const win = this.ensureDiscoveryWindow()
    const shouldHideDiscoveryWindow = !win.isVisible()
    if (shouldHideDiscoveryWindow) win.showInactive()
    try {
    await win.loadURL(url)
    await sleep(3500)

    const shareButton = await this.waitForPagePoint(win, `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const visible = (node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const nodes = [...document.querySelectorAll('button, [role="button"], a, [aria-label], [title], [class*="share" i], [data-e2e*="share" i]')]
      const candidates = nodes.map((node) => {
        const text = normalize([node.innerText, node.getAttribute('aria-label'), node.getAttribute('title'), node.className, node.getAttribute('data-e2e')].join(' '))
        if (!visible(node) || !/(分享|转发|share)/i.test(text) || /(评论|收藏|点赞|搜索|复制|链接)/.test(text)) return null
        const clickTarget = node.closest('button, [role="button"], a') || node
        const rect = clickTarget.getBoundingClientRect()
        const score = (/分享/.test(text) ? 5 : 0) + (/share/i.test(text) ? 3 : 0) + (clickTarget.tagName === 'BUTTON' ? 2 : 0)
        return { node: clickTarget, rect, score }
      }).filter(Boolean).sort((left, right) => right.score - left.score)
      const selected = candidates[0]
      if (!selected) return null
      return { x: Math.round(selected.rect.left + selected.rect.width / 2), y: Math.round(selected.rect.top + selected.rect.height / 2) }
    })()`, 'Could not find the Douyin video share button')
    await this.clickPagePoint(win, shareButton, 'Could not find the Douyin video share button')
    await sleep(900)

    const friendTarget = await this.waitForPagePoint(win, `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const visible = (node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const nodes = [...document.querySelectorAll('button, [role="button"], a, div, span')]
      const candidates = nodes.map((node) => {
        const text = normalize([node.innerText, node.getAttribute('aria-label'), node.getAttribute('title')].join(' '))
        if (!visible(node) || !/(私信|朋友|好友|联系人|发给朋友|分享给朋友|发送给朋友|抖音好友)/.test(text) || /(复制|链接|微信|QQ|微博|下载|举报|保存|更多)/i.test(text)) return null
        const clickTarget = node.closest('button, [role="button"], a') || node
        const rect = clickTarget.getBoundingClientRect()
        const score = (/私信|发给朋友|发送给朋友/.test(text) ? 8 : 0) + (/朋友|好友/.test(text) ? 4 : 0)
        return { node: clickTarget, rect, score }
      }).filter(Boolean).sort((left, right) => right.score - left.score)
      const selected = candidates[0]
      if (!selected) return null
      return { x: Math.round(selected.rect.left + selected.rect.width / 2), y: Math.round(selected.rect.top + selected.rect.height / 2) }
    })()`, 'Could not find the share-to-friends entry')
    await this.clickPagePoint(win, friendTarget, 'Could not find the share-to-friends entry')
    await sleep(700)

    await win.webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(target)}
      const visible = (node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const fields = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
        .filter(visible)
        .map((node) => {
          const text = [node.getAttribute('placeholder'), node.getAttribute('aria-label'), node.getAttribute('data-placeholder'), node.className].join(' ')
          const score = /搜索|好友|联系人|朋友|收件人/.test(text) ? 10 : 1
          return { node, score }
        })
        .sort((left, right) => right.score - left.score)
      const field = fields[0]?.node
      if (!field) return false
      field.focus()
      if ('value' in field) {
        field.value = target
      } else {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(field)
        selection.removeAllRanges()
        selection.addRange(range)
        if (!document.execCommand('insertText', false, target)) field.textContent = target
      }
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: target }))
      field.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`).catch(() => false)
    await sleep(900)

    const contactPoint = await this.waitForPagePoint(win, `(() => {
      const target = ${JSON.stringify(target)}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const visible = (node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const nodes = [...document.querySelectorAll('button, [role="button"], li, label, div, span')]
      const candidates = nodes.map((node) => {
        const text = normalize([node.innerText, node.getAttribute('aria-label'), node.getAttribute('title')].join(' '))
        if (!visible(node) || !text.includes(target) || /(搜索|取消|发送|分享|已选择)/.test(text)) return null
        const clickTarget = node.closest('button, [role="button"], li, label') || node
        const rect = clickTarget.getBoundingClientRect()
        const score = text === target ? 10 : text.startsWith(target) ? 6 : 2
        return { node: clickTarget, rect, score }
      }).filter(Boolean).sort((left, right) => right.score - left.score)
      const selected = candidates[0]
      if (!selected) return null
      return { x: Math.round(selected.rect.left + selected.rect.width / 2), y: Math.round(selected.rect.top + selected.rect.height / 2) }
    })()`, `Could not find contact "${target}" in the share panel`)
    await this.clickPagePoint(win, contactPoint, `Could not find contact "${target}" in the share panel`)
    await sleep(700)

    if (String(caption || '').trim()) {
      await win.webContents.executeJavaScript(`(() => {
        const caption = ${JSON.stringify(String(caption || '').trim().slice(0, 120))}
        const visible = (node) => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        const fields = [...document.querySelectorAll('textarea, input, [contenteditable="true"]')]
          .filter(visible)
          .map((node) => {
            const text = [node.getAttribute('placeholder'), node.getAttribute('aria-label'), node.getAttribute('data-placeholder'), node.className].join(' ')
            const score = /留言|说点|附言|消息|comment/i.test(text) ? 10 : 0
            return { node, score }
          })
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score)
        const field = fields[0]?.node
        if (!field) return false
        field.focus()
        if ('value' in field) field.value = caption
        else {
          if (!document.execCommand('insertText', false, caption)) field.textContent = caption
        }
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: caption }))
        return true
      })()`).catch(() => false)
      await sleep(300)
    }


    const sendPoint = await this.waitForPagePoint(win, FIND_SEND_TARGET_JS, 'Could not find the video share send button')
    await this.clickPagePoint(win, sendPoint, 'Could not find the video share send button')
    await sleep(3000)

    const confirmed = await win.webContents.executeJavaScript(`(() => {
      const text = document.body?.innerText || ''
      if (/发送成功|已发送|分享成功/.test(text)) return true
      const editor = document.querySelector('${EDITOR_SELECTOR}')
      const current = editor ? ('value' in editor ? editor.value : editor.innerText) : ''
      if (!String(current || '').trim()) return true
      const openDialogs = [...document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="popover" i]')]
        .filter((node) => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none'
        })
        .map((node) => node.innerText || '')
      return !openDialogs.some((value) => /发送|分享|好友|朋友|私信/.test(value))
    })()`).catch(() => true)
    if (!confirmed) throw new Error(`Douyin did not confirm the video card was sent; send point=(${sendPoint.x}, ${sendPoint.y})`)

    const sentText = `[视频分享] ${video.title || video.note || video.url || ''}`.replace(/\s+/g, ' ').trim()
    this.rememberSelfPreview(target, sentText)
    this.lastSeen.set(target, sentText)
    this.lastReplyTime.set(target, Date.now())
    this.recordSuccessfulSend(target, 'videoShare')
    this.recordConversationMessage(target, 'me', sentText)
    this.log('message_sent', `Shared a video card with ${target}`, { name: target, url, source: metadata.source || 'video_share', ai: Boolean(metadata.ai), model: metadata.model || '', provider: metadata.provider || '', aiLabel: metadata.aiLabel || '' })
    return { ok: true, kind: 'videoShare', card: true }
    } finally {
      if (shouldHideDiscoveryWindow && !win.isDestroyed()) win.hide()
    }
  }

  async sendVideoShareTask(name, task) {
    if (!name) throw new Error('Contact name cannot be empty')
    const state = this.storage.get()
    const contact = (state.contacts || []).find((item) => item.name === name) || { name }
    const video = await this.resolveVideoShareItem(name, task, contact)
    let caption = fallbackVideoShareCaption(video)
    let aiMeta = { source: 'video_share' }
    if (this.ai?.draftVideoShare && this.ai?.hasProvider?.()) {
      try {
        const draft = await this.ai.draftVideoShare({ contact, video })
        if (draft?.ok && (draft.labeledText || draft.text)) {
          const showAiModelLabel = state.settings?.showAiModelLabel !== false
          caption = String(showAiModelLabel ? (draft.labeledText || draft.text) : draft.text).trim()
          aiMeta = { source: 'video_share', ai: true, model: draft.model || '', provider: draft.provider || '', aiLabel: draft.aiLabel || '' }
        }
      } catch (error) {
        this.log('video_share_caption_fallback', `${name} 的视频分享语生成失败，已改用保守文案`, { name, error: error.message, url: video.url })
      }
    }
    await this.sendNativeVideoShare(name, video, caption, aiMeta)
    return { ok: true, kind: 'videoShare', video, caption, message: caption, card: true }
  }

  async processVideoShareTask(sparks, index, task, now, blacklist, canSend) {
    const today = localDateKey(now)
    const previousState = freshVideoShareState(task.videoShareState, today)
    const maxPerDay = videoShareDailyLimit(task)
    let nextTask = { ...task, maxPerDay, videoShareState: previousState }
    if (!nextTask.enabled) return
    if (blacklist.has(nextTask.name)) return
    if (previousState.sentToday >= maxPerDay) {
      if (nextTask.lastRunDate !== today || nextTask.nextRunAt) {
        nextTask = { ...nextTask, lastRunDate: today, nextRunAt: '' }
        sparks[index] = nextTask
        this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
      }
      return
    }
    if (!nextTask.nextRunAt || localDateKey(nextTask.nextRunAt) !== today) {
      nextTask = { ...nextTask, nextRunAt: scheduleNextVideoShareAt(nextTask, now) }
      sparks[index] = nextTask
      this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
    }
    if (!nextTask.nextRunAt || new Date(nextTask.nextRunAt).getTime() > now.getTime()) return
    if (nextTask.lastAttemptAt && (Date.now() - Number(nextTask.lastAttemptAt)) < SPARK_RETRY_MS) return
    if (!canSend(nextTask.name)) return
    const attempted = { ...nextTask, lastAttemptAt: Date.now() }
    sparks[index] = attempted
    this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
    try {
      const result = await this.sendVideoShareTask(nextTask.name, attempted)
      const usedVideoKeys = [...(previousState.usedVideoKeys || []), videoShareItemKey(result.video)].slice(-200)
      const sentToday = previousState.sentToday + 1
      const stateAfterSend = videoShareStateAfterSend(previousState, result.video, attempted, now, today, sentToday, usedVideoKeys)
      const done = sentToday >= maxPerDay
      const updated = {
        ...attempted,
        videoShareState: stateAfterSend,
        lastRunDate: done ? today : attempted.lastRunDate,
        nextRunAt: done ? '' : scheduleNextVideoShareAt({ ...attempted, videoShareState: stateAfterSend }, now),
        lastAttemptAt: Date.now(),
      }
      sparks[index] = updated
      this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
      this.log('video_share_sent', `${nextTask.name} random video shared`, { name: nextTask.name, sentToday, maxPerDay, url: result.video.url })
    } catch (error) {
      this.log('video_share_failed', `${nextTask.name} 的随机视频分享发送失败，稍后重试`, { name: nextTask.name, error: error.message })
    }
  }

  async processContactVideoShareTasks(contacts, now, blacklist, canSend) {
    let changed = false
    const today = localDateKey(now)
    for (let index = 0; index < contacts.length; index += 1) {
      const contact = contacts[index]
      const config = contact?.profile?.videoShare || {}
      if (!config.enabled) continue
      if (blacklist.has(contact.name)) continue
      const task = {
        id: `contact-video-share:${contact.name}`,
        name: contact.name,
        kind: 'videoShare',
        enabled: true,
        time: config.windowStart || '12:00',
        windowStart: config.windowStart || '12:00',
        windowEnd: config.windowEnd || '22:30',
        maxPerDay: config.maxPerDay,
        discoveryMode: config.discoveryMode || 'auto',
        categories: normalizeVideoShareCategories(config.categories),
        discoveryQuery: config.discoveryQuery || '',
        keywords: config.keywords || '',
        topics: config.topics || '',
        videos: config.videos,
        videoList: config.videoList,
        message: config.videoList || '',
        nextRunAt: config.nextRunAt || '',
        lastAttemptAt: config.lastAttemptAt || 0,
        lastRunDate: config.lastRunDate || '',
        videoShareState: config.videoShareState,
      }
      const previousState = freshVideoShareState(task.videoShareState, today)
      const maxPerDay = videoShareDailyLimit(task)
      let nextConfig = { ...config, maxPerDay, videoShareState: previousState }
      const persist = (patch) => {
        nextConfig = { ...nextConfig, ...patch }
        contacts[index] = { ...contact, profile: { ...(contact.profile || {}), videoShare: nextConfig } }
        changed = true
      }
      if (previousState.sentToday >= maxPerDay) {
        if (task.lastRunDate !== today || task.nextRunAt) persist({ lastRunDate: today, nextRunAt: '' })
        continue
      }
      let nextRunAt = task.nextRunAt
      if (!nextRunAt || localDateKey(nextRunAt) !== today) {
        nextRunAt = scheduleNextVideoShareAt({ ...task, videoShareState: previousState }, now)
        persist({ nextRunAt })
      }
      if (!nextRunAt || new Date(nextRunAt).getTime() > now.getTime()) continue
      if (task.lastAttemptAt && (Date.now() - Number(task.lastAttemptAt)) < SPARK_RETRY_MS) continue
      if (!canSend(contact.name)) continue
      persist({ lastAttemptAt: Date.now() })
      try {
        const result = await this.sendVideoShareTask(contact.name, { ...task, videoShareState: previousState })
        const usedVideoKeys = [...(previousState.usedVideoKeys || []), videoShareItemKey(result.video)].slice(-200)
        const sentToday = previousState.sentToday + 1
        const stateAfterSend = videoShareStateAfterSend(previousState, result.video, { ...task, videoShareState: previousState }, now, today, sentToday, usedVideoKeys)
        const done = sentToday >= maxPerDay
        persist({
          videoShareState: stateAfterSend,
          lastRunDate: done ? today : task.lastRunDate,
          nextRunAt: done ? '' : scheduleNextVideoShareAt({ ...task, videoShareState: stateAfterSend }, now),
          lastAttemptAt: Date.now(),
        })
        this.log('video_share_sent', `${contact.name} random video shared`, { name: contact.name, sentToday, maxPerDay, url: result.video.url, source: 'contact' })
      } catch (error) {
        this.log('video_share_failed', `${contact.name} 的随机视频分享发送失败，稍后重试`, { name: contact.name, error: error.message, source: 'contact' })
      }
    }
    if (changed) {
      this.storage.update({ contacts })
      this.emitEvent('contacts', { contacts })
    }
  }

  async isLastMessageFromMe(name) {
    try {
      const win = await this.selectConversation(name)
      await this.waitForEditor(win)
      const role = await win.webContents.executeJavaScript(`(() => {
        const rowSelector = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
        const mediaSelector = ${JSON.stringify(CHAT_MESSAGE_MEDIA_SELECTOR)}
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        const editorRect = editor?.getBoundingClientRect()
        const seen = new Set()
        const candidates = [...document.querySelectorAll(rowSelector + ', ' + mediaSelector)]
          .map((node) => {
            const row = node.closest(rowSelector)
            if (!row || seen.has(row)) return null
            seen.add(row)
            const rect = row.getBoundingClientRect()
            if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return null
            let sig = ''
            for (let c = row, d = 0; c && d < 4; c = c.parentElement, d += 1) sig += ' ' + String(c.className || '')
            const me = /isFromMe|MessageItemTextisFromMe/i.test(sig) || /(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(sig)
            const them = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(sig)
            const bubble = row.querySelector('[class*="content"], [class*="text"], [class*="bubble"], video, img, [style*="background-image"], [class*="video" i], [class*="image" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i]') || row
            const bubbleRect = bubble.getBoundingClientRect()
            return {
              withinMessageRow: true,
              rect: {
                top: rect.top,
                left: bubbleRect.left,
                width: bubbleRect.width,
                height: bubbleRect.height,
              },
              me,
              them,
            }
          })
          .filter(Boolean)
        return (${pickLatestChatMessageRole.toString()})(candidates, {
          innerWidth: window.innerWidth,
          editorRect: editorRect ? { left: editorRect.left, width: editorRect.width } : null,
        })
      })()`).catch(() => null)
      return role === 'me' ? true : role === 'contact' ? false : null
    } catch (_) { return null }
  }

  async sendMessage(name, text, metadata = {}) {
    if (!name || !String(text).trim()) throw new Error('联系人和消息内容不能为空')
    this.assertCanSend(name)
    let value = String(text).trim()
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const editorState = await win.webContents.executeJavaScript(`(() => {
      const value = ${JSON.stringify(String(text).trim())}
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      if (!editor || editor.disabled || editor.getAttribute('aria-disabled') === 'true') return { ok: false }
      const current = 'value' in editor ? editor.value : editor.innerText
      const normalized = [...String(current || '')]
        .filter((character) => ![0x200B, 0x200C, 0x200D, 0xFEFF].includes(character.charCodeAt(0)))
        .join('').trim()
      if (normalized && normalized !== value) return { ok: false, occupied: true, current }
      if (normalized === value) return { ok: true, current }
      editor.focus()
      if ('value' in editor) {
        editor.value = value
      } else {
        const selection = window.getSelection()
        selection.removeAllRanges()
        const range = document.createRange()
        range.selectNodeContents(editor)
        selection.addRange(range)
        if (!document.execCommand('insertText', false, value)) editor.textContent = value
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      const updated = 'value' in editor ? editor.value : editor.innerText
      const normalizedUpdated = [...String(updated || '')]
        .filter((character) => ![0x200B, 0x200C, 0x200D, 0xFEFF].includes(character.charCodeAt(0)))
        .join('').trim()
      return { ok: normalizedUpdated === value, current: updated }
    })()`).catch((error) => { throw new Error(`写入私信输入框失败：${error.message}`) })
    let acceptedExistingDraft = false
    if (editorState?.occupied) {
      const allowedDrafts = Array.isArray(metadata.allowedDrafts) ? metadata.allowedDrafts : []
      const currentDraft = normalizeEditorText(editorState.current)
      const allowed = [value, ...allowedDrafts].map(normalizeEditorText).filter(Boolean)
      if (!allowed.includes(currentDraft)) throw new Error('The message editor already contains unsent text')
      value = currentDraft
      acceptedExistingDraft = true
    }
    if (!editorState?.ok && !acceptedExistingDraft) {
      const focused = await win.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        if (!editor || editor.disabled || editor.getAttribute('aria-disabled') === 'true') return false
        editor.focus()
        if ('select' in editor) editor.select()
        else {
          const selection = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(editor)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        return true
      })()`).catch(() => false)
      if (focused) {
        await win.webContents.insertText(value)
        await sleep(150)
      }
      const inserted = await win.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        const current = editor ? ('value' in editor ? editor.value : editor.innerText) : ''
        return [...String(current || '')].filter(character => ![0x200B, 0x200C, 0x200D, 0xFEFF].includes(character.charCodeAt(0))).join('').trim() === ${JSON.stringify(value)}
      })()`).catch(() => false)
      if (!inserted) throw new Error('私信内容没有成功写入输入框，抖音页面结构可能已经更新')
    }
    try {
      await this.sendCurrentInput(win)
    } catch (error) {
      await win.webContents.executeJavaScript(`(() => {
        const expected = ${JSON.stringify(value)}
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"]')
        const current = [...String(editor?.innerText || '')]
          .filter((character) => ![0x200B, 0x200C, 0x200D, 0xFEFF].includes(character.charCodeAt(0)))
          .join('').trim()
        if (!editor || current !== expected) return false
        editor.focus()
        document.execCommand('selectAll', false, null)
        document.execCommand('delete', false, null)
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
        return true
      })()`).catch(() => false)
      throw error
    }
    const normalized = value.replace(/\s+/g, ' ').trim()
    this.rememberSelfPreview(name, normalized)
    this.lastSeen.set(name, normalized)
    this.lastReplyTime.set(name, Date.now())
    this.recordSuccessfulSend(name, 'text')
    this.recordConversationMessage(name, 'me', normalized)
    this.log('message_sent', `Sent a message to ${name}`, { name, text: normalized, source: metadata.source || 'manual', ai: Boolean(metadata.ai), model: metadata.model || '', provider: metadata.provider || '', aiLabel: metadata.aiLabel || '' })
    return { ok: true }
  }

  updateAutomation(config) {
    const current = this.storage.get()
    this.storage.update({ automation: { ...current.automation, ...config } })
    this.startWorker()
    return { ok: true }
  }

  getSendAllowance(_name, now = Date.now()) {
    const state = this.storage.get()
    const config = state.automation || {}
    const dailyLimit = Math.max(1, Math.floor(Number(config.dailyLimit ?? 30) || 30))
    const today = localDateKey(now)
    const history = Array.isArray(state.sendHistory) ? state.sendHistory : []
    const sentToday = history.filter((entry) => entry.at && localDateKey(entry.at) === today).length
    if (sentToday >= dailyLimit) {
      return { ok: false, reason: `今天已发送 ${sentToday} 条，达到每日上限 ${dailyLimit} 条`, sentToday, dailyLimit }
    }

    return { ok: true, sentToday, dailyLimit }
  }

  hasSentConversationToday(name, now = Date.now()) {
    const target = String(name || '').trim()
    if (!target) return false
    const today = localDateKey(now)
    return (this.storage.get().sendHistory || []).some((entry) => (
      String(entry?.name || '').trim() === target && entry?.at && localDateKey(entry.at) === today
    ))
  }

  assertCanSend(name) {
    const allowance = this.getSendAllowance(name)
    if (!allowance.ok) throw new Error(allowance.reason)
    return allowance
  }

  recordSuccessfulSend(name, kind) {
    const now = new Date()
    const cutoff = now.getTime() - (8 * 24 * 60 * 60 * 1000)
    const state = this.storage.get()
    const sendHistory = [...(state.sendHistory || []), { at: now.toISOString(), name, kind }]
      .filter((entry) => new Date(entry.at).getTime() >= cutoff)
      .slice(-1000)
    this.storage.update({ sendHistory })
  }

  startWorker() {
    if (this.pollTimer) return
    const scheduleNext = () => {
      const refreshSeconds = Number(this.storage.get().settings?.refreshInterval || 5)
      const delay = Math.max(5000, Math.min(300000, refreshSeconds * 1000))
      this.pollTimer = setTimeout(async () => {
        try { await this.runAutomation() } catch (error) { this.log('worker_error', error.message) }
        if (this.pollTimer) scheduleNext()
      }, delay || AUTOMATION_POLL_MS)
    }
    scheduleNext()
  }

  async runAutomation() {
    if (this.polling) return
    const state = this.storage.get()
    const config = state.automation || {}
    const settings = state.settings || {}
    const draftOnly = settings.aiReplyDraftOnly === true
    if (settings.quietHours) {
      const toMinutes = (value) => {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
        return match ? Number(match[1]) * 60 + Number(match[2]) : 0
      }
      const now = new Date()
      const current = now.getHours() * 60 + now.getMinutes()
      const start = toMinutes(settings.quietStart || '23:00')
      const end = toMinutes(settings.quietEnd || '07:00')
      const muted = start === end || (start < end ? current >= start && current < end : current >= start || current < end)
      if (muted) return
    }
    const hasContactVideoShares = (state.contacts || []).some((contact) => contact?.profile?.videoShare?.enabled)
    const hasPendingInquiries = (config.inquiries || []).some((item) => item?.status === 'waiting')
    const hasWork = Boolean((config.autoReply && !config.paused) || (config.sparks || []).some((task) => task.enabled) || hasContactVideoShares || hasPendingInquiries)
    if (!hasWork) return
    const status = await this.getStatus()
    if (!status.connected) return
    if (!this.window || this.window.isDestroyed()) this.ensureWindow(false)
    this.polling = true
    try {
      const { contacts } = await this.syncContacts()
      const today = localDateKey()
      const blacklist = new Set((config.blacklist || []).map((name) => String(name).trim()).filter(Boolean))
      const aiDisabledContacts = new Set((config.aiDisabledContacts || []).map((name) => String(name).trim()).filter(Boolean))
      const canSend = (name) => !blacklist.has(name) && this.getSendAllowance(name).ok
      for (const contact of contacts) {
        const currentMessageKey = contactMessageKey(contact)
        const previous = this.lastSeen.get(contact.name)
        const hasPrevious = this.lastSeen.has(contact.name)
        if (!contact.preview) {
          this.lastSeen.set(contact.name, currentMessageKey)
          continue
        }
        const pendingInquiry = (config.inquiries || []).find((item) => item?.name === contact.name && item?.status === 'waiting')
        // Paused/disabled automation must not consume the incoming preview;
        // it should remain eligible when the user resumes automation.
        if ((!config.autoReply || config.paused) && !pendingInquiry) continue
        const blocked = blacklist.has(contact.name) || aiDisabledContacts.has(contact.name)
        if (blocked && !pendingInquiry) {
          const reason = blacklist.has(contact.name) ? 'blacklist' : 'ai_disabled'
          const noticeKey = `${reason}:${contact.name}:${contact.preview}`
          this.blockedContacts.add(contact.name)
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('auto_blocked', `Auto reply disabled for ${contact.name}`, { name: contact.name, reason, preview: contact.preview })
          }
          continue
        }
        const reenabled = pendingInquiry ? false : this.blockedContacts.delete(contact.name)
        // Establish a baseline on the first sync so old conversations are not
        // answered unexpectedly after a fresh install or logout.
        if (!hasPrevious && !reenabled) {
          this.lastSeen.set(contact.name, currentMessageKey)
          continue
        }
        if (previous === currentMessageKey && !reenabled) continue
        if (!pendingInquiry && !draftOnly && !canSend(contact.name)) {
          const noticeKey = `${contact.name}:${localDateKey()}`
          if (!this.lastLimitNotice.has(noticeKey)) {
            this.lastLimitNotice.set(noticeKey, Date.now())
            this.log('send_blocked', `已达到每日发送上限，暂不回复 ${contact.name}`, { name: contact.name })
          }
          // Keep lastSeen unchanged so the message is retried after the limit
          // resets instead of being silently discarded.
          continue
        }
        const bracketedPreview = /^\[[^\]\r\n]{1,40}\]$/.test(String(contact.preview || '').trim())
        const lastSelfAt = Number(this.lastSentAt.get(contact.name) || 0)
        const recentSelfPreview = bracketedPreview
          && this.lastSent.get(contact.name) === String(contact.preview || '').replace(/\s+/g, ' ').trim()
          && Date.now() - lastSelfAt < 90_000
        if (recentSelfPreview) {
          this.log('auto_skip', `${contact.name} 是刚刚自己发的表情，跳过`, { name: contact.name, preview: contact.preview })
          this.lastSeen.set(contact.name, currentMessageKey)
          continue
        }
        // A positive list marker is useful, but its absence is not proof that
        // the latest message came from the contact. Verify in the chat view.
        const fromMe = contact.fromMe === true ? true : bracketedPreview ? false : await this.isLastMessageFromMe(contact.name)
        if (fromMe === true) {
          this.log('auto_skip', `${contact.name} 是自己发的，跳过`)
          this.lastSeen.set(contact.name, currentMessageKey)
          continue
        }
        this.recordVideoShareEngagement(contact.name, currentMessageKey)
        const learnedContact = this.recordConversationMessage(contact.name, 'contact', contact.preview, contact)
        if (pendingInquiry) {
          try {
            const summary = await this.ai.summarizeInquiry({ contact: learnedContact, question: pendingInquiry.question, asked: pendingInquiry.asked, answer: contact.preview })
            const latest = this.storage.get()
            const inquiries = [...(latest.automation?.inquiries || [])]
            const index = inquiries.findIndex((item) => item.id === pendingInquiry.id)
            if (index >= 0) inquiries[index] = { ...inquiries[index], status: 'answered', answer: contact.preview, report: summary.report || summary.text || '', answeredAt: new Date().toISOString(), summaryModel: summary.model || '' }
            this.storage.update({ automation: { ...latest.automation, inquiries } })
            this.emitEvent('inquiries', { inquiries })
            this.log('inquiry_answered', `${contact.name} inquiry answered`, { name: contact.name, inquiryId: pendingInquiry.id, report: summary.report || summary.text || '' })
            this.lastSeen.set(contact.name, currentMessageKey)
            continue
          } catch (error) {
            this.log('inquiry_failed', `${contact.name} 的话题代问摘要失败，稍后重试`, { name: contact.name, inquiryId: pendingInquiry.id, error: error.message })
            if (previous === undefined) this.lastSeen.delete(contact.name)
            else this.lastSeen.set(contact.name, previous)
            continue
          }
        }
        const rule = (config.rules || []).find((item) => item.enabled !== false && (item.keywords || []).some((keyword) => contact.preview.includes(keyword)))
        let replyText = rule?.replyText || ''
        let aiAttempted = false
        let aiDraft = null
        if (!replyText && this.ai?.hasProvider?.()) {
          aiAttempted = true
          try {
            // 进入聊天面板抓取完整消息以增强上下文理解
            let enhancedContact = learnedContact
            try {
              const chatWin = await this.selectConversation(contact.name)
              if (chatWin) {
                const visibleMessages = await this.captureVisibleMessages(chatWin)
                if (visibleMessages.length > 0) {
                  const mergedMessages = mergeMessageHistory(learnedContact.learning?.messages, visibleMessages)
                  const enhancedLearning = this.ai.analyzeConversation(mergedMessages)
                  enhancedContact = { ...learnedContact, learning: enhancedLearning }
                }
              }
            } catch (_) { /* 抓取完整消息失败，回退到预览文本 */ }

            let mediaCapture = normalizeCapturedMedia([])
            const mediaKind = mediaPreviewKind(contact.preview)
            const isMedia = Boolean(mediaKind)
            if (isMedia) {
              if (settings.videoReplyEnabled === false || settings.videoRecognitionEnabled === false) {
                this.log('media_skipped', `${contact.name} media skipped because video replies are disabled`, { name: contact.name, mediaKind, reason: 'video_reply_disabled' })
                this.lastSeen.set(contact.name, currentMessageKey)
                continue
              }
              try {
                const recognition = videoRecognitionOptions(settings)
                mediaCapture = normalizeCapturedMedia(await this.captureLatestIncomingMedia(contact.name, recognition), mediaKind)
                // Keep the original node-level capture as a fallback for older
                // page layouts where the message wrapper is not discoverable.
                if (shouldUseVideoFrameFallback(recognition, mediaCapture) && this.captureLatestIncomingVideo) {
                  mediaCapture = normalizeCapturedMedia(await this.captureLatestIncomingVideo(contact.name), mediaKind)
                }
              } catch (_) {}
            }
            if (isMedia) {
              const providers = this.storage.get().providers || []
              const hasAudioTranscript = Boolean(mediaCapture.audioTranscript)
              const hasPublicContext = hasPublicMediaContext(mediaCapture)
              const caps = providers.length ? providers.some(p => (p.capabilities || []).includes('vision')) : Boolean(this.ai?.hasProvider?.())
              if (!caps && !hasAudioTranscript && !hasPublicContext) {
                this.log('media_skipped', `${contact.name} media skipped because the model lacks vision`, { name: contact.name, mediaKind })
                this.lastSeen.set(contact.name, currentMessageKey)
                continue
              }
              const requiresDecodedVideo = mediaKind === 'video' || mediaCapture.detectedVideo === true
              if (!mediaCapture.frames.length && !hasAudioTranscript && !hasPublicContext) {
                this.log(requiresDecodedVideo ? 'video_unreadable' : 'media_uncertain', `${contact.name} media frames could not be captured`, { name: contact.name, mediaKind, mediaCapture })
                this.lastSeen.set(contact.name, currentMessageKey)
                continue
              }
              if (requiresDecodedVideo && mediaCapture.videoReady !== true && !hasAudioTranscript && !hasPublicContext) {
                if (settings.videoLowConfidenceReply === false) {
                  this.log('video_unreadable', `${contact.name} video frames were low confidence and conservative replies are disabled`, { name: contact.name, mediaKind, mediaCapture, reason: 'low_confidence_disabled' })
                  this.lastSeen.set(contact.name, currentMessageKey)
                  continue
                }
                mediaCapture = { ...mediaCapture, mediaKind: 'video', confidence: 'low', reason: mediaCapture.reason || 'video_not_decoded' }
                this.log('video_low_confidence', `${contact.name} video frames are limited; using a conservative AI reply`, { name: contact.name, mediaKind, mediaCapture })
              }
            }
            aiDraft = await this.ai.draft({ contact: enhancedContact, incoming: contact.preview, incomingMeta: conversationTimeMeta(contact), videoFrames: isMedia ? mediaCapture : undefined })
            if (aiDraft?.ok && (aiDraft.labeledText || aiDraft.text)) {
              const model = aiDraft.model || this.storage.get().providers?.[0]?.model || '当前模型'
              const label = aiDraft.aiLabel || `AI · ${model}`
              const showAiModelLabel = this.storage.get().settings?.showAiModelLabel !== false
              const generated = String(showAiModelLabel ? (aiDraft.labeledText || aiDraft.text) : aiDraft.text).trim()
              replyText = showAiModelLabel && !generated.startsWith(`【${label}】`) ? `【${label}】${generated}` : generated
            }
          } catch (error) {
            this.log('ai_error', `为 ${contact.name} 调用 AI 失败`, { name: contact.name, error: error.message })
            if (previous === undefined) this.lastSeen.delete(contact.name)
            else this.lastSeen.set(contact.name, previous)
            continue
          }
        }
        if (replyText) {
          if (draftOnly && aiAttempted) {
            this.lastSeen.set(contact.name, currentMessageKey)
            this.log('reply_drafted', `AI draft prepared for ${contact.name}`, {
              name: contact.name,
              text: replyText,
              incoming: contact.preview,
              model: aiDraft?.model || this.storage.get().providers?.[0]?.model || '当前模型',
              provider: aiDraft?.provider || this.storage.get().providers?.[0]?.name || '',
            })
            continue
          }
          try {
            const aiMeta = aiAttempted ? { ai: true, source: 'ai', model: aiDraft?.model || this.storage.get().providers?.[0]?.model || '', provider: aiDraft?.provider || this.storage.get().providers?.[0]?.name || '', aiLabel: aiDraft?.aiLabel || `AI · ${aiDraft?.model || this.storage.get().providers?.[0]?.model || '当前模型'}` } : { source: 'rule' }
            await this.sendMessage(contact.name, replyText, aiMeta)
            this.lastSeen.set(contact.name, currentMessageKey)
          } catch (error) {
            if (previous === undefined) this.lastSeen.delete(contact.name)
            else this.lastSeen.set(contact.name, previous)
            this.log('send_error', `auto reply send failed for ${contact.name}`, { name: contact.name, error: error.message })
          }
          // sendMessage 内部已设 lastSeen，不要覆盖
        } else if (aiAttempted) {
          if (previous === undefined) this.lastSeen.delete(contact.name)
          else this.lastSeen.set(contact.name, previous)
          const noticeKey = `ai_empty:${contact.name}:${currentMessageKey}`
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('ai_empty', `AI 未返回有效回复，保留 ${contact.name} 的消息待重试`, { name: contact.name })
          }
        } else {
          if (previous === undefined) this.lastSeen.delete(contact.name)
          else this.lastSeen.set(contact.name, previous)
          const noticeKey = `ai_unavailable:${contact.name}:${currentMessageKey}`
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('ai_unavailable', `No model is configured; keeping ${contact.name}'s message for retry`, { name: contact.name })
          }
        }
      }
      // 持久化 lastSeen 到 storage
      const seenArr = [...this.lastSeen].map(([n, p]) => ({ name: n, preview: p, at: Date.now() }))
      if (this.storage?.update) this.storage.update({ lastSeenPairs: seenArr })

      const now = new Date()
      const minutesNow = now.getHours() * 60 + now.getMinutes()
      const sparks = [...(config.sparks || [])]
      for (let index = 0; index < sparks.length; index += 1) {
        const task = sparks[index]
        if (isVideoShareTask(task)) {
          await this.processVideoShareTask(sparks, index, task, now, blacklist, canSend)
          continue
        }
        const due = timeToMinutes(task.time) <= minutesNow
        const retryReady = !task.lastAttemptAt || (Date.now() - Number(task.lastAttemptAt)) >= SPARK_RETRY_MS
        // Automatically fill missed sparks later the same day after a retryable failure.
        if (!task.enabled || !due || task.lastRunDate === today || !retryReady) continue
        if (this.hasSentConversationToday(task.name)) {
          sparks[index] = { ...task, lastRunDate: today, lastAttemptAt: Date.now() }
          this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
          this.log('spark_fill_skipped', `${task.name} 今天已有发送记录，本次无需补续`, { name: task.name, reason: 'sent_today' })
          continue
        }
        if (!canSend(task.name)) continue
        const attempted = { ...task, lastAttemptAt: Date.now() }
        sparks[index] = attempted
        this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
        try {
          await this.sendTask(task.name, task)
          sparks[index] = { ...attempted, lastRunDate: today, lastAttemptAt: Date.now() }
          this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
          this.log('spark_sent', `${task.name} spark task completed`, { name: task.name, autoFill: true })
        } catch (error) {
          this.log('spark_fill_failed', `${task.name} spark retry failed; will retry later`, { name: task.name, error: error.message })
        }
      }
      await this.processContactVideoShareTasks([...(this.storage.get().contacts || [])], now, blacklist, canSend)
    } finally {
      this.polling = false
    }
  }

  log(type, message, detail = {}) {
    const entry = { id: Date.now(), at: new Date().toISOString(), type, message, detail }
    this.storage.addLog(entry)
    this.emitEvent('log', entry)
  }

  emitEvent(type, payload) {
    this.emit?.({ type, payload })
  }

  destroy() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    if (this.window && !this.window.isDestroyed()) {
      this.window.__forceClose = true
      this.window.destroy()
    }
    if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) this.discoveryWindow.destroy()
  }
}

module.exports = { AUTOMATION_POLL_MS, DouyinService, VIDEO_SHARE_CATEGORIES, conversationTimeMeta, dailySparkMessage, extractConversationPreview, extractConversationTimeLabel, extractStreakCount, fallbackVideoShareCaption, hasPublicMediaContext, isVideoPreview, mediaPreviewKind, mergeMessageHistory, modelMediaRect, normalizeCapturedMedia, normalizeCommentContext, normalizeVideoRecognitionStrength, normalizeVideoShareCategories, normalizeVideoShareItems, pickLatestChatMessageRole, resolveConversationSentAt, resolveSparkTask, scheduleNextVideoShareAt, shouldUseVideoFrameFallback, videoRecognitionOptions, videoShareDailyLimit, videoShareDiscoveryTerms }
