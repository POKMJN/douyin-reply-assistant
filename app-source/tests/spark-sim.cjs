// 续火花"今日播报"专项模拟器（200 遍）
//
// 通过 ai:draft-spark IPC 走真实链路：抓取当天真实天气/热点 → AI 生成播报文案（不发送）。
// 模拟"连续多天给同一个人发播报"：每个联系人的发送历史跨轮累积（复读判定依赖它）。
// 每 12 轮重启一次应用（模拟生产规模：跨联系人开场池每天只有 ~11 条，避免 200 连发
// 自我碰撞失真；重启同时清模型冷却）。
//
// 用法：node tests/spark-sim.cjs [轮数，默认 200]
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const ARTIFACTS = path.join(__dirname, '..', 'test-artifacts')
const DEBUG_HOST = 'http://127.0.0.1:9223'
const TOTAL = Number(process.argv[2] || 200)
const CONTACTS = ['simspark·阿甲', 'simspark·阿乙', 'simspark·阿丙', 'simspark·阿丁', 'simspark·阿戊', 'simspark·阿己']
const APP_EXE = 'D:\\续声\\抖音回复助手\\抖音回复助手.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const WEATHER_MARK = /度|伞|雨|晴|阴|云|雪|风|雾|暖|晒|降|保暖|添衣|补水|干燥|紫外线|能见度|温度|气温|适宜/
const DATE_MARK = /周[一二三四五六日天]|\d{1,2}月|\d{1,2}日|今天|星期/
const BLESS_MARK = /祝|愿|开心|顺利|愉快|好心情|加油|安|甜|棒|舒坦|自在|轻松|悠|歇/

let cdp = null
let wsId = 0
const pending = new Map()

async function connect() {
  const list = await (await fetch(`${DEBUG_HOST}/json`)).json()
  const main = list.filter((t) => t.type === 'page').find((t) => t.title === '抖音回复助手')
  if (!main) throw new Error('找不到主窗口')
  const ws = new WebSocket(main.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
    }
  })
  cdp = {
    ws,
    async eval(expression, timeoutMs = 200000) {
      const out = await Promise.race([
        new Promise((res2, rej2) => {
          const mid = ++wsId
          pending.set(mid, { res: res2, rej: rej2 })
          ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
        }),
        sleep(timeoutMs).then(() => { throw new Error('页面调用超时') }),
      ])
      if (out.exceptionDetails) throw new Error('页面内异常: ' + (out.exceptionDetails.exception?.description || '').slice(0, 150))
      return out.result?.value
    },
    close: () => ws.close(),
  }
  return cdp
}

async function restartApp() {
  try { cdp?.close(); cdp = null } catch {}
  execSync(`powershell -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { $_.ProcessName -like '*抖音回复助手*' } | Stop-Process -Force"`, { stdio: 'ignore' })
  await sleep(3000)
  execSync(`powershell -ExecutionPolicy Bypass -Command "Start-Process -FilePath '${APP_EXE}' -ArgumentList '--remote-debugging-port=9223'"`, { stdio: 'ignore' })
  await sleep(16000)
  await connect()
}

const histories = new Map() // contact -> [{role,text}]
const records = []

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const jsonlPath = path.join(ARTIFACTS, `spark-${stamp}.jsonl`)
  const reportPath = path.join(ARTIFACTS, `spark-report-${stamp}.md`)
  const jl = (obj) => fs.appendFileSync(jsonlPath, JSON.stringify(obj) + '\n', 'utf8')
  await connect()
  console.log(`[spark-sim] 目标 ${TOTAL} 轮 · ${CONTACTS.length} 位模拟联系人（历史跨轮累积，模拟连续多天）`)

  let t0 = Date.now()
  for (let i = 0; i < TOTAL; i += 1) {
    // 每轮间隔 ≥8s（尊重 15s/key 节流与真实节奏）
    if (i > 0 && Date.now() - t0 < 8000) await sleep(8000 - (Date.now() - t0))
    t0 = Date.now()
    // 每 12 轮重启应用：生产中跨联系人开场池每天只有 ~11 条
    if (i > 0 && i % 12 === 0) {
      console.log(`  [${i}] 重启应用（清理当日开场池，模拟新的一天）…`)
      await restartApp()
    }
    if (!cdp) await connect()

    const name = CONTACTS[i % CONTACTS.length]
    const history = histories.get(name) || []
    let r = null
    try {
      r = await cdp.eval(`window.desktopApp.ai.draftSpark({ name: ${JSON.stringify(name)}, history: ${JSON.stringify(history)} }).catch(e => ({ ok: false, error: e.message }))`)
    } catch (error) {
      // 连接断开等：重连后本轮记失败
      try { await connect() } catch {}
      r = { ok: false, error: error.message }
    }
    const text = String(r?.text || '')
    const rec = {
      i, contact: name,
      ok: Boolean(r?.ok), text: text.slice(0, 80),
      rejected: Boolean(r?.rejected), error: r?.error || '',
      weatherUsed: r?.weatherUsed || '', hotTopicUsed: r?.hotTopicUsed || '',
      ms: r?.elapsedMs || 0,
      weatherCovered: null, hotCovered: null, dateCovered: null, blessCovered: null,
    }
    if (rec.ok && text) {
      rec.weatherCovered = rec.weatherUsed ? (WEATHER_MARK.test(text) ? 1 : 0) : null
      rec.hotCovered = rec.hotTopicUsed ? (text.split(/[，。！？；、]/).some((c) => c && rec.hotTopicUsed.replace(/^【[^】]*】/, '').split(/，|：| |｜/).some((k) => k.length >= 2 && text.includes(k.slice(0, Math.min(6, k.length))))) ? 1 : 0) : null
      rec.dateCovered = DATE_MARK.test(text) ? 1 : 0
      rec.blessCovered = BLESS_MARK.test(text) ? 1 : 0
      if (!rec.weatherUsed && /伞|降雨|紫外线|°C/.test(text)) rec.hallucination = 1
      history.push({ role: 'me', text })
      histories.set(name, history.slice(-30))
    }
    records.push(rec)
    jl({ event: 'turn', ...rec })
    if ((i + 1) % 20 === 0) {
      const ok = records.filter((r2) => r2.ok).length
      const weatherC = records.filter((r2) => r2.weatherCovered === 1).length + '/' + records.filter((r2) => r2.weatherCovered !== null).length
      console.log(`[${String(i + 1).padStart(3)}/${TOTAL}] 成功 ${ok} · 天气覆盖 ${weatherC} · ${Math.round((Date.now() - tStart) / 60000)}min`)
    }
  }
  try { cdp.close() } catch {}

  // ---- 报告 ----
  const okRecs = records.filter((r) => r.ok && r.text)
  const fails = records.filter((r) => !r.ok)
  const cov = (mark) => {
    const eligible = records.filter((r) => r[mark] !== null)
    return eligible.length ? `${eligible.filter((r) => r[mark] === 1).length}/${eligible.length}（${(eligible.filter((r) => r[mark] === 1).length / eligible.length * 100).toFixed(0)}%）` : '—'
  }
  const halluc = records.filter((r) => r.hallucination).length
  const rejectReasons = {}
  for (const r of fails) rejectReasons[(r.error || 'unknown').slice(0, 40)] = (rejectReasons[(r.error || 'unknown').slice(0, 40)] || 0) + 1
  // 每联系人连续成功天数（模拟连续多天不误杀）
  const streaks = {}
  for (const name of CONTACTS) {
    const list = records.filter((r) => r.contact === name)
    let best = 0, cur = 0
    for (const r of list) { if (r.ok && r.text) { cur += 1; best = Math.max(best, cur) } else cur = 0 }
    streaks[name] = { total: list.length, bestStreak: best }
  }
  const ms = okRecs.map((r) => r.ms).filter(Boolean).sort((a, b) => a - b)
  const lines = [
    `# 续火花"今日播报"专项模拟报告（${records.length} 轮）`,
    ``,
    `- 成功生成 ${okRecs.length} · 拒发/失败 ${fails.length} · 耗时 ${Math.round((Date.now() - t0) / 60000)} 分钟`,
    ``,
    `## 播报要素覆盖率`,
    ``,
    `| 要素 | 覆盖率 |`,
    `|---|---|`,
    `| 天气/提醒（有天气数据时） | ${cov('weatherCovered')} |`,
    `| 日期/星期 | ${cov('dateCovered')} |`,
    `| 热点（有热点数据时） | ${cov('hotCovered')} |`,
    `| 祝福/收尾 | ${cov('blessCovered')} |`,
    `| 无天气数据时的幻觉 | ${halluc} 次 |`,
    ``,
    `## 连续多天不误杀（每联系人最长连续成功）`,
    ``,
    ...Object.entries(streaks).map(([name, s]) => `- ${name}：最长连续 ${s.bestStreak} 次 / 共 ${s.total} 轮`),
    ``,
    `## 拒发/失败原因分布`,
    ``,
    ...Object.entries(rejectReasons).map(([type, count]) => `- ${type}: ${count} 次`),
    ``,
    `## 延迟：p50 ${ms[Math.floor(ms.length / 2)] || '—'}ms / p95 ${ms[Math.floor(ms.length * 0.95)] || '—'}ms`,
    ``,
    `## 样本回复（每联系人最近 2 条）`,
    ...CONTACTS.flatMap((name) => {
      const list = records.filter((r) => r.contact === name && r.text).slice(-2)
      return list.map((r) => `- ${name}：${r.text}`)
    }),
  ]
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log('\n' + lines.join('\n'))
  console.log(`\n报告：${reportPath}`)
  const bad = fails.length > records.length * 0.2 || halluc > 0
  console.log(bad ? '\n❌ 拒发率超过 20% 或存在幻觉' : '\n✅ 拒发/失败率 ≤20% 且零幻觉')
  process.exit(bad ? 1 : 0)
}

let tStart = Date.now()
main().catch((error) => { console.error('[spark-sim] 致命错误:', error.message); process.exit(1) })
