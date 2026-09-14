// 构建脚本：从旧 douyin-service.cjs 剪裁生成 v2 automation.cjs
// - 剪除：视频分享任务（~600 行死代码）、话题库/热榜、话题代问、clickPagePoint/waitForPagePoint
// - 替换：runAutomation → 引擎驱动的轮次状态机版本
// 用法：node tools/build-automation.cjs
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', '..', '_extracted', 'app-current', 'electron', 'douyin-service.cjs')
const DEST = path.join(__dirname, '..', 'electron', 'automation.cjs')

const lines = fs.readFileSync(SRC, 'utf8').split('\n') // 0-based; line N (1-based) = lines[N-1]
const range = (a, b) => lines.slice(a - 1, b) // inclusive 1-based

// 保留区间（1-based 闭区间）
const segments = [
  range(1, 29),     // 头部 require + 常量 + computePollDelay/humanReplyDelay
  range(88, 571),   // sleep..resolveSparkTask（spark 文案池）
  range(731, 865),  // normalizeHistoryMessage..shouldDeferConsumptionOnFromMe
  range(892, 948),  // pureMediaPreviewPattern..shouldUseVideoFrameFallback
  range(966, 1263), // extractConversationPreview..readVideoCommentContext
  range(1367, 2502),// ensureWindow..recordConversationMessage
  range(2551, 2652),// waitForEditor..sendTask 前两行
  range(2654, 2689),// sendTask 其余 + sendAiSparkTask
  range(3198, 3511),// processProactiveChats..startWorker
  range(3935, 3954),// log/emitEvent/destroy + 类结束
]

let out = segments.map((seg) => seg.join('\n')).join('\n').replace(/\r\n/g, '\n') // 源文件是 CRLF，统一为 LF 便于后续字符串锚点匹配

// ---- 修补 ----
// 1) sendTask：去掉 videoShare 分支
out = out.replace(
  "    if (effectiveTask?.kind === 'aiSpark') return this.sendAiSparkTask(name, effectiveTask)\n    if (isVideoShareTask(effectiveTask)) return this.sendVideoShareTask(name, effectiveTask)\n",
  "    if (effectiveTask?.kind === 'aiSpark') return this.sendAiSparkTask(name, effectiveTask)\n",
)
if (out.includes('isVideoShareTask')) throw new Error('isVideoShareTask 残留')

// 2) 发现窗口：允许后台节流 + 用完即毁（内存优化：不再常驻一个隐藏浏览器窗口）
out = out.replace(
  `  ensureDiscoveryWindow() {
    if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) return this.discoveryWindow`,
  `  ensureDiscoveryWindow() {
    if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) {
      this.scheduleDiscoveryCleanup()
      return this.discoveryWindow
    }`,
)
out = out.replace(
  `        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    // 后台窗口静音：搜索/观看视频时页面自动播放不发出任何声音，画面照常渲染`,
  `        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    // 后台窗口静音：搜索/观看视频时页面自动播放不发出任何声音，画面照常渲染`,
)
out = out.replace(
  `    this.discoveryWindow.webContents.setWindowOpenHandler(({ url }) => (/^bytedance:/i.test(url) ? { action: 'deny' } : { action: 'deny' }))
    return this.discoveryWindow
  }`,
  `    this.discoveryWindow.webContents.setWindowOpenHandler(({ url }) => (/^bytedance:/i.test(url) ? { action: 'deny' } : { action: 'deny' }))
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
  }`,
)
if (out.includes('backgroundThrottling: false,\n        nodeIntegration')) throw new Error('discovery throttling 未替换')

// 3) destroy：清理发现窗口定时器
out = out.replace(
  `  destroy() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }`,
  `  destroy() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    if (this._discoveryCleanupTimer) { clearTimeout(this._discoveryCleanupTimer); this._discoveryCleanupTimer = null }`,
)

// 4) 引入对话引擎 + 续火花今日播报素材（天气/热点）
out = out.replace(
  "const { analyzeLanguageStyle, daysSinceContact, factText } = require('./ai-service.cjs')",
  "const { analyzeLanguageStyle, daysSinceContact, factText, fetchWeatherContext, fetchHotTopicsCached, hotTopicForSparkCached } = require('./ai-service.cjs')\nconst { shouldAutoReply, dailyMessageKey } = require('./conversation-engine.cjs')",
)

// 4.5) sendAiSparkTask：抓取今日天气与热点，注入"今日播报"式续火花
out = out.replace(
  "      const draft = await this.ai.draftSparkMessage({ contact, task })",
  `      let sparkWeather = ''
      let sparkHotTopic = ''
      try { await fetchHotTopicsCached() } catch { /* 热点抓取失败不阻塞，热点段落自动跳过 */ }
      try { sparkWeather = await fetchWeatherContext(this.storage) } catch { sparkWeather = '' }
      try { sparkHotTopic = hotTopicForSparkCached() } catch { sparkHotTopic = '' }
      const draft = await this.ai.draftSparkMessage({ contact, task, weather: sparkWeather, hotTopic: sparkHotTopic })`,
)
if (!out.includes('sparkWeather')) throw new Error('续火花天气注入失败')
if (!out.includes('await fetchHotTopicsCached()')) throw new Error('热点抓取调用未注入')

// 4.5b) 拒发/失败回退：用真实天气拼最小播报，替代陈旧套话（旧文案"我来补个今日份消息"）
out = out.replace(
  "    if (!text) {\n      text = String(task?.message || '').trim() || '今天也来续个火花呀～'\n      aiMeta = { source: 'spark_text' }\n    }",
  `    if (!text) {
      const hourNow = new Date().getHours()
      const greeting = hourNow < 11 ? '早上好呀' : hourNow < 14 ? '中午好' : hourNow < 18 ? '下午好' : '晚上好'
      text = sparkWeather ? \`\${greeting}，\${sparkWeather}。照顾好自己呀\` : (String(task?.message || '').trim() || \`\${greeting}，今天也要照顾好自己呀\`)
      aiMeta = { source: 'spark_text' }
    }`,
)
if (!out.includes('照顾好自己')) throw new Error('天气兜底文案未注入')

// 5) 插入新的 runAutomation（旧实现已被区间排除；新实现插在 log 方法之前）
const logIdx = out.indexOf('  log(type, message, detail = {}) {')
if (logIdx < 0) throw new Error('未找到 log 方法锚点')

const NEW_RUN = `  // 轮次状态持久化：把对话引擎的 turn 状态写回联系人记录
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

  async runAutomation() {
    if (this.polling) return
    const state = this.storage.get()
    const config = state.automation || {}
    const settings = state.settings || {}
    if (settings.quietHours) {
      const toMinutes = (value) => {
        const match = String(value || '').match(/^(\\d{1,2}):(\\d{2})$/)
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
      const challenged = await this.window.webContents.executeJavaScript(\`(() => {
        const nodes = document.querySelectorAll('[class*="captcha"], iframe[src*="captcha"], [id*="captcha"]')
        for (const el of nodes) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 100 && rect.height > 100) return true
        }
        return false
      })()\`).catch(() => false)
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
    // 看门狗：页面 executeJavaScript 卡死会让本轮无限挂起，整轮超 5 分钟强制中止
    const watchdog = setTimeout(() => {
      this.log('worker_watchdog', '自动回复本轮执行超时，已强制跳过本轮', { detail: '页面可能卡死' })
      this.polling = false
    }, 5 * 60 * 1000)
    this.polling = true
    try {
      const { contacts } = await this.syncContacts()
      const today = localDateKey()
      const blacklist = new Set((config.blacklist || []).map((name) => String(name).trim()).filter(Boolean))
      const aiDisabledContacts = new Set((config.aiDisabledContacts || []).map((name) => String(name).trim()).filter(Boolean))
      const canSend = (name) => !blacklist.has(name) && this.getSendAllowance(name).ok
      const factCandidates = []
      const topicCandidates = []
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
          if (firstBlockedThisSession) this.log('auto_blocked', \`已跳过 \${contact.name}：该联系人位于黑名单\`, { name: contact.name, reason: 'blacklist' })
          continue
        }
        if (aiDisabledContacts.has(contact.name)) continue // 用户主动关闭：不刷日志、不消费消息
        if (!canSend(contact.name)) {
          const noticeKey = \`\${contact.name}:\${localDateKey()}\`
          if (!this.lastLimitNotice.has(noticeKey)) {
            this.lastLimitNotice.set(noticeKey, Date.now())
            this.log('send_blocked', \`已达到每日发送上限，暂不回复 \${contact.name}\`, { name: contact.name })
          }
          continue // 保留消息，限额重置后补回
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
            this.log('auto_recheck', \`\${contact.name} 疑似在我回复期间发来新消息，暂不消费，下轮重查\`, { name: contact.name, preview: String(contact.preview || '').slice(0, 60) })
            continue
          }
          this.lastSeen.set(contact.name, currentMessageKey)
          this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey }))
          continue
        }
        if (fromMe !== false) {
          const noticeKey = \`role_unknown:\${contact.name}:\${currentMessageKey}\`
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('auto_recheck', \`无法确认 \${contact.name} 最后一条消息的发送方，本轮不回复，下轮重查\`, { name: contact.name })
          }
          continue
        }
        // 我方回声守卫：预览就是刚发出的内容（或带 AI 标签的回显），绝不再次回复
        const lastSentText = String(this.lastSent.get(contact.name) || '').replace(/\\s+/g, ' ').trim()
        const previewText = String(contact.preview || '').replace(/\\s+/g, ' ').trim()
        if (lastSentText && (previewText === lastSentText || previewText.startsWith(lastSentText) || previewText.includes('【AI · '))) {
          this.lastSeen.set(contact.name, currentMessageKey)
          this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey }))
          continue
        }
        // 引擎轮次闸门：同一消息 key 只处理一次；两次自动发送之间有最小间隔
        const gate = shouldAutoReply(contact, { key: currentMessageKey, fromMe: false })
        if (!gate.ok) {
          if (gate.reason === 'already_handled') {
            this.lastSeen.set(contact.name, currentMessageKey)
          } else if (gate.reason === 'min_gap') {
            const noticeKey = \`min_gap:\${contact.name}\`
            if (!this.lastSkipNotice.has(noticeKey)) {
              this.lastSkipNotice.set(noticeKey, Date.now())
              this.log('auto_recheck', \`\${contact.name} 刚回复过，等待 \${Math.ceil((gate.retryInMs || 0) / 1000)} 秒后再处理\`, { name: contact.name })
            }
          }
          continue
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
            if (!this.lastSkipNotice.has(\`ai_backoff:\${contact.name}\`)) {
              this.lastSkipNotice.set(\`ai_backoff:\${contact.name}\`, Date.now())
              this.log('ai_backoff', \`\${contact.name} 的 AI 调用暂缓（\${Math.ceil((backoff.retryAt - Date.now()) / 1000)} 秒后重试）\`, { name: contact.name })
            }
            continue // 不消费，退避结束后重试
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
                  this.log('media_text_fallback', \`\${contact.name} 媒体回复已关闭，使用预览文本回复\`, { name: contact.name, mediaKind, reason: 'replyable_preview' })
                } else {
                  this.log('media_skipped', \`\${contact.name} 媒体已跳过：视频回复已关闭\`, { name: contact.name, mediaKind, reason: 'video_reply_disabled' })
                  this.lastSeen.set(contact.name, currentMessageKey)
                  this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey }))
                  continue
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
              this.log('media_text_fallback', \`\${contact.name} 媒体捕获不可用，使用预览文本回复\`, { name: contact.name, mediaKind, reason: mediaCapture.reason || 'media_capture_unavailable' })
            }
            if (useMediaForReply) {
              const caps = providers.length ? providers.some(p => (p.capabilities || []).includes('vision')) : Boolean(this.ai?.hasProvider?.())
              if (!caps && !hasAudioTranscript && !hasPublicContext) {
                this.log('media_skipped', \`\${contact.name} 媒体已跳过：模型不支持视觉\`, { name: contact.name, mediaKind })
                this.lastSeen.set(contact.name, currentMessageKey)
                this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey }))
                continue
              }
              const requiresDecodedVideo = mediaKind === 'video' || mediaCapture.detectedVideo === true
              if (!mediaCapture.frames.length && !hasAudioTranscript && !hasPublicContext) {
                this.log(requiresDecodedVideo ? 'video_unreadable' : 'media_uncertain', \`\${contact.name} 媒体画面无法捕获\`, { name: contact.name, mediaKind })
                this.lastSeen.set(contact.name, currentMessageKey)
                this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey }))
                continue
              }
            }
            aiDraft = await this.ai.draft({ contact: enhancedContact, incoming: contact.preview, incomingMeta: timeMeta, videoFrames: useMediaForReply ? mediaCapture : undefined })
            if (aiDraft?.ok && (aiDraft.labeledText || aiDraft.text)) {
              const model = aiDraft.model || providers?.[0]?.model || '当前模型'
              const label = aiDraft.aiLabel || \`AI · \${model}\`
              const showAiModelLabel = this.storage.get().settings?.showAiModelLabel !== false
              const generated = String(showAiModelLabel ? (aiDraft.labeledText || aiDraft.text) : aiDraft.text).trim()
              replyText = showAiModelLabel && !generated.startsWith(\`【\${label}】\`) ? \`【\${label}】\${generated}\` : generated
            }
          } catch (error) {
            this.log('ai_error', \`为 \${contact.name} 调用 AI 失败\`, { name: contact.name, error: error.message })
            const prevStep = this.aiBackoff.get(contact.name)?.step || 0
            const step = Math.min(prevStep + 1, 4)
            const delay = [30000, 120000, 480000, 1800000][step - 1]
            this.aiBackoff.set(contact.name, { step, retryAt: Date.now() + delay })
            continue // 不消费，退避后重试
          }
        }
        if (replyText) {
          try {
            const mediaKindForReply = mediaPreviewKind(contact.preview)
            if (mediaKindForReply && isUnavailableMediaReply(replyText)) {
              this.lastSeen.set(contact.name, currentMessageKey)
              this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey }))
              this.log('ai_reply_rejected', \`\${contact.name} 的媒体回复已拦截\`, { name: contact.name, mediaKind: mediaKindForReply, text: replyText, reason: 'unavailable_media_reply' })
              continue
            }
            // 草稿模式：AI 生成的回复进入草稿列表等待人工确认
            if (settings.aiReplyDraftOnly === true) {
              const drafts = [...(this.storage.get().pendingDrafts || [])]
              drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText, incoming: String(contact.preview || ''), model: aiDraft?.model || '', provider: aiDraft?.provider || '', status: 'pending' })
              const capped = drafts.slice(0, 50)
              this.storage.update({ pendingDrafts: capped })
              this.emitEvent('drafts', { drafts: capped })
              this.log('ai_draft_pending', \`已为 \${contact.name} 生成 AI 草稿待确认\`, { name: contact.name, text: replyText })
              this.lastSeen.set(contact.name, currentMessageKey)
              this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey }))
              continue
            }
            const aiMeta = aiAttempted ? { ai: true, source: 'ai', model: aiDraft?.model || '', provider: aiDraft?.provider || '', aiLabel: aiDraft?.aiLabel || '' } : { source: 'rule' }
            // 拟人延迟：AI 回复不秒回，按长度加 1.5–12 秒随机"打字时间"
            if (aiAttempted) await sleep(humanReplyDelay(replyText))
            await this.sendMessage(contact.name, replyText, aiMeta)
            this.aiBackoff.delete(contact.name)
            this.lastSeen.set(contact.name, currentMessageKey)
            this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))
          } catch (error) {
            this.log('send_error', \`自动回复发送失败：\${contact.name}\`, { name: contact.name, error: error.message })
            continue // 不消费，下轮重试
          }
        } else if (aiAttempted && aiDraft?.rejected === true) {
          // 拒发不重试：同一输入重试大概率产出同类内容，直接消费消息（宁可不说）
          this.lastSeen.set(contact.name, currentMessageKey)
          this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey }))
        } else if (aiAttempted) {
          const noticeKey = \`ai_empty:\${contact.name}:\${currentMessageKey}\`
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('ai_empty', \`AI 未返回有效回复，保留 \${contact.name} 的消息待重试\`, { name: contact.name })
          }
          continue // 不消费
        } else {
          const noticeKey = \`ai_unavailable:\${contact.name}:\${currentMessageKey}\`
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('ai_unavailable', \`未配置可用模型，保留 \${contact.name} 的消息待重试\`, { name: contact.name })
          }
          continue // 不消费
        }
      }
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
          this.log('spark_fill_skipped', \`\${task.name} 今天已有发送记录，本次无需补续\`, { name: task.name, reason: 'sent_today' })
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
          this.log('spark_sent', \`\${task.name} 的问候任务已完成\`, { name: task.name })
        } catch (error) {
          this.log('spark_fill_failed', \`\${task.name} 问候任务执行失败，稍后重试\`, { name: task.name, error: error.message })
        }
      }
      // 主动伴聊：活跃时段内低频挑人主动聊
      try { await this.processProactiveChats(now, blacklist, aiDisabledContacts) } catch (error) { this.log('companion_error', \`主动伴聊执行失败\`, { error: error.message }) }
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
      this.polling = false
    }
  }

`

out = out.slice(0, logIdx) + NEW_RUN + out.slice(logIdx)

// 4.6) 双消息（允许而非必须）：首条发出并持久化轮次后，紧跟着发第二条随口话（独立容错）
out = out.replace(
  `            await this.sendMessage(contact.name, replyText, aiMeta)
            this.aiBackoff.delete(contact.name)
            this.lastSeen.set(contact.name, currentMessageKey)
            this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))`,
  `            await this.sendMessage(contact.name, replyText, aiMeta)
            this.aiBackoff.delete(contact.name)
            this.lastSeen.set(contact.name, currentMessageKey)
            this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))
            // 双消息（允许而非必须）：模型补了第二条随口话时紧跟发出；独立容错，
            // 失败只记日志——首条已送达，轮次已闭环，绝不能因此重发首条
            const followUp = aiAttempted ? String(aiDraft?.text2 || '') : ''
            if (followUp) {
              try {
                await sleep(humanReplyDelay(followUp))
                await this.sendMessage(contact.name, followUp, aiMeta)
              } catch (followError) {
                this.log('send_error', \`第二条消息发送失败（首条已送达，不影响本轮）\`, { name: contact.name, error: followError.message })
              }
            }`,
)
if (!out.includes('const followUp')) throw new Error('双消息发送未注入')

// 4.7) 草稿模式：第二条消息并入同一条草稿（换行分隔，人工确认时一起发）
out = out.replace(
  "              drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText, incoming: String(contact.preview || ''), model: aiDraft?.model || '', provider: aiDraft?.provider || '', status: 'pending' })",
  "              drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText + (aiDraft?.text2 ? '\\n' + aiDraft.text2 : ''), incoming: String(contact.preview || ''), model: aiDraft?.model || '', provider: aiDraft?.provider || '', status: 'pending' })",
)


// 5.5) 内存卫生：抖音聊天页是常驻重型 SPA，连续运行数小时后渲染进程累积到 300-500MB。
// 超阈值且自动化空闲时自动刷新页面（消息 key 已持久化不会漏回/重发；hook 会在
// did-finish-load 重新注入）。必须在 NEW_RUN 注入之后执行（锚点来自 NEW_RUN）。
out = out.replace(
  `  async runAutomation() {`,
  `  // 内存卫生：超过阈值且空闲时刷新聊天页释放内存（每 10 分钟检查一次）
  startMemoryHygiene() {
    if (this._memoryTimer) return
    this._pageLoadedAt = Date.now()
    this._memoryTimer = setInterval(() => {
      if (this.polling || this.verificationActive) return
      try {
        const win = this.window
        if (!win || win.isDestroyed()) return
        if (win.webContents.isLoading()) return
        const pid = win.webContents.getOSProcessId()
        const metric = process.getAppMetrics().find((m) => m.pid === pid)
        const memMB = metric ? (metric.memory?.workingSetSize || 0) : 0
        const uptimeMin = Math.round((Date.now() - (this._pageLoadedAt || Date.now())) / 60000)
        if (memMB > 400 && uptimeMin >= 10) {
          this.log('memory_hygiene', \`聊天页内存 \${memMB}MB 超过阈值，已自动刷新页面释放内存\`, { memMB, uptimeMin })
          this._pageLoadedAt = Date.now()
          win.webContents.loadURL(CHAT_URL).catch(() => {})
        }
      } catch { /* 内存检查失败不影响自动化 */ }
    }, 10 * 60 * 1000)
  }

  async runAutomation() {`,
)
if (!out.includes('startMemoryHygiene() {')) throw new Error('内存卫生方法未注入')
out = out.replace(
  `      }, delay || AUTOMATION_POLL_MS)
    }
    scheduleNext()
  }`,
  `      }, delay || AUTOMATION_POLL_MS)
    }
    scheduleNext()
    this.startMemoryHygiene()
  }`,
)
if (!out.includes('this.startMemoryHygiene()')) throw new Error('startMemoryHygiene 未挂载到 startWorker')
out = out.replace(
  `  destroy() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }`,
  `  destroy() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    if (this._memoryTimer) { clearInterval(this._memoryTimer); this._memoryTimer = null }`,
)
if (!out.includes('clearInterval(this._memoryTimer)')) throw new Error('内存卫生定时器未清理')

// 6) 追加新 module.exports（旧 exports 行在剪除区间外）
if (out.includes('module.exports')) throw new Error('module.exports 意外残留')
out += `module.exports = { AUTOMATION_POLL_MS, DouyinService, computePollDelay, humanReplyDelay, conversationTimeMeta, dailySparkMessage, extractConversationPreview, extractConversationTimeLabel, extractPublicCommentItemText, extractReactAwemeId, extractStreakCount, hasPublicMediaContext, hasReplyablePreviewText, isUnavailableMediaReply, isVideoPreview, mediaPreviewKind, mergeMessageHistory, mergePublicMediaContext, normalizeCapturedMedia, normalizeCommentContext, normalizeVisibleMediaContext, normalizeVideoRecognitionMode, pickLatestChatMessageRole, resolveConversationSentAt, resolveSparkTask, shouldDeferConsumptionOnFromMe, shouldUseVideoFrameFallback, videoRecognitionOptions }
`

fs.writeFileSync(DEST, out, 'utf8')
console.log(`written ${DEST} (${out.split('\n').length} lines)`)
