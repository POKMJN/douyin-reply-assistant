const assert = require('node:assert/strict')
const Module = require('node:module')
const test = require('node:test')
const vm = require('node:vm')

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: class {}, session: {} }
  return originalLoad.call(this, request, parent, isMain)
}

const {
  DouyinService,
  extractPublicCommentItemText,
  extractReactAwemeId,
  hasPublicMediaContext,
  isUnavailableMediaReply,
  mediaPreviewKind,
  mergePublicMediaContext,
  normalizeCommentContext,
  normalizeCapturedMedia,
  normalizeVisibleMediaContext,
  pickLatestChatMessageRole,
  shouldUseVideoFrameFallback,
  videoRecognitionOptions,
} = require('../electron/douyin-service.cjs')
const {
  buildChatMessages,
  normalizeVideoInput,
  replyQualityIssues,
} = require('../electron/ai-service.cjs')

test.after(() => {
  Module._load = originalLoad
})

test('ignores emoji-like toolbar nodes outside chat message rows', () => {
  const role = pickLatestChatMessageRole([
    {
      withinMessageRow: false,
      rect: { top: 760, left: 980, width: 32, height: 32 },
      me: true,
    },
    {
      withinMessageRow: true,
      rect: { top: 520, left: 128, width: 180, height: 56 },
      them: true,
    },
  ], {
    innerWidth: 1200,
    editorRect: { left: 0, width: 1200 },
  })

  assert.equal(role, 'contact')
})

test('does not classify a stray emoji node as my last message by itself', () => {
  const role = pickLatestChatMessageRole([
    {
      withinMessageRow: false,
      rect: { top: 760, left: 980, width: 32, height: 32 },
      me: true,
    },
  ], {
    innerWidth: 1200,
    editorRect: { left: 0, width: 1200 },
  })

  assert.equal(role, null)
})

test('falls back to bubble position for valid message rows without role classes', () => {
  assert.equal(pickLatestChatMessageRole([
    {
      withinMessageRow: true,
      rect: { top: 200, left: 820, width: 160, height: 48 },
    },
  ], {
    innerWidth: 1200,
    editorRect: { left: 0, width: 1200 },
  }), 'me')

  assert.equal(pickLatestChatMessageRole([
    {
      withinMessageRow: true,
      rect: { top: 200, left: 120, width: 160, height: 48 },
    },
  ], {
    innerWidth: 1200,
    editorRect: { left: 0, width: 1200 },
  }), 'contact')
})

test('syncContacts persists merged contact previews from Douyin', async () => {
  const events = []
  const storage = {
    state: {
      contacts: [{
        id: 'Ada',
        name: 'Ada',
        preview: 'old preview',
        profile: { personality: 'warm' },
        learning: { messages: [{ role: 'contact', text: 'hello' }] },
      }],
    },
    get() {
      return structuredClone(this.state)
    },
    update(patch) {
      this.state = { ...this.state, ...patch }
      return this.get()
    },
  }
  const service = new DouyinService({ storage, emit: (event) => events.push(event) })
  service.waitForChatReady = async () => ({
    webContents: {
      executeJavaScript: async () => [{
        id: 'Ada',
        name: 'Ada',
        avatar: 'avatar.png',
        fire: 12,
        preview: 'new preview',
        messageKey: 'new preview',
        sentAtLabel: '12:34',
      }],
    },
  })

  const result = await service.syncContacts()

  assert.equal(result.contacts[0].preview, 'new preview')
  assert.equal(storage.state.contacts[0].preview, 'new preview')
  assert.deepEqual(storage.state.contacts[0].profile, { personality: 'warm' })
  assert.equal(storage.state.contacts[0].learning.messages[0].text, 'hello')
  assert.equal(events.at(-1).type, 'contacts')
  assert.equal(events.at(-1).payload.contacts[0].preview, 'new preview')
})

test('automation handles a new media bubble when the conversation preview is unchanged', async () => {
  const preview = '\u5206\u4eab[\u56fe\u96c6]'
  const listKey = `${preview}\u241f1`
  const sent = []
  const storage = {
    state: {
      settings: {},
      automation: {
        autoReply: true,
        paused: false,
        rules: [{ enabled: true, keywords: ['\u5206\u4eab'], replyText: '\u6536\u5230' }],
        sparks: [],
      },
      contacts: [],
    },
    get() {
      return structuredClone(this.state)
    },
    update(patch) {
      this.state = { ...this.state, ...patch }
      return this.get()
    },
  }
  const service = new DouyinService({ storage })
  service.window = { isDestroyed: () => false }
  service.lastSeen.set('Ada', listKey)
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({
    contacts: [{
      id: 'Ada',
      name: 'Ada',
      preview,
      messageKey: listKey,
      unread: '1',
      sentAtLabel: '\u521a\u521a',
    }],
  })
  service.captureLatestIncomingMessageIdentity = async () => ({
    role: 'contact',
    fingerprint: 'bubble-2',
  })
  service.getSendAllowance = () => ({ ok: true })
  service.isLastMessageFromMe = async () => false
  service.recordVideoShareEngagement = () => null
  service.recordConversationMessage = (_name, _role, _text, contact) => contact
  service.sendMessage = async (name, text) => {
    sent.push({ name, text })
  }

  await service.runAutomation()
  await service.runAutomation()

  assert.deepEqual(sent, [{ name: 'Ada', text: '\u6536\u5230' }])
})

test('automation replies to a recent unread media preview on first sync', async () => {
  const preview = '\u5206\u4eab[\u89c6\u9891]'
  const sent = []
  const storage = {
    state: {
      settings: {},
      automation: {
        autoReply: true,
        paused: false,
        rules: [{ enabled: true, keywords: ['\u5206\u4eab'], replyText: '\u6536\u5230' }],
        sparks: [],
      },
      contacts: [],
    },
    get() {
      return structuredClone(this.state)
    },
    update(patch) {
      this.state = { ...this.state, ...patch }
      return this.get()
    },
  }
  const service = new DouyinService({ storage })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({
    contacts: [{
      id: 'Ada',
      name: 'Ada',
      preview,
      messageKey: preview,
      unread: '1',
      sentAtLabel: '\u521a\u521a',
    }],
  })
  service.captureLatestIncomingMessageIdentity = async () => ({
    role: 'contact',
    fingerprint: 'first-media',
  })
  service.getSendAllowance = () => ({ ok: true })
  service.isLastMessageFromMe = async () => false
  service.recordVideoShareEngagement = () => null
  service.recordConversationMessage = (_name, _role, _text, contact) => contact
  service.sendMessage = async (name, text) => {
    sent.push({ name, text })
  }

  await service.runAutomation()

  assert.deepEqual(sent, [{ name: 'Ada', text: '\u6536\u5230' }])
})

test('automation falls back to text AI when broad media preview detection has replyable text', async () => {
  const preview = '\u4f60\u770b\u770b\u6ca1\u9f3b\u5b50\u6ca1\u773c\ud83d\udc40'
  const sent = []
  const drafts = []
  const logs = []
  const storage = {
    state: {
      settings: { showAiModelLabel: false },
      providers: [{ name: 'mock', model: 'mock-model', capabilities: ['vision'] }],
      automation: {
        autoReply: true,
        paused: false,
        rules: [],
        sparks: [],
      },
      contacts: [],
    },
    get() {
      return structuredClone(this.state)
    },
    update(patch) {
      this.state = { ...this.state, ...patch }
      return this.get()
    },
  }
  const service = new DouyinService({ storage })
  service.ai = {
    hasProvider: () => true,
    analyzeConversation: (messages) => ({ messages }),
    draft: async (payload) => {
      drafts.push(payload)
      return { ok: true, text: '\u54c8\u54c8\u8fd9\u4e2a\u5f62\u5bb9\u592a\u6709\u753b\u9762\u4e86', model: 'mock-model', provider: 'mock' }
    },
  }
  service.log = (type, message, meta) => logs.push({ type, message, meta })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({
    contacts: [{
      id: 'Ada',
      name: 'Ada',
      preview,
      messageKey: preview,
      unread: '1',
      sentAtLabel: '\u521a\u521a',
    }],
  })
  service.captureLatestIncomingMessageIdentity = async () => ({
    role: 'contact',
    fingerprint: 'text-that-looks-media',
  })
  service.captureLatestIncomingMedia = async () => normalizeCapturedMedia({
    frames: [],
    mediaKind: 'media',
    confidence: 'none',
    reason: 'no_visible_media_bubble',
  }, 'video')
  service.selectConversation = async () => null
  service.getSendAllowance = () => ({ ok: true })
  service.isLastMessageFromMe = async () => false
  service.recordVideoShareEngagement = () => null
  service.recordConversationMessage = (_name, _role, _text, contact) => contact
  service.sendMessage = async (name, text) => {
    sent.push({ name, text })
  }

  await service.runAutomation()

  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].incoming, preview)
  assert.equal(drafts[0].videoFrames, undefined)
  assert.deepEqual(sent, [{ name: 'Ada', text: '\u54c8\u54c8\u8fd9\u4e2a\u5f62\u5bb9\u592a\u6709\u753b\u9762\u4e86' }])
  assert.equal(logs.some((entry) => entry.type === 'video_unreadable' || entry.type === 'media_uncertain'), false)
})

test('public-page recognition modes skip frames and audio', () => {
  assert.deepEqual(videoRecognitionOptions({ videoRecognitionStrength: 'comments20' }), {
    strength: 'comments20',
    maxFrames: 0,
    audio: false,
    commentLimit: 20,
    commentWaitMs: 3500,
    commentScrolls: 4,
    publicPageOnly: true,
  })

  assert.deepEqual(videoRecognitionOptions({ videoRecognitionStrength: 'comments30' }), {
    strength: 'comments30',
    maxFrames: 0,
    audio: false,
    commentLimit: 30,
    commentWaitMs: 4500,
    commentScrolls: 6,
    publicPageOnly: true,
  })
})

test('shared-comment previews are treated as media and unavailable replies are unsafe', () => {
  assert.equal(mediaPreviewKind('分享[评论]'), 'share')
  assert.equal(mediaPreviewKind('分享 [ 评论 ]'), 'share')
  assert.equal(isUnavailableMediaReply('我这边只显示分享评论，没看到内容诶，你截我看看呀'), true)
  assert.equal(isUnavailableMediaReply('这个梗还挺戳的'), false)
})

test('comment context supports up to thirty comments and longer copy', () => {
  const comments = Array.from({ length: 35 }, (_, index) => `comment ${index + 1}`)
  const description = '文案'.repeat(260)
  const normalized = normalizeCommentContext({ description, comments }, 30)

  assert.equal(normalized.videoComments.length, 30)
  assert.equal(normalized.videoComments.at(-1), 'comment 30')
  assert.equal(normalized.videoPageDescription.length, 500)
})

test('public-page modes fall back to frame capture when public context is unavailable', () => {
  const recognition = videoRecognitionOptions({ videoRecognitionStrength: 'comments20' })
  const mediaCapture = normalizeCapturedMedia({
    frames: [],
    mediaKind: 'video',
    detectedVideo: true,
    confidence: 'none',
    reason: 'public_page_only',
  }, 'video')

  assert.equal(hasPublicMediaContext(mediaCapture), false)
  assert.equal(shouldUseVideoFrameFallback(recognition, mediaCapture), true)
})

test('public-page modes skip frame capture when public context is available', () => {
  const recognition = videoRecognitionOptions({ videoRecognitionStrength: 'comments20' })
  const mediaCapture = normalizeCapturedMedia({
    frames: [],
    mediaKind: 'video',
    videoPageDescription: '这个职场反转后面有个点挺妙呀',
    videoComments: ['这段太真实了', '最后反转笑死'],
    confidence: 'medium',
    reason: 'public_page_only',
  }, 'video')

  assert.equal(hasPublicMediaContext(mediaCapture), true)
  assert.equal(shouldUseVideoFrameFallback(recognition, mediaCapture), false)
})

test('public text and comments are usable without frames', () => {
  const mediaCapture = normalizeCapturedMedia({
    frames: [],
    mediaKind: 'video',
    videoPageDescription: '这个职场反转后面有个点挺妙呀',
    videoComments: ['这段太真实了', '最后反转笑死'],
    confidence: 'medium',
    reason: 'public_page_only',
  }, 'video')

  assert.equal(hasPublicMediaContext(mediaCapture), true)
  assert.equal(mediaCapture.frames.length, 0)
  assert.equal(mediaCapture.videoComments.length, 2)
})

test('shared-comment cards preserve the visible comment and copy without using the author as a title', () => {
  const cardText = [
    '分享 @zmjjkk 的评论',
    '起码累着自己了😍',
    '来自视频',
    '“我去，不早说” #冷知识 #生活小妙招',
  ].join('\n')

  const visible = normalizeVisibleMediaContext(cardText, 20)
  assert.equal(visible.videoPageTitle, '')
  assert.equal(visible.videoPageDescription, '“我去，不早说” #冷知识 #生活小妙招')
  assert.equal(visible.videoSharedComment, '起码累着自己了😍')
  assert.deepEqual(visible.videoComments, ['起码累着自己了😍'])
  const compact = normalizeVisibleMediaContext(cardText.replace(/\n/g, ' '), 20)
  assert.equal(compact.videoPageDescription, '“我去，不早说” #冷知识 #生活小妙招')
  assert.deepEqual(compact.videoComments, ['起码累着自己了😍'])
  const graphicCard = normalizeVisibleMediaContext(cardText.replace('来自视频', '来自图文'), 20)
  assert.equal(graphicCard.videoPageDescription, '“我去，不早说” #冷知识 #生活小妙招')

  const merged = mergePublicMediaContext({
    videoPageTitle: 'zmjjkk的作品 - 抖音',
    videoPageAuthor: '@zmjjkk',
    videoComments: [],
    videoCommentError: 'public page unavailable',
  }, cardText, 20)
  assert.equal(merged.videoPageTitle, '')
  assert.equal(merged.videoPageDescription, '“我去，不早说” #冷知识 #生活小妙招')
  assert.equal(merged.videoSharedComment, '起码累着自己了😍')
  assert.deepEqual(merged.videoComments, ['起码累着自己了😍'])
})

test('comment20 mode reads the current public comment page when a card has no URL', async () => {
  const comments = Array.from({ length: 20 }, (_, index) => `公开热评${index + 1}`)
  const scripts = []
  const service = new DouyinService({
    storage: {
      get: () => ({ settings: {} }),
      addLog: () => {},
    },
  })
  const sourceWindow = {
    webContents: {
      executeJavaScript: async (script) => {
        scripts.push(script)
        assert.doesNotThrow(() => new Function(script))
        if (script.includes('const href =')) return { href: 'https://www.douyin.com/video/123', isPublicVideo: true }
        if (script.includes('const scrollers =')) return true
        if (script.includes('const limit =')) return { title: '标题', description: '视频文案', author: '作者', comments, source: 'https://www.douyin.com/video/123' }
        return false
      },
    },
  }

  const publicContext = await service.readVideoCommentContext(
    { shareUrl: '' },
    '测试联系人',
    { commentLimit: 20, commentWaitMs: 0, commentScrolls: 1 },
    sourceWindow,
  )
  assert.equal(publicContext.videoComments.length, 20)
  assert.equal(publicContext.videoComments.at(-1), '公开热评20')
  assert.equal(scripts.some((script) => script.includes('const href =')), true)

  const merged = mergePublicMediaContext(publicContext, ['分享 @作者 的评论', '反讽评论🤣', '来自视频', '视频文案'].join('\n'), 20)
  assert.equal(merged.videoSharedComment, '反讽评论🤣')
  assert.equal(merged.videoComments[0], '反讽评论🤣')
  assert.equal(merged.videoComments.length, 20)
  assert.equal(merged.videoComments.includes('公开热评19'), true)
  assert.equal(merged.videoComments.includes('公开热评20'), false)
})

test('public context never treats a bare card author as the video title', () => {
  const merged = mergePublicMediaContext({
    videoPageTitle: 'DreamCars Global',
    videoPageAuthor: '',
    videoPageDescription: '',
    videoComments: [],
  }, 'DreamCars Global', 20)

  assert.equal(merged.videoPageTitle, '')
  assert.equal(merged.videoPageDescription, '')
})

test('public comment items keep only the comment body', () => {
  const itemText = [
    '\u2022\u0300\u1d17\u2022\u0301',
    '...',
    '\u9a81\u9f99\u903c\u51fa\u4e86\u795e\u7136\u540e\u5929\u73919300\u903c\u51fa\u4e86\u771f\u795e\u9a81\u9f998\u81f3\u5c0a',
    '3\u5468\u524d\u00b7\u6d59\u6c5f',
    '6235',
    '\u5206\u4eab',
    '\u56de\u590d',
    '\u5c55\u5f0087\u6761\u56de\u590d',
  ].join('\n')

  assert.equal(
    extractPublicCommentItemText(itemText),
    '\u9a81\u9f99\u903c\u51fa\u4e86\u795e\u7136\u540e\u5929\u73919300\u903c\u51fa\u4e86\u771f\u795e\u9a81\u9f998\u81f3\u5c0a',
  )
})

test('Douyin share cards expose the public video ID through React message props', () => {
  const itemId = '7667524409142862409'
  const card = {
    querySelectorAll: () => [],
    __reactFiber$test: {
      memoizedProps: { className: 'MessageItemShareAwemecontainer' },
      return: {
        memoizedProps: {
          message: {
            parsedContent: {
              itemId,
              share_id: `2222550868838032_1785734174567_${itemId}`,
            },
          },
        },
        return: null,
      },
    },
  }

  assert.equal(extractReactAwemeId(card), itemId)
})

test('comment20 mode keeps comments captured from the public comment API', async () => {
  const apiComments = [
    '骁龙逼出了神然后天玑9300逼出了真神骁龙8至尊',
    '你惊动了一位神',
  ]
  const service = new DouyinService({
    storage: {
      get: () => ({ settings: {} }),
      addLog: () => {},
    },
  })
  const sourceWindow = {
    webContents: {
      executeJavaScript: async (script) => {
        assert.doesNotThrow(() => new Function(script))
        if (script.includes('const href =')) return { href: 'https://www.douyin.com/video/123', isPublicVideo: true }
        if (script.includes('const scrollers =')) return true
        if (script.includes('const limit =')) {
          return {
            title: 'DreamCars Global',
            description: '',
            author: '',
            apiComments,
            comments: [],
            source: 'https://www.douyin.com/video/123',
          }
        }
        return false
      },
    },
  }

  const publicContext = await service.readVideoCommentContext(
    { shareUrl: '' },
    '测试联系人',
    { commentLimit: 20, commentWaitMs: 0, commentScrolls: 1 },
    sourceWindow,
  )

  assert.deepEqual(publicContext.videoComments, apiComments)
})

test('media replies exclude author names and reject unloaded-media language', () => {
  const media = normalizeVideoInput({
    mediaKind: 'video',
    videoPageAuthor: 'xiang先生',
    videoPageDescription: '这个小妙招居然真有用',
    videoSharedComment: '起码累着自己了😍',
    videoComments: ['起码累着自己了😍'],
  })
  const messages = buildChatMessages({ name: '小明' }, '分享[评论]', [], '', media)
  const prompt = String(messages.at(-1).content)

  assert.match(prompt, /这个小妙招居然真有用/)
  assert.match(prompt, /起码累着自己了/)
  assert.match(prompt, /当前分享的评论：起码累着自己了/)
  assert.doesNotMatch(prompt, /xiang先生/)
  assert.match(replyQualityIssues('还是没加载出来，截个图吧', true).join('、'), /媒体未加载或要求对方截图/)
})

test('latest-message identity marks the row reused by media capture', async () => {
  const service = new DouyinService({ storage: { get: () => ({ settings: {} }) } })
  const scripts = []
  service.selectConversation = async () => ({
    webContents: {
      executeJavaScript: async (script) => {
        scripts.push(script)
        assert.doesNotThrow(() => new Function(script))
        return { role: 'contact', fingerprint: 'msg-test', media: true }
      },
    },
  })
  service.waitForEditor = async () => true

  const result = await service.captureLatestIncomingMessageIdentity('Ada')
  assert.equal(result.fingerprint, 'msg-test')
  assert.equal(result.role, 'contact')
  assert.equal(scripts.length, 1)
  assert.match(scripts[0], /data-xusheng-latest-message/)
  assert.match(scripts[0], /MessageBoxContentrowBox/)
})

test('media capture prefers the latest row marked by identity capture', async () => {
  const service = new DouyinService({ storage: { get: () => ({ settings: {} }) } })
  const scripts = []
  service.selectConversation = async () => ({
    webContents: {
      executeJavaScript: async (script) => {
        scripts.push(script)
        assert.doesNotThrow(() => new Function(script))
        return null
      },
    },
  })
  service.waitForEditor = async () => true

  const result = await service.captureLatestIncomingMedia('测试联系人', videoRecognitionOptions({ videoRecognitionStrength: 'comments20' }))
  assert.equal(result.reason, 'no_visible_media_bubble')
  assert.match(scripts[0], /__xushengFetchHook/)
  assert.match(scripts[1], /querySelector\('\[data-xusheng-latest-message="contact"\]'\)/)
})

test('public-page capture accepts a matched numeric video ID without clicking the card', async () => {
  const currentId = '7660538946628645364'
  const pageWindow = {
    __xushengVideoIds: [currentId],
    __xushengVideoInfo: new Map([[
      currentId,
      { author: 'current-author', desc: 'current-description', title: 'current-title', at: Date.now() },
    ]]),
  }
  const webContents = {
    sendInputEvent: () => {
      throw new Error('matched hook ID should not click the card')
    },
    executeJavaScript: async (script) => {
      if (script.includes('if (window.__xushengFetchHook) return true')) return true
      if (script.includes("document.querySelectorAll('[data-xusheng-media-capture]')")) {
        return {
          isVideo: true,
          duration: 0,
          videoUrl: '',
          shareUrl: '',
          shareText: 'current-author',
          domHint: null,
          playIconPoint: null,
          coverPoint: null,
          posterUrl: '',
          openPoint: { x: 420, y: 609 },
          videoRect: null,
          rect: { x: 300, y: 400, width: 240, height: 180 },
        }
      }
      if (script.includes('let fresh = 0')) return 1
      if (script.includes('const cardText =')) return vm.runInNewContext(script, { window: pageWindow })
      throw new Error(`Unexpected script: ${script.slice(0, 80)}`)
    },
  }
  const service = new DouyinService({
    storage: {
      get: () => ({ settings: {} }),
      addLog: () => {},
    },
  })
  service.selectConversation = async () => ({ webContents })
  service.waitForEditor = async () => true
  let capturedShareUrl = ''
  service.readVideoCommentContext = async (media) => {
    capturedShareUrl = media.shareUrl
    return {}
  }

  const result = await service.captureLatestIncomingMedia(
    'Ada',
    videoRecognitionOptions({ videoRecognitionStrength: 'comments20' }),
  )

  assert.equal(capturedShareUrl, `https://www.douyin.com/video/${currentId}`)
  assert.equal(result.videoPageUrlFound, true)
})

test('public-page capture never treats an unrelated historical video as the current card', async () => {
  const historicalId = '7660538946628645364'
  const pageWindow = {
    __xushengVideoIds: [historicalId],
    __xushengVideoInfo: new Map([[
      historicalId,
      { author: 'old-author', desc: 'old-description', title: 'old-title', at: Date.now() },
    ]]),
  }
  let clicked = false
  const webContents = {
    sendInputEvent: (event) => {
      if (event.type === 'mouseUp') clicked = true
    },
    executeJavaScript: async (script) => {
      if (script.includes('if (window.__xushengFetchHook) return true')) return true
      if (script.includes("document.querySelectorAll('[data-xusheng-media-capture]')")) {
        return {
          isVideo: true,
          duration: 0,
          videoUrl: '',
          shareUrl: '',
          shareText: 'current-author',
          domHint: null,
          playIconPoint: null,
          coverPoint: null,
          posterUrl: '',
          openPoint: { x: 420, y: 609 },
          videoRect: null,
          rect: { x: 300, y: 400, width: 240, height: 180 },
        }
      }
      if (script.includes('let fresh = 0')) return 1
      if (script.includes('const cardText =')) return vm.runInNewContext(script, { window: pageWindow })
      if (script === 'location.href') return 'https://www.douyin.com/chat'
      if (script.includes('const globals =')) return ''
      if (script.includes('const closeBtn =')) return false
      if (script.includes('const last = ids.at(-1)')) return historicalId
      if (script.includes('const authors =')) return { len: 1, last: historicalId, all: [historicalId], authors: ['old-author'] }
      throw new Error(`Unexpected script: ${script.slice(0, 80)}`)
    },
  }
  const service = new DouyinService({
    storage: {
      get: () => ({ settings: {} }),
      addLog: () => {},
    },
  })
  service.selectConversation = async () => ({ webContents })
  service.waitForEditor = async () => true
  service.readVideoCommentContext = async () => ({})

  const result = await service.captureLatestIncomingMedia(
    'Ada',
    videoRecognitionOptions({ videoRecognitionStrength: 'comments20' }),
  )

  assert.equal(clicked, true)
  assert.equal(result.videoPageUrlFound, false)
})
