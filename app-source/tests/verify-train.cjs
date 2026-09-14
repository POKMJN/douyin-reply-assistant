// 训练场端到端验证：真实应用里走一遍"对方说 → AI 拟回复 → 用户示范学习 → 检查学习结果"
async function main() {
  const list = await (await fetch('http://127.0.0.1:9223/json')).json()
  const main = list.filter(t => t.type === 'page').find(t => t.title === '抖音回复助手')
  const ws = new WebSocket(main.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result?.result?.value ?? msg.result)
    }
  })
  const ev = (expr) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })

  const r1 = await ev('window.desktopApp.ai.trainLearn({ name: "训练·测试", incoming: "在干嘛呢" })')
  console.log('1. 对方消息入库:', JSON.stringify(r1))
  const r2 = await ev('(async()=>{const s=await window.desktopApp.automation.getState();const c=s.contacts.find(c=>c.name==="训练·测试");const d=await window.desktopApp.ai.draft({contact:c,incoming:"在干嘛呢"});return {text:d.text,model:d.model}})()')
  console.log('2. AI 拟回复:', JSON.stringify(r2).slice(0, 120))
  const r3 = await ev('window.desktopApp.ai.trainLearn({ name: "训练·测试", incoming: "在干嘛呢", userText: "刚醒，你咋这个点醒着哈哈" })')
  console.log('3. 用户示范学习:', JSON.stringify(r3))
  const r4 = await ev('(async()=>{const s=await window.desktopApp.automation.getState();const c=s.contacts.find(c=>c.name==="训练·测试");return {examples:c.profile.examples, ownerStyle:c.learning.ownerStyle.summary, msgCount:c.learning.messages.length}})()')
  console.log('4. 学习结果:', JSON.stringify(r4))
  const r5 = await ev('(async()=>{const s=await window.desktopApp.automation.getState();const c=s.contacts.find(c=>c.name==="训练·测试");const d=await window.desktopApp.ai.draft({contact:c,incoming:"在干嘛呢"});return d.text})()')
  console.log('5. 学习后再拟回复:', JSON.stringify(r5))
  await ev('(async()=>{const s=await window.desktopApp.automation.getState();await window.desktopApp.automation.update({contacts:s.contacts.filter(c=>c.name!=="训练·测试")})})()')
  console.log('测试联系人已清理')
  ws.close()
}
main().catch(e => { console.error('验证失败:', e.message); process.exit(1) })
