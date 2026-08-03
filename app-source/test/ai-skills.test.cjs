const assert = require('node:assert/strict')
const Module = require('node:module')
const test = require('node:test')

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return { safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s), 'utf8'), decryptString: (b) => b.toString('utf8') } }
  return originalLoad.call(this, request, parent, isMain)
}

const {
  AiService,
  buildChatMessages,
  buildChatPrompt,
  buildSkillsBlock,
  buildVideoPrompt,
  buildVideoSharePrompt,
  normalizeSkills,
  parseSkillsImport,
} = require('../electron/ai-service.cjs')

const contact = { name: '小明', profile: {}, learning: { messages: [], contactStyle: {}, ownerStyle: {} } }
const skill = (overrides = {}) => ({ name: '语言判断', target: 'chat', instruction: '先判断对方语气再回', enabled: true, ...overrides })

function makeService(initial = {}) {
  const logs = []
  const state = { aiSkills: [], providers: [], settings: {}, appearance: {}, ...initial }
  const storage = {
    get: () => state,
    update: (patch) => Object.assign(state, patch),
    addLog: (log) => logs.push(log),
  }
  return { ai: new AiService(storage), storage, state, logs }
}

test('normalizeSkills 校验字段、裁剪长度、补默认值并过滤无效项', () => {
  const normalized = normalizeSkills([
    { name: '  语气  ', target: 'bad', instruction: '  指令内容  ', enabled: false },
    { name: 'x'.repeat(60), target: 'video', instruction: 'y'.repeat(2100) },
    { name: '', instruction: '无名称' },
    { name: '无指令' },
    null,
  ])
  assert.equal(normalized.length, 2)
  assert.equal(normalized[0].name, '语气')
  assert.equal(normalized[0].target, 'all') // 非法 target 回落为 all
  assert.equal(normalized[0].enabled, false)
  assert.equal(normalized[0].id.startsWith('skill-'), true)
  assert.equal(normalized[1].name.length, 50) // 名称截断
  assert.equal(normalized[1].instruction.length, 2000) // 指令截断
  assert.equal(normalized[1].enabled, true)
  assert.deepEqual(normalizeSkills('not-array'), [])
})

test('parseSkillsImport 支持 JSON 数组与单个对象,非法输入抛错', () => {
  const fromArray = parseSkillsImport(JSON.stringify([skill({ name: 'a' }), skill({ name: 'b' })]))
  assert.deepEqual(fromArray.map((item) => item.name), ['a', 'b'])
  const fromObject = parseSkillsImport(JSON.stringify(skill({ name: 'c' })))
  assert.equal(fromObject.length, 1)
  assert.equal(fromObject[0].name, 'c')
  assert.throws(() => parseSkillsImport(''), /导入内容为空/)
  assert.throws(() => parseSkillsImport('not json'), /不是有效的 JSON/)
  assert.throws(() => parseSkillsImport('[{"name":""}]'), /没有有效的 Skill/)
})

test('buildSkillsBlock 按 target 与 enabled 过滤,all 全局生效', () => {
  const skills = [
    skill({ name: '聊天A', instruction: '聊天指令A' }),
    skill({ name: '视频B', target: 'video', instruction: '视频指令B' }),
    skill({ name: '全局C', target: 'all', instruction: '全局指令C' }),
    skill({ name: '停用D', instruction: '停用指令D', enabled: false }),
  ]
  const chatBlock = buildSkillsBlock(skills, 'chat')
  assert.match(chatBlock, /聊天指令A/)
  assert.match(chatBlock, /全局指令C/)
  assert.doesNotMatch(chatBlock, /视频指令B/)
  assert.doesNotMatch(chatBlock, /停用指令D/)
  const videoBlock = buildSkillsBlock(skills, 'video')
  assert.doesNotMatch(videoBlock, /聊天指令A/)
  assert.match(videoBlock, /视频指令B/)
  assert.match(videoBlock, /全局指令C/)
  const shareBlock = buildSkillsBlock(skills, 'share')
  assert.match(shareBlock, /全局指令C/) // all 场景会注入到 share
  assert.equal(buildSkillsBlock([], 'chat'), '')
})

test('buildSkillsBlock 的 all 场景会注入到 chat/video/share 任一目标', () => {
  const skills = [skill({ name: '全局', target: 'all', instruction: '永远不写长段落' })]
  assert.match(buildSkillsBlock(skills, 'chat'), /永远不写长段落/)
  assert.match(buildSkillsBlock(skills, 'video'), /永远不写长段落/)
  assert.match(buildSkillsBlock(skills, 'share'), /永远不写长段落/)
})

test('prompt 注入:聊天/视频/分享语均按场景追加 skill', () => {
  const skills = [skill({ name: '语气', target: 'chat', instruction: '先判断语气再回' })]
  const chatPrompt = buildChatPrompt(contact, skills)
  assert.match(chatPrompt, /用户自定义 Skill/)
  assert.match(chatPrompt, /先判断语气再回/)
  const chatNoSkills = buildChatPrompt(contact)
  assert.doesNotMatch(chatNoSkills, /用户自定义 Skill/)

  const videoSkills = [skill({ name: '评论', target: 'video', instruction: '评论可能是反讽' })]
  assert.match(buildVideoPrompt(contact, videoSkills), /评论可能是反讽/)
  const shareSkills = [skill({ name: '分享', target: 'share', instruction: '分享语 10-35 字' })]
  assert.match(buildVideoSharePrompt(contact, { title: 't' }, shareSkills), /分享语 10-35 字/)
})

test('buildChatMessages 将 skills 透传到 system prompt', () => {
  const skills = [skill({ name: '聊天', target: 'chat', instruction: '每条回复不超过 20 字' })]
  const messages = buildChatMessages(contact, '在吗', [], '', { frames: [] }, skills)
  const system = messages[0].content
  assert.match(system, /每条回复不超过 20 字/)
  const mediaSkills = [skill({ name: '媒体', target: 'video', instruction: '媒体回复要克制' })]
  const mediaMessages = buildChatMessages(contact, '[视频]', [], '', { frames: ['data:image/jpeg;base64,AA'], mediaKind: 'media' }, mediaSkills)
  assert.match(mediaMessages[0].content, /媒体回复要克制/)
})

test('saveSkills 归一化并持久化', () => {
  const { ai, state } = makeService()
  const result = ai.saveSkills([skill({ name: '语气', target: 'bad' }), { name: '', instruction: 'x' }])
  assert.equal(result.ok, true)
  assert.equal(result.skills.length, 1)
  assert.equal(result.skills[0].target, 'all')
  assert.equal(state.aiSkills.length, 1)
})

test('importSkills 解析、同名合并、计数', () => {
  const { ai, state } = makeService({ aiSkills: [skill({ name: '语气', id: 'keep-id', instruction: '旧指令' })] })
  const result = ai.importSkills(JSON.stringify([
    skill({ name: '语气', instruction: '新指令' }), // 同名 → 覆盖,保留 id
    skill({ name: '新增', target: 'video', instruction: '新增指令' }),
  ]))
  assert.equal(result.ok, true)
  assert.equal(result.imported, 2)
  assert.equal(state.aiSkills.length, 2)
  const merged = state.aiSkills.find((item) => item.name === '语气')
  assert.equal(merged.id, 'keep-id')
  assert.equal(merged.instruction, '新指令')
  assert.equal(state.aiSkills.some((item) => item.name === '新增'), true)
})

test('importSkills 非法 JSON 抛错且不写入', () => {
  const { ai, state } = makeService()
  assert.throws(() => ai.importSkills('{{{'), /不是有效的 JSON/)
  assert.equal(state.aiSkills.length, 0)
})

test('draft 会把 aiSkills 注入到请求消息(无 provider 时走 simulated 不抛错)', async () => {
  const { ai, state } = makeService()
  state.aiSkills = [skill({ name: '全局', target: 'all', instruction: '只说口语短句' })]
  const result = await ai.draft({ contact, incoming: '在吗' })
  assert.equal(result.ok, true)
  assert.equal(result.simulated, true)
})
