// 内存卫生测试：验证读取内存的多级回退、KB→MB 换算、防泄漏阈值与守卫
const { test } = require('node:test')
const assert = require('node:assert')
require('./setup.cjs')
const electron = require('electron')
const { DouyinService } = require('../electron/automation.cjs')

function makeService(win) {
  const storage = {
    get: () => ({ lastSeenPairs: [], lastSentPairs: [], settings: {}, automation: {} }),
    update: () => {},
    addLog: () => {},
  }
  const svc = new DouyinService({ storage, emit: () => {}, ai: {}, partition: 'persist:test' })
  svc.window = win || null
  return svc
}

function fakeWindow(pid, { heapBytes = 0 } = {}) {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    destroy() { this.destroyed = true },
    webContents: {
      isLoading: () => false,
      getOSProcessId: () => pid,
      executeJavaScript: async () => heapBytes,
    },
  }
}

// 用 app.getAppMetrics 提供指标（Electron 37 的真实 API 位置）
async function withAppMetrics(pid, kb, fn) {
  const prev = electron.app
  electron.app = { getAppMetrics: () => [{ pid, memory: { workingSetSize: kb } }] }
  try { return await fn() } finally { electron.app = prev }
}

// 用 process.getAppMetrics 提供指标（旧版 Electron / 回退路径）
async function withProcessMetrics(pid, kb, fn) {
  const prevApp = electron.app
  const prevProc = process.getAppMetrics
  electron.app = undefined
  process.getAppMetrics = () => [{ pid, memory: { workingSetSize: kb } }]
  try { return await fn() } finally { electron.app = prevApp; process.getAppMetrics = prevProc }
}

test('runMemoryHygiene：走 app.getAppMetrics，≥800MB 且加载 ≥10 分钟时重建', async () => {
  const win = fakeWindow(4242)
  const svc = makeService(win)
  svc._pageLoadedAt = Date.now() - 20 * 60 * 1000
  const logged = []
  svc.log = (type, message, detail) => logged.push({ type, message, detail })
  let recycled = 0
  svc.recycleChatWindow = () => { recycled += 1 }

  await withAppMetrics(4242, 900 * 1024, () => svc.runMemoryHygiene()) // 900MB
  assert.equal(recycled, 1, '应触发重建')
  assert.equal(logged[0]?.type, 'memory_hygiene')
  assert.equal(logged[0]?.detail?.memMB, 900, 'KB→MB 换算正确（900*1024KB → 900MB）')
  assert.equal(logged[0]?.detail?.source, 'appMetrics')
})

test('runMemoryHygiene：正常水位不触发（阈值边界 800MB 触发，600MB 不触发）', async () => {
  const svc = makeService(fakeWindow(4248))
  svc._pageLoadedAt = Date.now() - 20 * 60 * 1000
  svc.log = () => {}
  let recycled = 0
  svc.recycleChatWindow = () => { recycled += 1 }

  await withAppMetrics(4248, 600 * 1024, () => svc.runMemoryHygiene()) // 600MB，正常水位
  assert.equal(recycled, 0, '600MB 属正常水位，不应重建（避免无谓重载）')
  await withAppMetrics(4248, 800 * 1024, () => svc.runMemoryHygiene())
  assert.equal(recycled, 1, '800MB 达到防泄漏阈值应重建')
})

test('runMemoryHygiene：回退到 process.getAppMetrics', async () => {
  const svc = makeService(fakeWindow(4249))
  svc._pageLoadedAt = Date.now() - 20 * 60 * 1000
  const logged = []
  svc.log = (t, m, d) => logged.push(d)
  let recycled = 0
  svc.recycleChatWindow = () => { recycled += 1 }

  await withProcessMetrics(4249, 900 * 1024, () => svc.runMemoryHygiene())
  assert.equal(recycled, 1)
  assert.equal(logged[0]?.source, 'appMetrics', '回退路径同样标记为 appMetrics 口径')
})

test('runMemoryHygiene：两级指标都缺失时回退到渲染进程 JS 堆（阈值 250MB）', async () => {
  const prevApp = electron.app
  const prevProc = process.getAppMetrics
  electron.app = undefined
  process.getAppMetrics = undefined
  try {
    const svc = makeService(fakeWindow(4250, { heapBytes: 300 * 1024 * 1024 })) // 300MB 堆
    svc._pageLoadedAt = Date.now() - 20 * 60 * 1000
    const logged = []
    svc.log = (t, m, d) => logged.push(d)
    let recycled = 0
    svc.recycleChatWindow = () => { recycled += 1 }

    await svc.runMemoryHygiene()
    assert.equal(recycled, 1, 'JS 堆 300MB ≥ 250MB 应重建')
    assert.equal(logged[0]?.source, 'jsHeap')

    const svc2 = makeService(fakeWindow(4251, { heapBytes: 150 * 1024 * 1024 })) // 150MB 堆
    svc2._pageLoadedAt = Date.now() - 20 * 60 * 1000
    svc2.log = () => {}
    let recycled2 = 0
    svc2.recycleChatWindow = () => { recycled2 += 1 }
    await svc2.runMemoryHygiene()
    assert.equal(recycled2, 0, 'JS 堆 150MB 低于阈值不应重建')
  } finally {
    electron.app = prevApp
    process.getAppMetrics = prevProc
  }
})

test('runMemoryHygiene：长时间低内存不触发（无时长兜底，避免无谓重载）', async () => {
  const svc = makeService(fakeWindow(4244))
  svc._pageLoadedAt = Date.now() - 10 * 60 * 60 * 1000 // 已加载 10 小时
  let recycled = 0
  svc.recycleChatWindow = () => { recycled += 1 }
  svc.log = () => {}

  await withAppMetrics(4244, 300 * 1024, () => svc.runMemoryHygiene()) // 内存正常
  assert.equal(recycled, 0)
})

test('runMemoryHygiene：轮询中或验证中跳过，窗口缺失/销毁也跳过', async () => {
  const win = fakeWindow(4245)
  const svc = makeService(win)
  svc._pageLoadedAt = Date.now() - 20 * 60 * 1000
  let recycled = 0
  svc.recycleChatWindow = () => { recycled += 1 }
  svc.log = () => {}

  svc.polling = true
  await withAppMetrics(4245, 900 * 1024, () => svc.runMemoryHygiene())
  assert.equal(recycled, 0, '轮询中不应重建')

  svc.polling = false
  svc.verificationActive = true
  await withAppMetrics(4245, 900 * 1024, () => svc.runMemoryHygiene())
  assert.equal(recycled, 0, '验证中不应重建')

  svc.verificationActive = false
  svc.window = null
  await withAppMetrics(4245, 900 * 1024, () => svc.runMemoryHygiene())
  assert.equal(recycled, 0, '窗口缺失不应重建')

  const dead = fakeWindow(4247)
  dead.destroyed = true
  svc.window = dead
  await withAppMetrics(4247, 900 * 1024, () => svc.runMemoryHygiene())
  assert.equal(recycled, 0, '窗口已销毁不应重建')
})

test('recycleChatWindow：销毁窗口并置空 this.window 以便下次按需重建', () => {
  const win = fakeWindow(4246)
  const svc = makeService(win)
  svc.recycleChatWindow()
  assert.equal(win.destroyed, true, '窗口应被销毁（渲染进程退出，OS 回收内存）')
  assert.equal(svc.window, null, 'this.window 应置空')
})
