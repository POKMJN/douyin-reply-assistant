const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { BrowserWindow, session } = require('electron')
const { analyzeLanguageStyle, daysSinceContact, factText, fetchWeatherContext, fetchHotTopicsCached, hotTopicForSparkCached } = require('./ai-service.cjs')
const { shouldAutoReply, dailyMessageKey } = require('./conversation-engine.cjs')

const CHAT_URL = 'https://www.douyin.com/chat?isPopup=1'
const PARTITION = 'persist:douyin-account'
const AUTOMATION_POLL_MS = 1000
// 联系人资料里的回复频率选项 → 两次发送的最小间隔秒数（instant 不限）
const REPLY_FREQUENCY_SECONDS = { instant: 0, '30s': 30, '60s': 60, '300s': 300, '3600s': 3600 }
const SPARK_RETRY_MS = 5 * 60 * 1000

// 风控软化：按空闲时长计算下一轮轮询延迟（1×/2×/3× + ±20% 抖动，钳制在 5s–300s）
function computePollDelay(baseMs, idleMs = 0, random = Math.random) {
  const factor = idleMs < 5 * 60_000 ? 1 : (idleMs < 30 * 60_000 ? 2 : 3)
  const jitter = 0.8 + random() * 0.4
  return Math.max(5000, Math.min(300_000, Math.round(baseMs * factor * jitter)))
}

// 风控软化：真人不会秒回。按回复长度生成 1.5–12 秒的随机“打字时间”
function humanReplyDelay(text = '', random = Math.random) {
  const length = String(text || '').length
  return Math.min(12_000, Math.round(1500 + length * 55 + random() * 2500))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const normalizeEditorText = (text) => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
function extractPublicCommentItemText(value) {
  const lines = String(value || '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (lines.length < 2) return ''

  const startsAfterMenu = lines[1] === '...' || lines[1] === '\u2026'
  const start = startsAfterMenu ? 2 : 1
  const timeLine = /^(?:\u521a\u521a|\d+\s*(?:\u79d2(?:\u949f)?|\u5206\u949f|\u5c0f\u65f6|\u5929|\u5468|\u4e2a\u6708|\u6708|\u5e74)\u524d|\u6628\u5929|\u524d\u5929|\d{1,2}[-/.]\d{1,2}|(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s*[\u00b7\u2022]\s*.*)?$/
  const end = lines.findIndex((line, index) => index >= start && timeLine.test(line))
  const actionLine = /^(?:\d+(?:\.\d+)?[\u4e07wW]?|\u5206\u4eab|\u56de\u590d|\u5c55\u5f00\s*\d+\s*\u6761\u56de\u590d|\u6536\u8d77\u56de\u590d)$/
  return lines
    .slice(start, end >= 0 ? end : lines.length)
    .filter((line) => !actionLine.test(line))
    .join(' ')
    .trim()
}

function extractReactAwemeId(root) {
  if (!root) return ''
  const validId = (value) => /^\d{17,20}$/.test(String(value || '')) ? String(value) : ''
  const fromProps = (props) => {
    const candidates = [
      props?.message?.parsedContent,
      props?.parsedContent,
      props?.message?.content,
      props?.item,
      props?.aweme,
      props,
    ]
    for (const value of candidates) {
      if (!value || typeof value !== 'object') continue
      for (const key of ['itemId', 'item_id', 'awemeId', 'aweme_id', 'groupId', 'group_id']) {
        const id = validId(value[key])
        if (id) return id
      }
      const sharedId = String(value.share_id || value.shareId || '').split('_').at(-1)
      const id = validId(sharedId)
      if (id) return id
    }
    return ''
  }
  const descendants = typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll('*')] : []
  for (const node of [root, ...descendants].slice(0, 160)) {
    for (const key of Object.keys(node || {})) {
      if (key.startsWith('__reactProps')) {
        const id = fromProps(node[key])
        if (id) return id
      }
      if (!key.startsWith('__reactFiber')) continue
      for (let fiber = node[key], depth = 0; fiber && depth < 20; fiber = fiber.return, depth += 1) {
        const id = fromProps(fiber.memoizedProps) || fromProps(fiber.pendingProps)
        if (id) return id
      }
    }
  }
  return ''
}
const MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024
const AUDIO_TRANSCRIPTION_SECONDS = 90
const CHAT_MESSAGE_ROW_SELECTOR = '[class*="MessageBoxContentrowBox"], [class*="messageMessageBoxcontentBox"], [class*="MessageBoxContentcolumnBox"], [data-e2e*="message-item"], [data-e2e*="messageItem"]'
const CHAT_MESSAGE_MEDIA_SELECTOR = '[class*="sticker"], [class*="emoji"], [class*="imageMsg"], [class*="mediaMsg"], [class*="cardMsg"], [class*="ShareAweme" i]'

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
      ? session.fromPartition(this.partition)
      : session?.defaultSession
    const cookies = await cookieSession?.cookies?.get?.({ url })
    if (Array.isArray(cookies) && cookies.length) {
      headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }
  } catch (_) {}
  return headers
}

const normalizeVideoRecognitionMode = (value) => {
  const key = String(value || 'smart').toLowerCase()
  return ['smart', 'comments', 'lite'].includes(key) ? key : 'smart'
}

const videoRecognitionOptions = (settings = {}) => {
  const mode = normalizeVideoRecognitionMode(settings.videoRecognitionMode || settings.videoRecognitionStrength)
  // 三种模式（对应 UI「视频识别模式」）：
  // smart   智能识别：画面 + 音频 + 文案 + 评论，先理解再回复、多候选择优、低置信度保守回复
  // comments 文案 + 评论：只读公开页文案和评论，不碰画面音频，无需视觉模型，快且省
  // lite    轻量省流：只抓 1 帧 + 文案，无音频评论，最快最省
  const presets = {
    smart: { mode, maxFrames: 3, audio: true, commentLimit: 3, commentWaitMs: 3000, commentScrolls: 1, publicPageOnly: false },
    comments: { mode, maxFrames: 0, audio: false, commentLimit: 50, commentWaitMs: 6000, commentScrolls: 8, publicPageOnly: true },
    lite: { mode, maxFrames: 1, audio: false, commentLimit: 0, commentWaitMs: 0, commentScrolls: 0, publicPageOnly: false },
  }
  return presets[mode] || presets.smart
}

const normalizeCommentContext = (value = {}, limit = 5) => {
  const source = value && typeof value === 'object' ? value : {}
  const comments = (Array.isArray(source.comments) ? source.comments : Array.isArray(source.videoComments) ? source.videoComments : [])
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 2)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, Math.max(0, Math.min(50, Math.floor(Number(limit) || 0))))
  return {
    videoPageTitle: String(source.title || source.videoPageTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    videoPageAuthor: String(source.author || source.videoPageAuthor || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    videoPageDescription: String(source.description || source.videoPageDescription || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    videoSharedComment: String(source.sharedComment || source.videoSharedComment || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    videoComments: comments,
    videoCommentSource: String(source.source || source.videoCommentSource || ''),
    videoCommentError: String(source.error || source.videoCommentError || ''),
  }
}

const visibleMediaJunk = /^(?:分享|来自(?:视频|图文|图片|作品)|播放|评论|写评论|发表评论|点赞|收藏|转发|打开抖音|点击查看|展开|收起|查看更多|全部评论|暂无评论|广告|举报)$/i

function normalizeVisibleMediaContext(value = {}, limit = 5) {
  const raw = typeof value === 'string'
    ? value
    : String(value?.visibleText || value?.shareText || value?.shareTitle || value?.text || '')
  const maxComments = Math.max(0, Math.min(50, Math.floor(Number(limit) || 0)))
  const lines = raw
    .split(/[\r\n]+/)
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 2)
    .filter((line, index, list) => list.indexOf(line) === index)
  const compact = lines.join(' ')
  const comments = []
  let description = ''
  let afterCommentHeader = false
  let afterVideoLabel = false

  const pushComment = (line) => {
    const text = String(line || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length < 2 || visibleMediaJunk.test(text)) return
    if (/^(?:分享\s*@?.{0,48}\s*的评论|来自视频)$/i.test(text)) return
    if (!comments.some((item) => item === text || item.includes(text) || text.includes(item))) comments.push(text.slice(0, 180))
  }

  for (const line of lines) {
    if (/分享\s*@?.{0,48}\s*的评论/i.test(line) || /分享\s*\[?\s*评论\s*\]?/i.test(line)) {
      afterCommentHeader = true
      afterVideoLabel = false
      continue
    }
    if (/来自(?:视频|图文|图片|作品)/i.test(line)) {
      const inlineDescription = line.replace(/^.*?来自(?:视频|图文|图片|作品)\s*[:：]?\s*/i, '').trim()
      if (inlineDescription && inlineDescription !== line && !visibleMediaJunk.test(inlineDescription)) description = inlineDescription.slice(0, 500)
      afterVideoLabel = true
      afterCommentHeader = false
      continue
    }
    if (afterVideoLabel && !description && !visibleMediaJunk.test(line)) {
      description = line.slice(0, 500)
      continue
    }
    if (afterCommentHeader) pushComment(line)
  }

  if (!comments.length) {
    const match = compact.match(/分享\s*@?.{1,48}?\s*的评论\s+(.{2,180}?)(?:\s+来自视频\s+(.{2,500}))?$/i)
    if (match) {
      pushComment(match[1])
      if (!description && match[2]) description = match[2].replace(/\s+/g, ' ').trim().slice(0, 500)
    }
  }

  return {
    videoPageTitle: '',
    videoPageDescription: description,
    videoSharedComment: comments[0] || '',
    videoComments: comments.slice(0, maxComments),
    videoCommentSource: comments.length || description ? 'visible_card' : '',
  }
}

function mergePublicMediaContext(publicContext = {}, visibleText = '', limit = 5) {
  const publicMeta = normalizeCommentContext(publicContext, limit)
  const visibleMeta = normalizeVisibleMediaContext(visibleText, limit)
  const maxComments = Math.max(0, Math.min(50, Math.floor(Number(limit) || 0)))
  const sharedComment = visibleMeta.videoSharedComment || publicMeta.videoSharedComment || ''
  const mergedComments = [...new Set([
    sharedComment,
    ...publicMeta.videoComments,
    ...visibleMeta.videoComments,
  ].map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter((item) => item.length >= 2))].slice(0, maxComments)
  const author = publicMeta.videoPageAuthor
  const rawTitle = publicMeta.videoPageTitle
  const titleWithoutPlatform = rawTitle
    .replace(/\s*[-|｜·]\s*(?:抖音|Douyin).*$/i, '')
    .trim()
  const normalizedAuthor = author.replace(/^@/, '').replace(/\s+/g, '').trim()
  const normalizedTitle = titleWithoutPlatform.replace(/^@/, '').replace(/\s+/g, '').trim()
  const visibleLines = String(visibleText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const visibleAuthorOnly = visibleLines.length === 1
    && visibleLines[0].length <= 60
    && !/(?:分享|评论|来自视频|来自图文|#)/.test(visibleLines[0])
    ? visibleLines[0].replace(/^@/, '').replace(/\s+/g, '').trim()
    : ''
  const sourceOnlyTitle = !titleWithoutPlatform
    || /^(?:抖音|Douyin)(?:\s*[-|｜·].*)?$/i.test(titleWithoutPlatform)
    || /^.{1,48}(?:的作品|的主页|的抖音)$/i.test(titleWithoutPlatform)
    || (normalizedAuthor && normalizedTitle === normalizedAuthor)
    || (visibleAuthorOnly && normalizedTitle.toLowerCase() === visibleAuthorOnly.toLowerCase())
  const publicTitle = sourceOnlyTitle ? '' : titleWithoutPlatform

  return {
    videoPageTitle: publicTitle || visibleMeta.videoPageTitle || '',
    videoPageAuthor: author,
    videoPageDescription: publicMeta.videoPageDescription || visibleMeta.videoPageDescription || '',
    videoSharedComment: sharedComment,
    videoComments: mergedComments,
    videoCommentSource: publicMeta.videoCommentSource || visibleMeta.videoCommentSource || '',
    videoCommentError: publicMeta.videoCommentError || '',
    videoPageUrlFound: Boolean(publicContext?.videoPageUrlFound),
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
const normalizeHistoryMessage = (item) => ({
  role: item?.role === 'me' ? 'me' : 'contact',
  text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
})

const MEDIA_MESSAGE_FINGERPRINT_SEPARATOR = '\u241e'
const contactMessageKey = (contact) => String(contact?.messageKey || contact?.preview || '')
const normalizeMessageFingerprintText = (value) => String(value || '')
  .replace(/(?:刚刚|昨天|今天|星期[一二三四五六日天]|\d+(?:分钟|小时|天)前|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 1200)
const normalizeMessageFingerprintUrl = (value) => {
  const text = String(value || '').trim()
  if (!text || /^(?:blob:|data:)/i.test(text)) return ''
  try {
    const parsed = new URL(text, 'https://www.douyin.com')
    return decodeURIComponent(parsed.pathname).replace(/\/+$/, '')
  } catch (_) {
    return text.split(/[?#]/, 1)[0]
  }
}
function stableMessageFingerprint({ ids = [], urls = [], text = '', role = '', fallbackOrdinal = 0 } = {}) {
  const stableIds = [...new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || '').trim()).filter(Boolean))].sort()
  const stableUrls = [...new Set((Array.isArray(urls) ? urls : []).map(normalizeMessageFingerprintUrl).filter(Boolean))].sort()
  const stableText = normalizeMessageFingerprintText(text)
  const stableParts = [String(role || ''), ...stableIds.map((value) => `id:${value}`), ...stableUrls.map((value) => `url:${value}`), `text:${stableText}`]
  if (!stableIds.length && !stableUrls.length) stableParts.push(`ordinal:${Math.max(0, Number(fallbackOrdinal) || 0)}`)
  const signature = stableParts.join('\u241f')
  return signature.replace(/[\u241f:]/g, '').trim() ? `msg-${createHash('sha256').update(signature).digest('hex').slice(0, 20)}` : ''
}
const mediaMessageKey = (contact, fingerprint) => {
  const preview = String(contact?.preview || '').trim()
  const identity = String(fingerprint || '').trim()
  return identity ? `${preview}${MEDIA_MESSAGE_FINGERPRINT_SEPARATOR}${identity}` : contactMessageKey(contact)
}
const isMediaMessageKey = (value, preview) => String(value || '').startsWith(`${String(preview || '').trim()}${MEDIA_MESSAGE_FINGERPRINT_SEPARATOR}`)

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
  if (/(?:\[?媒体\]?|媒体卡片|分享\s*@|来自视频|分享\s*\[?\s*评论\s*\]?|分享(?:了)?评论)/i.test(text)) return 'share'
  if (/(?:\[?图集\]?|分享\[图集\]|相册)/i.test(text)) return 'album'
  if (/(?:\[?图片\]?|照片|photo|image)/i.test(text)) return 'image'
  if (/(?:\[?动图\]?|GIF)/i.test(text)) return 'gif'
  if (/(?:\[?表情\]?|表情包|emoji)/i.test(text)) return 'sticker'
  if (/(?:分享(?:了)?(?:链接|商品|直播|音乐|作品)|\[分享\])/i.test(text)) return 'share'
  return ''
}

// 竞态保护判定（AI 回复吞掉对方第二条消息的根因）：
// 对方在 AI 处理上一条消息期间又发来新消息时，聊天面板最后一条可能是 AI 刚发出的回复，
// "最后一条是我发的"会误判为无需回复，并把这条新消息的 key 消费掉，导致它永远不被处理。
// 判定：当前预览像"对方发来的媒体"（我自己只发文字/表情，不会是视频/图片/分享卡片），
// 且不等于我最近一次发出的内容 → 视为疑似新消息，暂不消费 key，留待下轮重新确认。
const INCOMING_MEDIA_KINDS = ['video', 'album', 'image', 'gif', 'share']
const shouldDeferConsumptionOnFromMe = (preview, myLastSentText) => {
  const previewText = String(preview || '').replace(/\s+/g, ' ').trim()
  if (!previewText) return false
  if (previewText === String(myLastSentText || '').replace(/\s+/g, ' ').trim()) return false
  // 「分享[商品]/分享[音乐]」等带方括号的分享预览不走 mediaPreviewKind（历史上按文本回复），
  // 但它们同样是"对方发来的卡片"，在竞态保护里也应暂不消费
  if (/^分享\[|^\[分享/.test(previewText)) return true
  return INCOMING_MEDIA_KINDS.includes(mediaPreviewKind(previewText))
}
const pureMediaPreviewPattern = /^(?:\[?\s*(?:视频|媒体|图集|图片|照片|动图|表情|GIF)\s*\]?|分享\s*@?[^\s，,。；;：:]{1,48}\s*的(?:作品|视频|评论)|分享\s*\[?\s*(?:视频|媒体|图集|图片|评论)\s*\]?|分享(?:了)?(?:视频|作品|评论|链接|商品|直播|音乐)|发来一个视频|发来了一段|视频卡片|媒体卡片|来自视频|播放|作品|[▶⏵]|\d{1,3}["秒]?)$/i
const mediaMarkerPattern = /(?:\[?\s*(?:视频|媒体|图集|图片|照片|动图|表情|GIF)\s*\]?|分享\s*@?[^\s，,。；;：:]{1,48}\s*的(?:作品|视频|评论)|分享\s*\[?\s*(?:视频|媒体|图集|图片|评论)\s*\]?|分享(?:了)?(?:视频|作品|评论|链接|商品|直播|音乐)|发来一个视频|发来了一段|视频卡片|媒体卡片|来自视频|播放|作品|看这个|你看看|[▶⏵]|\d{1,3}["秒]?)/ig
const hasReplyablePreviewText = (value) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text || pureMediaPreviewPattern.test(text)) return false
  const remainder = text.replace(mediaMarkerPattern, '').replace(/\s+/g, '').trim()
  return remainder.length > 0
}

const unavailableMediaReplyPattern = /(?:没|未|无法|不能).{0,8}(?:加载|显示|弹出|读取|看见|看到)|(?:看|读|加载|显示).{0,4}不到|(?:没|没有).{0,6}(?:内容|东西|画面)|(?:截|发)(?:个|张)?图|截图(?:发|给|看)/i
const isUnavailableMediaReply = (value) => unavailableMediaReplyPattern.test(String(value || '').replace(/\s+/g, ' ').trim())

const normalizeCapturedMedia = (value, hintedKind = '') => {
  const source = value && typeof value === 'object' ? value : {}
  const frames = (Array.isArray(value) ? value : Array.isArray(source.frames) ? source.frames : [])
    .map((frame) => String(frame || '').trim())
    .filter((frame) => /^data:image\/(?:jpeg|png|webp);base64,/i.test(frame) || /^https?:\/\//i.test(frame))
    .slice(0, 3)
  const mediaKind = String(source.mediaKind || hintedKind || (source.detectedVideo ? 'video' : frames.length ? 'media' : '') || '')
  const decodedVideoFrames = Math.max(0, Math.floor(Number(source.decodedVideoFrames || 0) || 0))
  const detectedVideo = Boolean(source.detectedVideo || mediaKind === 'video')
  const videoReady = source.videoReady === true || decodedVideoFrames > 0
  const confidence = String(source.confidence || (
    !frames.length ? 'none' : detectedVideo ? (videoReady ? 'high' : 'low') : mediaKind === 'share' ? 'medium' : 'medium'
  ))
  const commentContext = normalizeCommentContext(source, source.videoComments?.length || 0)
  return {
    frames,
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

const hasPublicMediaContext = (media = {}) => Boolean(
  String(media.videoPageTitle || '').trim()
    || String(media.videoPageDescription || '').trim()
    || (Array.isArray(media.videoComments) && media.videoComments.length)
)

const shouldUseVideoFrameFallback = (recognition = {}, mediaCapture = {}) => (
  !mediaCapture.frames?.length
  && (recognition.publicPageOnly !== true || !hasPublicMediaContext(mediaCapture))
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
  const labelled = (Array.isArray(lines) ? lines : []).find((value) => /火花|连续\s*\d+\s*天|^\d+\s*天/.test(String(value)))
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
  constructor({ storage, emit, ai, partition }) {
    this.storage = storage
    this.emit = emit
    this.ai = ai
    this.partition = partition || PARTITION
    this.window = null
    this.discoveryWindow = null
    this.pollTimer = null
    this.polling = false
    this.lastSeen = new Map()
    this.lastLimitNotice = new Map()
    this.lastSkipNotice = new Map()
    this.blockedContacts = new Set()
    this.aiBackoff = new Map()
    this.verificationActive = false
    this.lastActivityAt = Date.now() // 最近一次会话有新消息的时间，用于空闲自适应降频
    this._capturedVideoUrl = null
    this._videoDetailIds = new Set()
    this._detailListenerAttached = false
    const savedSeen = (this.storage?.get().lastSeenPairs || []).filter(p => Date.now() - p.at < 86400000)
    savedSeen.forEach(p => this.lastSeen.set(p.name, p.preview))
    const savedPairs = (this.storage?.get().lastSentPairs || []).filter(p => Date.now() - p.at < 86400000)
    this.lastSent = new Map(savedPairs.map(p => [p.name, p.text]))
    this.lastReplyTime = new Map()
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

  async readVideoCommentContext(media, name, options = {}, sourceWindow = null) {
    const limit = Math.max(0, Math.min(50, Math.floor(Number(options.commentLimit || 0) || 0)))
    if (!limit) return {}
    const hasShareUrl = Boolean(media?.shareUrl)
    const win = hasShareUrl ? this.ensureDiscoveryWindow() : sourceWindow
    if (!win) return {}
    try {
      if (hasShareUrl) {
        await win.loadURL(media.shareUrl)
      } else {
        const pageState = await win.webContents.executeJavaScript(`(() => {
          const href = String(location.href || '')
          const body = String(document.body?.innerText || '')
          const isPublicVideo = /douyin\\.com\\/(?:video|note)\\//i.test(href)
            || /(?:全部评论|发布评论|展开\\s*\\d+\\s*条回复)/i.test(body)
          return { href, isPublicVideo }
        })()`).catch(() => ({ isPublicVideo: false }))
        if (!pageState?.isPublicVideo) return {}
      }
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
      const scrolls = Math.max(1, Math.min(8, Math.floor(Number(options.commentScrolls || 1) || 1)))
      for (let index = 0; index < scrolls; index += 1) {
        await sleep(Math.max(450, Math.floor(Number(options.commentWaitMs || 3000) / Math.max(2, scrolls + 1))))
        await win.webContents.executeJavaScript(`(() => {
          try {
            const scrollers = [...document.querySelectorAll('[class*="comment" i], [data-e2e*="comment" i], [role="dialog"], main, body')]
              .filter((node) => node && node.scrollHeight > node.clientHeight + 50)
              .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))
            const target = scrollers[0] || document.scrollingElement || document.documentElement
            target.scrollBy(0, Math.max(320, innerHeight * 0.65))
          } catch {}
          return true
        })()`).catch(() => false)
      }
      await sleep(Math.max(500, Math.floor(Number(options.commentWaitMs || 3000) / 4)))
      const context = await win.webContents.executeJavaScript(`(async () => {
        const limit = ${JSON.stringify(limit)}
        const normalize = (value, max = 500) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max)
        const extractPublicCommentItemText = ${extractPublicCommentItemText.toString()}
        const meta = (selector, max = 500) => normalize(document.querySelector(selector)?.content || document.querySelector(selector)?.getAttribute('content') || '', max)
        const title = normalize(meta('meta[property="og:title"]') || meta('meta[name="title"]') || document.title, 120)
        const description = normalize(
          meta('meta[property="og:description"]', 500)
            || meta('meta[name="description"]', 500)
            || document.querySelector('[data-e2e*="desc"], [class*="desc" i], [class*="caption" i], [class*="title" i]')?.innerText,
          500
        )
        const author = normalize(document.querySelector('[data-e2e="video-author-name"], [data-e2e*="author-name"], [class*="authorName" i], [class*="author-name" i]')?.innerText || '', 60)
        const bad = /^(?:发表评论|写评论|输入评论|登录|扫码|打开抖音|点击查看|分享|收藏|点赞|展开|收起|回复|查看更多|全部评论|暂无评论|相关搜索|搜索|广告|举报)$/i
        const textOf = (node) => normalize([
          node.innerText,
          node.getAttribute('aria-label'),
          node.getAttribute('title'),
        ].find(Boolean) || '', 180)
        const comments = []
        const commentItems = [...document.querySelectorAll('[data-e2e="comment-item"]')]
        for (const node of commentItems) {
          const text = normalize(extractPublicCommentItemText(node.innerText), 180)
          if (text.length < 3 || text.length > 180) continue
          if (bad.test(text)) continue
          if (title && (text === title || title.includes(text))) continue
          if (description && description.includes(text) && text.length < 12) continue
          if (/^\\d+$/.test(text) || /^[\\d.万wW]+$/.test(text)) continue
          if (comments.some((item) => item === text || item.includes(text) || text.includes(item))) continue
          comments.push(text)
          if (comments.length >= limit) break
        }
        if (!comments.length) {
          const fallbackSelectors = [
            '[data-e2e*="comment-content"]',
            '[data-e2e*="comment-text"]',
            '[class*="comment-content" i]',
            '[class*="comment-text" i]',
          ]
          const nodes = [...new Set(fallbackSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
          for (const node of nodes) {
            const text = textOf(node)
            if (text.length < 3 || text.length > 180 || bad.test(text)) continue
            if (title && (text === title || title.includes(text))) continue
            if (description && description.includes(text) && text.length < 12) continue
            if (/^\\d+$/.test(text) || /^[\\d.万wW]+$/.test(text)) continue
            if (comments.some((item) => item === text || item.includes(text) || text.includes(item))) continue
            comments.push(text)
            if (comments.length >= limit) break
          }
        }
        const apiComments = []
        const commentUrls = [...new Set(performance.getEntriesByType('resource')
          .map((entry) => String(entry.name || ''))
          .filter((url) => /aweme\\/v1\\/web\\/comment\\/list\\//i.test(url)))]
        for (const url of commentUrls.slice(-Math.max(2, Math.ceil(limit / 5) + 2))) {
          try {
            const response = await fetch(url, { credentials: 'include' })
            if (!response.ok) continue
            const payload = await response.json()
            for (const item of (Array.isArray(payload?.comments) ? payload.comments : [])) {
              const text = normalize(item?.text || item?.comment_text || item?.content || '', 180)
              if (text.length >= 2 && !apiComments.includes(text)) apiComments.push(text)
              if (apiComments.length >= limit) break
            }
          } catch {}
          if (apiComments.length >= limit) break
        }
        return { title, description, author, apiComments, comments, source: location.href }
      })()`).catch((error) => ({ error: error.message }))
      const normalized = normalizeCommentContext({
        ...context,
        comments: Array.isArray(context?.apiComments) && context.apiComments.length
          ? context.apiComments
          : context?.comments,
      }, limit)
      if (normalized.videoComments.length || normalized.videoPageTitle || normalized.videoPageDescription) {
        this.log('video_comments_captured', `已读取 ${name} 的视频公开页评论`, {
          name,
          comments: normalized.videoComments.length,
          titleFound: Boolean(normalized.videoPageTitle),
        })
      }
      return { ...normalized, videoPageUrlFound: Boolean(hasShareUrl || context?.source || sourceWindow) }
    } catch (error) {
      this.log('video_comments_unavailable', `${name} 视频评论未读取`, { name, error: error.message })
      return { videoCommentError: error.message || 'video_comments_unavailable', videoPageUrlFound: hasShareUrl }
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
      title: '抖音账号登录 · 自动回复',
      autoHideMenuBar: true,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    // Douyin pages sometimes advertise a Windows-only `bytedance:` deep link.
    // It is not needed for web automation and Windows otherwise shows a Store dialog.
    // Video/note pages must never replace the chat page in the main window:
    // opening them there strands the automation on a page with no editor/send
    // button. Discovery work is delegated to the hidden discovery window instead.
    const isVideoDetailUrl = (url) => /^https?:\/\/[^/]*douyin\.com\/(?:video|note)\//i.test(String(url || ''))
    this._capturedVideoUrl = null
    const captureVideoUrl = (url) => {
      if (isVideoDetailUrl(url)) {
        this._capturedVideoUrl = url
        return true
      }
      return false
    }
    this.window.webContents.on('will-navigate', (event, url) => {
      if (/^bytedance:/i.test(url) || captureVideoUrl(url)) event.preventDefault()
    })
    this.window.webContents.on('will-redirect', (event, url) => {
      if (/^bytedance:/i.test(url) || captureVideoUrl(url)) event.preventDefault()
    })
    this.window.webContents.on('will-frame-navigate', (event, details) => {
      if (/^bytedance:/i.test(details.url) || captureVideoUrl(details.url)) event.preventDefault()
    })
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^bytedance:/i.test(url) || captureVideoUrl(url)) return { action: 'deny' }
      return { action: 'allow' }
    })
    // 抖音网页版聊天点击分享卡片后，视频详情通过 XHR 拉取（不导航、也不挂
    // window 全局变量）。监听详情 API 响应，从 URL 或响应体里提取 aweme_id，
    // 用于拼公开页地址交给独立 discovery 窗口抓取。
    this._videoDetailIds = new Set()
    const captureDetailId = (url) => {
      const id = String(url || '').match(/aweme_id[=/\-](\d{10,20})|aweme\/v1\/web\/aweme\/detail\/(\d{10,20})|video\/(\d{10,20})|note\/(\d{10,20})/i)
      if (id) {
        const found = id[1] || id[2] || id[3] || id[4]
        if (found) {
          this._videoDetailIds.add(found)
          if (this._videoDetailIds.size > 80) {
            const firstKey = this._videoDetailIds.values().next().value
            if (firstKey) this._videoDetailIds.delete(firstKey)
          }
          if (!this._capturedVideoUrl) this._capturedVideoUrl = 'https://www.douyin.com/video/' + found
          return found
        }
      }
      return ''
    }
    const attachDetailListener = () => {
      const session = this.window.webContents.session
      if (this._detailListenerAttached) return
      this._detailListenerAttached = true
      session.webRequest.onBeforeRequest({ urls: ['*://*.douyin.com/*', '*://*.amemv.com/*', '*://*.douyinpic.com/*'] }, (details, callback) => {
        if (/aweme\/v1\/web\/aweme\/detail|aweme\/v1\/web\/comment|aweme\/detail/i.test(details.url)) {
          captureDetailId(details.url)
        }
        callback({})
      })
    }
    attachDetailListener()
    this.window.on('closed', () => { this._detailListenerAttached = false })
    // 抖音聊天消息通过 WebSocket 长连接推送，必须在页面加载时注入 hook，
    // 否则会话切换后已建立的连接抓不到消息帧。
    this.window.webContents.on('did-finish-load', () => {
      this.injectMessageCaptureHook(this.window)
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

  // 在抖音页面上下文里 hook WebSocket / fetch / XHR，捕获聊天消息数据里的
  // aweme_id（含视频标题、作者、文案），供 publicPageOnly 模式零点击提取，
  // 之后交给独立 discovery 窗口抓取完整文案和评论。
  async injectMessageCaptureHook(win) {
    if (!win || win.isDestroyed?.()) return false
    try {
      return await win.webContents.executeJavaScript(`(() => {
        if (window.__xushengFetchHook) return true
        window.__xushengVideoIds = []
        window.__xushengVideoInfo = new Map()
        const collect = (text) => {
          try {
            if (!text || typeof text !== 'string' || !text.includes('aweme_id')) return
            const data = JSON.parse(text)
            const walk = (value) => {
              if (!value || typeof value !== 'object') return
              if (Array.isArray(value)) { value.forEach(walk); return }
              if (typeof value.aweme_id === 'string' && /^\\d{10,20}$/.test(value.aweme_id)) {
                const id = value.aweme_id
                if (!window.__xushengVideoIds.includes(id)) {
                  window.__xushengVideoIds.push(id)
                  if (window.__xushengVideoIds.length > 60) window.__xushengVideoIds.shift()
                }
                const shareInfo = value.share_info || value.shareInfo || value.share || {}
                const author = String(
                  value.author?.nickname
                  || value.author?.name
                  || value.authorName
                  || value.nickname
                  || value.user?.nickname
                  || value.user_name
                  || shareInfo.share_author
                  || shareInfo.author
                  || value.author?.user?.nickname
                  || ''
                ).trim().slice(0, 60)
                const desc = String(
                  value.desc
                  || value.title
                  || shareInfo.share_title
                  || shareInfo.title
                  || shareInfo.share_desc
                  || value.content
                  || ''
                ).trim().slice(0, 500)
                const covers = []
                const addCover = (candidate) => {
                  if (Array.isArray(candidate)) {
                    candidate.forEach(addCover)
                    return
                  }
                  const url = String(candidate?.url || candidate || '').trim()
                  if (/^https?:\\/\\//i.test(url) && !covers.includes(url)) covers.push(url.slice(0, 800))
                }
                addCover(value.video?.cover?.url_list)
                addCover(value.video?.origin_cover?.url_list)
                addCover(value.video?.dynamic_cover?.url_list)
                addCover(value.cover?.url_list)
                addCover(value.cover_url?.url_list)
                addCover(value.images?.flatMap?.((image) => image?.url_list || []))
                if (window.__xushengVideoInfo.size >= 60) {
                  const oldestKey = window.__xushengVideoInfo.keys().next().value
                  if (oldestKey) window.__xushengVideoInfo.delete(oldestKey)
                }
                window.__xushengVideoInfo.set(id, {
                  desc,
                  author,
                  title: String(value.title || shareInfo.share_title || '').slice(0, 120),
                  covers: covers.slice(0, 12),
                  stats: value.statistics || null,
                  at: Date.now(),
                })
              }
              for (const key of Object.keys(value)) {
                if (key === 'aweme_id' && typeof value.aweme_id === 'string' && /^\\d{10,20}$/.test(value.aweme_id)) continue
                walk(value[key])
              }
            }
            walk(data)
          } catch {}
        }
        const decodeData = (data) => {
          // WebSocket 帧可能是文本、Blob 或 ArrayBuffer
          if (typeof data === 'string') return data
          if (data instanceof ArrayBuffer) { try { return new TextDecoder().decode(data) } catch {} }
          if (ArrayBuffer.isView(data)) { try { return new TextDecoder().decode(data.buffer, { stream: true }) } catch {} }
          if (typeof Blob !== 'undefined' && data instanceof Blob) {
            try {
              // 仅对小体积 Blob 进行文本解码，超大媒体切片 Blob 跳过防止挤占堆内存
              if (data.size <= 256 * 1024) {
                data.text().then((t) => collect(t)).catch(() => {})
              }
              return ''
            } catch {}
          }
          return ''
        }
        const OriginalWebSocket = window.WebSocket
        if (OriginalWebSocket) {
          window.WebSocket = function (...args) {
            const socket = new OriginalWebSocket(...args)
            try {
              const originalAddEventListener = socket.addEventListener.bind(socket)
              socket.addEventListener = (type, listener, options) => {
                if (type === 'message') {
                  return originalAddEventListener(type, (event) => {
                    try { collect(decodeData(event.data)) } catch {}
                    if (typeof listener === 'function') listener(event)
                  }, options)
                }
                return originalAddEventListener(type, listener, options)
              }
            } catch {}
            return socket
          }
          window.WebSocket.prototype = OriginalWebSocket.prototype
          const originalProtoDescriptor = Object.getOwnPropertyDescriptor(OriginalWebSocket.prototype, 'onmessage')
          if (originalProtoDescriptor) {
            Object.defineProperty(window.WebSocket.prototype, 'onmessage', {
              set(value) {
                if (typeof value === 'function') {
                  this.__xushengUserOnMessage = value
                  const handler = (event) => {
                    try { collect(decodeData(event.data)) } catch {}
                    if (typeof this.__xushengUserOnMessage === 'function') this.__xushengUserOnMessage(event)
                  }
                  if (originalProtoDescriptor.set) originalProtoDescriptor.set.call(this, handler)
                  else this.addEventListener('message', handler)
                } else if (originalProtoDescriptor.set) {
                  originalProtoDescriptor.set.call(this, value)
                }
              },
              get() {
                if (originalProtoDescriptor.get) return originalProtoDescriptor.get.call(this)
                return this.__xushengUserOnMessage || null
              },
              configurable: true,
            })
          }
          Object.setPrototypeOf(window.WebSocket, OriginalWebSocket)
        }
        const originalFetch = window.fetch
        if (originalFetch) {
          window.fetch = async (...args) => {
            const response = await originalFetch(...args)
            try {
              const url = String(args[0]?.url || args[0] || '')
              // 快速前置过滤：仅对可能含有视频详情/消息/评论的业务接口克隆流，直接放过视频流、静态资源与高频打点
              if (/(?:aweme|im|message|comment|detail|web\\/v1)/i.test(url)) {
                const cloned = response.clone()
                cloned.text().then(collect).catch(() => {})
              }
            } catch {}
            return response
          }
        }
        const originalOpen = XMLHttpRequest.prototype.open
        const originalSend = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.open = function (...args) {
          this.__xushengUrl = String(args[1] || '')
          return originalOpen.apply(this, args)
        }
        XMLHttpRequest.prototype.send = function (...args) {
          if (this.__xushengUrl && /(?:aweme|im|message|comment|detail|web\\/v1)/i.test(this.__xushengUrl)) {
            this.addEventListener('load', () => { try { collect(this.responseText) } catch {} })
          }
          return originalSend.apply(this, args)
        }
        window.__xushengFetchHook = true
        return true
      })()`)
    } catch {
      return false
    }
  }

  ensureDiscoveryWindow() {
    if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) {
      this.scheduleDiscoveryCleanup()
      return this.discoveryWindow
    }
    this.discoveryWindow = new BrowserWindow({
      width: 980,
      height: 760,
      show: false,
      title: 'Douyin video discovery',
      autoHideMenuBar: true,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    // 后台窗口静音：搜索/观看视频时页面自动播放不发出任何声音，画面照常渲染
    this.discoveryWindow.webContents.setAudioMuted(true)
    const denyDeepLink = (event, url) => {
      if (/^bytedance:/i.test(url)) event.preventDefault()
    }
    this.discoveryWindow.webContents.on('will-navigate', denyDeepLink)
    this.discoveryWindow.webContents.on('will-redirect', denyDeepLink)
    this.discoveryWindow.webContents.on('will-frame-navigate', (event, details) => denyDeepLink(event, details.url))
    this.discoveryWindow.webContents.setWindowOpenHandler(({ url }) => (/^bytedance:/i.test(url) ? { action: 'deny' } : { action: 'deny' }))
    this.scheduleDiscoveryCleanup()
    return this.discoveryWindow
  }

  // 发现窗口用完即毁：常驻隐藏浏览器窗口是后台内存的主要来源之一（空闲 2 分钟后销毁）
  scheduleDiscoveryCleanup() {
    if (this._discoveryCleanupTimer) clearTimeout(this._discoveryCleanupTimer)
    this._discoveryCleanupTimer = setTimeout(() => {
      this._discoveryCleanupTimer = null
      if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) {
        try { this.discoveryWindow.destroy() } catch { /* ignore */ }
      }
      this.discoveryWindow = null
    }, 2 * 60 * 1000)
  }

  async openLogin() {
    const win = this.ensureWindow(true)
    if (!win.webContents.getURL().startsWith('https://www.douyin.com/')) await win.loadURL(CHAT_URL)
    win.focus()
    return { ok: true }
  }

  async logout() {
    await session.fromPartition(this.partition).clearStorageData()
    if (this.window && !this.window.isDestroyed()) await this.window.loadURL(CHAT_URL)
    this.lastSeen.clear()
    this.lastSent.clear()
    this.emitEvent('status', await this.getStatus())
    return { ok: true }
  }

  async getStatus() {
    const cookies = await session.fromPartition(this.partition).cookies.get({ url: 'https://www.douyin.com' })
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
        const unreadLabel = (unreadNode?.innerText || unreadNode?.textContent || unreadNode?.getAttribute('aria-label') || '').trim()
        const unread = Boolean(unreadNode)
        const messageKey = unread ? preview + '\u241f' + (unreadLabel || 'unread') : preview
        return { id: name, name, avatar: image?.src || '', fire, preview, messageKey, unread, unreadLabel, fromMe, sentAtLabel }
      }).filter(Boolean)
    })()`)
    const savedContacts = this.storage.get().contacts || []
    const savedByName = new Map(savedContacts.map((contact) => [contact.name, contact]))
    // 垃圾名过滤：页面尚未渲染完成时，聊天列表会把数字 ID 当昵称抓下来。
    // 这类条目绝不能入库——2026-08-29 曾因重启后首帧抓到纯数字名，
    // 与已存昵称全部失配，导致全部联系人的 learning/profile 被裸数据覆盖清空。
    const isJunkName = (value) => !String(value || '').trim() || /^\d+$/.test(String(value).trim())
    const validContacts = contacts.filter((contact) => contact?.name && !isJunkName(contact.name))
    const contactsWithTime = validContacts.map((contact) => ({ ...contact, ...conversationTimeMeta(contact) }))
    const mergedFresh = contactsWithTime.map((contact) => ({
      ...(savedByName.get(contact.name) || {}),
      ...contact,
    }))
    // 保留本次未出现在列表里的已存联系人：列表懒加载/部分渲染时只能看到一部分，
    // 绝不能把没显示的联系人（连同其 learning/profile）从存储里丢掉。
    const scrapedNames = new Set(contactsWithTime.map((contact) => contact.name))
    const preserved = savedContacts.filter((contact) => contact?.name && !scrapedNames.has(contact.name) && !isJunkName(contact.name))
    const mergedContacts = [...mergedFresh, ...preserved]
    if (this.storage?.update && (mergedContacts.length || !savedContacts.length)) {
      // 仅当联系人列表实际发生变化时才写盘，避免每轮轮询都触发全量保存。
      // 变更按"名字 → 列表字段签名"比较，避免保序追加 preserved 后索引错位导致的多余写盘。
      const signature = (contact) => `${contact.preview}|${contact.messageKey}|${contact.unread}|${contact.fire}`
      const savedSignatures = new Map(savedContacts.map((contact) => [contact.name, signature(contact)]))
      const changed = mergedContacts.length !== savedContacts.length
        || mergedContacts.some((contact) => !savedByName.has(contact.name))
        || mergedContacts.some((contact) => savedSignatures.get(contact.name) !== undefined && savedSignatures.get(contact.name) !== signature(contact))
      if (changed) this.storage.update({ contacts: mergedContacts })
    }
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

  async captureLatestIncomingMessageIdentity(name, sourceWindow = null) {
    const win = sourceWindow && !sourceWindow.isDestroyed?.() ? sourceWindow : await this.selectConversation(name)
    await this.waitForEditor(win)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const identity = await win.webContents.executeJavaScript(`(() => {
        const rowSelector = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
        const mediaSelector = ${JSON.stringify(CHAT_MESSAGE_MEDIA_SELECTOR)}
        document.querySelectorAll('[data-xusheng-latest-message]').forEach((node) => node.removeAttribute('data-xusheng-latest-message'))
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        const editorRect = editor?.getBoundingClientRect()
        const seen = new Set()
        const rows = [...document.querySelectorAll(rowSelector + ', ' + mediaSelector)]
          .map((node) => {
            const row = node.closest(rowSelector)
            if (!row || seen.has(row)) return null
            seen.add(row)
            const rect = row.getBoundingClientRect()
            if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return null
            let classes = ''
            for (let current = row, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) classes += ' ' + String(current.className || '')
            const me = /isFromMe|MessageItemTextisFromMe/i.test(classes) || /(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(classes)
            const them = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(classes)
            const bubble = row.querySelector('[class*="content"], [class*="text"], [class*="bubble"], video, img, [style*="background-image"], [class*="video" i], [class*="image" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i]') || row
            const bubbleRect = bubble.getBoundingClientRect()
            return { row, rect, bubbleRect, me, them }
          })
          .filter(Boolean)
          .sort((left, right) => left.rect.top - right.rect.top)
        const selected = rows.at(-1)
        if (!selected) return null
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : innerWidth * 0.65
        const role = selected.me ? 'me' : selected.them ? 'contact' : selected.bubbleRect.left + selected.bubbleRect.width / 2 > divider ? 'me' : 'contact'
        selected.row.setAttribute('data-xusheng-latest-message', role)
        const ids = []
        const urls = []
        const add = (target, value) => {
          const normalized = String(value || '').replace(/\\s+/g, ' ').trim()
          if (normalized) target.push(normalized.slice(0, 1200))
        }
        for (let current = selected.row, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) {
          for (const attr of ['data-message-id', 'data-msg-id', 'data-item-id', 'data-id']) add(ids, current.getAttribute?.(attr))
        }
        const nested = [selected.row, ...selected.row.querySelectorAll('a, video, source, img, [data-message-id], [data-msg-id], [data-item-id], [data-id], [data-url], [data-href]')].slice(0, 120)
        for (const node of nested) {
          for (const attr of ['href', 'src', 'poster', 'data-url', 'data-href']) add(urls, node.getAttribute?.(attr))
          for (const attr of ['data-message-id', 'data-msg-id', 'data-item-id', 'data-id']) add(ids, node.getAttribute?.(attr))
          if ('currentSrc' in node) add(urls, node.currentSrc)
        }
        const text = String(selected.row.innerText || selected.row.textContent || '').replace(/\\s+/g, ' ').trim()
        const comparableText = text.replace(/(?:刚刚|昨天|今天|星期[一二三四五六日天]|\\d+(?:分钟|小时|天)前|\\d{1,2}:\\d{2}|\\d{1,2}月\\d{1,2}日)/g, ' ').replace(/\\s+/g, ' ').trim()
        const fallbackOrdinal = rows.slice(0, -1).filter((item) => {
          const itemText = String(item.row.innerText || item.row.textContent || '').replace(/(?:刚刚|昨天|今天|星期[一二三四五六日天]|\\d+(?:分钟|小时|天)前|\\d{1,2}:\\d{2}|\\d{1,2}月\\d{1,2}日)/g, ' ').replace(/\\s+/g, ' ').trim()
          return itemText === comparableText
        }).length
        return {
          role,
          ids,
          urls,
          text,
          fallbackOrdinal,
          media: Boolean(selected.row.querySelector('video, img, [style*="background-image"], [class*="video" i], [class*="image" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i]')),
        }
      })()`).catch(() => null)
      if (!identity) {
        if (attempt < 3) await sleep(250)
        continue
      }
      const fingerprint = identity.fingerprint || stableMessageFingerprint(identity)
      if (fingerprint) return { ...identity, fingerprint }
      if (attempt < 3) await sleep(250)
    }
    return null
  }

  // Capture the complete latest incoming media bubble. Douyin share cards often
  // contain a poster image, text and nested video nodes, so selecting the last
  // <img> or <video> alone can capture an avatar or a sticker instead.
  async captureLatestIncomingMedia(name, recognitionOptions = {}) {
    const recognition = { ...videoRecognitionOptions(this.storage.get().settings || {}), ...(recognitionOptions || {}) }
    const maxFrames = Math.max(0, Math.min(3, Math.floor(Number(recognition.maxFrames ?? 3) || 0)))
    const shouldCaptureFrames = maxFrames > 0 && recognition.publicPageOnly !== true
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    // 消息捕获 hook 在页面加载时已注入（见 ensureWindow），这里幂等兜底。
    await this.injectMessageCaptureHook(win)
    const media = await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-xusheng-media-capture]').forEach((node) => node.removeAttribute('data-xusheng-media-capture'))
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const rowSelector = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
      const mediaSelector = ${JSON.stringify(CHAT_MESSAGE_MEDIA_SELECTOR)}
      const extractReactAwemeId = ${extractReactAwemeId.toString()}
      const markedRow = document.querySelector('[data-xusheng-latest-message="contact"]')
      const seen = new Set()
      const all = markedRow
        ? [markedRow]
        : [...document.querySelectorAll(rowSelector + ', ' + mediaSelector)]
            .map((node) => node.closest(rowSelector))
            .filter((node) => node && !seen.has(node) && seen.add(node))
      const rows = all
        .map((node) => {
          const rect = node.getBoundingClientRect()
          let signature = ''
          for (let parent = node, depth = 0; parent && depth < 6; parent = parent.parentElement, depth += 1) signature += ' ' + String(parent.className || '')
          const selfByClass = /MessageItemTextisFromMe|isFromMe|(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
          const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
          const mediaNode = [...node.querySelectorAll('video, [style*="background-image"], [class*="video" i], [class*="image" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i], img')].find((candidate) => {
            const candidateRect = candidate.getBoundingClientRect()
            let candidateClasses = ''
            for (let current = candidate, depth = 0; current && current !== node && depth < 4; current = current.parentElement, depth += 1) candidateClasses += ' ' + String(current.className || '')
            return candidateRect.width >= 64 && candidateRect.height >= 44 && !/avatar|userhead|headimage|profilephoto/i.test(candidateClasses)
          })
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
            const reactAwemeId = extractReactAwemeId(node)
            if (reactAwemeId) return 'https://www.douyin.com/video/' + reactAwemeId
            const urlPattern = /(?:https?:\\/\\/v\\.douyin\\.com\\/[^\\s"'<>]+|https?:\\/\\/[^\\s"'<>]*douyin\\.com\\/(?:video|note|share)\\/[^\\s"'<>]+|\\/video\\/\\d+|\\/note\\/\\d+|\\/share\\/[^\\s"'<>]+)/i
            const values = []
            const collect = (item) => {
              const text = String(item || '')
              const match = text.match(urlPattern)
              if (match) values.push(match[0])
            }
            // 视频卡片常被 <a href> 包裹，链接可能挂在外层祖先上：向上扫描到 body。
            const ancestors = []
            for (let parent = node.parentElement, depth = 0; parent && parent !== document.body && depth < 12; parent = parent.parentElement, depth += 1) ancestors.push(parent)
            const nodes = [node, ...node.querySelectorAll('*'), ...ancestors]
            for (const item of nodes) {
              for (const attr of ['href', 'src', 'data-href', 'data-url', 'data-share-url', 'data-video-url', 'data-item-url', 'data-link', 'data-id', 'data-item-id', 'data-aweme-id', 'data-video-id', 'data-group-id', 'data-e2e', 'aria-label', 'title']) {
                collect(item.getAttribute?.(attr))
              }
              collect(item.dataset ? Object.values(item.dataset).join(' ') : '')
            }
            collect(node.innerText)
            collect(node.outerHTML)
            // 没有完整链接时，尝试从 id 类属性拼出公开页 URL（videoId 通常 ≥ 8 位数字）。
            for (const item of nodes) {
              for (const attr of ['data-id', 'data-item-id', 'data-aweme-id', 'data-video-id', 'data-group-id']) {
                const id = String(item.getAttribute?.(attr) || '').match(/\\d{8,}/)?.[0]
                if (id) values.push('https://www.douyin.com/video/' + id)
              }
            }
            // video/note 详情页链接有时藏在图片 URL 或播放地址的参数里，
            // 或在页面其它可点击元素上（如分享卡片的跳转 <a>）。兜底收集。
            if (!values.length) {
              const extra = [...document.querySelectorAll('a[href*="douyin.com"], a[href*="v.douyin.com"], [data-e2e*="video" i], [data-e2e*="aweme" i], [data-e2e*="share" i]')]
              for (const item of extra) {
                for (const attr of ['href', 'data-href', 'data-url', 'data-share-url', 'data-video-url', 'data-item-url', 'data-e2e', 'aria-label', 'title']) {
                  collect(item.getAttribute?.(attr))
                }
              }
            }
            // 封面 div 的背景图 URL 常带 aweme_id 参数（如 ...?aweme_id=xxx），
            // 这是最后一条可靠线索：从计算样式里提取背景图并匹配视频 ID。
            if (!values.length) {
              const bgNodes = [...node.querySelectorAll('[class*="awemeContainer" i], [class*="cover" i], [style*="background"]')]
              for (const el of bgNodes) {
                const bg = String(getComputedStyle(el).backgroundImage || el.getAttribute('style') || '')
                const urlMatch = bg.match(/url\\(["']?([^"')]+)["']?\\)/i)
                if (urlMatch) collect(urlMatch[1])
                collect(bg)
              }
            }
            for (const raw of values) {
              try { return new URL(raw, location.href).href } catch {}
            }
            return ''
          })()
          if (!mediaNode && !shareUrl) return null
          const shareText = String(node.innerText || '').replace(/\\r/g, '\\n').trim().slice(0, 1000)
          // 诊断：记录卡片 DOM 特征，便于排查分享链接/标题提取失败。
          const domHint = {
            rowClass: String(node.className || '').slice(0, 120),
            anchors: [...node.querySelectorAll('a[href]')].slice(0, 3).map((a) => String(a.getAttribute('href') || '').slice(0, 120)),
            imgSrcs: [...node.querySelectorAll('img')].slice(0, 3).map((img) => String(img.getAttribute('src') || img.currentSrc || '').slice(0, 160)),
            bgImages: [...node.querySelectorAll('[class*="awemeContainer" i], [class*="cover" i], [style*="background"]')].slice(0, 3).map((el) => String(getComputedStyle(el).backgroundImage || el.getAttribute('style') || '').slice(0, 200)),
            videoSrcs: [...node.querySelectorAll('video')].slice(0, 2).map((v) => String(v.currentSrc || v.src || '').slice(0, 120)),
            html: String(node.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 2500),
          }
          const videoRect = video?.getBoundingClientRect()
          return { node, rect, role, top: rect.top, video, videoCandidate, poster, videoUrl, videoRect, shareUrl, shareText, domHint }
        }).filter((item) => item && item.role === 'contact').sort((left, right) => left.top - right.top)
      const selected = rows.at(-1)
      if (!selected) return null
      selected.node.scrollIntoView({ block: 'center', inline: 'nearest' })
      selected.node.setAttribute('data-xusheng-media-capture', 'latest')
      const rect = selected.node.getBoundingClientRect()
      const videoAfterScroll = selected.node.querySelector('video')
      const videoRectAfterScroll = videoAfterScroll?.getBoundingClientRect()
      const openTarget = selected.node.querySelector('[class*="ShareAweme" i], [class*="activeClickArea" i], [class*="awemeContainer" i], a[href], [role="button"], [class*="video" i], [class*="card" i], [class*="play" i], video') || selected.videoCandidate || selected.node
      const openRect = openTarget.getBoundingClientRect()
      const playIcon = selected.node.querySelector('[class*="playIcon" i], [class*="PlayIcon" i], [class*="play" i], svg[viewBox]')
      const playIconRect = playIcon?.getBoundingClientRect()
      const coverEl = selected.node.querySelector('[class*="awemeContainer" i], [class*="cover" i], [class*="imgReal" i]') || selected.node.querySelector('img')
      const coverRect = coverEl?.getBoundingClientRect()
      return {
        isVideo: Boolean(videoAfterScroll || selected.videoCandidate),
        duration: videoAfterScroll && Number.isFinite(videoAfterScroll.duration) ? videoAfterScroll.duration : 0,
        videoUrl: /^https?:\\/\\//i.test(selected.videoUrl || '') ? selected.videoUrl : '',
        shareUrl: /^https?:\\/\\//i.test(selected.shareUrl || '') ? selected.shareUrl : '',
        shareText: selected.shareText || '',
        domHint: selected.domHint || null,
        assetUrls: [...selected.node.querySelectorAll('img')]
          .map((image) => image.currentSrc || image.src || '')
          .filter((url) => /^https?:\\/\\//i.test(url))
          .slice(0, 10),
        playIconPoint: playIconRect?.width && playIconRect?.height ? {
          x: Math.round(playIconRect.left + playIconRect.width / 2),
          y: Math.round(playIconRect.top + playIconRect.height / 2),
        } : null,
        coverPoint: coverRect?.width && coverRect?.height ? {
          x: Math.round(coverRect.left + coverRect.width / 2),
          y: Math.round(coverRect.top + coverRect.height / 2),
        } : null,
        posterUrl: /^https?:\\/\\//i.test(selected.poster || '') ? selected.poster : '',
        openPoint: openRect.width && openRect.height ? {
          x: Math.round(openRect.left + openRect.width / 2),
          y: Math.round(openRect.top + openRect.height / 2),
        } : null,
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
    // publicPageOnly 模式：优先从 fetch/XHR hook 捕获的消息数据里取视频 ID
    // （零点击、零弹层）；hook 没捕获到时才点击卡片，由导航/webRequest 拦截
    // 兜底。无论哪种方式，主窗口都保持聊天界面不导航。
    if (recognition.publicPageOnly === true && !media.shareUrl && media.openPoint) {
      // WebSocket 推送有延迟，轮询等待 hook 捕获到最新消息（最多 3.5 秒）。
      const waitStarted = Date.now()
      while (Date.now() - waitStarted < 3500) {
        await sleep(400)
        const pendingCount = await win.webContents.executeJavaScript(`(() => {
          const info = window.__xushengVideoInfo || new Map()
          let fresh = 0
          for (const meta of info.values()) if (meta && meta.at >= Date.now() - 90 * 1000) fresh += 1
          return fresh
        })()`).catch(() => 0)
        if (pendingCount > 0) break
      }
      // 1) 只接受能与当前卡片作者、封面或文案强匹配的 hook 数据。
      //    绝不能拿任意历史 ID 兜底，否则会用旧视频回复当前消息。
      const hookResult = await win.webContents.executeJavaScript(`(() => {
        const ids = window.__xushengVideoIds || []
        const info = window.__xushengVideoInfo || new Map()
        const cardText = ${JSON.stringify(String(media.shareText || '').slice(0, 1000))}
        const assetUrls = ${JSON.stringify((media.assetUrls || []).slice(0, 10))}
        const normalize = (value) => String(value || '').replace(/^@/, '').replace(/\\s+/g, '').trim().toLowerCase()
        const assetKey = (value) => {
          try { return decodeURIComponent(new URL(String(value || '')).pathname).replace(/~.*$/, '') }
          catch { return String(value || '').split('?')[0].replace(/~.*$/, '') }
        }
        const pick = (id) => {
          const meta = info.get(id)
          return { id, author: meta?.author || '', desc: meta?.desc || '' }
        }
        const cardKeys = new Set(assetUrls.map(assetKey).filter((key) => key.length >= 12))
        const coverMatches = ids.filter((id) => {
          const covers = info.get(id)?.covers || []
          return covers.some((url) => cardKeys.has(assetKey(url)))
        })
        if (coverMatches.length === 1) return pick(coverMatches[0])

        const lines = cardText.split(/[\\r\\n]+/).map((line) => line.trim()).filter(Boolean)
        const sourceIndex = lines.findIndex((line) => /来自(?:视频|图文)/.test(line))
        const sourceAuthor = sourceIndex >= 0 ? lines[sourceIndex + 1] || '' : ''
        const authorHint = normalize(sourceAuthor || (lines.length === 1 ? lines[0] : ''))
        if (authorHint.length >= 2) {
          const authorMatches = ids.filter((id) => {
            const author = normalize(info.get(id)?.author)
            return author && (author === authorHint || author.includes(authorHint) || authorHint.includes(author))
          })
          if (authorMatches.length === 1) return pick(authorMatches[0])
        }

        const normalizedCard = normalize(cardText)
        const textMatches = ids.filter((id) => {
          const meta = info.get(id)
          return [meta?.title, meta?.desc].some((value) => {
            const text = normalize(value)
            return text.length >= 8 && normalizedCard.length >= 8 && (text.includes(normalizedCard) || normalizedCard.includes(text))
          })
        })
        if (textMatches.length === 1) return pick(textMatches[0])
        return { id: '' }
      })()`).catch(() => ({ id: '' }))
      if (hookResult && /^\d{10,20}$/.test(String(hookResult.id || ''))) {
        media.shareUrl = 'https://www.douyin.com/video/' + hookResult.id
        const hookedText = [hookResult.author, hookResult.desc].filter(Boolean).join(' ').trim().slice(0, 300)
        if (hookedText) media.shareText = hookedText
      } else {
        // hook 未拿到强匹配 ID 时只记录状态，不能使用任意历史 ID。
        const hookDebug = await win.webContents.executeJavaScript(`(() => {
          const ids = window.__xushengVideoIds || []
          const info = window.__xushengVideoInfo || new Map()
          return {
            len: ids.length,
            last: ids.at(-1) || '',
            all: ids.slice(-8),
            hooked: Boolean(window.__xushengFetchHook),
          }
        })()`).catch(() => null)
        this.log('video_hook_debug', `当前卡片未匹配到 hook 视频 ${name}`, { name, hookDebug, shareText: String(media.shareText || '').slice(0, 60) })
        if (!media.shareUrl) {
        // 2) hook 未捕获，点击卡片由导航/webRequest 拦截兜底，随后关闭弹层。
        const detailIdsBefore = new Set(this._videoDetailIds)
        const hookIdsBefore = await win.webContents.executeJavaScript('Array.from(window.__xushengVideoIds || [])').catch(() => [])
        const winBefore = this._capturedVideoUrl
        this._capturedVideoUrl = null
        const click = (point) => {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
        }
        click(media.openPoint)
        const started = Date.now()
        let awemeId = ''
        let urlAfterClick = ''
        let detailRequests = 0
        while (Date.now() - started < 3500) {
          await sleep(400)
          if (this._capturedVideoUrl) break
          const href = await win.webContents.executeJavaScript('location.href').catch(() => '')
          urlAfterClick = String(href || urlAfterClick)
          if (/douyin\.com\/(?:video|note)\//i.test(urlAfterClick)) {
            this._capturedVideoUrl = urlAfterClick
            break
          }
          detailRequests = this._videoDetailIds.size
          if (!awemeId) {
            const lastId = [...this._videoDetailIds].filter((id) => !detailIdsBefore.has(id)).at(-1)
            if (lastId) awemeId = lastId
          }
        }
        // 无论是否捕获成功，都要关闭播放器弹层（Esc），避免遮挡聊天界面。
        try {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          await win.webContents.executeJavaScript(`(() => {
            const closeBtn = [...document.querySelectorAll('[class*="close" i], [class*="Close" i], [aria-label*="关闭" i], [title*="关闭" i]')]
              .find((node) => { const r = node.getBoundingClientRect(); return r.width > 8 && r.height > 8 })
            if (closeBtn) closeBtn.click()
            return Boolean(closeBtn)
          })()`).catch(() => false)
          await sleep(300)
        } catch {}
        if (this._capturedVideoUrl) {
          media.shareUrl = this._capturedVideoUrl
        } else if (awemeId) {
          media.shareUrl = 'https://www.douyin.com/video/' + awemeId
        } else {
          this._capturedVideoUrl = winBefore
        }
        // 点击后只接受本次新增的 hook ID；点击前已有的均属于历史候选。
        if (!media.shareUrl) {
          const hookLatest = await win.webContents.executeJavaScript(`(() => {
            const ids = window.__xushengVideoIds || []
            const before = new Set(${JSON.stringify(hookIdsBefore)})
            return ids.filter((id) => !before.has(id)).at(-1) || ''
          })()`).catch(() => '')
          if (/^\d{10,20}$/.test(String(hookLatest))) {
            media.shareUrl = 'https://www.douyin.com/video/' + hookLatest
          }
        }
        if (!media.shareUrl) {
          const hookState = await win.webContents.executeJavaScript(`(() => {
            const ids = window.__xushengVideoIds || []
            const info = window.__xushengVideoInfo || new Map()
            return {
              ids: ids.slice(-5),
              authors: ids.slice(-5).map((id) => String(info.get(id)?.author || '')),
              hooked: Boolean(window.__xushengFetchHook),
            }
          })()`).catch(() => null)
          this.log('video_url_capture_debug', `视频链接捕获失败诊断 ${name}`, {
            name,
            openPoint: media.openPoint,
            urlAfterClick: String(urlAfterClick || '').slice(0, 120),
            detailRequests,
            shareText: String(media.shareText || '').slice(0, 80),
            hookState,
          })
        }
        }
      }
    }
    const frames = []
    const capture = async (rect = media.rect) => {
      const image = await win.webContents.capturePage(rect)
      if (image.isEmpty()) return
      const size = image.getSize()
      const scale = Math.min(1, 640 / size.width, 640 / size.height)
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }) : image
      const frame = `data:image/jpeg;base64,${resized.toJPEG(58).toString('base64')}`
      if (frame.length <= 220_000 && !frames.includes(frame)) frames.push(frame)
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
      // 视频只采用真实解码出的关键帧（seek 到具体时间点截取）；
      // 不再使用气泡截图和封面 poster —— 封面与视频内容常常不符，据此回复容易编错画面。
      for (const ratio of (maxFrames > 2 ? [0.2, 0.68] : maxFrames > 1 ? [0.5] : [])) {
        if (await seek(ratio)) {
          await capture(media.videoRect || media.rect)
          decodedVideoFrames += 1
        }
      }
    } else {
      await capture()
    }
    this.log(recognition.publicPageOnly === true ? 'video_public_context_attempted' : 'media_captured', recognition.publicPageOnly === true ? `已尝试读取 ${name} 的视频公开页文案和评论` : `Captured media from ${name}`, { name, frames: Math.min(frames.length, maxFrames), video: media.isVideo, videoAddressFound: Boolean(media.videoUrl), videoPageUrlFound: Boolean(media.shareUrl), shareUrl: String(media.shareUrl || '').slice(0, 120), shareText: String(media.shareText || '').slice(0, 120), openPoint: media.openPoint, domHint: media.domHint, posterFound: shouldCaptureFrames && Boolean(media.posterUrl), mode: recognition.mode || 'smart', publicPageOnly: recognition.publicPageOnly === true })
    const [audioMeta, commentMeta] = await Promise.all([
      recognition.audio === false || recognition.publicPageOnly === true ? Promise.resolve({}) : this.transcribeCapturedMediaAudio(media, name, win),
      this.readVideoCommentContext(media, name, recognition, win),
    ])
    const mergedCommentMeta = mergePublicMediaContext(commentMeta, media.shareText || '', recognition.commentLimit || 5)
    if (recognition.publicPageOnly === true) {
      this.log('video_public_context_ready', `已整理 ${name} 的视频文案和评论上下文`, {
        name,
        comments: mergedCommentMeta.videoComments.length,
        titleFound: Boolean(mergedCommentMeta.videoPageTitle),
        descriptionFound: Boolean(mergedCommentMeta.videoPageDescription),
        source: mergedCommentMeta.videoCommentSource || '',
        error: mergedCommentMeta.videoCommentError || '',
      })
    }
    const result = normalizeCapturedMedia({
      ...mergedCommentMeta,
      ...audioMeta,
      frames: frames.slice(0, maxFrames),
      mediaKind: media.isVideo ? 'video' : 'media',
      detectedVideo: media.isVideo,
      videoReady: media.isVideo && decodedVideoFrames > 0,
      decodedVideoFrames,
      videoAddressFound: Boolean(media.videoUrl),
      videoPageUrlFound: Boolean(media.shareUrl || mergedCommentMeta.videoPageUrlFound),
      posterFound: shouldCaptureFrames && Boolean(media.posterUrl),
      captureSource: 'message_bubble',
      confidence: shouldCaptureFrames ? (media.isVideo ? (decodedVideoFrames > 0 ? 'high' : 'none') : (frames.length ? 'medium' : 'none')) : (mergedCommentMeta.videoComments.length || mergedCommentMeta.videoPageDescription || mergedCommentMeta.videoPageTitle ? 'medium' : 'none'),
      reason: shouldCaptureFrames ? (media.isVideo && decodedVideoFrames <= 0 ? 'video_not_decoded' : '') : 'public_page_only',
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
      const rowSelector = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
      const markedRow = document.querySelector('[data-xusheng-latest-message="contact"]')
      const visible = (node) => {
        const rect = node.getBoundingClientRect()
        return rect.width >= 72 && rect.height >= 48 && rect.bottom > 0 && rect.top < innerHeight
      }
      const build = (node) => {
        const rect = node.getBoundingClientRect()
        let signature = ''
        let parent = node
        for (let depth = 0; parent && depth < 7; parent = parent.parentElement, depth += 1) signature += ' ' + String(parent.className || '')
        const looksLikeMedia = node.tagName === 'VIDEO' || /video|player|play|image|photo|picture|album|gallery|sticker|emoji|gif|share|card|content/i.test(signature) || /background-image/i.test(node.getAttribute('style') || '')
        const looksLikeAvatar = /avatar|userhead|headimage|profilephoto/i.test(signature)
        if (!looksLikeMedia || looksLikeAvatar || !visible(node)) return null
        const selfByClass = /MessageItemTextisFromMe|(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : innerWidth * 0.65
        const fromMe = selfByClass || (!contactByClass && center > divider)
        if (fromMe) return null
        return { node, rect, isVideo: node.tagName === 'VIDEO', top: rect.top }
      }
      let candidates = []
      // 优先在身份捕获标记的最新消息行内寻找媒体，避免新消息尚未渲染
      // 完成时误选旧消息或界面其它元素。
      if (markedRow) {
        for (const node of markedRow.querySelectorAll('video, img, [style*="background-image"]')) {
          const item = build(node)
          if (item) candidates.push(item)
        }
      }
      // 标记行内没有候选时，退回全页面扫描（仍限定在聊天消息行容器内）。
      if (!candidates.length) {
        for (const row of document.querySelectorAll(rowSelector)) {
          for (const node of row.querySelectorAll('video, img, [style*="background-image"]')) {
            const item = build(node)
            if (item) candidates.push(item)
          }
        }
      }
      if (!candidates.length) return null
      candidates.sort((left, right) => left.top - right.top)
      const selected = candidates.at(-1)
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
    const learning = this.analyzeConversation(messages, current.learning)
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

  // 用 AI 归纳对话风格;未配置 AI 时退化为仅保存原始消息(行为与旧内联逻辑一致)
  analyzeConversation(messages, previous = {}) {
    return this.ai?.analyzeConversation
      ? this.ai.analyzeConversation(messages, previous)
      : { messages, videoInsights: Array.isArray(previous.videoInsights) ? previous.videoInsights : [], updatedAt: new Date().toISOString() }
  }

  recordConversationMessage(name, role, text, fallbackContact = {}, options = {}) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    if (!name || !value || !this.storage?.update) return fallbackContact
    const state = this.storage.get()
    const contacts = [...(state.contacts || [])]
    const index = contacts.findIndex((contact) => contact.name === name)
    const current = index >= 0 ? contacts[index] : { ...fallbackContact, id: fallbackContact.id || name, name }
    const human = options.human === true
    // 对话历史保留全部消息（含 AI 生成的），仅用于提供聊天语境
    const messages = mergeMessageHistory(current.learning?.messages, [{ role, text: value }])
    // 风格统计只吸收真人消息：对方的发言、以及本人手动发送/配置的回复；
    // AI 自动生成或自动任务发送的消息不进风格数据，防止 AI 把自己的话当成"本人的说话习惯"越学越像自己。
    const stylePrev = Array.isArray(current.learning?.styleMessages)
      ? current.learning.styleMessages
      : Array.isArray(current.learning?.messages) ? current.learning.messages : []
    const styleMessages = mergeMessageHistory(stylePrev, human ? [{ role, text: value }] : [])
    const learning = this.analyzeConversation(messages, current.learning)
    learning.styleMessages = styleMessages
    learning.contactStyle = analyzeLanguageStyle(styleMessages, 'contact')
    learning.ownerStyle = analyzeLanguageStyle(styleMessages, 'me')
    const updated = { ...current, learning }
    if (index >= 0) contacts[index] = updated
    else contacts.push(updated)
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
    const target = await win.webContents.executeJavaScript(FIND_SEND_TARGET_JS).catch((error) => { throw new Error(`点击发送按钮失败：${error.message}`) })
    if (!target) throw new Error('Could not find the send button')
    const point = { x: target.x, y: target.y }
    const press = () => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
    }
    const pressEnter = () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    }
    press()
    // Douyin usually clears the editor quickly after a successful send. Poll so
    // fast sends return immediately while still allowing slow acknowledgements.
    const started = Date.now()
    let after = { text: before.text }
    let enterPressed = false
    while (Date.now() - started < 5000) {
      await sleep(250)
      after = await win.webContents.executeJavaScript(`(() => ({
        text: (() => { const editor = document.querySelector('${EDITOR_SELECTOR}'); return editor ? ('value' in editor ? editor.value : editor.innerText) : '' })(),
      }))()`).catch((error) => { throw new Error(`发送后读取输入框失败：${error.message}`) })
      if (!normalizeEditorText(after.text)) return
      // 点击后 1.5s 仍未确认：按钮定位可能是 fallback 坐标（点到了空白处），
      // 改用 Enter 键发送（抖音私信输入框 Enter = 发送，Shift+Enter = 换行）。
      if (!enterPressed && Date.now() - started >= 1500) {
        enterPressed = true
        pressEnter()
      }
    }
    throw new Error(`Douyin did not confirm the message was sent; send point=(${point.x}, ${point.y})${target.fallback ? ' (fallback coordinate)' : ''}`)
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
    this.lastSent.set(name, `[${emojiName}]`)
    this.lastReplyTime.set(name, Date.now())
    const pairs = [...this.lastSent].map(([n, t]) => ({ name: n, text: t, at: Date.now() }))
    this.storage.update({ lastSentPairs: pairs })
    this.recordSuccessfulSend(name, 'emoji')
    this.log('message_sent', `Sent emoji "${emojiName}" to ${name}`, { name, emoji: emojiName })
    return { ok: true, kind: 'emoji', emojiName }
  }

  async sendTask(name, task) {
    const effectiveTask = resolveSparkTask(task)
    if (effectiveTask?.kind === 'aiSpark') return this.sendAiSparkTask(name, effectiveTask)
    if (effectiveTask?.kind === 'emoji') return this.sendEmoji(name, effectiveTask.emojiName || '\u65e9\u4e0a\u597d')
    if (effectiveTask?.kind === 'combo') {
      await this.sendMessage(name, effectiveTask?.message || '', { source: 'spark_combo_text', allowedDrafts: sparkMessageOptions(effectiveTask) })
      const emoji = await this.sendEmoji(name, effectiveTask.emojiName || '\u65e9\u4e0a\u597d')
      return { ok: true, kind: 'combo', emojiName: emoji.emojiName, message: effectiveTask?.message || '' }
    }
    return this.sendMessage(name, effectiveTask?.message || '', { source: 'spark_text', allowedDrafts: sparkMessageOptions(effectiveTask) })
  }

  // AI 自动续火花：从行为池（该联系人近期聊天记录，按角色区分）生成一条当天自然的续火花消息并发送。
  // AI 生成失败时回退到任务自带文案，保证续火花任务不会因此中断。
  async sendAiSparkTask(name, task) {
    if (!name) throw new Error('联系人名称不能为空')
    this.assertCanSend(name)
    const state = this.storage.get()
    const contact = (state.contacts || []).find((item) => item.name === name)
    let text = ''
    let aiMeta = {}
    if (this.ai?.draftSparkMessage) {
      try {
        let sparkWeather = ''
      let sparkHotTopic = ''
      try { await fetchHotTopicsCached() } catch { /* 热点抓取失败不阻塞，热点段落自动跳过 */ }
      try { sparkWeather = await fetchWeatherContext(this.storage) } catch { sparkWeather = '' }
      try { sparkHotTopic = hotTopicForSparkCached() } catch { sparkHotTopic = '' }
      const draft = await this.ai.draftSparkMessage({ contact, task, weather: sparkWeather, hotTopic: sparkHotTopic })
        if (draft?.ok && draft.text) {
          text = String(draft.text).trim()
          aiMeta = { source: 'ai_spark', ai: true, model: draft.model || '', provider: draft.provider || '', aiLabel: draft.aiLabel || 'AI' }
        }
      } catch (error) {
        this.log('ai_spark_fallback', `${name} 的 AI 续火花文案生成失败，已回退默认文案`, { name, error: error.message })
      }
    }
    if (!text) {
      const hourNow = new Date().getHours()
      const greeting = hourNow < 11 ? '早上好呀' : hourNow < 14 ? '中午好' : hourNow < 18 ? '下午好' : '晚上好'
      text = sparkWeather ? `${greeting}，${sparkWeather}。照顾好自己呀` : (String(task?.message || '').trim() || `${greeting}，今天也要照顾好自己呀`)
      aiMeta = { source: 'spark_text' }
    }
    await this.sendMessage(name, text, aiMeta)
    return { ok: true, kind: 'aiSpark', message: text }
  }
  // 主动搭话：活跃时段内随机挑一位联系人，AI 结合其行为池（长期记忆 + 兴趣 + 最近聊天）生成自然话题主动发送。
  // 低频限流：每日总量、最小间隔、每联系人每天最多 1 条；黑名单/禁 AI 名单跳过。
  async processProactiveChats(now, blacklist, aiDisabledContacts) {
    const config = this.storage.get().settings?.proactiveChat || {}
    if (!config.enabled) return
    const today = localDateKey(now)
    const minutesNow = now.getHours() * 60 + now.getMinutes()
    const start = timeToMinutes(config.windowStart || '10:00')
    const end = timeToMinutes(config.windowEnd || '22:00')
    // 支持跨午夜窗口（如 08:00 ~ 次日 01:00）：start > end 时视为跨天
    const inWindow = start === end
      ? true
      : start < end
        ? (minutesNow >= start && minutesNow <= end)
        : (minutesNow >= start || minutesNow <= end)
    if (!inWindow) return

    let pstate = this.storage.get().proactiveState || { date: '', sentToday: 0, lastSentAt: 0, sentContacts: [] }
    if (pstate.date !== today) pstate = { date: today, sentToday: 0, lastSentAt: 0, sentContacts: [] }
    const maxPerDay = Math.max(1, Math.floor(Number(config.maxPerDay) || 2))
    if (pstate.sentToday >= maxPerDay) return
    const minIntervalMs = Math.max(60, Math.floor(Number(config.minIntervalMinutes) || 180)) * 60 * 1000
    if (pstate.lastSentAt && Date.now() - pstate.lastSentAt < minIntervalMs) return

    const contacts = this.storage.get().contacts || []
    const sentContacts = new Set(Array.isArray(pstate.sentContacts) ? pstate.sentContacts : [])
    // 候选：未被黑名单/禁 AI 屏蔽、今天还没主动搭话过、该联系人允许主动伴聊（profile.companion !== false）。
    // 注意：不能用”今天没有过发送记录”来过滤——自动回复开启时，活跃联系人每天都会被
    // 自动回复聊过，那样候选永远是空的，主动搭话就永远不触发。这里只保证每人每天最多主动搭话 1 次。
    const candidates = contacts.filter((contact) => {
      if (!contact?.name) return false
      // 防脏数据：跳过纯数字昵称（抖音同步偶发把数字 ID 当成联系人）
      if (/^\d+$/.test(String(contact.name).trim())) return false
      if (blacklist.has(contact.name) || aiDisabledContacts.has(contact.name)) return false
      if (contact?.profile?.companion === false) return false
      if (sentContacts.has(contact.name)) return false
      return true
    })
    if (!candidates.length) return
    // 选人优先级（AI 伴聊）：先挑”有话题记录且近期互动过 1~3 天”的人续话题，
    // 其次挑”很久没聊”的人重拾关系，都没有再随机兜底。
    const withRecentTopic = []
    const withGap = []
    for (const contact of candidates) {
      const days = daysSinceContact(contact?.learning || {})
      if (days === null) continue
      if (days <= 3) withRecentTopic.push(contact)
      else withGap.push(contact)
    }
    const pool = withRecentTopic.length ? withRecentTopic : (withGap.length ? withGap : candidates)
    const contact = pool[Math.floor(Math.random() * pool.length)]
    if (!this.ai?.draftCompanionMessage) return
    let text = ''
    let aiMeta = {}
    try {
      const draft = await this.ai.draftCompanionMessage({ contact })
      if (draft?.ok && draft.text) {
        text = String(draft.text).trim()
        aiMeta = { source: 'companion', ai: true, model: draft.model || '', provider: draft.provider || '', aiLabel: draft.aiLabel || 'AI' }
      }
    } catch (error) {
      this.log('ai_proactive_fallback', `${contact.name} 的主动伴聊文案生成失败`, { name: contact.name, error: error.message })
    }
    if (!text) return
    const settings = this.storage.get().settings || {}
    // 伴聊消息先拟草稿：与自动回复的 aiReplyDraftOnly 同款闸门，人工确认/修改后再发送
    if (settings.proactiveChat?.sendToDraft === true) {
      const drafts = [...(this.storage.get().pendingDrafts || [])]
      drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text, incoming: '', model: aiMeta.model, provider: aiMeta.provider, status: 'pending' })
      const capped = drafts.slice(0, 50)
      this.storage.update({ pendingDrafts: capped })
      this.emitEvent('drafts', { drafts: capped })
      this.log('ai_companion_draft', `已为 ${contact.name} 生成 AI 伴聊草稿待确认`, { name: contact.name, text })
    } else {
      await this.sendMessage(contact.name, text, aiMeta)
      this.log('companion_sent', `已主动与 ${contact.name} 伴聊`, { name: contact.name, text })
    }
    const sentToday = pstate.sentToday + 1
    const nextState = { date: today, sentToday, lastSentAt: Date.now(), sentContacts: [...sentContacts, contact.name].slice(-100) }
    this.storage.update({ proactiveState: nextState })
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
    // 回复频率节流：按联系人资料里配置的最小发送间隔限制（instant 不限，双消息的跟进短消息豁免）
    const freqContact = (this.storage.get().contacts || []).find((item) => item.name === name)
    const freqSeconds = REPLY_FREQUENCY_SECONDS[freqContact?.profile?.frequency] || 0
    if (freqSeconds > 0 && !metadata.isFollowUp) {
      const lastAt = this.lastReplyTime.get(name) || 0
      const waitMs = freqSeconds * 1000 - (Date.now() - lastAt)
      if (waitMs > 0) throw new Error(`该联系人设置了回复间隔，请 ${Math.ceil(waitMs / 1000)} 秒后再发送`)
    }
    let value = String(text).trim()
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    // 若之前点击分享卡片打开过播放器弹层，先关闭，避免遮挡输入框/发送按钮。
    try {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await win.webContents.executeJavaScript(`(() => {
        const closeBtn = [...document.querySelectorAll('[class*="close" i], [class*="Close" i], [aria-label*="关闭" i], [title*="关闭" i]')]
          .find((node) => { const r = node.getBoundingClientRect(); return r.width > 8 && r.height > 8 })
        if (closeBtn) closeBtn.click()
        return Boolean(closeBtn)
      })()`).catch(() => false)
      await sleep(200)
    } catch {}
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
    this.lastSent.set(name, normalized)
    this.lastSeen.set(name, normalized)
    this.lastReplyTime.set(name, Date.now())
    const pairs = [...this.lastSent].map(([n, t]) => ({ name: n, text: t, at: Date.now() }))
    this.storage.update({ lastSentPairs: pairs })
    this.recordSuccessfulSend(name, 'text')
    this.recordConversationMessage(name, 'me', normalized, {}, { human: !metadata.ai })
    this.log('message_sent', `Sent a message to ${name}`, { name, text: normalized, source: metadata.source || 'manual', ai: Boolean(metadata.ai), model: metadata.model || '', provider: metadata.provider || '', aiLabel: metadata.aiLabel || '' })
    return { ok: true }
  }

  updateAutomation(config) {
    const current = this.storage.get()
    this.storage.update({ automation: { ...current.automation, ...config } })
    this.startWorker()
    return { ok: true }
  }

  getSendAllowance(name, now = Date.now()) {
    const state = this.storage.get()
    const config = state.automation || {}
    const dailyLimit = Math.max(1, Math.floor(Number(config.dailyLimit ?? 30) || 30))
    const today = localDateKey(now)
    const history = Array.isArray(state.sendHistory) ? state.sendHistory : []
    const sentToday = history.filter((entry) => entry.at && localDateKey(entry.at) === today).length
    if (sentToday >= dailyLimit) {
      return { ok: false, reason: `今天已发送 ${sentToday} 条，达到每日上限 ${dailyLimit} 条`, sentToday, dailyLimit }
    }
    // 单联系人每日上限：防止单个活跃对话吃光全局配额，导致其他联系人（如发了新视频的）得不到回复
    const perContactLimit = Math.max(1, Math.floor(Number(config.maxPerContactDaily ?? 12) || 12))
    const sentToContact = history.filter((entry) => entry.at && entry.name === name && localDateKey(entry.at) === today).length
    if (sentToContact >= perContactLimit) {
      return { ok: false, reason: `今天已向该联系人发送 ${sentToContact} 条，达到单联系人上限 ${perContactLimit} 条`, sentToday, dailyLimit }
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
      const base = Math.max(5000, Math.min(300000, refreshSeconds * 1000))
      // 风控软化：固定节拍是机器人特征。空闲越久轮询越慢（5 分钟内 1×，30 分钟内 2×，
      // 更久 3×），并叠加 ±20% 抖动；任何新消息都会把 lastActivityAt 拉回当前、节奏自动变快。
      const idleMs = Date.now() - (this.lastActivityAt || Date.now())
      const delay = computePollDelay(base, idleMs)
      this.pollTimer = setTimeout(async () => {
        try { await this.runAutomation() } catch (error) { this.log('worker_error', error.message) }
        if (this.pollTimer) scheduleNext()
      }, delay || AUTOMATION_POLL_MS)
    }
    scheduleNext()
    this.startMemoryHygiene()
  }

  // 轮次状态持久化：把对话引擎的 turn 状态写回联系人记录
  persistTurn(name, patcher) {
    try {
      const state = this.storage.get()
      const contacts = [...(state.contacts || [])]
      const index = contacts.findIndex((contact) => contact.name === name)
      if (index < 0) return
      const contact = contacts[index]
      contacts[index] = { ...contact, turn: patcher({ ...(contact.turn || {}) }) }
      this.storage.update({ contacts })
    } catch { /* turn 持久化失败不阻塞主流程 */ }
  }

  // ==================== 消息队列：收集 → 规划 → 执行 ====================
  // 旧版是"轮询即处理"：一轮里遍历联系人、边发现边回；处理期间来的新消息只能靠
  // auto_recheck"下轮重查"补，去重状态散在 lastSeen / turn / lastSent / lastSkipNotice
  // 四处，既看不到积压、也保证不了顺序，同一个人连发多条时容易出现"只回最后一条"。
  // 现在改成显式队列，三段式：
  //   ① 收集：轮询只负责发现新消息并入队，不做任何回复动作；
  //   ② 规划：出队前统一判定，结果只有 reply / hold / defer / skip 四种；
  //   ③ 执行：严格串行，同一时刻只有一个 AI 调用和一次发送。
  // 队列按联系人聚合（同一联系人只留最新一条，连发自动合并成一批）。未消费的消息
  // 不推进 lastSeen，重启后会被重新发现并入队——等价于"队列不丢"。
  incomingQueueMap() {
    if (!(this.incomingQueue instanceof Map)) this.incomingQueue = new Map()
    return this.incomingQueue
  }

  // 入队：同一联系人只保留最新一条待处理消息，连发合并成一批（回复仍针对最新预览，
  // 更早的内容照样随 learning.messages 进入上下文）。
  // 注意：未消费的消息每轮都会被"重新发现"（lastSeen 未推进），同 key 重复入队只刷新
  // 元数据、不算新消息也不记日志——否则延后中的消息会每轮刷一条 queue_merged。
  enqueueIncoming(item) {
    if (!item?.name) return null
    const queue = this.incomingQueueMap()
    const previous = queue.get(item.name)
    if (previous && previous.key === item.key) {
      const refreshed = {
        ...previous,
        preview: item.preview,
        unread: item.unread,
        incomingIdentity: item.incomingIdentity || previous.incomingIdentity,
        receivedAt: item.receivedAt || previous.receivedAt,
      }
      queue.set(item.name, refreshed)
      return refreshed
    }
    const merged = previous
      ? { ...item, mergedCount: (previous.mergedCount || 1) + 1, enqueuedAt: previous.enqueuedAt || item.enqueuedAt }
      : { ...item, mergedCount: 1 }
    queue.set(item.name, merged)
    if (previous) {
      // 日志节流：媒体预览的指纹键会随轮询抖动（同一张图集每轮指纹略有差异），
      // 不节流会变成"每轮一条 queue_merged"。同一联系人 10 分钟最多记一条。
      const noticeKey = `queue_merged:${item.name}`
      if (Date.now() - (this.lastSkipNotice.get(noticeKey) || 0) >= 10 * 60 * 1000) {
        this.lastSkipNotice.set(noticeKey, Date.now())
        this.log('queue_merged', `${item.name} 又发来新消息，与待处理消息合并为一轮`, { name: item.name, merged: merged.mergedCount, queueSize: queue.size })
      }
    } else {
      this.log('queue_enqueued', `新消息入队：${item.name}`, { name: item.name, mediaKind: item.mediaKind || '', queueSize: queue.size })
    }
    return merged
  }

  // ② 规划：出队前统一判定（只做不需要读页面的便宜判断，页面级守卫在执行阶段）
  // 返回 [{ item, action, reason }]，action：reply 该回 / hold 暂留（限额） / defer 等条件成熟
  planIncomingQueue({ canSend }) {
    const queue = this.incomingQueueMap()
    const plans = []
    for (const item of [...queue.values()].sort((a, b) => (a.enqueuedAt || 0) - (b.enqueuedAt || 0))) {
      if (item.deferUntil && Date.now() < item.deferUntil) {
        plans.push({ item, action: 'defer', reason: 'wait_until' })
        continue
      }
      // 每日发送上限：保留消息，限额重置后补回（与旧版一致，不消费）
      if (!canSend(item.name)) {
        const noticeKey = `${item.name}:${localDateKey()}`
        if (!this.lastLimitNotice.has(noticeKey)) {
          this.lastLimitNotice.set(noticeKey, Date.now())
          this.log('send_blocked', `已达到每日发送上限，暂不回复 ${item.name}`, { name: item.name })
        }
        plans.push({ item, action: 'hold', reason: 'daily_limit' })
        continue
      }
      plans.push({ item, action: 'reply', reason: '' })
    }
    return plans
  }

  // 消费：推进 lastSeen 与轮次状态并出队（这条消息闭环）
  markIncomingConsumed(item) {
    this.lastSeen.set(item.name, item.key)
    this.persistTurn(item.name, (turn) => ({ ...turn, lastHandledKey: item.key }))
    this.incomingQueueMap().delete(item.name)
  }

  // ① 收集：扫描联系人，把"未消费的新消息"入队。除媒体身份探测外不做任何动作。
  async collectIncoming(contacts, ctx) {
    const { autoReplyOn, blacklist, aiDisabledContacts } = ctx
    for (const contact of contacts) {
      const timeMeta = conversationTimeMeta(contact)
      const previewMediaKind = mediaPreviewKind(contact.preview)
      let currentMessageKey = contactMessageKey(contact)
      // 每日消息键：对方每天发同样的"早上好/嗨"是新的一天的新消息——文本消息把
      // 【收到日期】并入 key：同一天相同文本只处理一次（防刷屏），跨天自动解锁
      // （旧版跨天同文本会被误判"已处理"而永远沉默；媒体消息沿用指纹键不受影响）
      if (!previewMediaKind) currentMessageKey = dailyMessageKey(currentMessageKey, timeMeta.sentAt)
      const previous = this.lastSeen.get(contact.name)
      if (currentMessageKey !== previous) this.lastActivityAt = Date.now()
      const hasPrevious = this.lastSeen.has(contact.name)
      if (!contact.preview) {
        this.lastSeen.set(contact.name, currentMessageKey)
        continue
      }
      if (!autoReplyOn) continue // 主动任务在循环外处理；来消息不被消费，恢复后仍可回复
      const receivedAt = timeMeta.sentAt
      const receivedAtMs = receivedAt ? new Date(receivedAt).getTime() : Number.NaN
      const recentlyReceived = Number.isFinite(receivedAtMs) && Date.now() - receivedAtMs <= 30 * 60_000
      let incomingIdentity = null
      const shouldInspectMediaIdentity = Boolean(previewMediaKind) && (
        !hasPrevious
        || Boolean(contact.unread)
        || recentlyReceived
        || !isMediaMessageKey(previous, contact.preview)
      )
      if (shouldInspectMediaIdentity) {
        try {
          incomingIdentity = await this.captureLatestIncomingMessageIdentity(contact.name)
          if (incomingIdentity?.fingerprint) currentMessageKey = mediaMessageKey(contact, incomingIdentity.fingerprint)
        } catch (_) {}
      } else if (previewMediaKind && isMediaMessageKey(previous, contact.preview)) {
        currentMessageKey = previous
      }
      // 基线：首见联系人只建基线不回复（防旧会话被意外回复）
      if (!hasPrevious && !(previewMediaKind && (Boolean(contact.unread) || recentlyReceived))) {
        this.lastSeen.set(contact.name, currentMessageKey)
        continue
      }
      const legacyMediaKey = Boolean(previewMediaKind) && hasPrevious && !isMediaMessageKey(previous, contact.preview)
      if (legacyMediaKey && incomingIdentity?.fingerprint && previous === contactMessageKey(contact) && !contact.unread && !recentlyReceived) {
        this.lastSeen.set(contact.name, currentMessageKey)
        continue
      }
      if (previous === currentMessageKey) continue
      if (blacklist.has(contact.name)) {
        const firstBlockedThisSession = !this.blockedContacts.has(contact.name)
        this.blockedContacts.add(contact.name)
        if (firstBlockedThisSession) this.log('auto_blocked', `已跳过 ${contact.name}：该联系人位于黑名单`, { name: contact.name, reason: 'blacklist' })
        continue
      }
      if (aiDisabledContacts.has(contact.name)) continue // 用户主动关闭：不刷日志、不消费消息
      this.enqueueIncoming({
        name: contact.name,
        key: currentMessageKey,
        preview: contact.preview,
        mediaKind: previewMediaKind,
        receivedAt,
        unread: Boolean(contact.unread),
        incomingIdentity,
        enqueuedAt: Date.now(),
        attempts: 0,
      })
    }
  }

  // ③ 执行队列：串行处理规划结果，一次只跑一个 AI 调用 + 一次发送
  async drainIncomingQueue(ctx) {
    const queue = this.incomingQueueMap()
    if (!queue.size) return
    const startedAt = Date.now()
    const oldestEnqueuedAt = Math.min(...[...queue.values()].map((item) => item.enqueuedAt || startedAt))
    const plans = this.planIncomingQueue(ctx)
    const contactsByName = new Map((ctx.contacts || []).map((contact) => [contact.name, contact]))
    let consumed = 0
    let deferred = 0
    let held = 0
    for (const plan of plans) {
      if (ctx?.isCancelled?.()) break
      if (plan.action === 'hold') { held += 1; continue }
      if (plan.action === 'defer') { deferred += 1; continue }
      const item = plan.item
      const contact = contactsByName.get(item.name)
      if (!contact) { queue.delete(item.name); continue }
      const result = await this.handleIncomingItem(item, contact, ctx)
      if (result === 'consumed') consumed += 1
      else deferred += 1
    }
    // 观测：只在真的消费了消息时记一条处理汇总；队列长期积压时单独告警（10 分钟一次），
    // 避免"每轮一条 queue_drained"这种刷屏式日志。
    const waitedMs = Math.max(0, startedAt - oldestEnqueuedAt)
    if (consumed > 0) {
      this.log('queue_drained', `队列处理完成：消费 ${consumed} 条 / 延后 ${deferred} 条 / 保留 ${held} 条`, {
        consumed,
        deferred,
        held,
        queueSize: this.incomingQueueMap().size,
        waitedMs,
        elapsedMs: Date.now() - startedAt,
      })
    } else if (waitedMs >= 5 * 60 * 1000 && Date.now() - (this.lastSkipNotice.get('queue_backlog') || 0) >= 10 * 60 * 1000) {
      this.lastSkipNotice.set('queue_backlog', Date.now())
      this.log('queue_backlog', `队列积压 ${this.incomingQueueMap().size} 条，最早一条已等待 ${Math.round(waitedMs / 1000)} 秒`, {
        queueSize: this.incomingQueueMap().size,
        waitedMs,
        deferred,
        held,
      })
    }
  }

  // 执行单条消息：页面级守卫 + AI 拟回复 + 发送。
  // 返回 'consumed'（消息闭环、出队）或 'deferred'（保留在队列，下轮重新规划）
  async handleIncomingItem(item, contact, ctx) {
    const { settings, today, factCandidates, topicCandidates } = ctx
    const currentMessageKey = item.key
    const incomingIdentity = item.incomingIdentity
    const timeMeta = conversationTimeMeta(contact)

    // 延后：保留消息（不推进 lastSeen），带重试时间回队列。
    // 日志节流：同一联系人同一原因每 10 分钟最多一条——延后项每轮都会重新规划，
    // 不节流会变成"每轮刷日志"，既污染运行记录又白写盘。
    const defer = (reason, waitMs = 0) => {
      const queued = this.incomingQueueMap().get(item.name)
      if (queued) {
        queued.attempts = (queued.attempts || 0) + 1
        queued.deferUntil = waitMs ? Date.now() + waitMs : 0
      }
      if (reason) {
        const logKey = `${item.name}:${reason}`
        const lastLoggedAt = this.lastSkipNotice.get(`queue_defer:${logKey}`) || 0
        if (Date.now() - lastLoggedAt >= 10 * 60 * 1000) {
          this.lastSkipNotice.set(`queue_defer:${logKey}`, Date.now())
          this.log('queue_deferred', `${item.name} 本轮不处理：${reason}`, { name: item.name, reason, attempts: queued?.attempts || 1 })
        }
      }
      return 'deferred'
    }

    // 角色判定（三层）。最后一条消息的发送方【无法确认】时绝不抢发——
    // 旧版把 null 当成"对方发的"处理，这是自动回复自言自语循环的直接来源。
    const fromMe = contact.fromMe === true
      ? true
      : incomingIdentity?.role === 'me'
        ? true
        : incomingIdentity?.role === 'contact'
          ? false
          : await this.isLastMessageFromMe(contact.name)
    if (fromMe === true) {
      // 竞态保护：最后一条是"我"但预览像对方媒体时，可能是新消息被盖住——不消费，下轮重查
      if (shouldDeferConsumptionOnFromMe(contact.preview, this.lastSent.get(contact.name) || '')) {
        // 去重：同一联系人每 10 分钟最多提示一次。此处消息 key 含媒体指纹、会逐轮变化，
        // 仅按 key 去重无效，会每轮（约 5 秒）刷一条日志、疯狂写盘并推高主进程内存。
        const noticeKey = `defer_on_from_me:${contact.name}`
        if (Date.now() - (this.lastSkipNotice.get(noticeKey) || 0) >= 10 * 60 * 1000) {
          this.lastSkipNotice.set(noticeKey, Date.now())
          this.log('auto_recheck', `${contact.name} 疑似在我回复期间发来新消息，暂不消费，下轮重查`, { name: contact.name, preview: String(contact.preview || '').slice(0, 60) })
        }
        return defer('', 20 * 1000)
      }
      this.markIncomingConsumed(item)
      return 'consumed'
    }
    if (fromMe !== false) {
      const noticeKey = `role_unknown:${contact.name}:${currentMessageKey}`
      if (!this.lastSkipNotice.has(noticeKey)) {
        this.lastSkipNotice.set(noticeKey, Date.now())
        this.log('auto_recheck', `无法确认 ${contact.name} 最后一条消息的发送方，本轮不回复，下轮重查`, { name: contact.name })
      }
      return defer('role_unknown', 30 * 1000)
    }
    // 我方回声守卫：预览就是刚发出的内容（或带 AI 标签的回显），绝不再次回复
    const lastSentText = String(this.lastSent.get(contact.name) || '').replace(/\s+/g, ' ').trim()
    const previewText = String(contact.preview || '').replace(/\s+/g, ' ').trim()
    if (lastSentText && (previewText === lastSentText || previewText.startsWith(lastSentText) || previewText.includes('【AI · '))) {
      this.markIncomingConsumed(item)
      return 'consumed'
    }
    // 引擎轮次闸门：同一消息 key 只处理一次；两次自动发送之间有最小间隔
    const gate = shouldAutoReply(contact, { key: currentMessageKey, fromMe: false })
    if (!gate.ok) {
      if (gate.reason === 'already_handled') {
        this.markIncomingConsumed(item)
        return 'consumed'
      }
      if (gate.reason === 'min_gap') {
        const noticeKey = `min_gap:${contact.name}`
        if (!this.lastSkipNotice.has(noticeKey)) {
          this.lastSkipNotice.set(noticeKey, Date.now())
          this.log('auto_recheck', `${contact.name} 刚回复过，等待 ${Math.ceil((gate.retryInMs || 0) / 1000)} 秒后再处理`, { name: contact.name })
        }
        return defer('min_gap', gate.retryInMs || 20000)
      }
      return defer(gate.reason || 'gate_blocked')
    }
    const learnedContact = this.recordConversationMessage(contact.name, 'contact', contact.preview, contact, { human: true })
    // 长期记忆候选：今天尚未提炼的联系人才入列（每天最多一次）
    if (settings.longTermMemory !== false && this.ai?.mineFacts && learnedContact?.learning?.factsUpdatedAt !== today) {
      factCandidates.push(learnedContact)
    }
    // 话题状态候选：最近一次话题记录早于 2 小时才入列
    if (this.ai?.summarizeRecentTopic) {
      const topicLog = Array.isArray(learnedContact?.learning?.topicLog) ? learnedContact.learning.topicLog : []
      const lastTopicAt = topicLog.length ? new Date(topicLog.at(-1).at).getTime() : 0
      if (!Number.isFinite(lastTopicAt) || Date.now() - lastTopicAt >= 2 * 60 * 60 * 1000) {
        topicCandidates.push(learnedContact)
      }
    }
    let replyText = ''
    let aiAttempted = false
    let aiDraft = null
    if (this.ai?.hasProvider?.()) {
      // AI 失败退避：同联系人连续失败时按指数拉长重试间隔（30s→2min→8min→30min）
      const backoff = this.aiBackoff.get(contact.name)
      if (backoff && Date.now() < backoff.retryAt) {
        if (!this.lastSkipNotice.has(`ai_backoff:${contact.name}`)) {
          this.lastSkipNotice.set(`ai_backoff:${contact.name}`, Date.now())
          this.log('ai_backoff', `${contact.name} 的 AI 调用暂缓（${Math.ceil((backoff.retryAt - Date.now()) / 1000)} 秒后重试）`, { name: contact.name })
        }
        return defer('ai_backoff', Math.max(1000, backoff.retryAt - Date.now()))
      }
      aiAttempted = true
      try {
        // 打开会话抓取完整可见消息，增强上下文（传入 previous.learning 防止 facts/topicLog 被擦）
        let enhancedContact = learnedContact
        try {
          const chatWin = await this.selectConversation(contact.name)
          if (chatWin) {
            const visibleMessages = await this.captureVisibleMessages(chatWin)
            if (visibleMessages.length > 0) {
              const mergedMessages = mergeMessageHistory(learnedContact.learning?.messages, visibleMessages)
              const enhancedLearning = this.ai.analyzeConversation(mergedMessages, learnedContact.learning)
              enhancedContact = { ...learnedContact, learning: enhancedLearning }
            }
          }
        } catch (_) { /* 抓取失败回退预览文本 */ }

        let mediaCapture = normalizeCapturedMedia([])
        const mediaKind = mediaPreviewKind(contact.preview)
        const isMedia = Boolean(mediaKind)
        let useMediaForReply = isMedia
        if (isMedia) {
          if (settings.videoReplyEnabled === false || settings.videoRecognitionEnabled === false) {
            if (hasReplyablePreviewText(contact.preview)) {
              useMediaForReply = false
              this.log('media_text_fallback', `${contact.name} 媒体回复已关闭，使用预览文本回复`, { name: contact.name, mediaKind, reason: 'replyable_preview' })
            } else {
              this.log('media_skipped', `${contact.name} 媒体已跳过：视频回复已关闭`, { name: contact.name, mediaKind, reason: 'video_reply_disabled' })
              this.markIncomingConsumed(item)
              return 'consumed'
            }
          } else {
            try {
              const recognition = videoRecognitionOptions(settings)
              mediaCapture = normalizeCapturedMedia(await this.captureLatestIncomingMedia(contact.name, recognition), mediaKind)
              if (shouldUseVideoFrameFallback(recognition, mediaCapture) && this.captureLatestIncomingVideo) {
                mediaCapture = normalizeCapturedMedia(await this.captureLatestIncomingVideo(contact.name), mediaKind)
              }
            } catch (_) {}
          }
        }
        const providers = this.storage.get().providers || []
        const hasAudioTranscript = Boolean(mediaCapture.audioTranscript)
        const hasPublicContext = hasPublicMediaContext(mediaCapture)
        if (useMediaForReply && !mediaCapture.frames.length && !hasAudioTranscript && !hasPublicContext && hasReplyablePreviewText(contact.preview)) {
          useMediaForReply = false
          this.log('media_text_fallback', `${contact.name} 媒体捕获不可用，使用预览文本回复`, { name: contact.name, mediaKind, reason: mediaCapture.reason || 'media_capture_unavailable' })
        }
        if (useMediaForReply) {
          const caps = providers.length ? providers.some(p => (p.capabilities || []).includes('vision')) : Boolean(this.ai?.hasProvider?.())
          if (!caps && !hasAudioTranscript && !hasPublicContext) {
            this.log('media_skipped', `${contact.name} 媒体已跳过：模型不支持视觉`, { name: contact.name, mediaKind })
            this.markIncomingConsumed(item)
            return 'consumed'
          }
          const requiresDecodedVideo = mediaKind === 'video' || mediaCapture.detectedVideo === true
          if (!mediaCapture.frames.length && !hasAudioTranscript && !hasPublicContext) {
            this.log(requiresDecodedVideo ? 'video_unreadable' : 'media_uncertain', `${contact.name} 媒体画面无法捕获`, { name: contact.name, mediaKind })
            this.markIncomingConsumed(item)
            return 'consumed'
          }
        }
        aiDraft = await this.ai.draft({ contact: enhancedContact, incoming: contact.preview, incomingMeta: timeMeta, videoFrames: useMediaForReply ? mediaCapture : undefined })
        if (aiDraft?.ok && (aiDraft.labeledText || aiDraft.text)) {
          const model = aiDraft.model || providers?.[0]?.model || '当前模型'
          const label = aiDraft.aiLabel || `AI · ${model}`
          const showAiModelLabel = this.storage.get().settings?.showAiModelLabel !== false
          const generated = String(showAiModelLabel ? (aiDraft.labeledText || aiDraft.text) : aiDraft.text).trim()
          replyText = showAiModelLabel && !generated.startsWith(`【${label}】`) ? `【${label}】${generated}` : generated
        }
      } catch (error) {
        this.log('ai_error', `为 ${contact.name} 调用 AI 失败`, { name: contact.name, error: error.message })
        const prevStep = this.aiBackoff.get(contact.name)?.step || 0
        const step = Math.min(prevStep + 1, 4)
        const delay = [30000, 120000, 480000, 1800000][step - 1]
        this.aiBackoff.set(contact.name, { step, retryAt: Date.now() + delay })
        return defer('ai_error', delay) // 不消费，退避后重试
      }
    }
    if (replyText) {
      try {
        const mediaKindForReply = mediaPreviewKind(contact.preview)
        if (mediaKindForReply && isUnavailableMediaReply(replyText)) {
          this.log('ai_reply_rejected', `${contact.name} 的媒体回复已拦截`, { name: contact.name, mediaKind: mediaKindForReply, text: replyText, reason: 'unavailable_media_reply' })
          this.markIncomingConsumed(item)
          return 'consumed'
        }
        // 草稿模式：AI 生成的回复进入草稿列表等待人工确认
        if (settings.aiReplyDraftOnly === true) {
          const drafts = [...(this.storage.get().pendingDrafts || [])]
          drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText + (aiDraft?.text2 ? '\n' + aiDraft.text2 : ''), incoming: String(contact.preview || ''), model: aiDraft?.model || '', provider: aiDraft?.provider || '', status: 'pending' })
          const capped = drafts.slice(0, 50)
          this.storage.update({ pendingDrafts: capped })
          this.emitEvent('drafts', { drafts: capped })
          this.log('ai_draft_pending', `已为 ${contact.name} 生成 AI 草稿待确认`, { name: contact.name, text: replyText })
          this.markIncomingConsumed(item)
          return 'consumed'
        }
        const aiMeta = aiAttempted ? { ai: true, source: 'ai', model: aiDraft?.model || '', provider: aiDraft?.provider || '', aiLabel: aiDraft?.aiLabel || '' } : { source: 'rule' }
        // 拟人延迟：AI 回复不秒回，按长度加 1.5–12 秒随机"打字时间"
        if (aiAttempted) await sleep(humanReplyDelay(replyText))
        await this.sendMessage(contact.name, replyText, aiMeta)
        this.aiBackoff.delete(contact.name)
        this.lastSeen.set(contact.name, currentMessageKey)
        this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))
        // 双消息（允许而非必须）：模型补了第二条随口话时紧跟发出；独立容错，
        // 失败只记日志——首条已送达，轮次已闭环，绝不能因此重发首条
        const followUp = aiAttempted ? String(aiDraft?.text2 || '') : ''
        if (followUp) {
          try {
            await sleep(humanReplyDelay(followUp))
            await this.sendMessage(contact.name, followUp, { ...aiMeta, isFollowUp: true })
          } catch (followError) {
            this.log('send_error', `第二条消息发送失败（首条已送达，不影响本轮）`, { name: contact.name, error: followError.message })
          }
        }
        this.incomingQueueMap().delete(contact.name)
        return 'consumed'
      } catch (error) {
        this.log('send_error', `自动回复发送失败：${contact.name}`, { name: contact.name, error: error.message })
        return defer('send_error', 60 * 1000) // 不消费，下轮重试
      }
    }
    if (aiAttempted && aiDraft?.rejected === true) {
      // 拒发不重试：同一输入重试大概率产出同类内容，直接消费消息（宁可不说）
      this.markIncomingConsumed(item)
      return 'consumed'
    }
    if (aiAttempted) {
      const noticeKey = `ai_empty:${contact.name}:${currentMessageKey}`
      if (!this.lastSkipNotice.has(noticeKey)) {
        this.lastSkipNotice.set(noticeKey, Date.now())
        this.log('ai_empty', `AI 未返回有效回复，保留 ${contact.name} 的消息待重试`, { name: contact.name })
      }
      return defer('ai_empty', 60 * 1000)
    }
    const noticeKey = `ai_unavailable:${contact.name}:${currentMessageKey}`
    if (!this.lastSkipNotice.has(noticeKey)) {
      this.lastSkipNotice.set(noticeKey, Date.now())
      this.log('ai_unavailable', `未配置可用模型，保留 ${contact.name} 的消息待重试`, { name: contact.name })
    }
    return defer('ai_unavailable', 60 * 1000)
  }

  // 内存卫生：聊天页是常驻重型 SPA，渲染进程会累积数百 MB。
  // 每 3 分钟及每轮任务结束进入空闲时检查一次：
  // 1. 达到内存超标线（Working Set >= 450MB 或 JS堆 >= 160MB）
  // 2. 连续常驻达到 45 分钟生命周期上限（Proactive Lifecycle Recycling）
  // 满足上述任一条件且当前空闲无待发消息时，优雅重建渲染进程（OS 彻底回收 400~700MB 物理内存）。
  // 未达重建条件时，每 5 分钟在页面上下文进行一次轻量显存与缓存清洁。
  startMemoryHygiene() {
    if (this._memoryTimer) return
    this._pageLoadedAt = Date.now()
    this._memoryTimer = setInterval(() => { this.runMemoryHygiene().catch(() => {}) }, 3 * 60 * 1000)
  }

  // 内部集合生命周期淘汰：防止 lastSkipNotice, _videoDetailIds, aiBackoff, lastLimitNotice 随运行天数无限膨胀
  cleanupInternalMaps() {
    const now = Date.now()
    if (this.lastSkipNotice instanceof Map) {
      if (this.lastSkipNotice.size > 120) {
        for (const [k, v] of this.lastSkipNotice.entries()) {
          if (now - v > 30 * 60 * 1000 || this.lastSkipNotice.size > 80) {
            this.lastSkipNotice.delete(k)
          }
        }
      }
    }
    if (this._videoDetailIds instanceof Set && this._videoDetailIds.size > 80) {
      const excess = this._videoDetailIds.size - 80
      const it = this._videoDetailIds.values()
      for (let i = 0; i < excess; i++) {
        this._videoDetailIds.delete(it.next().value)
      }
    }
    if (this.aiBackoff instanceof Map) {
      for (const [k, v] of this.aiBackoff.entries()) {
        if (now >= v) this.aiBackoff.delete(k)
      }
    }
    if (this.lastLimitNotice instanceof Map) {
      for (const [k, v] of this.lastLimitNotice.entries()) {
        if (now - v > 24 * 60 * 60 * 1000) this.lastLimitNotice.delete(k)
      }
    }
    if (this.lastReplyTime instanceof Map) {
      for (const [k, v] of this.lastReplyTime.entries()) {
        if (now - v > 24 * 60 * 60 * 1000) this.lastReplyTime.delete(k)
      }
    }
  }

  // 页面内轻量清洁（不销毁窗口）：释放已暂停视频的显存，限制页面内元数据缓存
  async runInPageCleanup(win) {
    if (!win || win.isDestroyed?.() || win.webContents?.isLoading?.()) return
    try {
      await win.webContents.executeJavaScript(`(() => {
        try {
          if (window.__xushengVideoIds && window.__xushengVideoIds.length > 30) {
            window.__xushengVideoIds = window.__xushengVideoIds.slice(-30)
          }
          if (window.__xushengVideoInfo && window.__xushengVideoInfo.size > 30) {
            const excess = window.__xushengVideoInfo.size - 30
            const it = window.__xushengVideoInfo.keys()
            for (let i = 0; i < excess; i++) {
              const k = it.next().value
              if (k) window.__xushengVideoInfo.delete(k)
            }
          }
          const mediaEls = document.querySelectorAll('video, audio')
          for (const el of mediaEls) {
            if (el.paused && (!el.offsetParent || el.getBoundingClientRect().height === 0)) {
              el.removeAttribute('src')
              el.load()
            }
          }
          if (typeof window.gc === 'function') window.gc()
        } catch {}
      })()`).catch(() => {})
    } catch {}
    try {
      const el = require('electron')
      const ses = el?.session?.fromPartition?.(this.partition)
      ses?.clearCodeCaches?.({}).catch?.(() => {})
    } catch {}
  }

  // 读取聊天页渲染进程内存（MB）。注意：Electron 37 起 getAppMetrics 只在 app 上
  // （process.getAppMetrics 已移除，旧代码因此一直抛错、清理从未生效）。
  // 这里逐级回退：app.getAppMetrics → process.getAppMetrics → 渲染进程 JS 堆。
  async readChatPageMemoryMB(win) {
    try {
      const el = require('electron')
      const fn = (el && el.app && typeof el.app.getAppMetrics === 'function')
        ? el.app.getAppMetrics.bind(el.app)
        : (typeof process.getAppMetrics === 'function' ? process.getAppMetrics.bind(process) : null)
      if (fn) {
        const pid = win.webContents.getOSProcessId()
        const metric = fn().find((m) => m.pid === pid)
        // workingSetSize 单位是 KB（Electron MemoryInfo），换算成 MB
        if (metric) return { memMB: Math.round((metric.memory?.workingSetSize || 0) / 1024), source: 'appMetrics' }
      }
    } catch { /* 换下一级回退 */ }
    try {
      const bytes = await win.webContents.executeJavaScript('(performance.memory && performance.memory.usedJSHeapSize) || 0').catch(() => 0)
      if (bytes) return { memMB: Math.round(Number(bytes) / 1048576), source: 'jsHeap' }
    } catch { /* ignore */ }
    return { memMB: 0, source: 'none' }
  }

  async runMemoryHygiene() {
    this.cleanupInternalMaps()
    if (this.polling || this.verificationActive) return
    const win = this.window
    if (!win || win.isDestroyed()) return
    if (win.webContents.isLoading()) return
    // 待发送队列非空、或用户正在前台交互时，绝不打断
    if (this.incomingQueue instanceof Map && this.incomingQueue.size > 0) return
    if (win.isVisible()) return

    const now = Date.now()
    const uptimeMin = Math.round((now - (this._pageLoadedAt || now)) / 60000)
    const { memMB, source } = await this.readChatPageMemoryMB(win)

    // 触发条件（精准双轨治理）：
    // 1. 内存硬超标：常驻内存达到 450MB（或 JS 堆 160MB）且已加载 10 分钟以上
    const overMem = source === 'jsHeap' ? memMB >= 160 : memMB >= 450
    // 2. 存活轮转上限：运行达到 45 分钟且当前处于完全空闲，主动轮转以彻底释放累积的 DOM、显存与垃圾
    const maxUptimeReached = uptimeMin >= 45

    if (!((overMem && uptimeMin >= 10) || maxUptimeReached)) {
      // 未达到彻底重建标准时，每 5 分钟执行一次免重载页内轻量显存与缓存清洁
      if (now - (this._lastInPageCleanupAt || 0) >= 5 * 60 * 1000) {
        this._lastInPageCleanupAt = now
        await this.runInPageCleanup(win).catch(() => {})
      }
      return
    }

    const reason = overMem
      ? `常驻内存偏高 ${memMB}MB（${source}）/ 已运行 ${uptimeMin} 分钟`
      : `已连续常驻 ${uptimeMin} 分钟达到轮转周期`
    this.log('memory_hygiene', `抖音聊天页${reason}，重建渲染进程彻底释放内存`, { memMB, source, uptimeMin })
    await this.recycleChatWindow()
  }

  // 重建聊天页：destroy 让渲染进程彻底退出（OS 回收内存），清空 Chromium 会话缓存，下次轮询按需重建
  async recycleChatWindow() {
    const win = this.window
    if (!win || win.isDestroyed()) return
    // 前台保护：用户正在操作登录窗口时不强制销毁
    if (win.isVisible()) return
    this.window = null
    this._pageLoadedAt = Date.now()
    try {
      win.__forceClose = true
      win.destroy()
    } catch { /* 销毁失败不阻塞自动化 */ }
    try {
      const el = require('electron')
      const ses = el?.session?.fromPartition?.(this.partition)
      if (ses) {
        await ses.clearCache().catch(() => {})
        await ses.clearCodeCaches({}).catch(() => {})
      }
    } catch {}
    try { if (typeof global.gc === 'function') global.gc() } catch { /* 主进程堆回收（需 --expose-gc） */ }
  }

  async runAutomation() {
    if (this.polling) return
    const state = this.storage.get()
    const config = state.automation || {}
    const settings = state.settings || {}
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
    const hasSparkWork = (config.sparks || []).some((task) => task && task.enabled)
    const hasCompanion = Boolean(settings.proactiveChat?.enabled)
    const autoReplyOn = Boolean(config.autoReply) && !config.paused
    if (!autoReplyOn && !hasSparkWork && !hasCompanion) return
    const status = await this.getStatus()
    if (!status.connected) return
    if (!this.window || this.window.isDestroyed()) this.ensureWindow(false)
    // 风控检测：可见验证码出现即暂停本账号自动化，验证通过后自动恢复
    try {
      const challenged = await this.window.webContents.executeJavaScript(`(() => {
        const nodes = document.querySelectorAll('[class*="captcha"], iframe[src*="captcha"], [id*="captcha"]')
        for (const el of nodes) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 100 && rect.height > 100) return true
        }
        return false
      })()`).catch(() => false)
      if (challenged && !this.verificationActive) {
        this.verificationActive = true
        this.log('verification_required', '检测到抖音安全验证，已暂停本账号的自动回复；请在登录窗口完成验证，通过后自动恢复', { account: this.partition })
        this.emitEvent('verification', { required: true })
      } else if (!challenged && this.verificationActive) {
        this.verificationActive = false
        this.log('verification_cleared', '安全验证已通过，本账号自动回复恢复运行', {})
        this.emitEvent('verification', { required: false })
      }
      if (challenged) return
    } catch { /* 检测失败不阻塞本轮 */ }
    // 看门狗与轮次令牌：超时作废本轮令牌，避免卡死超时后与下一轮并发运行造成 DOM 冲突
    const runToken = Symbol('runAutomation')
    this._currentRunToken = runToken
    const isCancelled = () => this._currentRunToken !== runToken

    const watchdog = setTimeout(() => {
      this.log('worker_watchdog', '自动回复本轮执行超时，已强制跳过本轮', { detail: '页面可能卡死' })
      if (this._currentRunToken === runToken) this._currentRunToken = null
      this.polling = false
    }, 5 * 60 * 1000)
    this.polling = true
    try {
      const { contacts } = await this.syncContacts()
      if (isCancelled()) return
      const today = localDateKey()
      const blacklist = new Set((config.blacklist || []).map((name) => String(name).trim()).filter(Boolean))
      const aiDisabledContacts = new Set((config.aiDisabledContacts || []).map((name) => String(name).trim()).filter(Boolean))
      const canSend = (name) => !blacklist.has(name) && this.getSendAllowance(name).ok
      const factCandidates = []
      const topicCandidates = []
      const ctx = { config, settings, contacts, today, autoReplyOn, blacklist, aiDisabledContacts, canSend, factCandidates, topicCandidates, isCancelled }

      // ① 收集：只发现、只入队，不做任何回复动作
      await this.collectIncoming(contacts, ctx)
      if (isCancelled()) return
      // ② 规划 + ③ 执行：先统一判定，再严格串行处理（同一时刻只有一个 AI 调用和一次发送）
      await this.drainIncomingQueue(ctx)
      if (isCancelled()) return

      const seenArr = [...this.lastSeen].map(([n, p]) => ({ name: n, preview: p, at: Date.now() }))
      if (this.storage?.update) this.storage.update({ lastSeenPairs: seenArr })

      const now = new Date()
      const minutesNow = now.getHours() * 60 + now.getMinutes()
      const sparks = [...(config.sparks || [])]
      for (let index = 0; index < sparks.length; index += 1) {
        const task = sparks[index]
        const due = timeToMinutes(task.time) <= minutesNow
        const retryReady = !task.lastAttemptAt || (Date.now() - Number(task.lastAttemptAt)) >= SPARK_RETRY_MS
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
          this.log('spark_sent', `${task.name} 的问候任务已完成`, { name: task.name })
        } catch (error) {
          this.log('spark_fill_failed', `${task.name} 问候任务执行失败，稍后重试`, { name: task.name, error: error.message })
        }
      }
      // 主动伴聊：活跃时段内低频挑人主动聊
      try { await this.processProactiveChats(now, blacklist, aiDisabledContacts) } catch (error) { this.log('companion_error', `主动伴聊执行失败`, { error: error.message }) }
      // 长期记忆提炼：本轮最多 3 位联系人
      for (const candidate of factCandidates.slice(0, 3)) {
        if (!candidate?.name) continue
        try {
          const learned = await this.ai.mineFacts({ name: candidate.name, messages: candidate.learning?.messages, existing: candidate.learning?.facts })
          if (learned?.ok && Array.isArray(learned.facts)) {
            const latestState = this.storage.get()
            const latestContacts = [...(latestState.contacts || [])]
            const idx = latestContacts.findIndex((item) => item.name === candidate.name)
            if (idx >= 0) {
              latestContacts[idx] = { ...latestContacts[idx], learning: { ...(latestContacts[idx].learning || {}), facts: learned.facts, factsUpdatedAt: today } }
              this.storage.update({ contacts: latestContacts })
              this.emitEvent('contacts', { contacts: latestContacts })
            }
          }
        } catch (_) { /* 提炼失败不影响主流程 */ }
      }
      // 话题状态总结：本轮最多 2 位联系人
      for (const candidate of topicCandidates.slice(0, 2)) {
        if (!candidate?.name) continue
        try {
          const learned = await this.ai.summarizeRecentTopic({ name: candidate.name, messages: candidate.learning?.messages, existing: candidate.learning?.topicLog })
          if (learned?.ok && Array.isArray(learned.topics)) {
            const latestState = this.storage.get()
            const latestContacts = [...(latestState.contacts || [])]
            const idx = latestContacts.findIndex((item) => item.name === candidate.name)
            if (idx >= 0) {
              latestContacts[idx] = { ...latestContacts[idx], learning: { ...(latestContacts[idx].learning || {}), topicLog: learned.topics } }
              this.storage.update({ contacts: latestContacts })
              this.emitEvent('contacts', { contacts: latestContacts })
            }
          }
        } catch (_) { /* 话题总结失败不影响主流程 */ }
      }
    } finally {
      clearTimeout(watchdog)
      if (this._currentRunToken === runToken) this._currentRunToken = null
      this.polling = false
      // 每轮任务结束进入空闲时，顺带检测一次内存卫生（此时无锁、无待发任务，是安全回收的最佳时机）
      this.runMemoryHygiene().catch(() => {})
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
    if (this._memoryTimer) { clearInterval(this._memoryTimer); this._memoryTimer = null }
    if (this.incomingQueue instanceof Map) this.incomingQueue.clear()
    if (this._discoveryCleanupTimer) { clearTimeout(this._discoveryCleanupTimer); this._discoveryCleanupTimer = null }
    if (this.window && !this.window.isDestroyed()) {
      this.window.__forceClose = true
      this.window.destroy()
    }
    if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) this.discoveryWindow.destroy()
  }
}

module.exports = { AUTOMATION_POLL_MS, DouyinService, computePollDelay, humanReplyDelay, conversationTimeMeta, dailySparkMessage, extractConversationPreview, extractConversationTimeLabel, extractPublicCommentItemText, extractReactAwemeId, extractStreakCount, hasPublicMediaContext, hasReplyablePreviewText, isUnavailableMediaReply, isVideoPreview, mediaPreviewKind, mergeMessageHistory, mergePublicMediaContext, normalizeCapturedMedia, normalizeCommentContext, normalizeVisibleMediaContext, normalizeVideoRecognitionMode, pickLatestChatMessageRole, resolveConversationSentAt, resolveSparkTask, shouldDeferConsumptionOnFromMe, shouldUseVideoFrameFallback, videoRecognitionOptions }
