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

const READ_VIDEO_COMMENT_CONTEXT = `  async readVideoCommentContext(media, name, options = {}, sourceWindow = null) {
    const limit = Math.max(0, Math.min(50, Math.floor(Number(options.commentLimit || 0) || 0)))
    if (!limit) return {}
    const hasShareUrl = Boolean(media?.shareUrl)
    const targetAwemeId = (media?.shareUrl || '').match(/\\/video\\/(\\d+)/)?.[1]
      || (media?.shareUrl || '').match(/modal_id=(\\d+)/)?.[1]
      || (media?.shareUrl || '').match(/\\d{18,20}/)?.[0]
      || ''
    const win = hasShareUrl ? this.ensureDiscoveryWindow() : sourceWindow
    if (!win) return {}
    try {
      if (hasShareUrl) {
        await win.loadURL(media.shareUrl)
        // 立即静音并暂停视频播放，防止自动播放完后切到下一个视频
        await win.webContents.executeJavaScript(\`(() => {
          try {
            document.querySelectorAll('video').forEach((v) => { v.pause(); v.muted = true })
          } catch {}
        })()\`).catch(() => {})
        // 校验加载后的 URL：若被重定向到了无关推荐流（如 /jingxuan 但 modal_id 与目标不符），立即放弃，严禁张冠李戴
        const loadedUrl = String(win.webContents.getURL() || '')
        const loadedModalMatch = loadedUrl.match(/modal_id=(\\d+)/)?.[1] || loadedUrl.match(/\\/video\\/(\\d+)/)?.[1] || ''
        if (targetAwemeId && loadedModalMatch && loadedModalMatch !== targetAwemeId) {
          this.log('video_comments_mismatch', \`公开页被重定向到其他推荐视频（目标 \${targetAwemeId} vs 当前 \${loadedModalMatch}），已放弃读取该页\`, {
            name,
            targetAwemeId,
            loadedModalMatch,
            url: loadedUrl.slice(0, 120),
          })
          return { videoCommentError: 'video_redirect_mismatch', videoPageUrlFound: true }
        }
      } else {
        const pageState = await win.webContents.executeJavaScript(\`(() => {
          const href = String(location.href || '')
          const body = String(document.body?.innerText || '')
          const isPublicVideo = /douyin\\\\.com\\\\/(?:video|note)\\\\//i.test(href)
            || /(?:全部评论|发布评论|展开\\\\s*\\\\d+\\\\s*条回复)/i.test(body)
          return { href, isPublicVideo }
        })()\`).catch(() => ({ isPublicVideo: false }))
        if (!pageState?.isPublicVideo) return {}
      }
      await sleep(Math.max(1800, Number(options.commentWaitMs || 3000)))
      // 再次暂停可能自动播放的视频
      await win.webContents.executeJavaScript(\`(() => {
        try {
          document.querySelectorAll('video').forEach((v) => { v.pause(); v.muted = true })
        } catch {}
      })()\`).catch(() => {})
      await win.webContents.executeJavaScript(\`(() => {
        const normalize = (value) => String(value || '').replace(/\\\\s+/g, ' ').trim()
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
      })()\`).catch(() => false)
      const scrolls = Math.max(1, Math.min(8, Math.floor(Number(options.commentScrolls || 1) || 1)))
      for (let index = 0; index < scrolls; index += 1) {
        await sleep(Math.max(450, Math.floor(Number(options.commentWaitMs || 3000) / Math.max(2, scrolls + 1))))
        // 滚动中检查是否发生切视频
        const currentAweme = await win.webContents.executeJavaScript(\`(() => {
          try { document.querySelectorAll('video').forEach((v) => { v.pause(); v.muted = true }) } catch {}
          const m = location.href.match(/modal_id=(\\\\d+)/) || location.href.match(/\\\\/video\\\\/(\\\\d+)/);
          return m ? m[1] : '';
        })()\`).catch(() => '')
        if (targetAwemeId && currentAweme && currentAweme !== targetAwemeId) {
          this.log('video_comments_mismatch', \`滚动中页面切到了其他推荐视频（目标 \${targetAwemeId} vs 当前 \${currentAweme}），已停止读取\`, { name, targetAwemeId, currentAweme })
          return { videoCommentError: 'video_redirect_mismatch', videoPageUrlFound: true }
        }
        await win.webContents.executeJavaScript(\`(() => {
          try {
            // 只查找真正的评论列表滚动容器，严禁滚动 main, body, documentElement，防止触发切视频！
            const scrollers = [...document.querySelectorAll('[class*="comment" i], [data-e2e*="comment" i], [role="dialog"]')]
              .filter((node) => node && !['MAIN', 'BODY', 'HTML'].includes(node.tagName) && node.scrollHeight > node.clientHeight + 50)
              .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))
            const target = scrollers[0]
            if (target) {
              target.scrollBy(0, Math.max(320, innerHeight * 0.65))
            }
          } catch {}
          return true
        })()\`).catch(() => false)
      }
      await sleep(Math.max(500, Math.floor(Number(options.commentWaitMs || 3000) / 4)))
      const context = await win.webContents.executeJavaScript(\`(async () => {
        const limit = \${JSON.stringify(limit)}
        const targetAwemeId = \${JSON.stringify(targetAwemeId)}
        const currentHref = String(location.href || '')
        const currentId = (currentHref.match(/modal_id=(\\\\d+)/) || currentHref.match(/\\\\/video\\\\/(\\\\d+)/))?.[1] || ''
        if (targetAwemeId && currentId && currentId !== targetAwemeId) {
          return { mismatch: true, targetAwemeId, currentId, href: currentHref }
        }
        const normalize = (value, max = 500) => String(value || '').replace(/\\\\s+/g, ' ').trim().slice(0, max)
        const extractPublicCommentItemText = \${extractPublicCommentItemText.toString()}
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
          if (/^\\\\d+$/.test(text) || /^\\\\[\\\\d.万wW]+$/.test(text)) continue
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
            if (/^\\\\d+$/.test(text) || /^\\\\[\\\\d.万wW]+$/.test(text)) continue
            if (comments.some((item) => item === text || item.includes(text) || text.includes(item))) continue
            comments.push(text)
            if (comments.length >= limit) break
          }
        }
        const apiComments = []
        const commentUrls = [...new Set(performance.getEntriesByType('resource')
          .map((entry) => String(entry.name || ''))
          .filter((url) => /aweme\\\\/v1\\\\/web\\\\/comment\\\\/list\\\\//i.test(url)))]
          .filter((url) => !targetAwemeId || url.includes('aweme_id=' + targetAwemeId) || url.includes(targetAwemeId))
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
      })()\`).catch((error) => ({ error: error.message }))
      if (context?.mismatch) {
        this.log('video_comments_mismatch', \`公开页内容提取发现视频 ID 不符（目标 \${targetAwemeId} vs 当前 \${context.currentId}），已丢弃无关评论\`, {
          name,
          targetAwemeId,
          currentId: context.currentId,
          href: context.href,
        })
        return { videoCommentError: 'video_redirect_mismatch', videoPageUrlFound: true }
      }
      const normalized = normalizeCommentContext({
        ...context,
        comments: Array.isArray(context?.apiComments) && context.apiComments.length
          ? context.apiComments
          : context?.comments,
      }, limit)
      if (normalized.videoComments.length || normalized.videoPageTitle || normalized.videoPageDescription) {
        this.log('video_comments_captured', \`已读取 \${name} 的视频公开页评论\`, {
          name,
          comments: normalized.videoComments.length,
          titleFound: Boolean(normalized.videoPageTitle),
        })
      }
      return { ...normalized, videoPageUrlFound: Boolean(hasShareUrl || context?.source || sourceWindow) }
    } catch (error) {
      this.log('video_comments_unavailable', \`\${name} 视频评论未读取\`, { name, error: error.message })
      return { videoCommentError: error.message || 'video_comments_unavailable', videoPageUrlFound: hasShareUrl }
    }
  }`

// 保留区间（1-based 闭区间）
const segments = [
  range(1, 29),     // 头部 require + 常量 + computePollDelay/humanReplyDelay
  range(88, 571),   // sleep..resolveSparkTask（spark 文案池）
  range(731, 865),  // normalizeHistoryMessage..shouldDeferConsumptionOnFromMe
  range(892, 948),  // pureMediaPreviewPattern..shouldUseVideoFrameFallback
  range(966, 1120), // extractConversationPreview..transcribeCapturedMediaAudio
  [READ_VIDEO_COMMENT_CONTEXT], // 视频公开页评论提取（带严格视频 ID 校验与防切视频机制）
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

// 3.1) 过滤系统占位符"暂不支持该消息类型"，防止被误认作正常聊天文本
out = out.replace(
  "  if (isVideoPreview(text)) return 'video'",
  "  if (/暂不支持该消息类型/i.test(text)) return 'unsupported'\n  if (isVideoPreview(text)) return 'video'",
)
out = out.replace(
  "|作品|[▶⏵]|\\d{1,3}[\"秒]?)$/i",
  "|作品|[▶⏵]|\\d{1,3}[\"秒]?|暂不支持该消息类型|\\[暂不支持该消息类型\\])$/i",
)
out = out.replace(
  "  if (!text || pureMediaPreviewPattern.test(text)) return false",
  "  if (!text || pureMediaPreviewPattern.test(text) || /暂不支持该消息类型/i.test(text)) return false",
)
out = out.replace(
  "  const remainder = text.replace(mediaMarkerPattern, '').replace(/\\s+/g, '').trim()",
  "  const remainder = text.replace(mediaMarkerPattern, '').replace(/暂不支持该消息类型/g, '').replace(/\\s+/g, '').trim()",
)

// 3.2) 视频卡片上下文提取兜底：author 与 sharedComment 也算有效公开上下文
out = out.replace(
  `const hasPublicMediaContext = (media = {}) => Boolean(
  String(media.videoPageTitle || '').trim()
    || String(media.videoPageDescription || '').trim()
    || (Array.isArray(media.videoComments) && media.videoComments.length)
)`,
  `const hasPublicMediaContext = (media = {}) => Boolean(
  String(media.videoPageTitle || '').trim()
    || String(media.videoPageDescription || '').trim()
    || String(media.videoPageAuthor || '').trim()
    || String(media.videoSharedComment || '').trim()
    || (Array.isArray(media.videoComments) && media.videoComments.length)
)`,
)
out = out.replace(
  "    videoPageAuthor: author,",
  "    videoPageAuthor: author || visibleMeta.videoPageAuthor || visibleAuthorOnly || '',",
)

// 3.3) 极简模式（lite 模式，maxFrames = 1）修复：maxFrames >= 1 时能正常截取 1 帧画面
out = out.replace(
  "      for (const ratio of (maxFrames > 2 ? [0.2, 0.68] : maxFrames > 1 ? [0.5] : [])) {",
  "      for (const ratio of (maxFrames > 2 ? [0.2, 0.68] : maxFrames >= 1 ? [0.5] : [])) {",
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

const NEW_RUN = fs.readFileSync(path.join(__dirname, 'run-automation.template.cjs'), 'utf8')

out = out.slice(0, logIdx) + NEW_RUN + out.slice(logIdx)

// 4.6) 双消息（允许而非必须）：首条发出并持久化轮次后，紧跟着发第二条随口话（独立容错）
out = out.replace(
  `        await this.sendMessage(contact.name, replyText, aiMeta)
        this.aiBackoff.delete(contact.name)
        this.lastSent.set(contact.name, replyText)
        this.lastSeen.set(contact.name, currentMessageKey)
        this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))`,
  `        await this.sendMessage(contact.name, replyText, aiMeta)
        this.aiBackoff.delete(contact.name)
        this.lastSent.set(contact.name, replyText)
        this.lastSeen.set(contact.name, currentMessageKey)
        this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))
        // 双消息（允许而非必须）：模型补了第二条随口话时紧跟发出；独立容错，
        // 失败只记日志——首条已送达，轮次已闭环，绝不能因此重发首条
        const followUp = aiAttempted ? String(aiDraft?.text2 || '') : ''
        if (followUp) {
          try {
            await sleep(humanReplyDelay(followUp))
            await this.sendMessage(contact.name, followUp, aiMeta)
            this.lastSent.set(contact.name, followUp)
          } catch (followError) {
            this.log('send_error', \`第二条消息发送失败（首条已送达，不影响本轮）\`, { name: contact.name, error: followError.message })
          }
        }`,
)
if (!out.includes('const followUp')) throw new Error('双消息发送未注入')

// 4.7) 草稿模式：第二条消息并入同一条草稿（换行分隔，人工确认时一起发）
out = out.replace(
  "          drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText, incoming: String(contact.preview || ''), model: aiDraft?.model || '', provider: aiDraft?.provider || '', status: 'pending' })",
  "          drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText + (aiDraft?.text2 ? '\\n' + aiDraft.text2 : ''), incoming: String(contact.preview || ''), model: aiDraft?.model || '', provider: aiDraft?.provider || '', status: 'pending' })",
)


// 5.5) 内存卫生：抖音聊天页是常驻重型 SPA，连续运行数小时后渲染进程累积到 300-500MB。
// 空闲且超阈值时【重建渲染进程】：destroy 让渲染进程彻底退出、OS 立即回收其内存，
// 下次轮询按需 ensureWindow 重建（消息 key 已持久化不会漏回/重发；hook 会在
// did-finish-load 重新注入）。仅刷新页面（loadURL）不销毁进程，释放非常有限。
// 必须在 NEW_RUN 注入之后执行（锚点来自 NEW_RUN）。
out = out.replace(
  `  async runAutomation() {`,
  `  // 内存卫生：聊天页是常驻重型 SPA，渲染进程会累积数百 MB。每 10 分钟检查一次，
  // 空闲且超阈值时重建渲染进程（destroy 让进程退出、OS 立即回收内存），下次轮询按需重建。
  startMemoryHygiene() {
    if (this._memoryTimer) return
    this._pageLoadedAt = Date.now()
    this._memoryTimer = setInterval(() => { this.runMemoryHygiene().catch(() => {}) }, 10 * 60 * 1000)
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
    if (this.polling || this.verificationActive) return
    const win = this.window
    if (!win || win.isDestroyed()) return
    if (win.webContents.isLoading()) return
    const uptimeMin = Math.round((Date.now() - (this._pageLoadedAt || Date.now())) / 60000)
    const { memMB, source } = await this.readChatPageMemoryMB(win)
    // 触发条件（防泄漏护栏）：聊天页常驻内存异常偏高才重建。实测抖音聊天页自身固有占用
    // 就有 300-600MB，重载并不能降低这部分、反而会瞬时冲高，因此阈值必须高于正常水位，
    // 只在疑似泄漏（持续增长到 800MB 以上）时才回收。RSS 与 JS 堆两套口径分别设阈。
    const overMem = source === 'jsHeap' ? memMB >= 250 : memMB >= 800
    if (!(overMem && uptimeMin >= 10)) return
    this.log('memory_hygiene', \`聊天页内存 \${memMB}MB（\${source}）/ 已加载 \${uptimeMin} 分钟，疑似异常增长，重建渲染进程释放内存\`, { memMB, source, uptimeMin })
    this.recycleChatWindow()
  }

  // 重建聊天页：destroy 让渲染进程彻底退出（OS 回收内存），下次轮询按需重建
  recycleChatWindow() {
    const win = this.window
    this.window = null
    this._pageLoadedAt = Date.now()
    try {
      if (win && !win.isDestroyed()) {
        win.__forceClose = true
        win.destroy()
      }
    } catch { /* 销毁失败不阻塞自动化 */ }
    try { if (typeof global.gc === 'function') global.gc() } catch { /* 主进程堆回收（需 --expose-gc） */ }
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
    if (this._memoryTimer) { clearInterval(this._memoryTimer); this._memoryTimer = null }
    if (this.incomingQueue instanceof Map) this.incomingQueue.clear()`,
)
if (!out.includes('clearInterval(this._memoryTimer)')) throw new Error('内存卫生定时器未清理')

// 6) 追加新 module.exports（旧 exports 行在剪除区间外）
if (out.includes('module.exports')) throw new Error('module.exports 意外残留')
out += `module.exports = { AUTOMATION_POLL_MS, DouyinService, computePollDelay, humanReplyDelay, conversationTimeMeta, dailySparkMessage, extractConversationPreview, extractConversationTimeLabel, extractPublicCommentItemText, extractReactAwemeId, extractStreakCount, hasPublicMediaContext, hasReplyablePreviewText, isUnavailableMediaReply, isVideoPreview, mediaPreviewKind, mergeMessageHistory, mergePublicMediaContext, normalizeCapturedMedia, normalizeCommentContext, normalizeVisibleMediaContext, normalizeVideoRecognitionMode, pickLatestChatMessageRole, resolveConversationSentAt, resolveSparkTask, shouldDeferConsumptionOnFromMe, shouldUseVideoFrameFallback, videoRecognitionOptions }
`

fs.writeFileSync(DEST, out, 'utf8')
console.log(`written ${DEST} (${out.split('\n').length} lines)`)
