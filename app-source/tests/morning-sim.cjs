// "每天只发早上好/嗨"场景模拟器（100 遍）
//
// 场景：对方每天只发裸问候（早上好/嗨/续火花/表情），验证：
//  1. 跨天解锁——每天的同文本问候都能得到回复（每日消息键修复的回归验证）；
//  2. 回复多样性——连续 20 天给同一人回"早上好"，不逐字复读、质量门不回退；
//  3. 同日防刷屏——同一天重复同文本不触发 AI（每 10 轮抽查一次）。
//
// 用法：node tests/morning-sim.cjs [轮数，默认 100]
// 前置：应用带 --remote-debugging-port=9223 运行（真实模型）
const fs = require('node:fs')
const path = require('node:path')
require('./setup.cjs')
const { shouldAutoReply, markHandled, markOutgoing, dailyMessageKey, MIN_AUTO_REPLY_GAP_MS } = require('../electron/conversation-engine.cjs')
const { sharesLongSubstring } = require('../electron/ai-service.cjs')

const DEBUG_HOST = 'http://127.0.0.1:9223'
const ARTIFACTS = path.join(__dirname, '..', 'test-artifacts')
const TOTAL = Number(process.argv[2] || 100)
const CONTACTS = ['morningsim·小明', 'morningsim·小红', 'morningsim·阿强', 'morningsim·阿花', 'morningsim·老周']
const GREETINGS = ['早上好', '嗨', '早上好呀', '早呀', '早安', '嗨嗨', '续火花', '😊', '在吗', '早上好！']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findMainPage() {
  const list = await (await fetch(`${DEBUG_HOST}/json`)).json()
  const main = list.filter((t) => t.type === 'page').find((t) => t.title === '抖音回复助手')
  if (!main) throw new Error('找不到主窗口，请确认应用带 --remote-debugging-port=9223 启动')
  return main.webSocketDebuggerUrl
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send(method, params) { return new Promise((res2, rej2) => { const mid = ++id; pending.set(mid, { res: res2, rej: rej2 }); ws.send(JSON.stringify({ id: mid, method, params })) }) },
      close: () => ws.close(),
    })
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result) }
    }
    ws.onerror = () => reject(new Error('WebSocket 连接失败'))
  })
}
async function evalMain(cdp, expr, timeoutMs = 200000) {
  const out = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => { throw new Error('页面调用超时') }),
  ])
  if (out.exceptionDetails) throw new Error('页面内异常: ' + (out.exceptionDetails.exception?.description || out.exceptionDetails.text).slice(0, 200))
  return out.result?.value
}
const DRAFT_EXPR = (payload) => `window.desktopApp.ai.draft(${JSON.stringify(payload)}).catch(e => ({ ok: false, error: e.message }))`

async function main() {
  const t0 = Date.now()
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const jsonlPath = path.join(ARTIFACTS, `morning-${stamp}.jsonl`)
  const reportPath = path.join(ARTIFACTS, `morning-report-${stamp}.md`)
  const jl = (obj) => fs.appendFileSync(jsonlPath, JSON.stringify(obj) + '\n', 'utf8')

  const cdp = await connect(await findMainPage())
  const state = new Map() // contact -> { turn, history: [], sent: [], lastReply, lastSent }
  const contactOf = (name) => {
    if (!state.has(name)) state.set(name, { turn: {}, history: [], lastReply: '', lastSent: '' })
    return state.get(name)
  }
  let vNow = Date.now()
  const DAY = 86400000
  const records = []
  let aiCalls = 0
  let cooldownFails = 0

  console.log(`[morning-sim] ${TOTAL} 轮 · ${CONTACTS.length} 位"每天只发问候"的联系人（每轮=一天）`)

  for (let i = 0; i < TOTAL; i += 1) {
    // 16s/条：低于 AMD 免费档真实 RPM（~4/min），避免把网关打进冷却窗口失真
    if (i > 0 && Date.now() - t0 < 16000) await sleep(16000 - (Date.now() - t0))
    const name = CONTACTS[i % CONTACTS.length]
    const st = contactOf(name)
    // 每轮推进一天（该联系人的第 floor(i/5)+1 天）
    const dayIndex = Math.floor(i / CONTACTS.length)
    const sentAt = new Date(t0 + dayIndex * DAY + 8 * 3600000) // 每天早上 8 点发来
    vNow = sentAt.getTime() + 60000
    const incoming = GREETINGS[i % GREETINGS.length]
    const key = dailyMessageKey(incoming, sentAt)

    // 同日防刷屏抽查：每 10 轮，把刚处理过的 key 再喂一次（同一天）→ 必须被拦
    if (i > 0 && i % 10 === 0 && st.turn.lastHandledKey) {
      const gate = shouldAutoReply(st.turn ? { turn: st.turn } : {}, { key: st.turn.lastHandledKey, fromMe: false, now: vNow })
      const blocked = !gate.ok
      records.push({ i: i - 0.5, dim: 'gate-check', name, passed: blocked, detail: gate.reason || '未拦截!' })
      jl({ event: 'gate-check', i, blocked, reason: gate.reason || 'NOT_BLOCKED' })
      if (!blocked) console.log(`  ⚠️ 同日防刷屏抽查未拦截！`)
    }

    // 角色确认 + 回声守卫 + 引擎闸门（与 runAutomation 一致）
    const gate = shouldAutoReply({ turn: st.turn }, { key, fromMe: false, now: vNow })
    if (!gate.ok) {
      records.push({ i, dim: 'reply', name, incoming, text: '', passed: false, issue: `门控拦截:${gate.reason}（跨天应解锁！修复失效）`, aiCalled: 0 })
      jl({ event: 'turn', i, name, incoming, passed: false, reason: gate.reason })
      console.log(`[${String(i + 1).padStart(3)}/${TOTAL}] ${name} "${incoming}" → ❌ 门控拦截 ${gate.reason}`)
      continue
    }
    const contact = {
      id: name, name, profile: { relationship: '朋友' },
      learning: { messages: st.history.slice(-30), facts: [], topicLog: [], mediaLog: [] },
      turn: st.turn,
    }
    let result
    try {
      result = await evalMain(cdp, DRAFT_EXPR({ contact, incoming, incomingMeta: { sentAt: sentAt.toISOString(), sentAtLabel: '刚刚' } }))
      aiCalls += 1
    } catch (error) {
      result = { ok: false, error: error.message }
    }
    if (!result?.ok && /没有可用的 AI 模型/.test(String(result?.error || ''))) cooldownFails += 1
    const text = String(result?.text || '')
    const issues = []
    if (result?.skipped) issues.push(result.rejected ? '被质检拒发（裸问候不该拒发）' : 'AI 判断不回复（裸问候不该沉默）')
    if (text && [...text].length > 42) issues.push('超长')
    if (text && /```|\*\*/.test(text)) issues.push('Markdown')
    if (/(?:作为(?:一个)?AI|我理解你的感受|听起来你|感谢你的分享)/i.test(text)) issues.push('AI 腔')
    if (isReasoningLeakLocal(text)) issues.push('思考泄漏')
    if ((text.match(/\p{Extended_Pictographic}/gu) || []).length > 2) issues.push('表情过多')
    if (text && text === st.lastReply) issues.push('与上一条逐字重复')
    if (text && st.lastReply && sharesLongSubstring(text, st.lastReply, 12)) issues.push('与上一条高度重合(≥12)')
    const passed = issues.length === 0 && (Boolean(result?.ok) || Boolean(result?.rejected))
    records.push({ i, dim: 'reply', name, incoming, text: text.slice(0, 60), passed, issue: issues.join(';'), aiCalled: 1, day: dayIndex + 1 })
    jl({ event: 'turn', i, name, incoming, day: dayIndex + 1, text, passed, issues, error: result?.error || '' })
    console.log(`[${String(i + 1).padStart(3)}/${TOTAL}] ${name} "${incoming}" → ${passed ? '✅' : '❌'} ${JSON.stringify(text.slice(0, 30))}${issues.length ? ' ' + issues.join(';') : ''}`)
    if (text) {
      st.lastReply = text
      st.lastSent = String(result?.labeledText || text)
      st.history.push({ role: 'contact', text: incoming }, { role: 'me', text: String(result?.labeledText || text) })
      st.history = st.history.slice(-30)
      st.turn = markHandled(markOutgoing(st.turn, vNow), key, vNow)
    }
  }
  try { cdp.close() } catch {}

  // ---- 报告 ----
  const replies = records.filter((r) => r.dim === 'reply')
  const checks = records.filter((r) => r.dim === 'gate-check')
  const passed = replies.filter((r) => r.passed).length
  const gatePassed = checks.filter((r) => r.passed).length
  const variety = new Map()
  for (const r of replies) {
    variety.set(r.name, variety.get(r.name) || { total: 0, distinct: new Set(), repeats: 0 })
    const v = variety.get(r.name)
    v.total += 1
    if (r.text) v.distinct.add(r.text)
    if (r.issue?.includes('逐字重复')) v.repeats += 1
  }
  const lines = [
    `# "每天只发早上好/嗨"场景模拟报告（${replies.length} 轮回复 + ${checks.length} 次防刷屏抽查）`,
    ``,
    `- 回复正常率：**${passed}/${replies.length}（${(passed / Math.max(1, replies.length) * 100).toFixed(0)}%）**`,
    `- 同日防刷屏抽查：${gatePassed}/${checks.length} 通过`,
    `- 模拟期间 AI 调用 ${aiCalls} 次（冷却跳过 ${cooldownFails} 轮）`,
    ``,
    `## 每联系人回复多样性（连续 20 天只发问候）`,
    ``,
    `| 联系人 | 轮数 | 去重后不同回复 | 逐字重复 |`,
    `|---|---|---|---|`,
    ...[...variety.entries()].map(([name, v]) => `| ${name} | ${v.total} | ${v.distinct.size} | ${v.repeats} |`),
    ``,
    `## 失败样本`,
    ``,
    ...replies.filter((r) => !r.passed).slice(0, 15).map((r) => `- 第${r.i}轮 ${r.name} "${r.incoming}" → ${r.issue || r.detail || '（空）'}`),
  ]
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log('\n' + lines.join('\n'))
  console.log(`\n报告：${reportPath}`)
  const bad = passed < replies.length * 0.95 || gatePassed < checks.length
  console.log(bad ? '\n❌ 存在异常' : '\n✅ 全部正常')
  process.exit(bad ? 1 : 0)
}

function isReasoningLeakLocal(text) {
  return /^(我们|我)(根据|按照|需要)|根据(要求|提示)/.test(String(text || ''))
}

main().catch((error) => { console.error('[morning-sim] 致命错误:', error.message); process.exit(1) })
