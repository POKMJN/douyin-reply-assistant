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
      // 回声拦截：若预览文本就是我刚发出的内容（含截断、前缀、AI 标签显现），
      // 或联系人显式标记为 fromMe，直接更新 lastSeen，绝不入队（防止发送后 5 秒假入队与自我复读循环）
      const lastSentText = String(this.lastSent.get(contact.name) || '').replace(/\s+/g, ' ').trim()
      const previewText = String(contact.preview || '').replace(/\s+/g, ' ').trim()
      const isOutgoingEcho = Boolean(lastSentText) && (
        previewText === lastSentText
        || lastSentText.startsWith(previewText)
        || previewText.startsWith(lastSentText)
        || (previewText.length >= 8 && lastSentText.includes(previewText))
        || (previewText.length >= 8 && previewText.includes(lastSentText.slice(0, 15)))
        || previewText.includes('【AI · ')
      )
      if (isOutgoingEcho || contact.fromMe === true) {
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
    const isEcho = Boolean(lastSentText) && (
      previewText === lastSentText
      || lastSentText.startsWith(previewText)
      || previewText.startsWith(lastSentText)
      || (previewText.length >= 8 && lastSentText.includes(previewText))
      || (previewText.length >= 8 && previewText.includes(lastSentText.slice(0, 15)))
      || previewText.includes('【AI · ')
    )
    if (isEcho) {
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
          drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText, incoming: String(contact.preview || ''), model: aiDraft?.model || '', provider: aiDraft?.provider || '', status: 'pending' })
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
        this.lastSent.set(contact.name, replyText)
        this.lastSeen.set(contact.name, currentMessageKey)
        this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))
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
      const ctx = { config, settings, contacts, today, autoReplyOn, blacklist, aiDisabledContacts, canSend, factCandidates, topicCandidates }

      // ① 收集：只发现、只入队，不做任何回复动作
      await this.collectIncoming(contacts, ctx)
      // ② 规划 + ③ 执行：先统一判定，再严格串行处理（同一时刻只有一个 AI 调用和一次发送）
      await this.drainIncomingQueue(ctx)

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
      this.polling = false
    }
  }

