const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: class {}, session: {} }
  return originalLoad.call(this, request, parent, isMain)
}
const { AUTOMATION_POLL_MS, DouyinService, VIDEO_SHARE_CATEGORIES, conversationTimeMeta, dailySparkMessage, extractConversationPreview, extractConversationTimeLabel, extractStreakCount, fallbackVideoShareCaption, isVideoPreview, mediaPreviewKind, mergeMessageHistory, mergePublicMediaContext, modelMediaRect, normalizeCapturedMedia, normalizeCommentContext, normalizeVisibleMediaContext, normalizeVideoShareCategories, normalizeVideoShareItems, resolveConversationSentAt, scheduleNextVideoShareAt, shouldUseVideoFrameFallback, videoRecognitionOptions, videoShareDailyLimit, videoShareDiscoveryTerms } = require('../electron/douyin-service.cjs')
Module._load = originalLoad

const localDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

test('contact preview excludes streak counts and other row metadata', () => {
  const lines = ['小明', '726', '10分钟前', '今晚一起吃饭吗']

  assert.equal(extractStreakCount('726', lines), 726)
  assert.equal(extractConversationPreview(lines, '今晚一起吃饭吗', '726'), '今晚一起吃饭吗')
  assert.equal(extractConversationPreview(lines, '', '726'), '今晚一起吃饭吗')
})

test('an actual numeric message is preserved when read from the preview node', () => {
  const lines = ['小明', '726', '刚刚', '311']

  assert.equal(extractConversationPreview(lines, '311', '726'), '311')
})

test('conversation list time labels are extracted and resolved', () => {
  const now = new Date('2026-07-22T08:00:00+08:00')
  const lines = ['小明', '726', '01:00', '昨晚睡不着']
  const label = extractConversationTimeLabel(lines)
  const sentAt = resolveConversationSentAt(label, now)

  assert.equal(label, '01:00')
  assert.equal(new Date(sentAt).getHours(), 1)
  assert.equal(conversationTimeMeta({ sentAtLabel: label }, now).sentAt, sentAt)
})

test('video previews are recognized without treating normal text as video', () => {
  assert.equal(isVideoPreview('[视频]'), true)
  assert.equal(isVideoPreview('对方发来一个视频'), true)
  assert.equal(isVideoPreview('晚上一起吃饭吗'), false)
})

test('Douyin media previews are classified for vision handling', () => {
  assert.equal(mediaPreviewKind('[视频]'), 'video')
  assert.equal(mediaPreviewKind('▶Ι〣〣〣36"'), 'video')
  assert.equal(mediaPreviewKind('分享 @搞个礼物 的评论'), 'share')
  assert.equal(mediaPreviewKind('分享[评论]'), 'share')
  assert.equal(mediaPreviewKind('分享[图集]'), 'album')
  assert.equal(mediaPreviewKind('[图片]'), 'image')
  assert.equal(mediaPreviewKind('[表情]'), 'sticker')
  assert.equal(mediaPreviewKind('晚上一起吃饭吗'), '')
})

test('model media capture rect trims bottom author overlays without shifting content', () => {
  assert.deepEqual(modelMediaRect({ x: 100.8, y: 50.2, width: 160.2, height: 214.8 }), {
    x: 100,
    y: 50,
    width: 161,
    height: 181,
  })
  assert.deepEqual(modelMediaRect({ x: 0, y: 0, width: 120, height: 80 }, { stripBottom: false }), {
    x: 0,
    y: 0,
    width: 120,
    height: 80,
  })
})

test('AI automation passes captured video frames to the draft request', async () => {
  const state = { settings: { videoRecognitionStrength: 'deep' }, automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 }, sendHistory: [] }
  const drafted = []
  let captureOptions
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '这个也太逗了' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[视频]' }] })
  service.captureLatestIncomingMedia = async (_name, options) => {
    captureOptions = options
    return ({
    frames: ['data:image/jpeg;base64,frame'],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: true,
    decodedVideoFrames: 1,
    audioTranscript: '这里有人说早上好',
    audioTranscriptionSource: 'direct_url',
    audioTranscriptionModel: 'whisper-test',
    videoPageTitle: '早市小吃',
    videoComments: ['看起来好香'],
    confidence: 'high',
  })
  }
  service.sendMessage = async () => ({ ok: true })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.deepEqual(drafted[0].videoFrames.frames, ['data:image/jpeg;base64,frame'])
  assert.equal(drafted[0].videoFrames.confidence, 'high')
  assert.equal(drafted[0].videoFrames.audioTranscript, '这里有人说早上好')
  assert.equal(drafted[0].videoFrames.audioTranscriptionModel, 'whisper-test')
  assert.deepEqual(captureOptions, { strength: 'deep', maxFrames: 9, audio: true, commentLimit: 12, commentWaitMs: 6500, frameDetail: 'high', imageMaxSize: 960, jpegQuality: 72 })
  assert.deepEqual(drafted[0].videoFrames.videoComments, ['看起来好香'])
})

test('public-page comment modes keep video replies text-only', async () => {
  assert.deepEqual(videoRecognitionOptions({ videoRecognitionStrength: 'comments20' }), {
    strength: 'comments20',
    maxFrames: 0,
    audio: false,
    commentLimit: 20,
    commentWaitMs: 6500,
    commentScrolls: 4,
    publicPageOnly: true,
  })
  assert.deepEqual(videoRecognitionOptions({ videoRecognitionStrength: 'comments30' }), {
    strength: 'comments30',
    maxFrames: 0,
    audio: false,
    commentLimit: 30,
    commentWaitMs: 8500,
    commentScrolls: 6,
    publicPageOnly: true,
  })
  const comments = Array.from({ length: 35 }, (_, index) => `评论${index + 1}`)
  const context = normalizeCommentContext({ description: '这是一条公开页文案', comments }, 30)
  assert.equal(context.videoComments.length, 30)
  assert.equal(context.videoPageDescription, '这是一条公开页文案')
  assert.equal(shouldUseVideoFrameFallback(videoRecognitionOptions({ videoRecognitionStrength: 'comments30' }), { frames: [] }), false)
})

test('visible shared-comment cards preserve comment text without treating authors as titles', () => {
  const cardText = [
    '分享 @zmjjkk 的评论',
    '起码累着自己了😍',
    '来自视频',
    '“我去，不早说” #冷知识 #生活小妙招',
  ].join('\n')
  const visible = normalizeVisibleMediaContext(cardText, 20)

  assert.equal(visible.videoPageTitle, '“我去，不早说” #冷知识 #生活小妙招')
  assert.deepEqual(visible.videoComments, ['起码累着自己了😍'])
  assert.equal(visible.videoCommentSource, 'visible_card')
  const compactVisible = normalizeVisibleMediaContext(cardText.replace(/\n/g, ' '), 20)
  assert.equal(compactVisible.videoPageTitle, '“我去，不早说” #冷知识 #生活小妙招')
  assert.deepEqual(compactVisible.videoComments, ['起码累着自己了😍'])
  assert.deepEqual(normalizeVisibleMediaContext('xiang先生', 20).videoComments, [])
  assert.equal(normalizeVisibleMediaContext('xiang先生', 20).videoPageTitle, '')

  const merged = mergePublicMediaContext({
    videoPageTitle: '',
    videoPageAuthor: '',
    videoPageDescription: '',
    videoComments: [],
    videoCommentError: 'public page unavailable',
  }, cardText, 20)
  assert.equal(merged.videoPageTitle, '“我去，不早说” #冷知识 #生活小妙招')
  assert.deepEqual(merged.videoComments, ['起码累着自己了😍'])
  assert.equal(mergePublicMediaContext({ videoPageTitle: 'xiang先生的作品 - 抖音' }, 'xiang先生', 20).videoPageTitle, '')
})

test('public-page context can reply without frames or fallback capture', async () => {
  const comments = Array.from({ length: 30 }, (_, index) => `热评${index + 1}`)
  const state = {
    settings: { videoRecognitionStrength: 'comments30' },
    providers: [{ name: 'Text', model: 'text-model', capabilities: [] }],
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  const drafted = []
  const sent = []
  let captureOptions
  let fallbackCalled = false
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '这条评论区挺有意思' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[视频]' }] })
  service.selectConversation = async () => null
  service.captureLatestIncomingMedia = async (_name, options) => {
    captureOptions = options
    return normalizeCapturedMedia({
      frames: [],
      maxFrames: options.maxFrames,
      mediaKind: 'video',
      detectedVideo: true,
      videoReady: false,
      videoPageTitle: '早市小吃',
      videoPageDescription: '老板出摊做早餐',
      videoComments: comments,
      confidence: 'medium',
      reason: 'public_page_only',
    })
  }
  service.captureLatestIncomingVideo = async () => {
    fallbackCalled = true
    return { frames: ['data:image/jpeg;base64,frame'] }
  }
  service.sendMessage = async (name, text) => { sent.push({ name, text }) }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.deepEqual(captureOptions, {
    strength: 'comments30',
    maxFrames: 0,
    audio: false,
    commentLimit: 30,
    commentWaitMs: 8500,
    commentScrolls: 6,
    publicPageOnly: true,
  })
  assert.equal(fallbackCalled, false)
  assert.equal(drafted.length, 1)
  assert.deepEqual(drafted[0].videoFrames.frames, [])
  assert.equal(drafted[0].videoFrames.videoComments.length, 30)
  assert.deepEqual(sent, [{ name: '小明', text: '【AI · text-model】这条评论区挺有意思' }])
})

test('AI automation can reply to video audio when no frame was captured', async () => {
  const state = { providers: [{ name: 'Text', model: 'text-model', capabilities: [] }], automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 }, sendHistory: [] }
  const drafted = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '早呀' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[视频]' }] })
  service.captureLatestIncomingMedia = async () => ({
    frames: [],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: false,
    audioTranscript: '这里有人说早上好',
    audioTranscriptionSource: 'direct_url',
    confidence: 'low',
  })
  service.sendMessage = async () => ({ ok: true })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(drafted.length, 1)
  assert.deepEqual(drafted[0].videoFrames.frames, [])
  assert.equal(drafted[0].videoFrames.audioTranscript, '这里有人说早上好')
})

test('media auto replies can be disabled from settings', async () => {
  const logs = []
  const state = { settings: { videoReplyEnabled: false }, automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 }, sendHistory: [] }
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: (entry) => logs.push(entry) },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async () => assert.fail('disabled media replies must not call AI') },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[视频]' }] })
  service.captureLatestIncomingMedia = async () => assert.fail('disabled media replies must not capture frames')
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(logs.at(-1).type, 'media_skipped')
  assert.equal(logs.at(-1).detail.reason, 'video_reply_disabled')
  assert.equal(service.lastSeen.get('小明'), '[视频]')
})

test('low confidence videos still generate conservative AI replies when a frame exists', async () => {
  const logs = []
  const state = { automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 }, sendHistory: [] }
  const drafted = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: (entry) => logs.push(entry) },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '有点看不清是哪段诶' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[视频]' }] })
  service.captureLatestIncomingMedia = async () => ({
    frames: ['data:image/jpeg;base64,poster'],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: false,
    videoAddressFound: false,
    posterFound: true,
  })
  service.sendMessage = async () => ({ ok: true })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.ok(logs.some((entry) => entry.type === 'video_low_confidence'))
  assert.equal(drafted[0].videoFrames.confidence, 'low')
  assert.equal(drafted[0].videoFrames.reason, 'video_not_decoded')
})

test('low confidence video replies can be disabled from settings', async () => {
  const logs = []
  const state = { settings: { videoLowConfidenceReply: false }, automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 }, sendHistory: [] }
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: (entry) => logs.push(entry) },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async () => assert.fail('low confidence disabled must not call AI') },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[视频]' }] })
  service.captureLatestIncomingMedia = async () => ({
    frames: ['data:image/jpeg;base64,poster'],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: false,
  })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(logs.at(-1).type, 'video_unreadable')
  assert.equal(logs.at(-1).detail.reason, 'low_confidence_disabled')
  assert.equal(service.lastSeen.get('小明'), '[视频]')
})

test('unreadable videos with no frames are skipped instead of generating an AI reply', async () => {
  const logs = []
  const state = { automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 }, sendHistory: [] }
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: (entry) => logs.push(entry) },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async () => assert.fail('videos with no frames must not call AI') },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[视频]' }] })
  service.captureLatestIncomingMedia = async () => ({
    frames: [],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: false,
  })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(logs.at(-1).type, 'video_unreadable')
  assert.equal(service.lastSeen.get('小明'), '[视频]')
})

test('image media still uses vision frames without requiring video decoding', async () => {
  const state = { automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 }, sendHistory: [] }
  const drafted = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '这张图挺有意思' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[图片]' }] })
  service.captureLatestIncomingMedia = async () => ({
    frames: ['data:image/jpeg;base64,image-frame'],
    mediaKind: 'image',
    detectedVideo: false,
    videoReady: false,
  })
  service.sendMessage = async () => ({ ok: true })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.deepEqual(drafted[0].videoFrames.frames, ['data:image/jpeg;base64,image-frame'])
  assert.equal(drafted[0].videoFrames.mediaKind, 'image')
})

test('shared comment cards capture media instead of falling back to text-only replies', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 },
    providers: [{ name: 'Vision', model: 'vision-model', capabilities: ['vision'] }],
    sendHistory: [],
  }
  const drafted = []
  let captured = false
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: {
      hasProvider: () => true,
      draft: async (payload) => { drafted.push(payload); return { ok: true, text: '这评论也太好笑了' } },
    },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '分享[评论]' }] })
  service.captureLatestIncomingMedia = async () => {
    captured = true
    return { frames: ['data:image/jpeg;base64,comment-card'], mediaKind: 'share', detectedVideo: false, videoReady: false }
  }
  service.sendMessage = async () => ({ ok: true })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(captured, true)
  assert.equal(drafted[0].incoming, '分享[评论]')
  assert.deepEqual(drafted[0].videoFrames.frames, ['data:image/jpeg;base64,comment-card'])
  assert.equal(drafted[0].videoFrames.mediaKind, 'share')
})

test('composite media capture script compiles independently of page content', async () => {
  const service = new DouyinService({ storage: { get: () => ({}) }, emit: () => {} })
  service.selectConversation = async () => ({ webContents: { executeJavaScript: async (script) => { new Function(script); return null } } })
  service.waitForEditor = async () => ({})
  assert.deepEqual(await service.captureLatestIncomingMedia('小明'), normalizeCapturedMedia({ frames: [], mediaKind: 'media', confidence: 'none', reason: 'no_visible_media_bubble' }))
})

test('visible chat history merges without duplicating the overlap', () => {
  const previous = [
    { role: 'contact', text: '第一条' },
    { role: 'me', text: '第二条' },
    { role: 'contact', text: '第三条' },
  ]
  const visible = [
    { role: 'me', text: '第二条' },
    { role: 'contact', text: '第三条' },
    { role: 'me', text: '第四条' },
  ]

  assert.deepEqual(mergeMessageHistory(previous, visible), [
    ...previous,
    { role: 'me', text: '第四条' },
  ])
})

test('learning script compiles and persists the learned contact', async () => {
  const state = { contacts: [{ id: '小明', name: '小明' }], logs: [] }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.push(entry),
  }
  const win = {
    webContents: {
      executeJavaScript: async (script) => {
        new Function(script)
        return [{ role: 'contact', text: '在吗' }, { role: 'me', text: '在啊' }]
      },
    },
  }
  const service = new DouyinService({
    storage,
    emit: () => {},
    ai: { analyzeConversation: (messages) => ({ messages, contactStyle: { summary: '偏短句' } }) },
  })
  service.selectConversation = async () => win
  service.waitForEditor = async () => ({})

  const result = await service.learnConversation('小明')

  assert.equal(result.learnedMessages, 2)
  assert.equal(state.contacts[0].learning.contactStyle.summary, '偏短句')
  assert.equal(state.logs[0].type, 'language_learned')
})

test('new incoming and sent messages continuously update local learning', () => {
  const state = { contacts: [{ id: '小明', name: '小明', learning: { messages: [{ role: 'contact', text: '旧消息' }] } }] }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
  }
  const service = new DouyinService({
    storage,
    emit: () => {},
    ai: { analyzeConversation: (messages) => ({ messages, updatedAt: '2026-07-19T00:00:00.000Z' }) },
  })

  service.recordConversationMessage('小明', 'contact', '新消息')
  service.recordConversationMessage('小明', 'me', '我的回复')

  assert.deepEqual(state.contacts[0].learning.messages, [
    { role: 'contact', text: '旧消息' },
    { role: 'contact', text: '新消息' },
    { role: 'me', text: '我的回复' },
  ])
})

test('sendMessage falls back to native text insertion', async () => {
  const calls = []
  const results = [{ ok: false }, true, true]
  const win = {
    webContents: {
      executeJavaScript: async () => results.shift(),
      insertText: async (text) => { calls.push(text) },
    },
  }
  const logs = []
  const service = new DouyinService({
    storage: {
      state: { automation: { dailyLimit: 30, cooldown: 0 }, sendHistory: [] },
      get() { return structuredClone(this.state) },
      update(patch) { this.state = { ...this.state, ...patch } },
      addLog: (entry) => logs.push(entry),
    },
    emit: () => {},
  })
  service.selectConversation = async () => win
  service.waitForEditor = async () => ({})
  service.sendCurrentInput = async () => {}

  const result = await service.sendMessage('小明', 'AI 自动回复')

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, ['AI 自动回复'])
  assert.equal(logs[0].type, 'message_sent')
  assert.equal(service.lastSent.get('小明'), 'AI 自动回复')
})

test('sendMessage sends an existing allowed spark draft instead of blocking retries', async () => {
  const win = { webContents: { executeJavaScript: async () => ({ ok: false, occupied: true, current: 'spark draft a' }) } }
  const logs = []
  const service = new DouyinService({
    storage: {
      state: { automation: { dailyLimit: 30, cooldown: 0 }, sendHistory: [] },
      get() { return structuredClone(this.state) },
      update(patch) { this.state = { ...this.state, ...patch } },
      addLog: (entry) => logs.push(entry),
    },
    emit: () => {},
  })
  service.selectConversation = async () => win
  service.waitForEditor = async () => ({})
  let sent = false
  service.sendCurrentInput = async () => { sent = true }

  const result = await service.sendMessage('spark-contact', 'spark draft b', {
    source: 'spark_combo_text',
    allowedDrafts: ['spark draft a', 'spark draft b'],
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(sent, true)
  assert.equal(logs[0].type, 'message_sent')
  assert.equal(logs[0].detail.text, 'spark draft a')
})

test('combo spark tasks send text first and then the selected emoji', async () => {
  const calls = []
  const service = new DouyinService({ storage: { get: () => ({}) }, emit: () => {} })
  service.sendMessage = async (name, text, metadata) => { calls.push(['text', name, text, metadata.source]); return { ok: true } }
  service.sendEmoji = async (name, emojiName) => { calls.push(['emoji', name, emojiName]); return { ok: true, kind: 'emoji', emojiName } }

  const result = await service.sendTask('小明', { kind: 'combo', message: '今天也来续个火花呀', emojiName: '续火花' })

  assert.deepEqual(calls, [
    ['text', '小明', '今天也来续个火花呀', 'spark_combo_text'],
    ['emoji', '小明', '续火花'],
  ])
  assert.deepEqual(result, { ok: true, kind: 'combo', emojiName: '续火花', message: '今天也来续个火花呀' })
})

test('spark text tasks choose one saved message for the current day', async () => {
  const calls = []
  const service = new DouyinService({ storage: { get: () => ({}) }, emit: () => {} })
  const task = { id: 22, kind: 'text', name: 'spark-contact', message: 'fallback', messages: ['A', 'B', 'C'] }
  service.sendMessage = async (name, text) => { calls.push({ name, text }); return { ok: true } }

  await service.sendTask('spark-contact', task)

  assert.deepEqual(calls, [{ name: 'spark-contact', text: dailySparkMessage(task) }])
  assert.match(calls[0].text, /^[ABC]$/)
  assert.notEqual(dailySparkMessage(task, new Date('2026-07-23T10:00:00')), dailySparkMessage(task, new Date('2026-07-22T10:00:00')))
})

test('starting an inquiry sends a generated question and persists a waiting record', async () => {
  const state = { contacts: [{ name: '小明' }], automation: { inquiries: [], dailyLimit: 30 }, sendHistory: [] }
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), update: (patch) => Object.assign(state, patch), addLog: () => {} },
    emit: () => {},
    ai: { planInquiry: async () => ({ ok: true, text: '你最近工作忙不忙呀', model: 'test-model', provider: 'Test', aiLabel: 'AI · test-model' }) },
  })
  const sent = []
  service.sendMessage = async (name, text, metadata) => sent.push({ name, text, metadata })

  const result = await service.startInquiry({ name: '小明', question: '他最近工作忙不忙' })

  assert.equal(result.inquiry.status, 'waiting')
  assert.equal(state.automation.inquiries[0].question, '他最近工作忙不忙')
  assert.deepEqual(sent, [{ name: '小明', text: '你最近工作忙不忙呀', metadata: { source: 'inquiry', ai: true, model: 'test-model', provider: 'Test', aiLabel: 'AI · test-model' } }])
})

test('a pending inquiry summarizes the next reply without sending another message', async () => {
  const state = {
    contacts: [{ name: '小明' }],
    automation: { autoReply: false, paused: false, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], inquiries: [{ id: 1, name: '小明', question: '他最近工作忙不忙', asked: '你最近工作忙不忙呀', status: 'waiting' }], dailyLimit: 30 },
    sendHistory: [], logs: [],
  }
  const storage = { get: () => structuredClone(state), update: (patch) => Object.assign(state, patch), addLog: (entry) => state.logs.unshift(entry) }
  const service = new DouyinService({ storage, emit: () => {}, ai: { summarizeInquiry: async () => ({ ok: true, report: '对方说最近工作很忙。', model: 'test-model' }), analyzeConversation: (messages) => ({ messages }) } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '最近项目很多，确实挺忙的' }] })
  service.isLastMessageFromMe = async () => false
  service.sendMessage = async () => assert.fail('inquiry answers must not trigger an automatic outgoing reply')
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(state.automation.inquiries[0].status, 'answered')
  assert.equal(state.automation.inquiries[0].report, '对方说最近工作很忙。')
  assert.equal(state.logs[0].type, 'inquiry_answered')
})

test('video share task parsing and limits stay conservative', () => {
  const task = {
    kind: 'videoShare',
    maxPerDay: 50,
    message: 'https://v.douyin.com/abc/ | 冷幽默短片 | 后面那个停顿很好笑\nnot a url',
  }

  assert.equal(videoShareDailyLimit(task), 10)
  assert.deepEqual(normalizeVideoShareItems(task), [{
    url: 'https://v.douyin.com/abc/',
    title: '冷幽默短片',
    note: '后面那个停顿很好笑',
  }])
  assert.match(fallbackVideoShareCaption({ note: '后面那个停顿很好笑' }), /停顿/)
})

test('video share discovery terms prefer configured topics', () => {
  assert.deepEqual(videoShareDiscoveryTerms(
    { profile: { personality: '健身日常、电影剪辑' } },
    { discoveryQuery: '搞笑反转\n猫狗日常' },
  ).slice(0, 4), ['搞笑反转', '猫狗日常', '健身日常', '电影剪辑'])
  assert.ok(videoShareDiscoveryTerms({}, {}).length > 0)
})

test('video share category tags normalize and prioritize learned replies', () => {
  assert.deepEqual(normalizeVideoShareCategories(['搞笑反转', '未知类型', '猫狗萌宠', '搞笑反转']), ['搞笑反转', '猫狗萌宠'])
  assert.ok(VIDEO_SHARE_CATEGORIES.includes('电影剪辑'))

  const terms = videoShareDiscoveryTerms({
    profile: {
      videoShare: {
        categories: ['搞笑反转', '电影剪辑'],
        videoShareState: {
          categoryStats: {
            搞笑反转: { sent: 3, replied: 0 },
            电影剪辑: { sent: 2, replied: 2 },
          },
        },
      },
    },
  }, {})
  assert.deepEqual(terms.slice(0, 2), ['电影剪辑', '搞笑反转'])
})

test('video share random schedule stays inside the same day time window', () => {
  const task = { kind: 'videoShare', time: '13:00', windowEnd: '14:00' }
  const at = scheduleNextVideoShareAt(task, new Date('2026-07-23T12:10:00+08:00'))
  const scheduled = new Date(at)

  assert.equal(localDateKey(scheduled), localDateKey(new Date('2026-07-23T12:10:00+08:00')))
  assert.ok(scheduled.getHours() >= 13)
  assert.ok(scheduled.getHours() <= 14)
})

test('video share automation sends no more than ten times per day per task', async () => {
  const today = localDateKey()
  const state = {
    automation: {
      autoReply: false,
      blacklist: [],
      sparks: [{
        id: 31,
        name: '小明',
        kind: 'videoShare',
        time: '00:00',
        windowStart: '00:00',
        windowEnd: '23:59',
        maxPerDay: 99,
        enabled: true,
        videos: [{ url: 'https://v.douyin.com/abc/', title: '冷幽默', note: '最后那个停顿很好笑' }],
        videoShareState: { date: today, sentToday: 9, usedVideoKeys: [] },
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
      }],
      dailyLimit: 30,
    },
    contacts: [{ name: '小明' }],
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const shares = []
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  service.sendNativeVideoShare = async (name, video, caption, metadata) => {
    shares.push({ name, video, caption, metadata })
    service.recordSuccessfulSend(name, 'videoShare')
    return { ok: true }
  }

  await service.runAutomation()
  await service.runAutomation()

  assert.equal(shares.length, 1)
  assert.equal(shares[0].video.url, 'https://v.douyin.com/abc/')
  assert.equal(state.sendHistory[0].kind, 'videoShare')
  assert.equal(state.automation.sparks[0].maxPerDay, 10)
  assert.equal(state.automation.sparks[0].videoShareState.sentToday, 10)
  assert.equal(state.automation.sparks[0].lastRunDate, today)
  assert.equal(state.automation.sparks[0].nextRunAt, '')
})

test('contact-level video share switch drives random video sending', async () => {
  const today = localDateKey()
  const state = {
    automation: { autoReply: false, blacklist: [], sparks: [], dailyLimit: 30 },
    contacts: [{
      name: '小明',
      profile: {
        videoShare: {
          enabled: true,
          windowStart: '00:00',
          windowEnd: '23:59',
          maxPerDay: 2,
          categories: ['电影剪辑'],
          videos: [{ url: 'https://v.douyin.com/contact/', title: '冷幽默', note: '后面那个停顿很好笑' }],
          videoShareState: { date: today, sentToday: 0, usedVideoKeys: [] },
          nextRunAt: new Date(Date.now() - 1000).toISOString(),
        },
      },
    }],
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const shares = []
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  service.sendNativeVideoShare = async (name, video, caption, metadata) => {
    shares.push({ name, video, caption, metadata })
    service.recordSuccessfulSend(name, 'videoShare')
    return { ok: true }
  }

  await service.runAutomation()

  assert.equal(shares.length, 1)
  assert.equal(shares[0].name, '小明')
  assert.equal(shares[0].video.url, 'https://v.douyin.com/contact/')
  assert.equal(state.contacts[0].profile.videoShare.videoShareState.sentToday, 1)
  assert.equal(state.contacts[0].profile.videoShare.videoShareState.lastShared.category, '电影剪辑')
  assert.equal(state.contacts[0].profile.videoShare.videoShareState.categoryStats['电影剪辑'].sent, 1)
  assert.equal(state.logs[0].type, 'video_share_sent')
  assert.equal(state.logs[0].detail.source, 'contact')
})

test('contact-level video share can auto discover without provided links', async () => {
  const today = localDateKey()
  const state = {
    automation: { autoReply: false, blacklist: [], sparks: [], dailyLimit: 30 },
    contacts: [{
      name: '小明',
      profile: {
        personality: '喜欢轻松搞笑',
        videoShare: {
          enabled: true,
          windowStart: '00:00',
          windowEnd: '23:59',
          maxPerDay: 2,
          categories: ['搞笑反转'],
          discoveryQuery: '搞笑反转',
          videos: [],
          videoShareState: { date: today, sentToday: 0, usedVideoKeys: [] },
          nextRunAt: new Date(Date.now() - 1000).toISOString(),
        },
      },
    }],
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const shares = []
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  service.discoverVideoShareItem = async (contact, task) => ({
    url: 'https://www.douyin.com/video/123',
    title: `搜到：${task.discoveryQuery}`,
    note: '反转挺轻松',
    searchTerm: task.discoveryQuery,
    category: task.categories[0],
    source: 'douyin_search',
  })
  service.sendNativeVideoShare = async (name, video, caption, metadata) => {
    shares.push({ name, video, caption, metadata })
    service.recordSuccessfulSend(name, 'videoShare')
    return { ok: true }
  }

  await service.runAutomation()

  assert.equal(shares.length, 1)
  assert.equal(shares[0].name, '小明')
  assert.equal(shares[0].video.url, 'https://www.douyin.com/video/123')
  assert.equal(state.contacts[0].profile.videoShare.videoShareState.sentToday, 1)
  assert.equal(state.contacts[0].profile.videoShare.videoShareState.lastShared.category, '搞笑反转')
  assert.equal(state.logs[0].type, 'video_share_sent')
})

test('incoming replies increase the last shared video category preference', async () => {
  const state = {
    automation: { autoReply: true, blacklist: [], aiDisabledContacts: [], sparks: [], dailyLimit: 30 },
    contacts: [{
      name: '小明',
      preview: '这个剪得挺好',
      profile: {
        videoShare: {
          enabled: false,
          categories: ['电影剪辑', '搞笑反转'],
          videoShareState: {
            date: localDateKey(),
            sentToday: 1,
            usedVideoKeys: [],
            categoryStats: { 电影剪辑: { sent: 1, replied: 0 } },
            lastShared: {
              at: new Date().toISOString(),
              category: '电影剪辑',
              url: 'https://www.douyin.com/video/123',
              engaged: false,
            },
          },
        },
      },
    }],
    sendHistory: [],
    providers: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const service = new DouyinService({
    storage,
    emit: () => {},
    ai: {
      hasProvider: () => true,
      analyzeConversation: (messages) => ({ messages, updatedAt: new Date().toISOString() }),
      draft: async () => ({ ok: true, text: '哈哈确实不错' }),
    },
  })
  service.window = { isDestroyed: () => false }
  service.lastSeen.set('小明', '小明:上一条')
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '这个剪得挺好' }] })
  service.isLastMessageFromMe = async () => false
  service.selectConversation = async () => null
  service.sendMessage = async (name, text) => {
    service.recordSuccessfulSend(name, 'text')
    return { ok: true, name, text }
  }

  await service.runAutomation()

  const shareState = state.contacts[0].profile.videoShare.videoShareState
  assert.equal(shareState.categoryStats['电影剪辑'].replied, 1)
  assert.equal(shareState.lastShared.engaged, true)
})

test('video share falls back to saved links when discovery fails', async () => {
  const today = localDateKey()
  const state = {
    contacts: [{ name: '小明' }],
    settings: {},
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const shares = []
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.discoverVideoShareItem = async () => { throw new Error('search failed') }
  service.sendNativeVideoShare = async (name, video, caption, metadata) => {
    shares.push({ name, video, caption, metadata })
    return { ok: true }
  }

  const result = await service.sendVideoShareTask('小明', {
    kind: 'videoShare',
    discoveryQuery: '搞笑',
    videos: [{ url: 'https://v.douyin.com/fallback/', title: '备用', note: '备用亮点' }],
    videoShareState: { date: today, sentToday: 0, usedVideoKeys: [] },
  })

  assert.equal(result.video.url, 'https://v.douyin.com/fallback/')
  assert.equal(shares[0].video.url, 'https://v.douyin.com/fallback/')
  assert.equal(result.message, result.caption)
  assert.equal(state.logs[0].type, 'video_share_discovery_fallback')
})

test('daily limit blocks every send path without time-based cooldown', () => {
  const now = Date.now()
  const storage = {
    state: {
      automation: { dailyLimit: 2 },
      sendHistory: [
        { at: new Date(now - 60_000).toISOString(), name: '小明' },
      ],
    },
    get() { return structuredClone(this.state) },
    update(patch) { this.state = { ...this.state, ...patch } },
    addLog() {},
  }
  const service = new DouyinService({ storage, emit: () => {} })

  assert.equal(service.getSendAllowance('小明', now).ok, true)
  assert.equal(service.getSendAllowance('小红', now).ok, true)
  storage.state.sendHistory.push({ at: new Date(now - 120_000).toISOString(), name: '小红' })
  assert.match(service.getSendAllowance('小刚', now).reason, /每日上限/)
})

test('auto reply sends once per new incoming message', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [{ keywords: ['消息'], replyText: '收到。' }], sparks: [], dailyLimit: 30, replyDelayMin: 0, replyDelayMax: 0 },
    sendHistory: [],
  }
  let preview = '新消息 1'
  const sent = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => false },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview }] })
  service.sendMessage = async (name, text) => { sent.push({ name, text }); return { ok: true } }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()
  await service.runAutomation()
  preview = '新消息 2'
  await service.runAutomation()

  assert.deepEqual(sent, [
    { name: '小明', text: '收到。' },
    { name: '小明', text: '收到。' },
  ])
})

test('keyword rule replies before AI', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [{ keywords: ['在吗'], replyText: '在的。' }], sparks: [], dailyLimit: 30, cooldown: 0, replyDelayMin: 0, replyDelayMax: 0 },
    sendHistory: [],
  }
  let aiCalls = 0
  const sent = []
  const storage = { get: () => structuredClone(state), addLog: () => {} }
  const service = new DouyinService({
    storage,
    emit: () => {},
    ai: { hasProvider: () => true, draft: async () => { aiCalls += 1; return { ok: true, text: 'AI 回复' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '你在吗' }] })
  service.sendMessage = async (name, text) => { sent.push({ name, text }); return { ok: true } }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(aiCalls, 0)
  assert.deepEqual(sent, [{ name: '小明', text: '在的。' }])
})

test('automation replies immediately without a second contact sync', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [{ keywords: ['在吗'], replyText: '在的。' }], sparks: [], dailyLimit: 30, cooldown: 0, replyDelayMin: 0, replyDelayMax: 0 },
    sendHistory: [],
  }
  let syncCount = 0
  let sends = 0
  const logs = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: (entry) => logs.push(entry) },
    emit: () => {},
    ai: { hasProvider: () => false },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => { syncCount += 1; return { contacts: [{ name: '小明', preview: '你在吗' }] } }
  service.sendMessage = async () => { sends += 1 }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(sends, 1)
  assert.equal(syncCount, 1)
  assert.equal(service.lastSeen.get('小明'), '你在吗')
  assert.equal(logs.length, 0)
})

test('automation checks for new messages every second', () => {
  assert.equal(AUTOMATION_POLL_MS, 1000)
})

test('AI reply uses saved contact context without blocking on live learning', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  let learningCalls = 0
  const drafted = []
  const sent = []
  const contact = { name: '小明', preview: '新消息', learning: { ownerStyle: { summary: '短句' } } }
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '马上回' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [contact] })
  service.learnConversation = async () => { learningCalls += 1 }
  service.sendMessage = async (name, text) => { sent.push({ name, text }) }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(learningCalls, 0)
  assert.equal(drafted[0].contact.learning.ownerStyle.summary, '短句')
  assert.deepEqual(sent, [{ name: '小明', text: '【AI · 当前模型】马上回' }])
})

test('automatic AI replies pass incoming message time to the model', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  const drafted = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '刚看到，昨晚那么晚还没睡啊' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '睡不着', sentAtLabel: '01:00', sentAt: '2026-07-22T01:00:00+08:00' }] })
  service.selectConversation = async () => null
  service.sendMessage = async () => ({ ok: true })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(drafted[0].incomingMeta.sentAtLabel, '01:00')
  assert.equal(drafted[0].incomingMeta.sentAt, '2026-07-22T01:00:00+08:00')
})

test('automatic AI replies do not send when the model chooses no reply', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 },
    sendHistory: [],
    logs: [],
  }
  const service = new DouyinService({
    storage: {
      get: () => structuredClone(state),
      update: (patch) => Object.assign(state, patch),
      addLog: (entry) => state.logs.unshift(entry),
    },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async () => ({ ok: true, text: '', labeledText: '' }) },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '昨晚吃夜宵吗', sentAtLabel: '昨天' }] })
  service.selectConversation = async () => null
  service.sendMessage = async () => assert.fail('no-reply AI decisions must not be sent')
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(service.lastSeen.get('小明'), '旧消息')
  assert.equal(state.logs[0].type, 'ai_empty')
})

test('automatic AI replies omit the model label when the setting is disabled', async () => {
  const state = {
    settings: { showAiModelLabel: false },
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  const sent = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async () => ({ ok: true, text: '我在呢', labeledText: '【AI · test-model】我在呢', model: 'test-model', aiLabel: 'AI · test-model' }) },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '在吗' }] })
  service.sendMessage = async (name, text) => sent.push({ name, text })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.deepEqual(sent, [{ name: '小明', text: '我在呢' }])
})

test('draft-only AI replies record suggestions without sending or using send limits', async () => {
  const state = {
    settings: { aiReplyDraftOnly: true },
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 1 },
    sendHistory: [{ at: new Date().toISOString(), name: 'someone', kind: 'text' }],
    logs: [],
  }
  const service = new DouyinService({
    storage: {
      get: () => structuredClone(state),
      update: (patch) => Object.assign(state, patch),
      addLog: (entry) => state.logs.unshift(entry),
    },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async () => ({ ok: true, text: 'I can reply like this.' }) },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'hello' }] })
  service.isLastMessageFromMe = async () => false
  service.selectConversation = async () => null
  service.sendMessage = async () => assert.fail('draft-only mode must not send messages')
  service.lastSeen.set('someone', 'old')

  await service.runAutomation()

  assert.equal(service.lastSeen.get('someone'), 'hello')
  assert.equal(state.logs[0].type, 'reply_drafted')
  assert.equal(state.logs[0].detail.name, 'someone')
  assert.equal(state.logs[0].detail.text, '【AI · 当前模型】I can reply like this.')
  assert.equal(state.sendHistory.length, 1)
})

test('spark completion persists across service restarts', async () => {
  const now = new Date()
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const state = {
    automation: { autoReply: false, blacklist: [], sparks: [{ id: 7, name: '小明', time, kind: 'text', message: '续火花', enabled: true }], dailyLimit: 30, cooldown: 0 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  let sends = 0
  const createService = () => {
    const service = new DouyinService({ storage, emit: () => {} })
    service.window = { isDestroyed: () => false }
    service.getStatus = async () => ({ connected: true })
    service.syncContacts = async () => ({ contacts: [] })
    service.isLastMessageFromMe = async () => false
    service.sendTask = async () => { sends += 1; return { ok: true } }
    return service
  }

  await createService().runAutomation()
  await createService().runAutomation()

  assert.equal(sends, 1)
  assert.match(state.automation.sparks[0].lastRunDate, /^\d{4}-\d{2}-\d{2}$/)
})

test('missed spark tasks are detected and filled later the same day', async () => {
  const state = {
    automation: {
      autoReply: false,
      blacklist: [],
      sparks: [{ id: 8, name: '小明', time: '00:00', kind: 'text', message: '续火花', enabled: true }],
      dailyLimit: 30,
    },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const service = new DouyinService({ storage, emit: () => {} })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  service.isLastMessageFromMe = async () => false
  let sends = 0
  service.sendTask = async () => { sends += 1; return { ok: true } }

  await service.runAutomation()

  assert.equal(sends, 1)
  assert.match(state.automation.sparks[0].lastRunDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(state.logs[0].type, 'spark_sent')
})

test('spark tasks send at their scheduled time when no conversation was sent today', async () => {
  const state = {
    automation: {
      autoReply: false,
      blacklist: [],
      sparks: [{ id: 9, name: '小明', time: '00:00', kind: 'text', message: '续火花', enabled: true }],
      dailyLimit: 30,
    },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const service = new DouyinService({ storage, emit: () => {} })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  let sends = 0
  service.sendTask = async () => { sends += 1; return { ok: true } }

  await service.runAutomation()

  assert.equal(sends, 1)
  assert.match(state.automation.sparks[0].lastRunDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(state.logs[0].type, 'spark_sent')
})

test('spark tasks skip when this contact already has a sent conversation today', async () => {
  const state = {
    automation: { autoReply: false, blacklist: [], sparks: [{ id: 11, name: '小明', time: '00:00', kind: 'text', message: '续火花', enabled: true }], dailyLimit: 30 },
    sendHistory: [{ at: new Date().toISOString(), name: '小明', kind: 'text' }],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const service = new DouyinService({ storage, emit: () => {} })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  service.sendTask = async () => assert.fail('a contact with a sent message today must not receive a spark task')

  await service.runAutomation()

  assert.match(state.automation.sparks[0].lastRunDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(state.logs[0].type, 'spark_fill_skipped')
  assert.equal(state.logs[0].detail.reason, 'sent_today')
})

test('spark tasks do not depend on last-message ownership', async () => {
  const state = {
    automation: {
      autoReply: false,
      blacklist: [],
      sparks: [{ id: 10, name: '小明', time: '00:00', kind: 'text', message: '续火花', enabled: true }],
      dailyLimit: 30,
    },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const service = new DouyinService({ storage, emit: () => {} })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  let sends = 0
  service.sendTask = async () => { sends += 1; return { ok: true } }

  await service.runAutomation()

  assert.equal(sends, 1)
  assert.match(state.automation.sparks[0].lastRunDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(state.logs[0].type, 'spark_sent')
})

test('daily send limit does not consume an incoming message', async () => {
  const now = Date.now()
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [], sparks: [], dailyLimit: 1 },
    sendHistory: [{ at: new Date(now - 1000).toISOString(), name: 'someone', kind: 'text' }],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'new incoming' }] })
  service.lastSeen.set('someone', 'old incoming')
  service.sendMessage = async () => assert.fail('daily limit must block sending')

  await service.runAutomation()

  assert.equal(service.lastSeen.get('someone'), 'old incoming')
  assert.equal(state.logs[0].type, 'send_blocked')
})

test('paused automation keeps a new message pending until resumed', async () => {
  const state = {
    automation: { autoReply: true, paused: true, blacklist: [], aiDisabledContacts: [], rules: [{ keywords: ['hello'], replyText: 'received' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: () => {},
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'hello' }] })
  service.lastSeen.set('someone', 'old')
  const sent = []
  service.sendMessage = async (name, text) => sent.push({ name, text })

  await service.runAutomation()
  assert.equal(service.lastSeen.get('someone'), 'old')
  assert.equal(sent.length, 0)

  state.automation.paused = false
  await service.runAutomation()
  assert.deepEqual(sent, [{ name: 'someone', text: 'received' }])
})

test('re-enabling a contact processes the message that was blocked', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: ['someone'], rules: [{ keywords: ['hello'], replyText: 'received' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: () => {},
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'hello' }] })
  service.lastSeen.set('someone', 'hello')
  const sent = []
  service.sendMessage = async (name, text) => sent.push({ name, text })

  await service.runAutomation()
  state.automation.aiDisabledContacts = []
  await service.runAutomation()

  assert.deepEqual(sent, [{ name: 'someone', text: 'received' }])
})

test('a weak list fromMe=false marker is verified before replying', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [{ keywords: ['reply'], replyText: 'received' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'my reply', fromMe: false }] })
  service.lastSeen.set('someone', 'old')
  service.isLastMessageFromMe = async () => true
  service.sendMessage = async () => assert.fail('our own message must not trigger an automatic reply')

  await service.runAutomation()

  assert.equal(state.logs[0].type, 'auto_skip')
  assert.equal(service.lastSeen.get('someone'), 'my reply')
})

test('incoming bracketed sticker previews are not skipped by a weak self-message check', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [{ keywords: ['[嗨]'], replyText: '嗨嗨' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const sent = []
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: '[嗨]', fromMe: null }] })
  service.lastSeen.set('someone', 'old')
  service.isLastMessageFromMe = async () => true
  service.sendMessage = async (name, text) => { sent.push({ name, text }); service.lastSeen.set(name, text) }

  await service.runAutomation()

  assert.deepEqual(sent, [{ name: 'someone', text: '嗨嗨' }])
  assert.notEqual(state.logs[0]?.type, 'auto_skip')
})

test('recent own bracketed sticker previews are skipped after emoji send uncertainty', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [{ keywords: ['[morning]'], replyText: 'must not send' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: '[morning]', fromMe: null }] })
  service.lastSeen.set('someone', 'old')
  service.rememberSelfPreview('someone', '[morning]')
  service.isLastMessageFromMe = async () => false
  service.sendMessage = async () => assert.fail('our own recent emoji preview must not trigger an automatic reply')

  await service.runAutomation()

  assert.equal(state.logs[0].type, 'auto_skip')
  assert.equal(service.lastSeen.get('someone'), '[morning]')
})

test('stale own bracketed sticker previews can still be treated as incoming', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [{ keywords: ['[morning]'], replyText: 'morning back' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const sent = []
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: '[morning]', fromMe: null }] })
  service.lastSeen.set('someone', 'old')
  service.lastSent.set('someone', '[morning]')
  service.lastSentAt.set('someone', Date.now() - 120_000)
  service.isLastMessageFromMe = async () => false
  service.sendMessage = async (name, text) => { sent.push({ name, text }); service.lastSeen.set(name, text) }

  await service.runAutomation()

  assert.deepEqual(sent, [{ name: 'someone', text: 'morning back' }])
  assert.notEqual(state.logs[0]?.type, 'auto_skip')
})

test('missing provider keeps an incoming message pending', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [], sparks: [], dailyLimit: 30 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'hello' }] })
  service.lastSeen.set('someone', 'old')

  await service.runAutomation()

  assert.equal(service.lastSeen.get('someone'), 'old')
  assert.equal(state.logs[0].type, 'ai_unavailable')
})
