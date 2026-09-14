// UI 修复验证（v2）：连接应用调试端口，在真实运行的界面上断言。
// 先 Page.reload 清掉页面内遗留状态，再依次验证：
// A) 搜索过滤不打断输入焦点；B) 数据补丁保持滚动 + 不销毁表单节点；
// C) 真实轮询事件到达后滚动不重置；D) 导航切换正常。
const DEBUG_HOST = 'http://127.0.0.1:9223'

async function findMainPage() {
  const list = await (await fetch(`${DEBUG_HOST}/json`)).json()
  const main = list.filter((t) => t.type === 'page').find((t) => t.title === '抖音回复助手')
  if (!main) throw new Error('找不到主窗口页面目标')
  return main.webSocketDebuggerUrl
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res2, rej2) => {
          const mid = ++id
          pending.set(mid, { res: res2, rej: rej2 })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
      close: () => ws.close(),
    })
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      }
    }
    ws.onerror = () => reject(new Error('WebSocket 连接失败'))
  })
}

async function main() {
  const cdp = await connect(await findMainPage())
  const results = []
  const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`) }
  const ev = async (expr) => {
    const out = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (out.exceptionDetails) throw new Error('页面内异常: ' + (out.exceptionDetails.exception?.description || out.exceptionDetails.text))
    return out.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 清状态：重载页面，等应用初始化完成
  await cdp.send('Page.enable')
  await cdp.send('Page.reload')
  let ready = false
  for (let i = 0; i < 25; i += 1) {
    ready = await ev(`Boolean(document.getElementById('contact-list-scroll') && document.getElementById('contact-list-scroll').children.length >= 3)`)
    if (ready) break
    await sleep(1000)
  }
  check('主窗口渲染完成且联系人列表非空', ready)

  // A) 搜索过滤不打断输入焦点（原始值断言）
  const a1 = await ev(`(() => {
    const search = document.getElementById('contact-search')
    search.focus()
    search.value = '乔治'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    return document.activeElement === search ? 'focused' : 'lost'
  })()`)
  check('A1 搜索输入焦点保留', a1 === 'focused', a1)
  const a2 = await ev(`document.querySelectorAll('#contact-list-scroll .contact-item').length`)
  check('A2 搜索过滤生效（乔治 → 1 项）', a2 === 1, `实际 ${a2} 项`)
  await ev(`(() => {
    const search = document.getElementById('contact-search')
    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    search.blur()
  })()`)

  // B) 数据补丁：滚动保持 + 表单节点不销毁
  await ev(`(() => {
    document.getElementById('contact-list-scroll').scrollTop = 220
    document.getElementById('contact-list-scroll').__marker = 'original-list-node'
    const select = document.querySelector('select[data-cf="frequency"]')
    if (select) select.__marker = 'original-select-node'
    return 'ok'
  })()`)
  await ev(`refreshDynamic()`)
  await sleep(300)
  const b1 = await ev(`document.getElementById('contact-list-scroll').scrollTop`)
  check('B1 数据补丁后滚动位置保持（220）', b1 === 220, `实际 ${b1}`)
  const b2 = await ev(`document.getElementById('contact-list-scroll').__marker === 'original-list-node' ? 'same' : 'replaced'`)
  check('B2 列表容器未被整体替换', b2 === 'same', b2)
  const b3 = await ev(`(() => { const s = document.querySelector('select[data-cf="frequency"]'); return s && s.__marker === 'original-select-node' ? 'alive' : 'dead' })()`)
  check('B3 表单下拉元素未被销毁', b3 === 'alive', b3)

  // C) 真实轮询事件到达后（约 5-10 秒一次），滚动位置不重置
  await ev(`document.getElementById('contact-list-scroll').scrollTop = 260`)
  await sleep(12000)
  const c1 = await ev(`document.getElementById('contact-list-scroll').scrollTop`)
  check('C1 真实轮询事件后滚动位置保持（260）', c1 === 260, `实际 ${c1}`)

  // D) 导航切换正常
  await ev(`document.querySelector('.rail-item[data-args*=\\"logs\\"]').click()`)
  const d1 = await ev(`Boolean(document.getElementById('logs-list')) ? 'ok' : 'missing'`)
  check('D1 切到运行记录页正常', d1 === 'ok', d1)
  await ev(`document.querySelector('.rail-item[data-args*=\\"chat\\"]').click()`)
  const d2 = await ev(`Boolean(document.getElementById('contact-list-scroll')) ? 'ok' : 'missing'`)
  check('D2 切回对话页正常', d2 === 'ok', d2)

  await cdp.close()
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过 ✅')
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => { console.error('验证失败:', error.message); process.exit(1) })
