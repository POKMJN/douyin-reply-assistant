// 存储迁移测试：旧版 v0.7.x state.json → v2
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { migrateLegacy, normalizeContact, defaults } = require('../electron/storage.cjs')

const { JsonStorage } = (() => {
  const Module = require('node:module')
  const stub = path.join(__dirname, 'electron-stub.cjs')
  const original = Module._resolveFilename
  if (!Module.__migrationStubbed) {
    Module._resolveFilename = function (request, ...args) {
      if (request === 'electron') return stub
      return original.call(this, request, ...args)
    }
    Module.__migrationStubbed = true
  }
  return require('../electron/storage.cjs')
})()

test('旧版全量 state 迁移：联系人学习数据完整保留', () => {
  const legacy = {
    automation: {
      autoReply: true,
      paused: false,
      dailyLimit: 20,
      sparks: [
        { kind: 'aiSpark', name: '小明', time: '09:00', enabled: true },
        { kind: 'videoShare', name: '小明', time: '12:00', enabled: true },
        { kind: 'text', name: '小红', time: '10:00', message: '早', enabled: true },
      ],
      blacklist: ['广告号'],
      aiDisabledContacts: ['老板'],
      inquiries: [{ id: 1, status: 'waiting' }],
    },
    contacts: [{
      id: 'c1', name: '小明',
      profile: { relationship: '同学', videoShare: { enabled: true, categories: ['搞笑'] } },
      learning: {
        messages: [{ role: 'contact', text: '你好' }, { role: 'me', text: '你好呀' }],
        facts: [{ at: '2026-01-01T00:00:00Z', text: '对方喜欢爬山' }],
        topicLog: [{ at: '2026-01-01T00:00:00Z', text: '聊了爬山' }],
      },
    }],
    topicPool: [{ text: '旧热点', category: '热点' }],
    providers: [{ name: 'p1', model: 'm1', baseUrl: 'https://x/v1' }],
    appearance: { theme: 'dark', accentColor: '#e95d48', fontSize: 'large', defaultTone: '轻松随意' },
    settings: { refreshInterval: '10', quietHours: true },
    logs: [{ id: 1, at: new Date().toISOString(), type: 'message_sent', message: 'x' }],
  }
  const migrated = migrateLegacy(legacy)
  assert.equal(migrated.version, 2)
  assert.equal(migrated.automation.autoReply, true)
  assert.equal(migrated.automation.dailyLimit, 20)
  assert.equal(migrated.automation.sparks.length, 2, 'videoShare 任务被清除')
  assert.ok(!migrated.automation.sparks.some((t) => t.kind === 'videoShare'))
  assert.ok(!('inquiries' in migrated.automation), '话题代问被移除')
  assert.deepEqual(migrated.automation.blacklist, ['广告号'])
  assert.deepEqual(migrated.automation.aiDisabledContacts, ['老板'])
  const contact = migrated.contacts[0]
  assert.equal(contact.learning.messages.length, 2, '聊天历史保留')
  assert.equal(contact.learning.facts.length, 1, '长期记忆保留')
  assert.equal(contact.learning.topicLog.length, 1, '话题记录保留')
  assert.ok(!contact.profile.videoShare, 'videoShare 残留被剥离')
  assert.deepEqual(contact.turn, { lastHandledKey: '', lastOutgoingAt: 0 }, '轮次状态初始化')
  assert.deepEqual(contact.learning.mediaLog, [], '媒体上下文初始化')
  assert.equal(migrated.topicPool, undefined, '话题库被移除')
  assert.deepEqual(migrated.providers, legacy.providers)
  assert.equal(migrated.appearance.theme, 'dark')
  assert.equal(migrated.appearance.defaultTone, '轻松随意')
  assert.ok(!('accentColor' in migrated.appearance), '外观自定义被收敛')
  assert.equal(migrated.settings.refreshInterval, '10')
  assert.equal(migrated.settings.quietHours, true)
  assert.equal(migrated.settings.videoRecognitionMode, 'smart', '新字段有默认值')
})

test('损坏的 state 文件回退到默认值', () => {
  const migrated = migrateLegacy(null)
  assert.equal(migrated.version, 2)
  assert.deepEqual(migrated.automation, defaults.automation)
  assert.deepEqual(migrateLegacy('garbage'), migrated)
})

test('normalizeContact 过滤无名字/纯数字脏数据兼容', () => {
  assert.equal(normalizeContact(null), null)
  assert.equal(normalizeContact({}), null)
  const ok = normalizeContact({ name: '小明' })
  assert.ok(ok.turn)
  assert.deepEqual(ok.learning.messages, [])
})

test('JsonStorage 读写回环 + 损坏文件容错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-test-'))
  try {
    const storage = new JsonStorage(dir)
    assert.equal(storage.get().version, 2)
    storage.update({ contacts: [normalizeContact({ name: '测试' })] })
    const reloaded = new JsonStorage(dir)
    assert.equal(reloaded.get().contacts[0].name, '测试')
    assert.equal(reloaded.get().version, 2)
    // 轮转备份应存在
    assert.ok(fs.existsSync(path.join(dir, 'state.prev.json')))
    // 损坏文件 → 默认值而非崩溃
    fs.writeFileSync(path.join(dir, 'state.json'), '{broken json', 'utf8')
    const broken = new JsonStorage(path.join(dir))
    assert.equal(broken.get().version, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('addLog 遵守开关与上限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-log-'))
  try {
    const storage = new JsonStorage(dir)
    for (let i = 0; i < 200; i += 1) storage.addLog({ type: 'x', message: `m${i}` })
    assert.ok(storage.get().logs.length <= 150)
    storage.update({ settings: { ...storage.get().settings, saveLogs: false } })
    const before = storage.get().logs.length
    storage.addLog({ type: 'x', message: 'should not add' })
    assert.equal(storage.get().logs.length, before)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
