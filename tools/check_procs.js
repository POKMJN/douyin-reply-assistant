const { execSync } = require('child_process');

try {
  const stdout = execSync('tasklist /FI "IMAGENAME eq 抖音回复助手.exe" /FO CSV /NH', { encoding: 'utf-8' });
  const lines = stdout.trim().split('\r\n').filter(Boolean);
  let totalMemKb = 0;
  console.log(`Process Count: ${lines.length}`);
  lines.forEach(line => {
    // format: "抖音回复助手.exe","5104","Console","1","52,488 K"
    const match = line.match(/"([^"]+)","(\d+)","([^"]*)","([^"]*)","([\d,]+)\s*K"/);
    if (match) {
      const pid = match[2];
      const memKb = parseInt(match[5].replace(/,/g, ''), 10);
      totalMemKb += memKb;
      console.log(`PID: ${pid} | Mem: ${(memKb / 1024).toFixed(2)} MB`);
    } else {
      console.log('Line:', line);
    }
  });
  console.log(`Total Working Set: ${(totalMemKb / 1024).toFixed(2)} MB`);
} catch (e) {
  console.error('Error running tasklist:', e.message);
}
