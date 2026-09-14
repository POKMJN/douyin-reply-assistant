// 测试引导：把 require('electron') 重定向到测试桩
const Module = require('node:module')
const path = require('node:path')

const originalResolve = Module._resolveFilename
if (!Module.__xushengStubbed) {
  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
    return originalResolve.call(this, request, ...args)
  }
  Module.__xushengStubbed = true
}

// 内存存储桩（实现 JsonStorage 的最小接口）
function createMemoryStorage(initial = {}) {
  let state = {
    version: 2,
    automation: { autoReply: true, paused: false, sparks: [], dailyLimit: 30, maxPerContactDaily: 12, blacklist: [], aiDisabledContacts: [] },
    contacts: [],
    providers: [],
    aiSkills: [],
    logs: [],
    sendHistory: [],
    pendingDrafts: [],
    appearance: { theme: 'auto', defaultTone: '' },
    settings: {
      videoReplyEnabled: true, videoRecognitionEnabled: true, videoAnalysisFirst: true, videoRecognitionMode: 'smart', multiCandidateReply: false,
      twoMessageChance: 0, // 默认关：需要测试双消息的用例显式设为 1
      showAiModelLabel: true, failoverEnabled: true, longTermMemory: true, aiReplyDraftOnly: false,
      proactiveChat: { enabled: false, maxPerDay: 2, windowStart: '10:00', windowEnd: '22:00', minIntervalMinutes: 180, sendToDraft: false },
    },
    ...initial,
  }
  return {
    get: () => structuredClone(state),
    update(patch) { state = { ...state, ...patch }; return structuredClone(state) },
    addLog(entry) { state.logs = [{ id: Date.now(), at: new Date().toISOString(), ...entry }, ...state.logs].slice(0, 150); return structuredClone(state) },
    _raw: () => state,
  }
}

module.exports = { createMemoryStorage }
