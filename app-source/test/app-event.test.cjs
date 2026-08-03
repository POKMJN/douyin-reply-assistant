const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test('contacts event refreshes visible contact preview without switching contacts', async () => {
  let douyinEventListener = null
  const appElement = { innerHTML: '' }
  const document = {
    activeElement: null,
    documentElement: {
      setAttribute() {},
      style: { setProperty() {} },
    },
    getElementById(id) {
      return id === 'app' ? appElement : null
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
  }
  const context = {
    Blob,
    URL,
    clearTimeout,
    confirm: () => true,
    console,
    document,
    setTimeout,
    structuredClone,
    window: {
      desktopApp: {
        automation: {
          getState: async () => ({
            automation: {},
            contacts: [{ id: 'Ada', name: 'Ada', preview: 'old preview' }],
            settings: {},
          }),
        },
        douyin: {
          getStatus: async () => ({ connected: true }),
        },
        onDouyinEvent(listener) {
          douyinEventListener = listener
          return () => {}
        },
      },
    },
  }

  const scriptPath = path.join(__dirname, '..', 'dist', 'app.js')
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath })
  await tick()
  await tick()

  assert.match(appElement.innerHTML, /old preview/)
  assert.doesNotMatch(appElement.innerHTML, /quiet-render/)
  assert.equal(typeof douyinEventListener, 'function')

  douyinEventListener({
    type: 'contacts',
    payload: { contacts: [{ id: 'Ada', name: 'Ada', preview: 'new preview' }] },
  })
  await tick()
  await tick()

  assert.match(appElement.innerHTML, /new preview/)
  assert.match(appElement.innerHTML, /quiet-render/)
})
