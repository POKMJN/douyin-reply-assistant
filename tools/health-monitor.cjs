const fs = require('fs')
const path = require('path')
const cp = require('child_process')

function getProcesses() {
  try {
    const script = `Get-Process -Name '抖音回复助手' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id):$($_.WorkingSet64):$($_.Responding)" }`
    const b64 = Buffer.from(script, 'utf16le').toString('base64')
    const output = cp.execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`).toString().trim()
    if (!output) return []
    return output.split(/\r?\n/).map(l => l.trim()).filter(l => l.includes(':')).map(line => {
      const [id, ws, resp] = line.split(':')
      return {
        id: Number(id),
        workingSetMB: Number((Number(ws) / (1024 * 1024)).toFixed(2)),
        responding: resp === 'True'
      }
    })
  } catch {
    return []
  }
}

function checkAccounts() {
  const accRoot = path.join(process.env.APPDATA || '', 'douyin-reply-assistant', 'accounts')
  const accountsInfo = []
  if (!fs.existsSync(accRoot)) return accountsInfo

  const dirs = fs.readdirSync(accRoot)
  for (const dir of dirs) {
    const stateFile = path.join(accRoot, dir, 'state.json')
    if (!fs.existsSync(stateFile)) continue
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      const logs = Array.isArray(state.logs) ? state.logs : []
      const errors = logs.filter(l => /error|crash|fail/i.test(l.type))
      const sent = Array.isArray(state.sendHistory) ? state.sendHistory : []
      const lastSent = sent.slice(0, 3)
      const lastLogs = logs.slice(0, 3)

      accountsInfo.push({
        id: dir,
        autoReply: state.automation?.autoReply,
        paused: state.automation?.paused,
        totalLogs: logs.length,
        errorCount: errors.length,
        recentErrors: errors.slice(0, 2),
        recentLogs: lastLogs,
        recentSent: lastSent
      })
    } catch (e) {
      accountsInfo.push({ id: dir, error: e.message })
    }
  }
  return accountsInfo
}

function runMonitor() {
  const procs = getProcesses()
  const totalMemMB = procs.reduce((sum, p) => sum + p.workingSetMB, 0)
  const accounts = checkAccounts()

  const report = {
    timestamp: new Date().toISOString(),
    localTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    processes: {
      count: procs.length,
      totalMemoryMB: Number(totalMemMB.toFixed(2)),
      allResponding: procs.every(p => p.responding),
      list: procs
    },
    accounts
  }

  console.log('=====================================================')
  console.log(`🕒 抖音回复助手运行巡检 [${report.localTime}]`)
  console.log('-----------------------------------------------------')
  console.log(`📊 进程状态: 共 ${report.processes.count} 个进程 | 物理工作集: ${report.processes.totalMemoryMB} MB | 响应状态: ${report.processes.allResponding ? '✅ 全部正常' : '⚠️ 存在未响应'}`)
  procs.forEach(p => console.log(`   - PID ${p.id}: ${p.workingSetMB} MB [${p.responding ? 'Responding' : 'Not Responding'}]`))
  
  console.log('-----------------------------------------------------')
  accounts.forEach(acc => {
    console.log(`👤 账号 [${acc.id}] | 自动回复: ${acc.autoReply ? '开启' : '关闭'} | 运行暂停: ${acc.paused ? '是' : '否'}`)
    if (acc.recentErrors && acc.recentErrors.length > 0) {
      console.log(`   ⚠️ 异常日志 (${acc.errorCount} 条):`)
      acc.recentErrors.forEach(e => console.log(`      [${e.at}] (${e.type}) ${e.message}`))
    } else {
      console.log(`   ✅ 状态正常，无未捕获异常`)
    }
    if (acc.recentLogs && acc.recentLogs.length > 0) {
      console.log('   📝 最近运行动态:')
      acc.recentLogs.forEach(l => console.log(`      [${l.at}] (${l.type}) ${l.message}`))
    }
    if (acc.recentSent && acc.recentSent.length > 0) {
      console.log('   💬 最近回复互动:')
      acc.recentSent.forEach(s => console.log(`      -> 给 [${s.name}]: ${s.text || s.preview || ''} (${s.at})`))
    }
  })
  console.log('=====================================================')
  return report
}

if (require.main === module) {
  runMonitor()
}

module.exports = { runMonitor }
