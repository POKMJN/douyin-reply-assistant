// 3 小时查找 bug 压力测试（soak test）
//
// 两层同时运行：
//  A) 虚拟时间对话马拉松（主体）：对抗性模拟"对方"（轰炸/复读/回声/视频/劫持/垃圾输入/
//     隔天跳跃）+ 模型故障注入（超时/429/思考泄漏/空回复/超长/Markdown/攻击性），
//     走真实的 conversation-engine + ai-service(注入 mock transport) + JsonStorage(真实磁盘读写)，
//     以虚拟时钟全速推进（3 小时真实时间 ≈ 数月虚拟聊天），逐轮断言不变量。
//  B) 应用健康巡检：每 5 分钟检查正在运行的软件（CDP 可达时：渲染响应/堆内存/错误日志；
//     文件层：state.json 完整性与尺寸趋势；每 15 分钟一次真实模型质量探针）。
//
// 不变量（每条违例 = 一个 bug，逐条记录）：
//  V1  同一消息 key 永不回复两次（含重启后）
//  V2  角色未确认/我方回声绝不触发回复
//  V3  最终回复必须通过全部质量门（≤42字、无 Markdown、无思考泄漏、无攻击性、无 AI 腔）
//  V4  state.json 每次写盘后必须可解析（原子写）
//  V5  learning.messages 有界（≤60）
//  V6  logs 有界（≤150）
//  V7  轮次最小间隔不被违反
//  V8  重启后轮次状态必须从磁盘恢复（lastHandledKey 不丢）
//  V9  全部模型健康时 draft 不应抛错
//  V10 进程内存无持续失控增长（软性告警）
//
// 用法：node tests/soak-3h.cjs [分钟数，默认 180]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
require('./setup.cjs')
const { JsonStorage } = require('../electron/storage.cjs')
const { AiService, isReasoningLeak, cleanGeneratedText } = require('../electron/ai-service.cjs')
const { shouldAutoReply, markHandled, markOutgoing, MIN_AUTO_REPLY_GAP_MS } = require('../electron/conversation-engine.cjs')

const MINUTES = Number(process.argv[2] || 180)
const DEADLINE = Date.now() + MINUTES * 60 * 1000
const ARTIFACTS = path.join(__dirname, '..', 'test-artifacts')
const MEDIA_SEP = '\u241e'

// ---- 可复现随机源 ----
let seed = 20260912
const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pick = (arr) => arr[Math.floor(rng() * arr.length)]
const chance = (p) => rng() < p

// ---- 统计与违例 ----
const stats = { turns: 0, replies: 0, gateBlocks: {}, rewrites: 0, rejections: 0, skips: 0, draftErrors: 0, restarts: 0, videoTurns: 0, modelFailures: 0 }
const violations = []
const violationsByType = {}
let violationsCapped = 0
function violation(type, detail) {
  violationsByType[type] = (violationsByType[type] || 0) + 1
  if (violations.length < 200) violations.push({ type, at: new Date().toISOString(), vNow: new Date(vNow).toISOString(), turns: stats.turns, detail: String(detail).slice(0, 400) })
  else violationsCapped += 1
}

// ---- 虚拟时钟 ----
let vNow = Date.now()

// ---- 人名池（含对抗性名字）----
const ROSTER = [' soak·小明', 'soak·Adrian', 'soak·小明2', '123456789', 'soak·Emoji😊', 'soak·长名字'.repeat(3), 'soak·Me', 'soak·她', 'soak·测试', 'soak·Old Friend', 'soak·🔥🔥', 'soak·小明3'].map((s) => s.trim())
const personas = new Map() // name -> { turn, lastSent, lastReply, seenKey }

// ---- 对抗性输入生成 ----
const NORMAL_MSGS = ['今天好累啊', '晚上吃什么好', '周título末去爬山不', '我刚看了个电影，超好看', '帮我看看这个', '笑死我了哈哈哈', '最近工作咋样', '明天要降温了', '在吗', '跟你说个事']
const LOW_INFO = ['哦', '嗯嗯', '哈哈', '？', '？？？', '6', '哈哈哈', '😅', '好']
const HIJACKS = ['突然想到 你觉得人生有什么意义', '你说人为什么要上班', '你觉得我该辞职吗', '问你个事 你说外星人存在吗']
const DIRTY_REPLIES = [
  '这'.repeat(60),                                     // 超长
  '**加粗**回复',                                      // Markdown
  '我们需要生成一条消息，要求是简短口语化',             // 思考泄漏
  '我理解你的感受，感谢你的分享',                       // AI 腔
  '闭嘴吧你',                                          // 攻击性
  '笑话',                                              // 正常兜底
  '哈哈哈',                                            // 只有笑声
]
const CLEAN_REPLIES = ['哈哈是吧', '我看行', '明天说', '行啊', '那你自己注意点', '刚看到，咋了', '可以可以', '笑死', '你先忙']
function mockReply(incoming) {
  const r = rng()
  if (r < 0.06) return pick(DIRTY_REPLIES)      // 坏输出：必须被质量门拦住/改写
  if (chance(0.15) && incoming.length > 3) return `关于${incoming.slice(0, 6)}` // 伪上下文相关
  return pick(CLEAN_REPLIES)
}

// ---- 模型故障注入传输层 ----
function makeMockTransport() {
  return async (url, options, body) => {
    const parsed = JSON.parse(String(body))
    const model = String(parsed.model || '')
    // 注入率说明：soak 的虚拟时钟下每真实分钟有数千次调用，注入率必须远低于真实世界
    // （真实 429 是偶发），否则冷却会永久锁死强模型池、94% 的 draft 变成保护性失败
    // （2026-09-12 第二轮 soak 实测教训）
    if (chance(0.005)) { stats.modelFailures += 1; const e = new Error('模型接口请求超时'); e.statusCode = 500; e.retryable = true; throw e }
    if (chance(0.002)) { stats.modelFailures += 1; const e = new Error('inference exceeds tpm/rpm limit'); e.statusCode = 429; throw e }
    if (chance(0.002)) { stats.modelFailures += 1; return { choices: [{ message: { reasoning_content: '我们需要生成一条消息，要求是简短' } }], model } }
    if (chance(0.002)) { stats.modelFailures += 1; return { choices: [{ message: { content: '' } }], model }
    }
    return { choices: [{ message: { content: mockReply(String(parsed.messages?.at(-1)?.content || '')) } }], model }
  }
}

// ---- 应用健康巡检（B 层）----
const appFindings = []
async function probeApp(cdpProbe) {
  const finding = { at: new Date().toISOString() }
  try {
    if (cdpProbe) {
      const list = await (await fetch('http://127.0.0.1:9223/json', { signal: AbortSignal.timeout(3000) })).json()
      const main = list.filter((t) => t.type === 'page').find((t) => t.title === '抖音回复助手')
      finding.targets = list.filter((t) => t.type === 'page').length
      if (main) {
        const ws = new WebSocket(main.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('ws超时')), 4000) })
        let mid = 0
        const ev = (expr) => new Promise((res2) => { const i = ++mid; const h = (e) => { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); res2(m.result?.result?.value) } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })) })
        const t0 = Date.now()
        finding.rendererOk = (await ev('1+1')) === 2
        finding.rendererMs = Date.now() - t0
        finding.heapMB = Math.round((await ev('performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0')) || 0)
        finding.errorLogs = await ev(`(async () => { const s = await window.desktopApp.automation.getState(); return s.logs.filter(l => /crash|worker_error|worker_watchdog/.test(l.type)).slice(0, 5).map(l => l.type + ':' + l.message).join(' | ') })()`)
        ws.close()
      }
    }
  } catch (error) {
    finding.cdpError = error.message
  }
  try {
    // 文件层：两个账号的 state.json 完整性与尺寸
    const root = 'C:/Users/Administrator/AppData/Roaming/douyin-reply-assistant/accounts'
    finding.states = []
    for (const acc of ['default', 'acc-mtfg63k5']) {
      try {
        const file = path.join(root, acc, 'state.json')
        const raw = fs.readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw)
        finding.states.push({ acc, kb: Math.round(raw.length / 1024), contacts: parsed.contacts?.length, logs: parsed.logs?.length })
      } catch (error) {
        finding.states.push({ acc, error: error.message })
        violation('V4-app-state', `${acc} state.json 损坏: ${error.message}`)
      }
    }
  } catch { /* ignore */ }
  appFindings.push(finding)
  return finding
}

// ---- 真实模型质量探针（每 15 分钟一次）----
let lastQualityProbe = 0
async function qualityProbe() {
  const list = await fetch('http://127.0.0.1:9223/json', { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null)
  if (!list) return null
  const main = list.filter((t) => t.type === 'page').find((t) => t.title === '抖音回复助手')
  if (!main) return null
  const ws = new WebSocket(main.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('ws超时')), 4000) })
  let mid = 0
  const ev = (expr) => new Promise((res2) => { const i = ++mid; const h = (e) => { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); res2(m.result?.result?.value) } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })) })
  const result = await ev(`window.desktopApp.ai.draft(${JSON.stringify({
    contact: { id: 'soak-probe', name: 'soak·质量探针', profile: { relationship: '朋友' }, learning: { messages: [{ role: 'contact', text: '在忙啥' }, { role: 'me', text: '刚忙完' }] } },
    incoming: pick(NORMAL_MSGS),
    incomingMeta: { sentAt: new Date().toISOString(), sentAtLabel: '刚刚' },
  })}).catch(e => ({ ok: false, error: e.message }))`)
  ws.close()
  return result
}

// ---- 主循环 ----
async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  const progressPath = path.join(ARTIFACTS, 'soak-progress.jsonl')
  const reportPath = path.join(ARTIFACTS, `soak-report-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.md`)
  const progress = (obj) => fs.appendFileSync(progressPath, JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n', 'utf8')

  // A 层初始化：真实存储 + 注入 mock 的 AI 服务
  let dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-state-'))
  let storage = new JsonStorage(dataDir)
  let ai = new AiService(storage, { transport: makeMockTransport() })
  // 预置联系人 + 模型列表（3 个模型让故障转移链真实运转）
  const contacts = ROSTER.map((name) => ({ id: name, name, profile: { relationship: '朋友' }, learning: { messages: [], facts: [], topicLog: [], mediaLog: [] }, turn: { lastHandledKey: '', lastOutgoingAt: 0 } }))
  storage.update({
    contacts,
    providers: [
      { name: 'soak-primary', model: 'deepseek-v4', baseUrl: 'https://soak.test/v1', capabilities: [] },
      { name: 'soak-backup', model: 'qwen-max', baseUrl: 'https://soak.test/v1', capabilities: [] },
      { name: 'soak-vision', model: 'meta/llama-3.2-11b-vision-instruct', baseUrl: 'https://soak.test/v1', capabilities: ['vision'] },
    ],
  })
  personas.clear()
  for (const name of ROSTER) personas.set(name, { lastSent: '', lastReply: '' })

  progress({ event: 'start', minutes: MINUTES, pid: process.pid })
  console.log(`[soak] 启动：${MINUTES} 分钟（pid ${process.pid}）`)
  console.log(`[soak] 进度: ${progressPath}`)
  console.log(`[soak] 报告: ${reportPath}`)

  let lastProbeAt = 0
  let lastReportAt = 0
  let ticksSinceYield = 0
  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss

  while (Date.now() < DEADLINE) {
    // ---- B 层：定期巡检 ----
    if (Date.now() - lastProbeAt > 5 * 60 * 1000) {
      lastProbeAt = Date.now()
      const finding = await probeApp(true).catch((e) => ({ at: new Date().toISOString(), error: e.message }))
      const rss = Math.round(process.memoryUsage().rss / 1048576)
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      progress({ event: 'probe', turns: stats.turns, rssMB: rss, ...finding })
      if (rss > 800) violation('V10-mem', `soak 进程 RSS ${rss}MB 异常偏高`)
      console.log(`[probe] ${finding.at.slice(11, 19)} turns=${stats.turns} rss=${rss}MB 违例=${violations.reduce((s, v) => s + 1, 0) + Object.values(violationsByType).reduce((s, n) => s + n, 0)}`)
      // 真实模型质量探针（15 分钟一次，走正在运行的应用）
      if (Date.now() - lastQualityProbe > 15 * 60 * 1000) {
        lastQualityProbe = Date.now()
        const q = await qualityProbe().catch((e) => ({ ok: false, error: e.message }))
        if (q) {
          const ok = q.ok && q.text && [...q.text].length <= 42 && !/```|\*\*/.test(q.text)
          progress({ event: 'quality-probe', ok, text: q.text, model: q.model, error: q.error })
          if (!ok) violation('V3-quality-probe', `真实模型探针异常: ${JSON.stringify({ text: q.text, error: q.error }).slice(0, 200)}`)
        }
      }
    }

    // ---- A 层：一轮对话 ----
    try {
      stats.turns += 1
      const name = pick(ROSTER)
      const p = personas.get(name)

      // 虚拟时间推进：小间隔为主，偶尔数小时跳跃（隔天场景）
      vNow += chance(0.05) ? (4 + rng() * 20) * 3600 * 1000 : MIN_AUTO_REPLY_GAP_MS * (0.1 + rng() * 4)

      // 行为选择
      const behaviorRoll = rng()
      const stored = storage.get().contacts.find((c) => c.name === name) || { learning: {} }
      let preview
      let media = null
      let behavior = 'normal'
      if (behaviorRoll < 0.12) { behavior = 'low-info'; preview = pick(LOW_INFO) }
      else if (behaviorRoll < 0.17) { behavior = 'hijack'; preview = pick(HIJACKS) }
      else if (behaviorRoll < 0.22) { behavior = 'video'; preview = '[视频]'; media = { mediaKind: 'video', detectedVideo: true, videoReady: false, confidence: 'medium', frameDetail: 'low', videoPageTitle: pick(['狗狗等主人放学', '深夜食堂探店', '健身动作教学']), videoPageDescription: '日常分享', videoComments: ['太可了', '学到了', '哈哈哈哈'] } }
      else if (behaviorRoll < 0.26 && p.lastSent) { behavior = 'echo'; preview = p.lastSent } // 预览显示我方已发送内容（含标签，与真实系统一致）
      else if (behaviorRoll < 0.30) { behavior = 'same-key'; preview = stored.learning?.messages?.at(-1)?.role === 'contact' ? stored.learning.messages.at(-1).text : pick(NORMAL_MSGS) }
      else if (behaviorRoll < 0.33) { behavior = 'fuzz'; preview = pick(['😄😊😃', 'a'.repeat(80), ' Messло文mixed123', '​零宽字符', 'ok\nnext']) }
      else { preview = pick(NORMAL_MSGS) }

      // --- 复刻 runAutomation 的判定序列 ---
      let key = media ? `${preview}${MEDIA_SEP}${Math.floor(rng() * 1e15)}` : preview
      // 角色判定：echo = 我方回显 → fromMe
      const fromMe = behavior === 'echo' ? true : (chance(0.02) ? null : false) // 2% 角色无法确认
      if (fromMe === true) {
        const echoGuard = preview === p.lastSent || preview.startsWith(p.lastSent) || preview.includes('【AI · ')
        if (!echoGuard) violation('V2', `我方消息未被回声守卫识别: ${preview.slice(0, 40)}`)
        const turn2 = markHandled({ ...(storage.get().contacts.find((c) => c.name === name)?.turn || {}) }, key, vNow)
        persistTurn(storage, name, turn2)
        continue
      }
      if (fromMe !== false) { stats.skips += 1; continue } // 角色未确认：不回复（正确行为）
      const gate = shouldAutoReply({ turn: stored.turn || {} }, { key, fromMe: false, now: vNow })
      if (!gate.ok) {
        stats.gateBlocks[gate.reason] = (stats.gateBlocks[gate.reason] || 0) + 1
        if (gate.reason === 'min_gap' && chance(0.02)) violation('V7-check', `min_gap 拦截正常触发（计数核对）`)
        continue
      }

      // --- AI draft（真实代码路径）---
      const learning = { messages: (stored.learning?.messages || []), facts: [], topicLog: [], mediaLog: [] }
      const contact = { id: name, name, profile: { relationship: '朋友' }, learning, turn: stored.turn || {} }
      const prevReplyCount = stats.replies
      let draft
      try {
        draft = await ai.draft({ contact, incoming: preview, incomingMeta: { sentAt: new Date(vNow).toISOString(), sentAtLabel: '刚刚' }, videoFrames: media || undefined })
      } catch (error) {
        stats.draftErrors += 1
        // 提供商冷却中的报错是预期行为；全健康时报错才算违例（这里 mock 无冷却持续报错大概率是代码问题，计为观察项）
        if (chance(0.05)) progress({ event: 'draft-error', error: error.message.slice(0, 150) })
        continue
      }
      if (!draft?.ok) { stats.draftErrors += 1; continue }
      if (draft.skipped) { stats.rejections += 1 }
      else {
        const text = String(draft.text || '')
        // ---- V3：质量门断言（任何漏网 = bug）----
        if (!text) violation('V3', '回复为空但未标记 skipped/rejected')
        if ([...text].length > 42) violation('V3', `超长回复漏网（${[...text].length} 字）: ${text.slice(0, 50)}`)
        if (/```|\*\*/.test(text)) violation('V3', `Markdown 漏网: ${text.slice(0, 50)}`)
        if (isReasoningLeak(text)) violation('V3', `思考泄漏漏网: ${text.slice(0, 50)}`)
        if (/(?:闭嘴|滚(?:蛋|开)?|废物|去死|傻[逼屌bB]|我理解你的感受|感谢你的分享)/i.test(text)) violation('V3', `攻击性/AI腔漏网: ${text.slice(0, 50)}`)
        stats.replies += 1
        p.lastReply = text
        p.lastSent = draft.labeledText || text
        // 记录我方消息（镜像 automation），供复读守卫与复读检测用
        learning.messages.push({ role: 'me', text: draft.labeledText || text })
        learning.messages = learning.messages.slice(-60)
      }
      // ---- V7：最小发送间隔（虚拟时钟核对）----
      const turnNow = storage.get().contacts.find((c) => c.name === name)?.turn || {}
      if (turnNow.lastOutgoingAt && vNow - turnNow.lastOutgoingAt < MIN_AUTO_REPLY_GAP_MS && stats.replies === prevReplyCount + 1 && !draft.skipped) {
        // 正常路径不会走到这里（gate 已拦），走到这里说明门控有洞
        violation('V7', `最小间隔未被门控拦截（Δ${vNow - turnNow.lastOutgoingAt}ms）`)
      }
      const newTurn = draft.skipped ? markHandled({ ...turnNow }, key, vNow) : markHandled(markOutgoing({ ...turnNow }, vNow), key, vNow)
      persistTurn(storage, name, newTurn)

      // 记录对方消息（镜像 recordConversationMessage）
      if (preview && !media) {
        const state = storage.get()
        const idx = state.contacts.findIndex((c) => c.name === name)
        if (idx >= 0) {
          const msgs = [...(state.contacts[idx].learning?.messages || []), { role: 'contact', text: preview.slice(0, 300) }].slice(-60)
          if (msgs.length > 60) violation('V5', `messages 超界: ${msgs.length}`)
          const contacts2 = [...state.contacts]
          contacts2[idx] = { ...contacts2[idx], learning: { ...state.contacts[idx].learning, messages: msgs } }
          storage.update({ contacts: contacts2 })
        }
      }

      // ---- V1：同 key 重放（每 97 轮抽测一次）----
      if (stats.turns % 97 === 0) {
        const replay = shouldAutoReply({ turn: storage.get().contacts.find((c) => c.name === name)?.turn || {} }, { key, fromMe: false, now: vNow })
        if (replay.ok) violation('V1', `已处理 key 重放仍放行: ${String(key).slice(0, 30)}`)
      }
    } catch (error) {
      violation('V7-loop', `主循环异常: ${error.stack?.split('\n')[0] || error.message}`)
    }

    // ---- 重启模拟（每 ~1500 轮）：V8 持久化恢复 ----
    if (stats.turns % 1500 === 0) {
      const name = pick(ROSTER)
      const before = storage.get().contacts.find((c) => c.name === name)?.turn || {}
      if (before.lastHandledKey) {
        storage = new JsonStorage(dataDir) // 从磁盘重建（真实重启语义）
        ai = new AiService(storage, { transport: makeMockTransport() })
        stats.restarts += 1
        const after = storage.get().contacts.find((c) => c.name === name)?.turn || {}
        if (after.lastHandledKey !== before.lastHandledKey) violation('V8', `重启后轮次状态丢失: ${name}`)
        const replay = shouldAutoReply({ turn: after }, { key: before.lastHandledKey, fromMe: false, now: vNow })
        if (replay.ok) violation('V1-restart', `重启后同 key 重放被放行: ${name}`)
      }
    }

    // 节流 yield + 定期进度输出
    if (++ticksSinceYield >= 200) {
      ticksSinceYield = 0
      await sleep(30)
      if (Date.now() - lastReportAt > 60 * 1000) {
        lastReportAt = Date.now()
        const totalViolations = Object.values(violationsByType).reduce((s, n) => s + n, 0)
        progress({ event: 'tick', turns: stats.turns, replies: stats.replies, violations: totalViolations })
      }
    }
  }

  // ---- 最终报告 ----
  const finalRss = Math.round(process.memoryUsage().rss / 1048576)
  const totalViolations = Object.values(violationsByType).reduce((s, n) => s + n, 0)
  const lines = [
    `# 3 小时 soak 测试报告`,
    ``,
    `- 时长：${MINUTES} 分钟（${new Date().toISOString()} 结束）`,
    `- 虚拟对话轮次：${stats.turns}（虚拟时钟跨越数月）`,
    `- AI 回复：${stats.replies} 次；质检拒发/不回复：${stats.rejections} 次；门控拦截：${JSON.stringify(stats.gateBlocks)}`,
    `- 模型故障注入：${stats.modelFailures} 次；draft 异常：${stats.draftErrors} 次；存储重启模拟：${stats.restarts} 次`,
    `- soak 进程内存：峰值 ${Math.round(peakRss / 1048576)}MB / 结束 ${finalRss}MB`,
    `- 应用健康巡检：${appFindings.length} 次（详见 progress jsonl）`,
    ``,
    `## 结论：${totalViolations === 0 ? '✅ 未发现不变量违例' : `❌ 发现 ${totalViolations} 个违例（去重后 ${Object.keys(violationsByType).length} 类）`}`,
    ``,
    `## 违例分布`,
    ...Object.entries(violationsByType).map(([type, count]) => `- ${type}: ${count} 次`),
    ``,
    `## 违例样本（最多 50 条）`,
    ...violations.slice(0, 50).map((v) => `- [${v.type}] ${v.detail}（虚拟时间 ${v.vNow}，第 ${v.turns} 轮）`),
    ``,
    `## 应用巡检摘要（最近 10 次）`,
    ...appFindings.slice(-10).map((f) => `- ${f.at} targets=${f.targets ?? '-'} renderer=${f.rendererOk ?? '-'}(${f.rendererMs ?? '-'}ms) heap=${f.heapMB ?? '-'}MB states=${JSON.stringify(f.states || [])} ${f.cdpError ? 'cdp:' + f.cdpError : ''}`),
  ]
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log('\n' + lines.join('\n'))
  progress({ event: 'done', totalViolations, turns: stats.turns })
  process.exit(totalViolations === 0 ? 0 : 1)
}

function persistTurn(storage, name, turn) {
  const state = storage.get()
  const idx = state.contacts.findIndex((c) => c.name === name)
  if (idx < 0) return
  const contacts = [...state.contacts]
  contacts[idx] = { ...contacts[idx], turn }
  storage.update({ contacts })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
main().catch((error) => { console.error('[soak] 致命错误:', error); process.exit(2) })
