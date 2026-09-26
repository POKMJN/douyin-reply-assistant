const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. Process and memory
let processStats = { count: 0, totalWsMb: 0, procs: [] };
try {
  const psOutput = execSync('powershell -NoProfile -Command "Get-Process -Name \'抖音回复助手\' -ErrorAction SilentlyContinue | Select-Object Id, WorkingSet64 | ConvertTo-Json"', { encoding: 'utf-8' });
  const parsed = JSON.parse(psOutput.trim());
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  let totalBytes = 0;
  for (const item of arr) {
    if (item && item.WorkingSet64) {
      totalBytes += item.WorkingSet64;
      processStats.procs.push({ pid: item.Id, wsMb: (item.WorkingSet64 / 1024 / 1024).toFixed(2) });
    }
  }
  processStats.count = processStats.procs.length;
  processStats.totalWsMb = (totalBytes / 1024 / 1024).toFixed(2);
} catch (e) {
  processStats.err = e.message;
}
console.log('=== PROCESS & MEMORY ===');
console.log(JSON.stringify(processStats, null, 2));

// 2. Data directory and logs
const appData = process.env.APPDATA || 'C:\\Users\\Administrator\\AppData\\Roaming';
const assistantDataDir = path.join(appData, 'douyin-reply-assistant');
console.log('\n=== ASSISTANT DATA DIR ===', assistantDataDir);

const logSummary = [];
function findLogs(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      findLogs(full);
    } else if (ent.name.endsWith('.log') || ent.name.endsWith('.json')) {
      const stat = fs.statSync(full);
      // check if modified recently (e.g. within 6 hours)
      const now = Date.now();
      const ageHours = (now - stat.mtimeMs) / (1000 * 3600);
      if (ageHours < 12) {
        logSummary.push({ file: full, size: stat.size, mtime: stat.mtime.toISOString(), ageHours: ageHours.toFixed(2) });
      }
    }
  }
}

findLogs(assistantDataDir);
console.log('\n=== RECENT LOGS / FILES ===');
console.log(JSON.stringify(logSummary, null, 2));

// 3. Inspect recent log contents for errors or reply quality
console.log('\n=== LOG DETAILS & ERRORS (14:00 - 15:00) ===');
for (const item of logSummary) {
  if (item.file.endsWith('.log')) {
    try {
      const content = fs.readFileSync(item.file, 'utf-8');
      const lines = content.split('\n');
      const recentLines = lines.slice(-100);
      const errors = recentLines.filter(l => /error|warn|fail|err|异常|超时|失败/i.test(l));
      console.log(`Log: ${path.basename(item.file)} - Total lines: ${lines.length}, Recent matching errors/warnings: ${errors.length}`);
      if (errors.length > 0) {
        console.log('Sample errors:', errors.slice(-5).join('\n'));
      }
    } catch (e) {
      console.log('Error reading log:', item.file, e.message);
    }
  }
}
