const fs = require('fs');
const path = require('path');

const appData = process.env.APPDATA || 'C:\\Users\\Administrator\\AppData\\Roaming';
const baseDir = path.join(appData, 'douyin-reply-assistant');

console.log('=== Base Dir Contents ===');
if (fs.existsSync(baseDir)) {
  const files = fs.readdirSync(baseDir);
  for (const f of files) {
    const stat = fs.statSync(path.join(baseDir, f));
    console.log(`${stat.isDirectory() ? '[DIR] ' : '[FILE]'} ${f} (${(stat.size/1024).toFixed(1)} KB, mtime: ${stat.mtime.toLocaleString()})`);
  }
}

// Check logs directory if exists
const logDir = path.join(baseDir, 'logs');
if (fs.existsSync(logDir)) {
  console.log('\n=== Logs Directory ===');
  const files = fs.readdirSync(logDir);
  for (const f of files) {
    const stat = fs.statSync(path.join(logDir, f));
    console.log(`${f} (${(stat.size/1024).toFixed(1)} KB, mtime: ${stat.mtime.toLocaleString()})`);
  }
}

// Check accounts / configs
const configPath = path.join(baseDir, 'config.json');
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    console.log('\n=== Accounts in Config ===');
    console.log('Accounts count:', cfg.accounts ? cfg.accounts.length : 0);
    if (cfg.accounts) {
      cfg.accounts.forEach((acc, i) => {
        console.log(`Account [${i}]: id=${acc.id}, name=${acc.name || acc.nickname || 'unnamed'}, status=${acc.status}`);
      });
    }
  } catch (e) {
    console.log('Config read error:', e.message);
  }
}

// Check storage.json or accounts.json
for (const fname of ['storage.json', 'accounts.json', 'reply-history.json', 'audit.json']) {
  const fpath = path.join(baseDir, fname);
  if (fs.existsSync(fpath)) {
    const stat = fs.statSync(fpath);
    console.log(`\n=== Checking ${fname} === (mtime: ${stat.mtime.toLocaleString()})`);
    try {
      const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
      if (Array.isArray(data)) {
        console.log(`Item count: ${data.length}`);
        if (data.length > 0) {
          console.log('Latest item:', JSON.stringify(data[data.length - 1]).slice(0, 300));
        }
      } else if (typeof data === 'object') {
        console.log('Keys:', Object.keys(data));
      }
    } catch (e) {
      console.log('Parse error:', e.message);
    }
  }
}
