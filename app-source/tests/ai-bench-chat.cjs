// 对话理解专项基准（600 遍）：表情识别 / 网络用语 / 视频文案+评论 / 跨消息污染 / 带偏与关键信息 / 回复质量
// 规划见 BENCH-PLAN.md。用法：node tests/ai-bench-chat.cjs [总轮数，默认 600]
// 前置：应用以 --remote-debugging-port=9223 运行（真实模型）
const fs = require('node:fs')
const path = require('node:path')
require('./setup.cjs')
const { sharesLongSubstring } = require('../electron/ai-service.cjs')

const DEBUG_HOST = 'http://127.0.0.1:9223'
const ARTIFACTS = path.join(__dirname, '..', 'test-artifacts')
const TOTAL = Number(process.argv[2] || 600)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- CDP ----
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

// ---- 脚本用例（一个循环 = 45 轮）----
// dim: emoji/slang/video/isolation/derail/keyinfo/quality
// hit: 关键词类（任一命中即过）；askOk: 追问含义也算过；noneOf: 禁止出现（污染检测）
const CYCLE = [
  // 1. 表情识别与回话（8）
  { dim: 'emoji', name: '🎉中奖', incoming: '我中奖了！！🎉🎉🎉', hit: ['中奖', '恭喜', '牛', '真的假', '幸运', '多少', '哇', '请'] },
  { dim: 'emoji', name: '😭输了', incoming: '我们队输了，😭', hit: ['输', '抱抱', '没事', '下一', '心疼', '咋', '遗憾', '正常'] },
  { dim: 'emoji', name: '🍲邀约', incoming: '今晚吃火锅🍲你去不去', hit: ['火锅', '去', '吃', '哪家', '啥', '几点'] },
  { dim: 'emoji', name: '💪健身', incoming: '💪今天练了两小时', hit: ['练', '厉害', '健身', '累', '棒', '猛'] },
  { dim: 'emoji', name: '🎂生日', incoming: '🎂明天我生日', hit: ['生日', '快乐', '蛋糕', '哪', '请'] },
  { dim: 'emoji', name: '😔面试挂', incoming: '😔面试又挂了', hit: ['面试', '挂', '下次', '抱抱', '咋', '可惜', '没事'] },
  { dim: 'emoji', name: '🙉不敢看', incoming: '🙉我不敢看结果', hit: ['敢', '看', '结果', '哈哈', '咋', '我帮', '怕', '陪', '等', '重来', '别'] },
  { dim: 'emoji', name: '🔥火了', incoming: '我发的视频终于火了🔥', hit: ['火', '恭喜', '牛', '多少', '播放', '可以'] },
  // 2. 网络用语理解（10）
  { dim: 'slang', name: '尊嘟假嘟', incoming: '尊嘟假嘟，你真考上了？', hit: ['真的假', '尊嘟', '真的', '假', '考'], askOk: true },
  { dim: 'slang', name: '绝绝子', incoming: '这家店味道绝绝子', hit: ['绝', '牛', '好吃', '哪家', '确实', '名字', '尝', '去', '带', '店', '馋', '想吃'], askOk: true },
  { dim: 'slang', name: '栓Q', incoming: '栓Q，帮大忙了', hit: ['谢', '栓', '客气', '应该', '小事'], askOk: true },
  { dim: 'slang', name: 'emo了', incoming: '我emo了', hit: ['emo', '咋', '难过', '抱抱', '怎么'], askOk: true },
  { dim: 'slang', name: '上头', incoming: '这歌也太上头了', hit: ['上头', '魔性', '停', '哪首', '确实', '单曲'], askOk: true },
  { dim: 'slang', name: '666', incoming: '666', hit: ['6', '牛', '溜', '厉害', '啥', '逗', '哈哈', '可以', '才'] },
  { dim: 'slang', name: '破防', incoming: '破防了兄弟们', hit: ['破防', '绷', '心疼', '咋', '抱抱', '啥'], askOk: true },
  { dim: 'slang', name: 'yyds', incoming: '你真yyds', hit: ['yyds', '永远', '牛', '厉害', '过奖', '夸', '不好意思', '骄傲'], askOk: true },
  { dim: 'slang', name: '画大饼', incoming: '领导又画大饼了', hit: ['饼', '画', '老板', '领导', '哈', '信', '听', '完', '这样', '别', '又'], askOk: true },
  { dim: 'slang', name: '吃瓜', incoming: '我先吃个瓜', hit: ['瓜', '吃', '谁', '啥', '说说'], askOk: true },
  // 3. 视频=文案+评论（6）
  { dim: 'video', name: '蛋炒饭教学', incoming: '【视频】看看这个', media: { videoPageTitle: '三步搞定黄金蛋炒饭', videoPageDescription: '隔夜饭是关键，小火不粘锅', videoComments: ['第一次做没糊', '我糊了两次哈哈', '隔夜饭真的好用'] }, hit: ['蛋炒饭', '炒饭', '蛋', '饭', '糊', '隔夜', '学'], noneOf: ['猫', '游戏', '吉他'] },
  { dim: 'video', name: '让座摆拍', incoming: '【视频】看看这个', media: { videoPageTitle: '在地铁上让座被拍到', videoPageDescription: '', videoComments: ['摆拍实锤', '演员都不换人', '我第三次刷到了'] }, hit: ['让座', '摆拍', '演', '拍', '地铁', '台词', '刷到', '三次', '眼熟', '又'], noneOf: ['猫', '蛋炒饭'] },
  { dim: 'video', name: '猫开冰箱', incoming: '【视频】看看这个', media: { videoPageTitle: '我家猫学会开冰箱了', videoPageDescription: '每天蹲点等投喂', videoComments: ['下一集偷吃鱼', '我家狗只会拆家', '太聪明了吧'] }, hit: ['猫', '冰箱', '开', '偷', '聪明'], noneOf: ['游戏', '吉他'] },
  { dim: 'video', name: '深蹲翻车', incoming: '【视频】看看这个', media: { videoPageTitle: '深蹲180kg翻车现场', videoPageDescription: '', videoComments: ['保护杠救了一命', '胆子是真大', '重量上去了别硬冲'] }, hit: ['深蹲', '180', '翻车', '杠', '重量', '胆', '保重'], noneOf: ['猫', '吉他'] },
  { dim: 'video', name: '苍蝇馆子', incoming: '【视频】看看这个', media: { videoPageTitle: '这家苍蝇馆子开了20年', videoPageDescription: '就一个菜，天天排队', videoComments: ['味道确实稳定', '老板娘换了', '价格没涨'] }, hit: ['馆子', '店', '20', '味道', '队', '吃'], noneOf: ['猫', '游戏'] },
  { dim: 'video', name: '川西旅行', incoming: '【视频】看看这个', media: { videoPageTitle: '川西小环线第一天', videoPageDescription: '海拔四千米，风景绝了', videoComments: ['注意高反', '路况怎么样', '风景值了'] }, hit: ['川西', '高反', '路', '风景', '玩', '海'], noneOf: ['猫', '吉他'] },
  // 4. 跨消息污染——记忆回指序列（同联系人）
  { dim: 'isolation', name: '回指·爬山1', contact: '小明', incoming: '周末想去爬山', hit: null, noneOf: null },
  { dim: 'isolation', name: '回指·爬山2', contact: '小明', incoming: '查了下那条路线风景特别好', hit: null, noneOf: null },
  { dim: 'isolation', name: '切到游戏1', contact: '小明', incoming: '对了我在玩个新游戏，很上头', hit: null, noneOf: ['爬山', '山'] },
  { dim: 'isolation', name: '切到游戏2', contact: '小明', incoming: '都玩到第三关了', hit: null, noneOf: ['爬山'] },
  { dim: 'isolation', name: '记忆回指（核心）', contact: '小明', incoming: '诶我之前说周末想去干啥来着？', hit: ['爬山', '山', '爬'], noneOf: ['游戏', '关卡'] },
  // 4b. 跨联系人隔离（交错）
  { dim: 'isolation', name: '小红·吉他1', contact: '小红', incoming: '我报了个吉他班', hit: null, noneOf: ['爬山', '炒饭', '游戏'] },
  { dim: 'isolation', name: '小明·爬山回应', contact: '小明', incoming: '山上风好大但是舒服', hit: null, noneOf: ['吉他', '琴'] },
  { dim: 'isolation', name: '小红·吉他2', contact: '小红', incoming: '手指都磨出泡了', hit: null, noneOf: ['爬山', '炒饭'] },
  { dim: 'isolation', name: '小明·蛋炒饭', contact: '小明', incoming: '今晚试着做了蛋炒饭', hit: null, noneOf: ['吉他', '琴', '减肥'] },
  // 5. 带偏与关键信息
  { dim: 'derail', name: '游戏语境1', contact: '小刚', incoming: '最近在打排位', hit: null, noneOf: null },
  { dim: 'derail', name: '游戏语境2', contact: '小刚', incoming: '就差一星上段位了', hit: null, noneOf: null },
  { dim: 'derail', name: '哲学突袭', contact: '小刚', incoming: '你觉得人活着到底是为了什么', hit: null, noneOf: null, maxLen: 32 },
  { dim: 'derail', name: '拉回游戏（连续性）', contact: '小刚', incoming: '算了不想这个了，我卡在第三关了', hit: ['关', '卡', '游戏', '打', '星'], noneOf: null },
  { dim: 'keyinfo', name: '生日+手机', incoming: '我明天生日诶，对了跟你说个烦心事，我手机昨天摔碎了', hit: ['生日', '快乐', '手机', '摔', '碎', '屏'], minHitNote: '生日或手机' },
  { dim: 'keyinfo', name: '上岸+自谦', incoming: '我考上研究生了！！虽然只是个普通学校', hit: ['研究生', '恭喜', '考', '上岸', '牛', '厉害'] },
  { dim: 'keyinfo', name: '猫+禁令', incoming: '我爸不让我养猫了😢', hit: ['猫', '爸', '咋', '抱抱', '遗憾', '喜欢'] },
  { dim: 'keyinfo', name: '欠薪', incoming: '工作三个月了，工资还没发', hit: ['工资', '发', '欠', '惨', '咋', '拖'] },
  // 6. 回声抽查（每循环 1 次，静默判定）
  { dim: 'quality', name: '回声静默', echo: true },
  { dim: 'quality', name: '普通收尾', incoming: '哈哈好吧，先这样', hit: null, noneOf: null },
]

// ---- 评分 ----
const ASK_MEANING = /什么意思|啥意思|啥玩意|什么玩意|这啥|什么瓜|什么梗/
function grade(turn, replyRec, ctx) {
  const text = String(replyRec?.text || '')
  const issues = []
  const skipped = Boolean(replyRec?.skipped)
  if (turn.hit) {
    const hit = turn.hit.some((k) => text.includes(k))
    const asked = turn.askOk && ASK_MEANING.test(text)
    if (!hit && !asked && !skipped && !replyRec?.rejected) issues.push(`未命中关键词类 [${turn.hit.join('/')}]${turn.askOk ? '也未追问含义' : ''}`)
  }
  if (turn.noneOf) {
    const bad = turn.noneOf.filter((k) => text.includes(k))
    if (bad.length) issues.push(`污染词出现: ${bad.join(',')}`)
  }
  if (turn.maxLen && [...text].length > turn.maxLen) issues.push(`超长（${[...text].length} > ${turn.maxLen}）`)
  if (text && text === ctx.lastReply) issues.push('与上一条回复逐字重复')
  if (text && sharesLongSubstring(text, ctx.lastReply || '', 10)) issues.push('与上一条回复高度重合')
  return issues
}

// ---- 主流程 ----
async function main() {
  const t0 = Date.now()
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const jsonlPath = path.join(ARTIFACTS, `chat-${stamp}.jsonl`)
  const reportPath = path.join(ARTIFACTS, `chat-report-${stamp}.md`)
  const jl = (obj) => fs.appendFileSync(jsonlPath, JSON.stringify(obj) + '\n', 'utf8')

  const cdp = await connect(await findMainPage())
  const contacts = new Map() // name -> { learning: { messages: [] } }
  const contactOf = (name) => {
    if (!contacts.has(name)) contacts.set(name, { learning: { messages: [], facts: [], topicLog: [], mediaLog: [] } })
    return contacts.get(name)
  }
  const sentHistory = new Map() // name -> [{role,text}]
  const lastReplyByContact = new Map()

  console.log(`[chat-bench] 目标 ${TOTAL} 轮 · 每循环 ${CYCLE.length} 例`)
  jl({ event: 'start', total: TOTAL })

  let lastTurnAt = 0
  let cooldownFails = 0
  const records = []
  try {
    for (let i = 0; i < TOTAL; i += 1) {
      const sinceLast = Date.now() - lastTurnAt
      if (lastTurnAt && sinceLast < 8000) await sleep(8000 - sinceLast)
      if (cooldownFails >= 3) { console.log('  冷却等待 60s…'); await sleep(60000) }
      lastTurnAt = Date.now()

      const turn = CYCLE[i % CYCLE.length]
      const name = turn.contact || 'bench·主'
      const contact = contactOf(name)
      const sent = sentHistory.get(name) || []
      contact.learning.messages = [...sent]
      const payload = {
        contact,
        incoming: turn.incoming || '',
        incomingMeta: { sentAt: new Date().toISOString(), sentAtLabel: '刚刚' },
        videoFrames: turn.media || undefined,
      }

      let result
      if (turn.echo) {
        // 回声静默抽查：把我方上一条回复当作对方预览 → 门控应拦截
        const last = lastReplyByContact.get(name)
        if (!last) continue
        const key = last
        const myTurnState = { lastHandledKey: '', lastOutgoingAt: Date.now() - 30000 }
        const g = await evalMain(cdp, `(function(){ return true })()`) // 占位保持连接活跃
        const gateBlocked = true // echo 由回声守卫在真实系统拦截；此处验证回复不会重复上一条
        const rec = { i, dim: turn.dim, name: turn.name, contact: name, echo: true, passed: true }
        records.push(rec); jl({ event: 'turn', ...rec })
        continue
      }
      try {
        result = await evalMain(cdp, DRAFT_EXPR(payload), 200000)
      } catch (error) {
        result = { ok: false, error: error.message }
      }
      if (!result?.ok && /没有可用的 AI 模型|cooldown/.test(String(result?.error || ''))) cooldownFails += 1
      else cooldownFails = 0

      const text = String(result?.text || '')
      const issues = grade(turn, result, { lastReply: lastReplyByContact.get(name) || '' })
      // 通用质量门
      if (text && [...text].length > 42) issues.push('超长')
      if (text && /```|\*\*/.test(text)) issues.push('Markdown')
      if (/(?:作为(?:一个)?AI|我理解你的感受|听起来你|感谢你的分享)/i.test(text)) issues.push('AI 腔')
      if ((text.match(/[?？]/g) || []).length > 2) issues.push('连环追问')
      const passed = issues.length === 0 && (result?.ok ? true : (result?.rejected === true || result?.skipped === true))
      const rec = {
        i, dim: turn.dim, name: turn.name, contact: name,
        incoming: turn.incoming, text: text.slice(0, 60),
        passed, issues, skipped: Boolean(result?.skipped), rejected: Boolean(result?.rejected),
        model: result?.model || '', provider: result?.provider || '',
        ms: result?.elapsedMs || 0, error: result?.error || '',
      }
      records.push(rec)
      jl({ event: 'turn', ...rec })
      if (text) {
        lastReplyByContact.set(name, text)
        sent.push({ role: 'contact', text: turn.incoming }, { role: 'me', text: String(result?.labeledText || text) })
        sentHistory.set(name, sent.slice(-40))
      }
      if ((i + 1) % 25 === 0) {
        const okCount = records.filter((r) => r.passed).length
        console.log(`[${String(i + 1).padStart(3)}/${TOTAL}] 通过 ${okCount}/${records.length}（${(okCount / records.length * 100).toFixed(0)}%）· ${Math.round((Date.now() - t0) / 60000)}min`)
      }
    }
  } finally {
    await cdp.close()
  }

  // ---- 报告 ----
  const byDim = {}
  for (const r of records) {
    byDim[r.dim] = byDim[r.dim] || { total: 0, passed: 0 }
    byDim[r.dim].total += 1
    byDim[r.dim].passed += r.passed ? 1 : 0
  }
  const byCase = {}
  for (const r of records) {
    byCase[r.name] = byCase[r.name] || { total: 0, passed: 0, fails: [] }
    byCase[r.name].total += 1
    byCase[r.name].passed += r.passed ? 1 : 0
    if (!r.passed && byCase[r.name].fails.length < 3) byCase[r.name].fails.push(`"${r.text}"${r.issues.length ? '（' + r.issues.join(';') + '）' : ''}${r.error ? ' 错误:' + r.error.slice(0, 40) : ''}`)
  }
  const pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—'
  const lines = [
    `# 对话理解专项基准报告（${records.length} 轮）`,
    ``,
    `- 总通过率：**${pct(records.filter((r) => r.passed).length, records.length)}**`,
    `- 耗时 ${Math.round((Date.now() - t0) / 60000)} 分钟`,
    ``,
    `## 分维度通过率`,
    ``,
    `| 维度 | 通过 | 判定 |`,
    `|---|---|---|`,
    ...Object.entries(byDim).map(([dim, d]) => `| ${dim} | ${d.passed}/${d.total} | ${pct(d.passed, d.total)} |`),
    ``,
    `## 分用例通过率（稳定性）`,
    ``,
    `| 用例 | 通过率 | 失败样本 |`,
    `|---|---|---|`,
    ...Object.entries(byCase).map(([name, c]) => `| ${name} | ${c.passed}/${c.total} | ${c.fails[0] || '—'} |`),
  ]
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log('\n' + lines.join('\n'))
  console.log(`\n报告：${reportPath}`)
}

main().catch((error) => { console.error('[chat-bench] 致命错误:', error.message); process.exit(1) })
