// 一次性改造脚本 v4：NEW_RUN 抽成外部模板 + 对齐注入锚点缩进
const fs = require('node:fs')
const path = require('node:path')
const p = path.join(__dirname, 'build-automation.cjs')
const original = fs.readFileSync(p, 'utf8')
const lines = original.split('\n')

// ---- 1) NEW_RUN 字面量 → 外部模板文件 ----
if (!lines[131].startsWith('const NEW_RUN = `')) throw new Error('L132 不是 NEW_RUN 起点')
if (lines[549] !== '`') throw new Error('L550 不是 NEW_RUN 终点')
lines.splice(131, 550 - 132 + 1, "const NEW_RUN = fs.readFileSync(path.join(__dirname, 'run-automation.template.cjs'), 'utf8')")

// 统一去 4 空格：兼容"行首反引号"（模板字符串起始行）与普通行
const dedent4 = (line) => {
  const m = line.match(/^(\s*[`"]?)( {4})/)
  if (!m) throw new Error('缩进异常: ' + JSON.stringify(line.slice(0, 48)))
  return line.slice(0, m[1].length) + line.slice(m[1].length + 4)
}
const normalize = (l) => l.trim().replace(/^`/, '').replace(/`,?$/, '').trim()

const SEND_HEAD = 'await this.sendMessage(contact.name, replyText, aiMeta)'
const SEND_TAIL_PREFIX = 'this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))'

// ---- 2) 两处发送块：12 → 8 空格 ----
const heads = []
lines.forEach((l, i) => { if (normalize(l) === SEND_HEAD) heads.push(i) })
if (heads.length !== 2) throw new Error(`发送块数量异常：${heads.length}（期望 2）`)
for (const head of heads) {
  let end = -1
  for (let i = head; i < lines.length; i += 1) {
    if (normalize(lines[i]).startsWith(SEND_TAIL_PREFIX)) { end = i; break }
  }
  if (end < 0) throw new Error('发送块尾部未找到')
  for (let i = head; i <= end; i += 1) lines[i] = dedent4(lines[i])
  console.log(`发送块去缩进：第 ${head + 1}–${end + 1} 行`)
}

// ---- 3) 双消息注入体：整段去 4 空格 ----
const followStart = lines.findIndex((l) => l.includes('// 双消息（允许而非必须）：模型补了第二条随口话时紧跟发出'))
if (followStart < 0) throw new Error('双消息注入体起点未找到')
let followEnd = -1
for (let i = followStart; i < lines.length; i += 1) {
  if (normalize(lines[i]) === '}') { followEnd = i; break }
}
if (followEnd < 0) throw new Error('双消息注入体终点未找到')
for (let i = followStart; i <= followEnd; i += 1) lines[i] = dedent4(lines[i])
console.log(`双消息注入体去缩进：第 ${followStart + 1}–${followEnd + 1} 行`)

// ---- 4) 草稿锚点与替换文本：14 → 10 ----
let draftCount = 0
for (let i = 0; i < lines.length; i += 1) {
  if (!lines[i].includes('drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText')) continue
  lines[i] = dedent4(lines[i])
  draftCount += 1
}
if (draftCount !== 2) throw new Error(`草稿锚点数量异常：${draftCount}（期望 2）`)

const out = lines.join('\n')
fs.writeFileSync(p, out, 'utf8')
console.log('build-automation.cjs 改造完成，新行数:', out.split('\n').length)
