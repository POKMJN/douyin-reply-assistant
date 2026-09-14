// 1000 遍 AI 回复 + 视频识别效率跑批
//
// 用法：node tests/ai-bench-volume.cjs [总轮数，默认 1000]
// 前置：应用以 --remote-debugging-port=9223 运行
//
// 结构：
//   阶段A（前 20%）：主力模型不变——视频识别准确率（合成图标准答案）+ 文字回复质量，
//                     得到"日常体验"的干净统计。
//   阶段B（其余 80%）：三个模型 key 之间轮换主模型（每个 key 仍守 15s 节流，
//                     总吞吐 ×3），混合视频/文字，得到大样本效率与稳定性数据，
//                     并给出每个模型的延迟分布。结束后自动恢复原主模型。
//
// 输出：逐轮 JSONL + 最终 md 统计报告（test-artifacts/）
const fs = require('node:fs')
const path = require('node:path')
require('./setup.cjs')
const { sharesLongSubstring } = require('../electron/ai-service.cjs')

const DEBUG_HOST = 'http://127.0.0.1:9223'
const ARTIFACTS = path.join(__dirname, '..', 'test-artifacts')
const TOTAL = Number(process.argv[2] || 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- PNG 合成图（同 ai-bench）----
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c } return t })()
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const pngChunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]) }
const SEGS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd',
  6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
}
const COLORS = { 红: [211, 47, 47], 蓝: [25, 118, 210], 绿: [56, 142, 60], 黄: [251, 192, 45], 黑: [17, 17, 17], 白: [250, 250, 250] }
function makeImage(colorName, digit, size = 480) {
  const [r, g, b] = COLORS[colorName]
  const px = Buffer.alloc(size * size * 3)
  for (let i = 0; i < size * size; i += 1) { px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b }
  const set = (x, y, fr, fg, fb) => { const o = (y * size + x) * 3; px[o] = fr; px[o + 1] = fg; px[o + 2] = fb }
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
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y += 1) { raw[y * (size * 3 + 1)] = 0; px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3) }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}
const zlib = require('node:zlib')

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
  if (out.exceptionDetails) throw new Error('页面内异常: ' + (out.exceptionDetails.exception?.exception?.description || out.exceptionDetails.text).slice(0, 200))
  return out.result?.value
}
const DRAFT_EXPR = (payload) => `window.desktopApp.ai.draft(${JSON.stringify(payload)}).catch(e => ({ ok: false, error: e.message }))`

// ---- 测试素材 ----
const COLOR_KEYS = Object.keys(COLORS)
const COLOR_TOKENS = { 红: ['红'], 蓝: ['蓝'], 绿: ['绿'], 黄: ['黄'], 黑: ['黑'], 白: ['白'] }
const DIGIT_TOKENS = { 0: ['0', '零'], 1: ['1', '一'], 2: ['2', '二'], 3: ['3', '三'], 4: ['4', '四'], 5: ['5', '五'], 6: ['6', '六'], 7: ['7', '七'], 8: ['8', '八'], 9: ['9', '九'] }
const hits = (text, tokens) => tokens.some((t) => String(text).includes(t))
const TEXT_MSGS = ['在干嘛', '今天好累啊', '晚上吃什么好', '周末有空不', '笑死我了哈哈哈', '？', '哦', '帮我看看这个', '最近咋样', '睡了吗', '突然想到一个问题 你觉得人生有什么意义', '明天要降温了', '刚看了个电影超好看', '你说咋办']
const mediaFor = (i) => {
  const color = COLOR_KEYS[i % COLOR_KEYS.length]
  const digit = (i * 7 + 3) % 10
  const frames = [makeImage(color, digit)]
  if (i % 4 === 3) frames.push(makeImage(COLOR_KEYS[(i + 2) % COLOR_KEYS.length], (digit + 5) % 10)) // 每 4 次 1 次双帧
  return { color, digit, frames, framesCount: frames.length }
}
const stat = (arr) => {
  if (!arr.length) return { n: 0 }
  const s = [...arr].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), min: s[0], max: s.at(-1) }
}

async function main() {
  const t0 = Date.now()
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const jsonlPath = path.join(ARTIFACTS, `volume-${stamp}.jsonl`)
  const reportPath = path.join(ARTIFACTS, `volume-report-${stamp}.md`)
  const jl = (obj) => fs.appendFileSync(jsonlPath, JSON.stringify(obj) + '\n', 'utf8')

  const cdp = await connect(await findMainPage())
  const state0 = await evalMain(cdp, `(async () => { const s = await window.desktopApp.automation.getState(); return { providers: (s.providers || []).map(p => p.name), settings: s.settings } })()`)
  const originalPrimary = state0.providers[0]
  console.log(`[volume] 目标 ${TOTAL} 轮 · 模型列表 ${state0.providers.join(', ')} · 原主模型 ${originalPrimary}`)
  console.log(`[volume] 逐轮记录 ${jsonlPath}`)
  jl({ event: 'start', total: TOTAL, providers: state0.providers, originalPrimary })

  const records = []
  const phaseATurns = Math.round(TOTAL * 0.2)
  let lastTurnAt = 0
  let consecutiveCooldownFails = 0
  try {
    for (let i = 0; i < TOTAL; i += 1) {
      // 真实节奏：轮询间隔 5-60 秒。instant 失败（如冷却窗口）会烧穿剩余轮数，
      // 必须保证最小轮间隔，冷却类失败后额外等待恢复（soak 跑批教训）
      const sinceLast = Date.now() - lastTurnAt
      if (lastTurnAt && sinceLast < 8000) await sleep(8000 - sinceLast)
      if (consecutiveCooldownFails >= 3) {
        console.log(`  连续 ${consecutiveCooldownFails} 次冷却失败，等待 60s 让主模型恢复…`)
        await sleep(60000)
      }
      lastTurnAt = Date.now()
      const phase = i < phaseATurns ? 'A' : 'B'
      const kind = phase === 'A' ? (i % 2 === 0 ? 'video' : 'text') : (i % 5 < 2 ? 'video' : 'text')
      // 阶段B：每轮轮换主模型（3 个 key 分摊节流窗口）
      if (phase === 'B' && state0.providers.length > 1) {
        const target = state0.providers[i % state0.providers.length]
        await evalMain(cdp, `window.desktopApp.ai.setPrimaryProvider(${JSON.stringify(target)}).catch(e => ({ ok: false, error: e.message }))`, 20000).catch(() => null)
      }
      const incoming = kind === 'video' ? '【视频】请用一句话告诉我：这张图的主色调是什么颜色？图中的数字是几？' : TEXT_MSGS[i % TEXT_MSGS.length]
      const m = kind === 'video' ? mediaFor(i) : null
      const media = m ? { frames: m.frames, mediaKind: 'video', detectedVideo: true, videoReady: true, decodedVideoFrames: m.framesCount, confidence: 'high', frameDetail: 'low' } : undefined
      const payload = {
        contact: { id: 'volume', name: 'bench·容量', profile: { relationship: '朋友' }, learning: { messages: [], facts: [], topicLog: [], mediaLog: [] } },
        incoming, incomingMeta: { sentAt: new Date().toISOString(), sentAtLabel: '刚刚' }, videoFrames: media,
      }
      const tStart = Date.now()
      let result = null
      try {
        result = await evalMain(cdp, DRAFT_EXPR(payload), 200000)
      } catch (error) {
        result = { ok: false, error: error.message }
      }
      const wallMs = Date.now() - tStart
      if (!result?.ok && /没有可用的 AI 模型|cooldown/.test(String(result?.error || ''))) consecutiveCooldownFails += 1
      else consecutiveCooldownFails = 0
      const text = String(result?.text || '')
      const rec = {
        i, phase, kind,
        ok: Boolean(result?.ok), skipped: Boolean(result?.skipped), rejected: Boolean(result?.rejected),
        text: text.slice(0, 60),
        model: result?.model || '', provider: result?.provider || '',
        ms: result?.elapsedMs || 0, wallMs,
        error: result?.error || '',
        colorOk: null, digitOk: null,
      }
      if (kind === 'video' && m) {
        // 准确率评分：回复或视觉分析文本命中标准答案
        const analysis = await evalMain(cdp, `(async () => { const s = await window.desktopApp.automation.getState(); const e = s.logs.find(l => l.type === 'ai_draft' && l.detail?.mediaAnalysis); return e?.detail?.mediaAnalysis || '' })()`, 15000).catch(() => '')
        rec.colorOk = hits(text, COLOR_TOKENS[m.color]) || hits(analysis, COLOR_TOKENS[m.color]) ? 1 : 0
        rec.digitOk = hits(text, DIGIT_TOKENS[m.digit]) || hits(analysis, DIGIT_TOKENS[m.digit]) ? 1 : 0
        rec.analysisHit = hits(analysis, COLOR_TOKENS[m.color]) || hits(analysis, DIGIT_TOKENS[m.digit]) ? 1 : 0
        rec.doubleFrame = m.framesCount > 1
      }
      records.push(rec)
      jl({ event: 'turn', ...rec })
      if ((i + 1) % 25 === 0) {
        const done = records
        const vids = done.filter((r) => r.kind === 'video' && r.colorOk !== null)
        const both = vids.filter((r) => r.colorOk && r.digitOk).length
        const errs = done.filter((r) => !r.ok && !r.skipped).length
        console.log(`[${String(i + 1).padStart(4)}/${TOTAL}] 阶段${phase} · 视频准确 ${vids.length ? (both / vids.length * 100).toFixed(0) + '%' : '-'} · 失败 ${errs} · 本批耗时 ${Math.round((Date.now() - t0) / 60000)}min`)
      }
    }
  } finally {
    // 恢复原主模型
    if (state0.providers.length > 1 && originalPrimary) {
      await evalMain(cdp, `window.desktopApp.ai.setPrimaryProvider(${JSON.stringify(originalPrimary)}).catch(e => ({ ok: false, error: e.message }))`, 20000).catch(() => null)
      console.log(`[volume] 已恢复原主模型：${originalPrimary}`)
      jl({ event: 'restore-primary', primary: originalPrimary })
    }
    await cdp.close()
  }

  // ---- 统计报告 ----
  const okRecs = records.filter((r) => r.ok && !r.skipped)
  const videoAcc = records.filter((r) => r.kind === 'video' && r.colorOk !== null)
  const videoBoth = videoAcc.filter((r) => r.colorOk && r.digitOk)
  const firstHalf = videoAcc.slice(0, Math.floor(videoAcc.length / 2))
  const secondHalf = videoAcc.slice(Math.floor(videoAcc.length / 2))
  const accNum = (list) => list.length ? list.filter((r) => r.colorOk && r.digitOk).length / list.length * 100 : null
  const accOf = (list) => { const n = accNum(list); return n === null ? '—' : n.toFixed(0) + '%' }
  const lat = (list) => stat(list.map((r) => r.ms).filter(Boolean))
  const perModel = {}
  for (const r of okRecs) {
    perModel[r.provider + '/' + r.model] = perModel[r.provider + '/' + r.model] || { video: [], text: [], errors: 0 }
    if (r.kind === 'video') perModel[r.provider + '/' + r.model].video.push(r.ms)
    else perModel[r.provider + '/' + r.model].text.push(r.ms)
  }
  const errorTypes = {}
  for (const r of records) if (!r.ok && !r.skipped) errorTypes[(r.error || 'unknown').slice(0, 60)] = (errorTypes[(r.error || 'unknown').slice(0, 60)] || 0) + 1
  const vLat = lat(okRecs.filter((r) => r.kind === 'video'))
  const tLat = lat(okRecs.filter((r) => r.kind === 'text'))
  const minutes = (Date.now() - t0) / 60000
  const lines = [
    `# 1000 遍 AI 回复 + 视频识别效率跑批报告`,
    ``,
    `- 轮数：${records.length}（阶段A ${phaseATurns} + 阶段B ${records.length - phaseATurns}）· 总耗时 ${minutes.toFixed(0)} 分钟 · 吞吐 ${(records.length / minutes).toFixed(1)} 轮/分钟`,
    `- 成功 ${okRecs.length} · AI 判断不回复/拒发 ${records.filter((r) => r.skipped).length} · 失败 ${records.filter((r) => !r.ok && !r.skipped).length}`,
    ``,
    `## 视频识别准确率（${videoAcc.length} 次有标准答案）`,
    ``,
    `- 回复级全对率：**${accOf(videoAcc)}**（前半 ${accOf(firstHalf)} → 后半 ${accOf(secondHalf)}，${(accNum(firstHalf) ?? 0) > (accNum(secondHalf) ?? 0) ? '⚠️ 后半段下降，检查疲劳/限流' : '无时间漂移'})`,
    `- 其中双帧用例全对率：${accOf(videoAcc.filter((r) => r.doubleFrame))}`,
    ``,
    `## 耗时分布（模型接口 elapsedMs）`,
    ``,
    `| 类型 | n | p50 | p95 | p99 | min | max |`,
    `|---|---|---|---|---|---|---|`,
    `| 视频识别回复 | ${vLat.n} | ${vLat.p50}ms | ${vLat.p95}ms | ${vLat.p99}ms | ${vLat.min}ms | ${vLat.max}ms |`,
    `| 文字回复 | ${tLat.n} | ${tLat.p50}ms | ${tLat.p95}ms | ${tLat.p99}ms | ${tLat.min}ms | ${tLat.max}ms |`,
    ``,
    `## 分模型表现`,
    ``,
    `| 模型 | 视频中位 | 视频n | 文字中位 | 文字n |`,
    `|---|---|---|---|---|`,
    ...Object.entries(perModel).map(([m, d]) => `| ${m} | ${stat(d.video).p50 ?? '—'}ms | ${d.video.length} | ${stat(d.text).p50 ?? '—'}ms | ${d.text.length} |`),
    ``,
    `## 失败分布`,
    ``,
    ...Object.entries(errorTypes).map(([type, count]) => `- ${type}: ${count} 次`),
    ``,
  ]
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log('\n' + lines.join('\n'))
  console.log(`\n报告：${reportPath}`)
}

main().catch((error) => { console.error('[volume] 致命错误:', error.message); process.exit(1) })
