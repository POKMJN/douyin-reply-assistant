// 测试跑批器：完整套件连续运行 N 轮（默认 12 轮），任一轮失败即终止并报告
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const ROUNDS = Number(process.env.ROUNDS || 12)
const suiteDir = __dirname
const testFiles = require('node:fs').readdirSync(suiteDir).filter((f) => f.endsWith('.test.cjs')).map((f) => path.join(suiteDir, f))

let allPass = true
for (let round = 1; round <= ROUNDS; round += 1) {
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  const passMatch = output.match(/ℹ pass (\d+)/) || output.match(/pass (\d+)/)
  const failMatch = output.match(/ℹ fail (\d+)/) || output.match(/fail (\d+)/)
  const pass = Number(passMatch?.[1] || 0)
  const fail = Number(failMatch?.[1] || 0)
  if (result.status !== 0 || fail > 0) {
    allPass = false
    console.log(`第 ${round} 轮：❌ 失败（pass=${pass} fail=${fail}）`)
    console.log(output.slice(-4000))
    break
  }
  console.log(`第 ${round} 轮：✅ 全部通过（${pass} tests）`)
}

if (!allPass) {
  console.error('\n测试未全部通过，禁止部署')
  process.exit(1)
}
console.log(`\n${ROUNDS} 轮全部通过 ✅`)
