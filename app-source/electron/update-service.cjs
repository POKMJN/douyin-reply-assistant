// 在线检查更新：查询 GitHub Releases 最新版本，供前端“检查更新”与引导下载使用。
const https = require('node:https')

const REPO = 'POKMJN/douyin-reply-assistant'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`

// 'v0.5.0' / '0.5.0' -> [0, 5, 0]；无法解析返回 null
function parseVersion(tag) {
  const match = String(tag || '').match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

// 远端 tag 是否比当前版本新（依次比较主、次、修订号）
function isNewer(remoteTag, currentVersion) {
  const remote = parseVersion(remoteTag)
  const local = parseVersion(currentVersion)
  if (!remote || !local) return false
  for (let i = 0; i < 3; i += 1) {
    if (remote[i] > local[i]) return true
    if (remote[i] < local[i]) return false
  }
  return false
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.request(LATEST_URL, {
      method: 'GET',
      headers: {
        'User-Agent': 'douyin-reply-assistant-updater',
        Accept: 'application/vnd.github+json',
      },
      timeout: 15000,
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`检查更新失败（GitHub 返回 HTTP ${res.statusCode}）`))
          return
        }
        try {
          const release = JSON.parse(data)
          const asset = (release.assets || []).find((item) => /\.exe$/i.test(item.name))
          resolve({
            tag: release.tag_name,
            name: release.name,
            body: release.body || '',
            url: release.html_url,
            assetUrl: asset?.browser_download_url || '',
          })
        } catch {
          reject(new Error('检查更新失败（无法解析更新信息）'))
        }
      })
    })
    req.on('error', () => reject(new Error('检查更新失败（网络异常）')))
    req.setTimeout(15000, () => { req.destroy(new Error('检查更新失败（请求超时）')) })
    req.end()
  })
}

// currentVersion 来自 app.getVersion()（如 '0.5.0'）
async function checkUpdate(currentVersion) {
  const release = await fetchLatestRelease()
  const hasUpdate = isNewer(release.tag, currentVersion)
  return {
    hasUpdate,
    currentVersion,
    latestVersion: release.tag,
    releaseName: release.name,
    notes: hasUpdate ? release.body : '',
    releaseUrl: release.url,
    assetUrl: hasUpdate ? release.assetUrl : '',
  }
}

module.exports = { checkUpdate, isNewer, parseVersion }
