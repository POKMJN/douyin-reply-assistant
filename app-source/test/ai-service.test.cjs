const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      safeStorage: {
        decryptString: (value) => value.toString('utf8'),
        encryptString: (value) => Buffer.from(value),
        isEncryptionAvailable: () => true,
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const { AiService, buildChatMessages, buildChatPrompt, buildLearningProfile, buildTurnGuidance, buildVideoPrompt, buildVideoSharePrompt, cleanGeneratedText, incomingTimeContext, isNoReplyDecision, labelAiReply, normalizeVideoInput, replyQualityIssues, timeContext } = require('../electron/ai-service.cjs')
Module._load = originalLoad

test('provider test and draft both call chat completions', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: requests.length === 1 ? '连接成功' : '这是 AI 回复' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const provider = {
    name: '测试模型',
    model: 'test-model',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    keyCipher: Buffer.from('secret-key').toString('base64'),
  }
  const state = { providers: [provider] }
  const storage = {
    get: () => structuredClone(state),
    addLog: () => {},
  }
  const service = new AiService(storage)

  assert.equal(service.hasProvider(), true)
  assert.deepEqual(await service.test(0), { ok: true, message: '连接测试成功' })
  const draft = await service.draft({ contact: { name: '小明' }, incoming: '你好' })

  assert.equal(draft.text, '这是 AI 回复')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, '/v1/chat/completions')
  assert.equal(requests[0].authorization, 'Bearer secret-key')
  assert.equal(requests[1].body.model, 'test-model')
  assert.equal(requests[1].body.messages[1].content, '你好')
  assert.match(requests[1].body.messages[0].content, /不要把自己当成助手、客服或咨询师/)
  assert.equal(requests[1].body.temperature, 0.85)
  assert.equal(requests[1].body.max_tokens, 120)
})

test('transcribeAudio sends audio to an OpenAI-compatible transcription endpoint', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('latin1'),
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ text: '视频里有人说早上好' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const audioPath = path.join(os.tmpdir(), `xusheng-asr-test-${Date.now()}.wav`)
  fs.writeFileSync(audioPath, Buffer.from('fake wav content'))
  t.after(() => fs.rmSync(audioPath, { force: true }))

  const service = new AiService({
    get: () => ({
      providers: [{
        name: 'ASR',
        model: 'chat-model',
        transcriptionModel: 'whisper-test',
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        keyCipher: Buffer.from('asr-key').toString('base64'),
      }],
    }),
    addLog: () => {},
  })

  const result = await service.transcribeAudio({ filePath: audioPath, mimeType: 'audio/wav' })

  assert.equal(result.text, '视频里有人说早上好')
  assert.equal(result.model, 'whisper-test')
  assert.equal(result.provider, 'ASR')
  assert.equal(requests[0].url, '/v1/audio/transcriptions')
  assert.equal(requests[0].authorization, 'Bearer asr-key')
  assert.match(requests[0].contentType, /^multipart\/form-data; boundary=/)
  assert.match(requests[0].body, /name="model"\r\n\r\nwhisper-test/)
  assert.match(requests[0].body, /name="file"; filename="xusheng-audio\.wav"/)
  assert.match(requests[0].body, /fake wav content/)
})

test('setPrimaryProvider moves a model to the front without dropping encrypted keys', () => {
  const state = {
    providers: [
      { name: '备用模型', model: 'backup', baseUrl: 'http://backup', keyCipher: 'backup-key' },
      { name: '主用模型', model: 'primary', baseUrl: 'http://primary', keyCipher: 'primary-key' },
    ],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
  }
  const service = new AiService(storage)

  const result = service.setPrimaryProvider(1)

  assert.deepEqual(result.providers.map((item) => item.name), ['主用模型', '备用模型'])
  assert.equal(state.providers[0].keyCipher, 'primary-key')
  assert.equal(state.providers[1].keyCipher, 'backup-key')
  assert.equal(result.providers[0].keyCipher, undefined)
})

test('chat prompt uses profile examples as the highest-priority voice reference', () => {
  const prompt = buildChatPrompt({
    name: '小明',
    profile: {
      relation: '老同学',
      call: '明哥',
      preferences: '爱打游戏',
      boundary: '不聊收入',
      examples: ['笑死我了', ' 行吧到时候再看 '],
    },
  })

  assert.match(prompt, /账号本人/)
  assert.match(prompt, /对方说得短，你也说得短/)
  assert.match(prompt, /不要每次都称呼对方/)
  assert.match(prompt, /笑死我了/)
  assert.match(prompt, /行吧到时候再看/)
  assert.match(prompt, /不聊收入/)
})

test('learned conversation produces style summaries and real chat roles', () => {
  const learning = buildLearningProfile([
    { role: 'contact', text: '在吗' },
    { role: 'me', text: '在啊咋了' },
    { role: 'contact', text: '哈哈哈没事呀' },
    { role: 'me', text: '笑死 你吓我一跳' },
    { role: 'contact', text: '晚上打游戏吗' },
  ])
  const contact = { name: '小明', learning }
  const messages = buildChatMessages(contact, '晚上打游戏吗')

  assert.equal(learning.messages.length, 5)
  assert.match(learning.contactStyle.summary, /偏短句/)
  assert.match(learning.contactStyle.summary, /笑声表达/)
  assert.deepEqual(messages.slice(1).map((item) => item.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.equal(messages.at(-1).content, '晚上打游戏吗')
  assert.match(messages[0].content, /自动学习到的对方说话特点/)
})

test('turn guidance chooses a compact response move from message intent and history', () => {
  const contact = {
    learning: {
      messages: [
        { role: 'me', text: '后来怎么样了？' },
        { role: 'contact', text: '终于过了哈哈哈' },
      ],
    },
  }

  const guidance = buildTurnGuidance(contact, '终于过了哈哈哈')
  assert.match(guidance, /分享好消息或兴奋点/)
  assert.match(guidance, /适合接梗/)
  assert.match(guidance, /别写成正式祝贺词/)
  assert.match(buildChatPrompt(contact, '终于过了哈哈哈'), /每次只选一个主要接法/)
})

test('reply quality checks catch mechanical chat patterns without rejecting normal short replies', () => {
  assert.deepEqual(replyQualityIssues('笑死，后面那个停顿太绝了'), [])
  assert.match(replyQualityIssues('我理解你的感受，如果你愿意，我可以给你一些建议。你怎么看？还有别的吗？').join('、'), /客服腔或 AI 腔/)
  assert.match(replyQualityIssues('我理解你的感受，如果你愿意，我可以给你一些建议。你怎么看？还有别的吗？').join('、'), /连续追问/)
  assert.match(replyQualityIssues('还是没显示出来，截个图吧', true).join('、'), /媒体未加载或要求对方截图/)
  assert.equal(cleanGeneratedText('```text\n那也太离谱了\n```'), '那也太离谱了')
  assert.equal(isNoReplyDecision('[不回复]'), true)
})

test('mechanical drafts are conditionally rewritten into a natural short reply', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      const content = requests.length === 1
        ? '我理解你的感受，如果你愿意，我可以给你一些建议。你怎么看？还有别的吗？'
        : '也太折磨了，先缓一会儿吧'
      response.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ providers: [{ name: 'Rewrite', model: 'rewrite-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64') }] }),
    addLog: () => {},
  }

  const result = await new AiService(storage).draft({ contact: { name: '小明' }, incoming: '今天真的累死了' })

  assert.equal(result.text, '也太折磨了，先缓一会儿吧')
  assert.equal(requests.length, 2)
  assert.equal(requests[1].temperature, 0.65)
  assert.match(requests[1].messages.at(-1).content, /保留原意和已知事实/)
})

test('explicit no-reply decisions are returned as skipped instead of fallback text', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: '[不回复]' } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ providers: [{ name: 'Skip', model: 'skip-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64') }] }),
    addLog: () => {},
  }

  const result = await new AiService(storage).draft({ contact: { name: '小明' }, incoming: '昨晚的临时邀约' })

  assert.equal(result.skipped, true)
  assert.equal(result.text, '')
  assert.equal(result.labeledText, '')
})

test('video replies use a compact prompt and at most three low-detail frames for raw frame arrays', () => {
  const frames = Array.from({ length: 4 }, (_, index) => `data:image/jpeg;base64,frame${index}`)
  const messages = buildChatMessages({
    name: '小明',
    profile: { relation: '朋友', examples: ['笑死我了'] },
    learning: { ownerStyle: { summary: '偏短句' }, messages: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'me' : 'contact', text: `历史消息${index}` })) },
  }, '[视频]', frames)

  assert.match(messages[0].content, /像真人刚看完一样/)
  assert.match(messages[0].content, /不要每句都用[“"]这[”"]或[“"]这个[”"]开头/)
  assert.doesNotMatch(messages[0].content, /这个角度看着有点像/)
  assert.equal(messages.length, 6)
  assert.equal(messages.at(-1).content.filter((part) => part.type === 'image_url').length, 3)
  assert.ok(messages.at(-1).content.filter((part) => part.type === 'image_url').every((part) => part.image_url.detail === 'low'))
})

test('captured video metadata can send more high-detail frames to vision models', () => {
  const frames = Array.from({ length: 7 }, (_, index) => `data:image/jpeg;base64,frame${index}`)
  const media = normalizeVideoInput({
    frames,
    maxFrames: 6,
    frameDetail: 'high',
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: true,
    confidence: 'high',
    audioTranscript: '视频里有人笑着说太离谱了',
  })
  const messages = buildChatMessages({ name: '小明' }, '[视频]', [], '前几帧铺垫，后面有反转笑点。', media)
  const userContent = messages.at(-1).content
  const imageParts = userContent.filter((part) => part.type === 'image_url')

  assert.equal(media.frames.length, 6)
  assert.equal(imageParts.length, 6)
  assert.ok(imageParts.every((part) => part.image_url.detail === 'high'))
  assert.match(userContent[0].text, /画质 high/)
  assert.match(userContent[0].text, /视频理解结果：前几帧铺垫，后面有反转笑点。/)
  assert.match(userContent[0].text, /视频音频转写：视频里有人笑着说太离谱了/)
})

test('video inputs keep capture metadata for conservative replies', () => {
  const media = normalizeVideoInput({
    frames: ['data:image/jpeg;base64,poster'],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: false,
    posterFound: true,
    confidence: 'low',
    reason: 'video_not_decoded',
  })
  const messages = buildChatMessages({ name: '小明' }, '[视频]', media.frames, '只能确认封面里有人在做饭', media)

  assert.equal(media.frames.length, 1)
  assert.equal(media.confidence, 'low')
  assert.match(messages.at(-1).content[0].text, /置信度 low/)
  assert.match(messages.at(-1).content[0].text, /只能确认封面里有人在做饭/)
  assert.match(messages.at(-1).content[0].text, /不要编造/)
})

test('video prompts include transcribed audio when available', () => {
  const media = normalizeVideoInput({
    frames: ['data:image/jpeg;base64,frame'],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: true,
    audioTranscript: '这里有人说早上好',
  })
  const messages = buildChatMessages({ name: '小明' }, '[视频]', media.frames, '', media)

  assert.match(messages.at(-1).content[0].text, /视频音频转写：这里有人说早上好/)
})

test('video prompts include public page comments when available', () => {
  const media = normalizeVideoInput({
    frames: ['data:image/jpeg;base64,frame'],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: true,
    videoPageTitle: '早市小吃',
    videoPageDescription: '老板出摊做早餐',
    videoSharedComment: '这也太真实了吧',
    videoComments: ['看起来好香', '这个摊我也去过'],
  })
  const messages = buildChatMessages({ name: '小明' }, '[视频]', media.frames, '', media)

  assert.match(messages.at(-1).content[0].text, /视频公开页信息：标题：早市小吃/)
  assert.match(messages.at(-1).content[0].text, /当前分享的评论：这也太真实了吧/)
  assert.match(messages.at(-1).content[0].text, /视频公开页可参考评论（仅用于理解，不要在回复中提及评论来源）：1\. 看起来好香 \/ 2\. 这个摊我也去过/)
})

test('video prompts do not expose source author names as reply topics', () => {
  const media = normalizeVideoInput({
    frames: [],
    mediaKind: 'video',
    detectedVideo: true,
    videoReady: false,
    videoPageAuthor: 'xiang先生',
    videoComments: ['起码累着自己了😍'],
    confidence: 'medium',
  })
  const messages = buildChatMessages({ name: '小明' }, '分享[评论]', media.frames, '', media)
  const text = messages.at(-1).content

  assert.equal(typeof text, 'string')
  assert.match(text, /起码累着自己了/)
  assert.doesNotMatch(text, /xiang先生/)
  assert.match(buildVideoPrompt({ name: '小明' }), /反讽、阴阳、玩梗或调侃/)
})

test('emoji guidance is opt-in per generated reply and comment source language is rejected', () => {
  assert.match(buildVideoPrompt({ name: '小明', _allowEmoji: false }), /不要使用任何 emoji/)
  assert.match(buildVideoPrompt({ name: '小明', _allowEmoji: true }), /可以视语气偶尔带 1 个自然的 emoji/)
  assert.match(replyQualityIssues('评论区都说太好笑了', true).join('、'), /提及评论来源/)
  assert.match(replyQualityIssues('太好笑了🤣', true, false).join('、'), /本次不需要使用表情/)
})

test('video drafts fall back to audio-only context when no vision model is configured', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '他说早上好，那就回早呀' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const result = await new AiService({
    get: () => ({ settings: { showAiModelLabel: false }, providers: [{ name: 'Text', model: 'text-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64') }] }),
    addLog: () => {},
  }).draft({
    contact: { name: '小明' },
    incoming: '[视频]',
    videoFrames: { frames: ['data:image/jpeg;base64,frame'], mediaKind: 'video', detectedVideo: true, videoReady: false, audioTranscript: '这里有人说早上好' },
  })

  assert.equal(result.text, '他说早上好，那就回早呀')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'text-model')
  assert.equal(typeof requests[0].messages.at(-1).content, 'string')
  assert.match(requests[0].messages.at(-1).content, /视频音频转写：这里有人说早上好/)
  assert.doesNotMatch(requests[0].messages.at(-1).content, /image_url/)
})

test('video drafts analyze frames before generating the final reply', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: requests.length === 1 ? '可确认：画面里有人在做饭。适合接做饭这个点。' : '看着还挺香的诶' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ settings: { showAiModelLabel: false }, providers: [{ name: 'Vision', model: 'vision-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64'), capabilities: ['vision'] }] }),
    addLog: () => {},
  }
  const result = await new AiService(storage).draft({
    contact: { name: '小明' },
    incoming: '[视频]',
    videoFrames: { frames: ['data:image/jpeg;base64,frame'], mediaKind: 'video', detectedVideo: true, videoReady: true, decodedVideoFrames: 1, confidence: 'high' },
  })

  assert.equal(result.text, '看着还挺香的诶')
  assert.equal(requests.length, 3)
  assert.match(requests[0].messages[0].content, /先理解一条抖音私信里的媒体内容/)
  assert.doesNotMatch(requests[0].messages.at(-1).content[0].text, /这些画面按时间顺序抽取/)
  assert.match(requests[1].messages.at(-1).content[0].text, /视频理解结果/)
  assert.match(requests[1].messages.at(-1).content[0].text, /画面里有人在做饭/)
  // request[2] is the second candidate from multi-candidate generation
})

test('video analysis preflight can be disabled to use one model call', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '这个画面挺有意思' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ settings: { showAiModelLabel: false, videoAnalysisFirst: false }, providers: [{ name: 'Vision', model: 'vision-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64'), capabilities: ['vision'] }] }),
    addLog: () => {},
  }
  const result = await new AiService(storage).draft({
    contact: { name: '小明' },
    incoming: '[视频]',
    videoFrames: { frames: ['data:image/jpeg;base64,frame'], mediaKind: 'video', detectedVideo: true, videoReady: true },
  })

  assert.equal(result.text, '这个画面挺有意思')
  assert.equal(requests.length, 2)
  assert.doesNotMatch(requests[0].messages.at(-1).content[0].text, /视频理解结果/)
  // Two calls because multi-candidate generates 2 candidates
})

test('AI replies expose a model label while preserving natural response text', () => {
  assert.equal(labelAiReply('凌晨了还没睡呀', { model: 'gpt-5.5' }), '【AI · gpt-5.5】凌晨了还没睡呀')
  assert.equal(labelAiReply('【AI · gpt-5.5】已经标注', { model: 'gpt-5.5' }), '【AI · gpt-5.5】已经标注')
})

test('video share prompt asks for content-specific casual captions', () => {
  const prompt = buildVideoSharePrompt({ name: '小明', profile: { relation: '朋友' } }, { title: '冷幽默短片', note: '最后那个停顿很好笑' })

  assert.match(prompt, /视频的真实内容信息/)
  assert.match(prompt, /具体亮点/)
  assert.match(prompt, /最后那个停顿很好笑/)
  assert.match(prompt, /不像平台推荐/)
})

test('model labels can be disabled without losing model audit metadata', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: '早点休息呀' } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ settings: { showAiModelLabel: false }, providers: [{ name: 'Test', model: 'private-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64') }] }),
    addLog: () => {},
  }
  const result = await new AiService(storage).draft({ contact: { name: '小明' }, incoming: '困了' })
  assert.equal(result.text, '早点休息呀')
  assert.equal(result.labeledText, '早点休息呀')
  assert.equal(result.aiLabel, 'AI · private-model')
  assert.equal(result.showAiModelLabel, false)
})

test('inquiry planning and answer summaries use the configured provider', async (t) => {
  let calls = 0
  const server = http.createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: calls === 1 ? '你最近工作忙不忙呀' : '对方明确表示最近工作比较忙。' } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ settings: { showAiModelLabel: false }, providers: [{ name: 'Test', model: 'inquiry-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64') }] }),
    addLog: () => {},
  }
  const service = new AiService(storage)
  const planned = await service.planInquiry({ contact: { name: '小明' }, question: '他最近工作忙不忙' })
  const summary = await service.summarizeInquiry({ contact: { name: '小明' }, question: '他最近工作忙不忙', asked: planned.text, answer: '最近确实挺忙的' })
  assert.equal(planned.labeledText, '你最近工作忙不忙呀')
  assert.equal(planned.model, 'inquiry-model')
  assert.equal(summary.report, '对方明确表示最近工作比较忙。')
  assert.equal(calls, 2)
})

test('video share drafts use the provided video content point', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '你看后面那个停顿，挺妙的' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ settings: { showAiModelLabel: false }, providers: [{ name: 'Test', model: 'share-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64') }] }),
    addLog: () => {},
  }
  const result = await new AiService(storage).draftVideoShare({ contact: { name: '小明' }, video: { title: '冷幽默短片', note: '最后那个停顿很好笑', url: 'https://v.douyin.com/abc/' } })

  assert.equal(result.text, '你看后面那个停顿，挺妙的')
  assert.equal(result.labeledText, '你看后面那个停顿，挺妙的')
  assert.match(requests[0].messages[0].content, /最后那个停顿很好笑/)
  assert.equal(requests[0].temperature, 0.9)
  assert.equal(requests[0].max_tokens, 80)
})

test('time context provides a midnight cue for natural replies', () => {
  const context = timeContext(new Date('2026-07-22T01:30:00+08:00'))
  assert.equal(context.label, '凌晨')
  assert.match(context.cue, /没睡/)
})

test('incoming time context asks the model to handle late replies', () => {
  const context = incomingTimeContext({
    sentAt: '2026-07-22T01:00:00+08:00',
    sentAtLabel: '01:00',
  }, new Date('2026-07-22T08:00:00+08:00'))

  assert.match(context.text, /对方消息时间/)
  assert.match(context.text, /已隔 7 小时/)
  assert.match(context.text, /凌晨发的，现在才处理/)
  assert.match(context.text, /\[不回复\]/)
})

test('no-reply decisions are treated as an empty AI draft', () => {
  assert.equal(cleanGeneratedText('[不回复]'), '')
  assert.equal(cleanGeneratedText('无需回复'), '')
})

test('retryable model responses are retried once before succeeding', async (t) => {
  let calls = 0
  const server = http.createServer((_request, response) => {
    calls += 1
    if (calls === 1) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'busy' } })); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: '收到啦' } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ providers: [{ name: 'Retry', model: 'retry-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64') }] }),
    addLog: () => {},
  }
  const result = await new AiService(storage).draft({ contact: { name: '小明' }, incoming: '在吗' })
  assert.equal(result.text, '收到啦')
  assert.equal(calls, 2)
})

test('draft fails over to the next configured provider', async (t) => {
  const servers = []
  const makeServer = (status, content) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(status >= 400 ? { error: { message: 'offline' } } : { choices: [{ message: { content } }] }))
    })
    servers.push(server)
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
  }
  const first = await makeServer(503, '')
  const second = await makeServer(200, '备用模型回复')
  t.after(() => servers.forEach((server) => server.close()))
  const key = Buffer.from('key').toString('base64')
  const storage = {
    get: () => ({ providers: [
      { name: 'Primary', model: 'primary', baseUrl: `http://127.0.0.1:${first.address().port}`, keyCipher: key },
      { name: 'Backup', model: 'backup', baseUrl: `http://127.0.0.1:${second.address().port}`, keyCipher: key },
    ] }),
    addLog: () => {},
  }
  const result = await new AiService(storage).draft({ contact: { name: '小明' }, incoming: '还在吗' })
  assert.equal(result.text, '备用模型回复')
  assert.equal(result.model, 'backup')
  assert.equal(result.provider, 'Backup')
})
