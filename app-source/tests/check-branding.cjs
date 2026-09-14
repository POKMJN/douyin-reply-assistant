// 检查所有页面不出现"重构版/rebuild"字样
async function main() {
  const list = await (await fetch('http://127.0.0.1:9223/json')).json()
  const main = list.filter(t => t.type === 'page').find(t => t.title === '抖音回复助手')
  const ws = new WebSocket(main.webSocketDebuggerUrl)
  let id = 0; const pending = new Map()
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result?.result?.value); pending.delete(m.id) } }
  const ev = (expr) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })) })
  // 逐页检查
  for (const section of ['chat', 'drafts', 'tasks', 'models', 'logs', 'settings']) {
    await ev(`(() => { const b = document.querySelector('.rail-item[data-args*="${section}"]'); if (b) b.click(); })()`)
    const hit = await ev(`document.getElementById('app').innerText.match(/重构版|rebuild/i)?.[0] || 'CLEAN'`)
    console.log(`${section} 页: ${hit === 'CLEAN' ? '✅ 无重构字样' : '❌ ' + hit}`)
  }
  // 启动日志（运行记录页可见的 app_boot 消息）
  const boot = await ev(`(async () => { const s = await window.desktopApp.automation.getState(); return s.logs.find(l => l.type === 'app_boot')?.message || '(无启动日志)' })()`)
  console.log('启动日志: ' + (boot))
  ws.close()
}
main().catch(e => { console.error(e.message); process.exit(1) })
