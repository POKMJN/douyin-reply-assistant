// QA 测试桩：替代 require('electron')，让主进程模块可在纯 Node 中加载。
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`stub:${text}`, 'utf8'),
  decryptString: (buf) => {
    const s = buf.toString('utf8')
    return s.startsWith('stub:') ? s.slice(5) : ''
  },
}

module.exports = new Proxy({ safeStorage }, {
  get(target, prop) {
    if (prop in target) return target[prop]
    return function StubClass() {}
  },
})
