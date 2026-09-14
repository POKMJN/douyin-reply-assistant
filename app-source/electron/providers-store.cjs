const fs = require('node:fs')
const path = require('node:path')

// 全账号共享的模型接口存储：providers.json 位于 userData 根目录。
// 所有账号读写同一份列表，实现模型列表全账号通用；写入采用临时文件 + 原子重命名。
class SharedProvidersStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'providers.json')
    this.providers = []
    this.reload()
  }

  reload() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      this.providers = Array.isArray(raw.providers) ? raw.providers.filter((item) => item && item.name) : []
    } catch {
      this.providers = []
    }
    return this.get()
  }

  get() {
    return structuredClone(this.providers)
  }

  save(providers) {
    this.providers = Array.isArray(providers) ? providers.filter((item) => item && item.name) : []
    const tempPath = `${this.filePath}.tmp`
    try {
      fs.writeFileSync(tempPath, JSON.stringify({ providers: this.providers }), 'utf8')
      fs.renameSync(tempPath, this.filePath)
    } catch (writeError) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch { /* 清理失败忽略 */ }
      throw writeError
    }
    return this.get()
  }

  // 把各账号 state.json 里的接口合并进共享存储（幂等）：
  // 已在共享文件中的条目优先保留；账号文件里同名但共享文件缺失的按传入顺序补入。
  mergeFrom(sources) {
    const byName = new Map(this.providers.map((item) => [item.name, item]))
    for (const list of sources) {
      for (const provider of (Array.isArray(list) ? list : [])) {
        if (!provider?.name || byName.has(provider.name)) continue
        byName.set(provider.name, provider)
      }
    }
    return this.save([...byName.values()])
  }
}

module.exports = { SharedProvidersStore }
