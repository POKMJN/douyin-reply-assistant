import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const sourceRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(sourceRoot, '..')
const stagingRoot = path.join(repoRoot, '.asar-build')
const outputPath = path.resolve(repoRoot, process.argv[2] || 'resources/app.asar')
const writesCandidateOnly = outputPath.endsWith('.new')
const candidatePath = writesCandidateOnly ? outputPath : `${outputPath}.new`

const runtimeFiles = ['package.json']
const distFiles = [
  'app.css',
  'app.js',
  'enhancements.css',
  'favicon.svg',
  'index.html',
  'app-icon.png',
  'tray-icon.png',
]

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

fs.rmSync(stagingRoot, { recursive: true, force: true })
fs.mkdirSync(stagingRoot, { recursive: true })

for (const file of runtimeFiles) {
  copyFile(path.join(sourceRoot, file), path.join(stagingRoot, file))
}

fs.cpSync(path.join(sourceRoot, 'electron'), path.join(stagingRoot, 'electron'), {
  recursive: true,
  filter: (entry) => !entry.endsWith('.map'),
})

for (const file of distFiles) {
  copyFile(path.join(sourceRoot, 'dist', file), path.join(stagingRoot, 'dist', file))
}

const appResources = path.join(sourceRoot, 'resources')
if (fs.existsSync(appResources) && fs.readdirSync(appResources).length) {
  fs.cpSync(appResources, path.join(stagingRoot, 'resources'), { recursive: true })
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.rmSync(candidatePath, { force: true })

const stagingArg = path.relative(repoRoot, stagingRoot)
const outputArg = path.relative(repoRoot, candidatePath)
const asarArgs = ['--yes', '@electron/asar', 'pack', stagingArg, outputArg]
const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npx'
const args = process.platform === 'win32'
  ? ['/d', '/c', `npx --yes @electron/asar pack ${stagingArg} ${outputArg}`]
  : asarArgs
const result = spawnSync(command, args, {
  cwd: repoRoot,
  encoding: 'utf8',
  windowsHide: true,
})

fs.rmSync(stagingRoot, { recursive: true, force: true })

if (result.status !== 0) {
  if (result.error) console.error(result.error.message)
  if (result.stdout) console.error(result.stdout)
  if (result.stderr) console.error(result.stderr)
  process.exit(result.status ?? 1)
}

let finalPath = candidatePath
if (!writesCandidateOnly) {
  try {
    fs.rmSync(outputPath, { force: true })
    fs.renameSync(candidatePath, outputPath)
    finalPath = outputPath
  } catch (error) {
    console.warn(`Could not replace ${path.relative(repoRoot, outputPath)}: ${error.message}`)
    console.warn(`Kept candidate package at ${path.relative(repoRoot, candidatePath)}`)
  }
}

const sizeMb = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(2)
console.log(`Packed ${path.relative(repoRoot, finalPath)} (${sizeMb} MB)`)
