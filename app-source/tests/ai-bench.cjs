// AI 回复 / 视频识别专项基准
//
// 三个维度（用法：node tests/ai-bench.cjs [accuracy|efficiency|quality|all]，默认 all）：
//   accuracy   识别准确度：本地合成"纯色背景+大数字"的测试图片（标准答案已知），
//              走应用真实识别管线（视觉分析 + 回复），按 颜色/数字 是否答对打分；
//              同时给"视频理解结果"（analysis）单独打分。
//   efficiency 识别效率：视频回复 vs 文字回复的耗时分布（中位/p95）、帧载荷大小、
//              视觉分析成功率、故障转移次数。
//   quality    AI 回复质量：脚本化对抗对话（正常/裸问号/话题劫持/低信息连发/复读守卫/
//              视频），逐维度通过率。
//
// 前置：应用以 --remote-debugging-port=9223 运行（使用真实配置的模型）。
// 报告写入 rebuild/test-artifacts/ai-bench-*.md
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
require('./setup.cjs')
const { sharesLongSubstring } = require('../electron/ai-service.cjs')

const DEBUG_HOST = 'http://127.0.0.1:9223'
const ARTIFACTS = path.join(__dirname, '..', 'test-artifacts')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ================= PNG 编码器（无依赖） =================
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
// 5x7 像素数字字体
const SEGS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd',
  6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
}
const COLORS = { 红: [211, 47, 47], 蓝: [25, 118, 210], 绿: [56, 142, 60], 黄: [251, 192, 45], 黑: [17, 17, 17], 白: [250, 250, 250] }

// 画一张 WxH 纯色背景 + 居中大数字 的 PNG，返回 data URL
function makeImage(colorName, digit, size = 480) {
  const [r, g, b] = COLORS[colorName]
  const px = Buffer.alloc(size * size * 3)
  for (let i = 0; i < size * size; i += 1) { px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b }
  const set = (x, y, fr, fg, fb) => { const o = (y * size + x) * 3; px[o] = fr; px[o + 1] = fg; px[o + 2] = fb }
  // 深底白字 / 浅底黑字
  const dark = (r + g + b) / 3 < 128
  const fr = dark ? 255 : 20, fg = dark ? 255 : 20, fb = dark ? 255 : 20
  // 七段数码管风格：每段一个矩形，无歧义
  const t = Math.floor(size / 12)
  const W = 4 * t, H = 7 * t
  const x0 = Math.floor((size - W) / 2), y0 = Math.floor((size - H) / 2)
  const fill = (rx, ry, rw, rh) => { for (let y = Math.max(0, ry); y < Math.min(size, ry + rh); y += 1) for (let x = Math.max(0, rx); x < Math.min(size, rx + rw); x += 1) set(x, y, fr, fg, fb) }
  const segs = SEGS[digit]
  if (segs.includes('a')) fill(x0 + t, y0, W - 2 * t, t)
  if (segs.includes('f')) fill(x0, y0, t, H / 2 + 1)
  if (segs.includes('b')) fill(x0 + W - t, y0, t, H / 2 + 1)
  if (segs.includes('g')) fill(x0 + t, y0 + Math.floor(H / 2) - Math.floor(t / 2), W - 2 * t, t)
  if (segs.includes('e')) fill(x0, y0 + Math.floor(H / 2), t, H / 2)
  if (segs.includes('c')) fill(x0 + W - t, y0 + Math.floor(H / 2), t, H / 2)
  if (segs.includes('d')) fill(x0 + t, y0 + H - t, W - 2 * t, t)
  // 原始扫描线 + filter 0
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0
    px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

// ================= CDP =================
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
async function evalMain(cdp, expr, timeoutMs = 150000) {
  const out = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => { throw new Error('页面调用超时') }),
  ])
  if (out.exceptionDetails) throw new Error('页面内异常: ' + (out.exceptionDetails.exception?.description || out.exceptionDetails.text).slice(0, 200))
  return out.result?.value
}
const DRAFT_EXPR = (payload) => `window.desktopApp.ai.draft(${JSON.stringify(payload)}).catch(e => ({ ok: false, error: e.message }))`

const COLOR_TOKENS = { 红: ['红'], 蓝: ['蓝'], 绿: ['绿'], 黄: ['黄'], 黑: ['黑'], 白: ['白'] }
const DIGIT_TOKENS = { 0: ['0', '零'], 1: ['1', '一'], 2: ['2', '二'], 3: ['3', '三'], 4: ['4', '四'], 5: ['5', '五'], 6: ['6', '六'], 7: ['7', '七'], 8: ['8', '八'], 9: ['9', '九'] }
const hits = (text, tokens) => tokens.some((t) => String(text).includes(t))

async function draftOnce(cdp, { incoming, media, seedMsgs = [] }) {
  const payload = {
    contact: {
      id: 'bench', name: 'bench·基准', profile: { relationship: '朋友' },
      learning: { messages: seedMsgs, facts: [], topicLog: [], mediaLog: [] },
    },
    incoming,
    incomingMeta: { sentAt: new Date().toISOString(), sentAtLabel: '刚刚' },
    videoFrames: media || undefined,
  }
  const t0 = Date.now()
  const result = await evalMain(cdp, DRAFT_EXPR(payload), 180000)
  return { result, wallMs: Date.now() - t0 }
}

// ================= accuracy =================
async function benchAccuracy(cdp, report) {
  // 可用环境变量过滤用例/切换细节：BENCH_CASES="黑/5,白/8" BENCH_DETAIL=high
  const filter = process.env.BENCH_CASES ? process.env.BENCH_CASES.split(',').map((s) => s.split('/')) : null
  const detail = process.env.BENCH_DETAIL === 'high' ? 'high' : 'low'
  let cases = [
    { color: '红', digit: 7 }, { color: '蓝', digit: 3 }, { color: '绿', digit: 9 },
    { color: '黄', digit: 2 }, { color: '黑', digit: 5 }, { color: '白', digit: 8 },
    { color: '红', digit: 1 }, { color: '蓝', digit: 6 }, { color: '绿', digit: 4 }, { color: '黄', digit: 0 },
  ]
  if (filter) cases = cases.filter((c) => filter.some(([col, dig]) => c.color === col && c.digit === Number(dig)))
  const rows = []
  for (const c of cases) {
    const dataUrl = makeImage(c.color, c.digit)
    const media = { frames: [dataUrl], mediaKind: 'video', detectedVideo: true, videoReady: true, decodedVideoFrames: 1, confidence: 'high', frameDetail: detail }
    const { result, wallMs } = await draftOnce(cdp, {
      incoming: `【视频】请用一句话告诉我：这张图的主色调是什么颜色？图中的数字是几？`,
      media,
    })
    const text = String(result?.text || '')
    const analysis = await latestAnalysis(cdp)
    const colorOk = hits(text, COLOR_TOKENS[c.color]) || hits(analysis, COLOR_TOKENS[c.color])
    const digitOk = hits(text, DIGIT_TOKENS[c.digit]) || hits(analysis, DIGIT_TOKENS[c.digit])
    const analysisColorOk = hits(analysis, COLOR_TOKENS[c.color])
    const analysisDigitOk = hits(analysis, DIGIT_TOKENS[c.digit])
    rows.push({ ...c, text, analysis: (analysis || '').slice(0, 80), colorOk, digitOk, analysisColorOk, analysisDigitOk, model: result?.model || result?.error || '?', ms: result?.elapsedMs || wallMs, error: result?.error })
    console.log(`  ${c.color}/${c.digit} → ${colorOk && digitOk ? '✅' : '❌'} "${text.slice(0, 30)}"（${rows.at(-1).model}，${rows.at(-1).ms}ms）`)
  }
  const replyColor = rows.filter((r) => r.colorOk).length
  const replyDigit = rows.filter((r) => r.digitOk).length
  const replyBoth = rows.filter((r) => r.colorOk && r.digitOk).length
  const anaBoth = rows.filter((r) => r.analysisColorOk && r.analysisDigitOk).length
  const latencies = rows.map((r) => r.ms).sort((a, b) => a - b)
  const section = [
    `## 识别准确度（${rows.length} 张合成图：纯色背景 + 大数字，标准答案已知）`,
    ``,
    `| 用例 | 回复提颜色 | 回复提数字 | 全对 | 理解结果全对 | 模型 | 耗时 |`,
    `|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.color}/${r.digit} | ${r.colorOk ? '✓' : '✗'} | ${r.digitOk ? '✓' : '✗'} | ${r.colorOk && r.digitOk ? '✓' : '✗'} | ${r.analysisColorOk && r.analysisDigitOk ? '✓' : '✗'} | ${r.model} | ${r.ms}ms |`),
    ``,
    `**回复级准确率**：颜色 ${(replyColor / rows.length * 100).toFixed(0)}% · 数字 ${(replyDigit / rows.length * 100).toFixed(0)}% · 双对 **${(replyBoth / rows.length * 100).toFixed(0)}%**`,
    `**理解级准确率**（视觉分析文本）：双对 **${(anaBoth / rows.length * 100).toFixed(0)}%**`,
    `**单次视频识别耗时**：中位 ${latencies[Math.floor(latencies.length / 2)]}ms / 最快 ${latencies[0]}ms / 最慢 ${latencies.at(-1)}ms`,
    ``,
    `<details><summary>逐例回复原文</summary>`,
    ...rows.map((r) => `- ${r.color}/${r.digit}：${r.text || '(空)'}`),
    `</details>`,
    ``,
  ]
  report.push(...section)
  return { replyBoth: replyBoth / rows.length, anaBoth: anaBoth / rows.length }
}

// 读最近一条 ai_draft 日志里的视频理解结果
async function latestAnalysis(cdp) {
  return evalMain(cdp, `(async () => {
    const s = await window.desktopApp.automation.getState()
    const entry = s.logs.find(l => l.type === 'ai_draft' && l.detail?.mediaAnalysis)
    return entry?.detail?.mediaAnalysis || ''
  })()`)
}

// ================= efficiency =================
async function benchEfficiency(cdp, report) {
  const failsBefore = await countProviderFails(cdp)
  // 视频组：2 帧 × 4 次；文字组：4 次
  const videoRuns = []
  const textRuns = []
  for (let i = 0; i < 4; i += 1) {
    const f1 = makeImage(['红', '蓝', '绿', '黄'][i], (i + 2) % 10)
    const f2 = makeImage(['蓝', '绿', '黄', '红'][i], (i + 5) % 10)
    const kb = Math.round((f1.length + f2.length) * 3 / 4 / 1024)
    const { result, wallMs } = await draftOnce(cdp, { incoming: '【视频】看看这个', media: { frames: [f1, f2], mediaKind: 'video', detectedVideo: true, videoReady: true, decodedVideoFrames: 2, confidence: 'high', frameDetail: 'low' } })
    videoRuns.push({ ms: result?.elapsedMs || wallMs, kb, ok: Boolean(result?.ok), analysisOk: await hasAnalysis(cdp), error: result?.error })
    console.log(`  视频#${i + 1}: ${videoRuns.at(-1).ms}ms（帧载荷 ${kb}KB）${videoRuns.at(-1).analysisOk ? '分析✓' : '分析✗'}`)
  }
  for (let i = 0; i < 4; i += 1) {
    const { result, wallMs } = await draftOnce(cdp, { incoming: ['在吗', '晚上吃什么', '周末有空不', '今天好累'][i] })
    textRuns.push({ ms: result?.elapsedMs || wallMs, ok: Boolean(result?.ok), error: result?.error })
    console.log(`  文字#${i + 1}: ${textRuns.at(-1).ms}ms`)
  }
  const failsAfter = await countProviderFails(cdp)
  const stat = (arr) => { const s = arr.map((r) => r.ms).sort((a, b) => a - b); return { med: s[Math.floor(s.length / 2)], min: s[0], max: s.at(-1) } }
  const v = stat(videoRuns), t = stat(textRuns)
  const analysisRate = videoRuns.filter((r) => r.analysisOk).length / videoRuns.length
  report.push(
    `## 识别效率`,
    ``,
    `| 指标 | 视频回复（2 帧） | 文字回复 |`,
    `|---|---|---|`,
    `| 耗时中位 | **${v.med}ms** | **${t.med}ms** |`,
    `| 耗时范围 | ${v.min}~${v.max}ms | ${t.min}~${t.max}ms |`,
    `| 帧载荷 | ${videoRuns[0].kb}KB/次 | 0 |`,
    ``,
    `- 视觉分析成功率：**${(analysisRate * 100).toFixed(0)}%**（${videoRuns.filter((r) => r.analysisOk).length}/${videoRuns.length}）`,
    `- 测试期间模型故障转移：${failsAfter - failsBefore} 次`,
    `- 视频相对文字的开销倍数：**${(v.med / Math.max(1, t.med)).toFixed(1)}×**`,
    ``,
  )
}

async function countProviderFails(cdp) {
  return evalMain(cdp, `(async () => {
    const s = await window.desktopApp.automation.getState()
    return s.logs.filter(l => l.type === 'ai_provider_failed').length
  })()`)
}
async function hasAnalysis(cdp) {
  return evalMain(cdp, `(async () => {
    const s = await window.desktopApp.automation.getState()
    const entry = s.logs.find(l => l.type === 'ai_draft' && l.detail?.mediaAnalysis)
    return Boolean(entry?.detail?.mediaAnalysis)
  })()`)
}

// ================= quality =================
async function benchQuality(cdp, report) {
  const turns = [
    { tag: '正常问候', incoming: '在干嘛呢' },
    { tag: '裸问号（困惑信号）', incoming: '？？' },
    { tag: '话题劫持', incoming: '突然想到 你觉得人生有什么意义' },
    { tag: '低信息A', incoming: '哦' },
    { tag: '低信息B（防复读）', incoming: '嗯嗯' },
    { tag: '负面情绪', incoming: '今天烦死了' },
    { tag: '邀约', incoming: '周末出来吃饭不' },
    { tag: '视频（合成图）', incoming: '【视频】看看这张图', media: { frames: [makeImage('红', 7)], mediaKind: 'video', detectedVideo: true, videoReady: true, decodedVideoFrames: 1, confidence: 'high', frameDetail: 'low' }, expectGrounding: true },
    { tag: '我方回声（应静默）', echo: true },
    { tag: '正常追问', incoming: '哈哈好吧' },
  ]
  const dims = { total: 0, lengthOk: 0, noRepeat: 0, noTone: 0, noBomb: 0, discipline: 0, grounded: 0, groundedN: 0 }
  let turnState = {}
  let lastReply = ''
  let vNow = Date.now()
  const rows = []
  for (const t of turns) {
    vNow += MIN_GAP + 5000
    if (t.echo) {
      // 我方回声：门控应拦截（静默）
      const key = `【AI · 测试】${lastReply}`
      const gate = shouldAutoReply({ turn: turnState }, { key, fromMe: true, now: vNow })
      const ok = !gate.ok
      dims.discipline += ok ? 1 : 0
      dims.total += 1
      rows.push({ tag: t.tag, reply: '（静默 ✅）', ok })
      continue
    }
    const gate = shouldAutoReply({ turn: turnState }, { key: t.incoming, fromMe: false, now: vNow })
    if (!gate.ok) {
      dims.discipline += t.tag.includes('低信息') ? 0 : 1
      rows.push({ tag: t.tag, reply: `（门控拦截：${gate.reason}）`, ok: false })
      continue
    }
    const { result } = await draftOnce(cdp, { incoming: t.incoming, media: t.media })
    const text = String(result?.text || '')
    const skipped = Boolean(result?.skipped)
    const lengthOk = !text || [...text].length <= 42
    const noRepeat = !lastReply || !(text === lastReply || sharesLongSubstring(text, lastReply, 5))
    const noTone = !/(?:作为(?:一个)?AI|我理解你的感受|听起来你|感谢你的分享|有什么我可以帮你)/i.test(text)
    const noBomb = (text.match(/[?？]/g) || []).length <= 2
    let grounded = true
    if (t.expectGrounding) {
      dims.groundedN += 1
      grounded = hits(text, COLOR_TOKENS.红) || hits(text, DIGIT_TOKENS[7]) || skipped
      dims.grounded += grounded ? 1 : 0
    }
    dims.lengthOk += lengthOk ? 1 : 0
    dims.noRepeat += noRepeat ? 1 : 0
    dims.noTone += noTone ? 1 : 0
    dims.noBomb += noBomb ? 1 : 0
    dims.total += 1
    const ok = lengthOk && noRepeat && noTone && noBomb && grounded && (!skipped || result?.rejected === true || true)
    rows.push({ tag: t.tag, reply: text ? `"${text.slice(0, 34)}"` : (skipped ? '（AI 判断不回复）' : `（失败：${result?.error || '空'}）`), ok: lengthOk && noRepeat && noTone && noBomb && grounded })
    if (text) { lastReply = text; turnState = markHandled(markOutgoing(turnState, vNow), t.incoming, vNow) }
    else turnState = markHandled(turnState, t.incoming, vNow)
  }
  const pct = (n, d) => d ? `${(n / d * 100).toFixed(0)}%` : '—'
  report.push(
    `## AI 回复质量（脚本化对抗对话 ${dims.total} 轮）`,
    ``,
    `| 维度 | 通过率 |`,
    `|---|---|`,
    `| 长度纪律（≤42 字） | ${pct(dims.lengthOk, dims.total)} |`,
    `| 防连续复读 | ${pct(dims.noRepeat, dims.total - 1)} |`,
    `| 无 AI 腔 | ${pct(dims.noTone, dims.total)} |`,
    `| 无连环追问（≤2 问号） | ${pct(dims.noBomb, dims.total)} |`,
    dims.groundedN ? `| 视频回复扣住具体画面 | ${pct(dims.grounded, dims.groundedN)} |` : '',
    ``,
    `| 轮次 | 回复 | 判定 |`,
    `|---|---|---|`,
    ...rows.map((r) => `| ${r.tag} | ${r.reply} | ${r.ok ? '✅' : '❌'} |`),
    ``,
  )
}

const MIN_GAP = 20 * 1000
const { shouldAutoReply, markHandled, markOutgoing } = require('../electron/conversation-engine.cjs')

// ================= main =================
async function main() {
  const modes = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const run = modes.length ? modes : ['accuracy', 'efficiency', 'quality']
  const cdp = await connect(await findMainPage())
  const report = [`# AI 回复 / 视频识别基准报告`, ``, `- 时间：${new Date().toISOString()}（真实模型：应用当前配置）`, ``]
  if (run.includes('accuracy')) { console.log('== accuracy =='); await benchAccuracy(cdp, report) }
  if (run.includes('efficiency')) { console.log('== efficiency =='); await benchEfficiency(cdp, report) }
  if (run.includes('quality')) { console.log('== quality =='); await benchQuality(cdp, report) }
  await cdp.close()
  const file = path.join(ARTIFACTS, `ai-bench-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.md`)
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  fs.writeFileSync(file, report.join('\n'), 'utf8')
  console.log(`\n报告已保存：${file}`)
}
main().catch((error) => { console.error('基准失败:', error.message); process.exit(1) })
