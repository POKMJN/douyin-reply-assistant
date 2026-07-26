const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { JsonStorage } = require('../electron/storage.cjs')

test('legacy contact AI blacklist migrates without blocking spark tasks', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    automation: { autoReply: true, blacklist: ['小明'] },
  }))

  const state = new JsonStorage(directory).get()

  assert.deepEqual(state.automation.aiDisabledContacts, ['小明'])
  assert.deepEqual(state.automation.blacklist, [])
})

test('legacy message logs migrate into persistent send history', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    logs: [{ type: 'message_sent', at: '2026-07-19T10:00:00.000Z', detail: { name: '小明' } }],
  }))

  const state = new JsonStorage(directory).get()

  assert.deepEqual(state.sendHistory, [{ at: '2026-07-19T10:00:00.000Z', name: '小明' }])
})

test('saved settings merge with new defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    settings: { desktopNotifications: false },
  }))

  const state = new JsonStorage(directory).get()

  assert.equal(state.settings.desktopNotifications, false)
  assert.equal(state.settings.minimizeToTray, true)
  assert.equal(state.automation.paused, false)
  assert.equal(state.settings.logRetention, '30')
  assert.equal(state.settings.showAiModelLabel, true)
  assert.equal(state.settings.videoReplyEnabled, true)
  assert.equal(state.settings.videoRecognitionEnabled, true)
  assert.equal(state.settings.videoRecognitionStrength, 'standard')
  assert.equal(state.settings.videoLowConfidenceReply, true)
  assert.equal(state.settings.videoAnalysisFirst, true)
})

test('legacy video reply switch migrates to the recognition switch', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    settings: { videoReplyEnabled: false },
  }))

  const storage = new JsonStorage(directory)
  const state = storage.get()

  assert.equal(state.settings.videoRecognitionEnabled, false)
  assert.equal(state.settings.videoReplyEnabled, false)
})

test('legacy video share spark tasks migrate into contact profiles', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    contacts: [{ id: '小明', name: '小明' }],
    automation: {
      sparks: [{
        id: 5,
        name: '小明',
        kind: 'videoShare',
        time: '13:00',
        windowEnd: '21:00',
        maxPerDay: 4,
        categories: ['搞笑反转', '电影剪辑'],
        discoveryQuery: '搞笑反转',
        message: 'https://v.douyin.com/abc/ | 冷幽默 | 后面停顿很好笑',
        enabled: true,
      }],
    },
  }))

  const state = new JsonStorage(directory).get()

  assert.deepEqual(state.automation.sparks, [])
  assert.equal(state.contacts[0].profile.videoShare.enabled, true)
  assert.equal(state.contacts[0].profile.videoShare.windowStart, '13:00')
  assert.equal(state.contacts[0].profile.videoShare.windowEnd, '21:00')
  assert.equal(state.contacts[0].profile.videoShare.maxPerDay, 4)
  assert.deepEqual(state.contacts[0].profile.videoShare.categories, ['搞笑反转', '电影剪辑'])
  assert.equal(state.contacts[0].profile.videoShare.discoveryQuery, '搞笑反转')
  assert.equal(state.contacts[0].profile.videoShare.videos[0].note, '后面停顿很好笑')
})

test('legacy garbled log messages are normalized for display', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    logs: [
      { type: 'auto_blocked', message: 'Auto reply disabled for 小明' },
      { type: 'auto_skip', message: '小明 鏄嚜宸卞彂鐨勶紝璺宠繃' },
      { type: 'spark_fill_skipped', message: '小明 浠婂ぉ宸叉湁鍙戦€佽褰曪紝鏈鏃犻渶琛ョ画' },
    ],
  }))

  const state = new JsonStorage(directory).get()

  assert.equal(state.logs[0].message, '已跳过 小明：该联系人已关闭 AI 自动回复')
  assert.equal(state.logs[1].message, '小明 是自己发的，跳过')
  assert.equal(state.logs[2].message, '小明 今天已有发送记录，本次无需补续')
})

test('disabled log storage does not persist new entries', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const storage = new JsonStorage(directory)
  storage.update({ settings: { ...storage.get().settings, saveLogs: false } })

  storage.addLog({ type: 'message_sent', message: 'sent' })

  assert.deepEqual(storage.get().logs, [])
})
