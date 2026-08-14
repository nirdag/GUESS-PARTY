const fs = require('fs');
const cov = JSON.parse(fs.readFileSync('coverage/coverage-final.json', 'utf8'));

for (const [filePath, data] of Object.entries(cov)) {
  const fileName = filePath.replace(/.*guess-party[\\\/]/, '');
  console.log(`\nFile: ${fileName}`);
  
  const fnMap = data.fnMap;
  const f = data.f;
  
  if (!fnMap || Object.keys(fnMap).length === 0) {
    console.log('No functions declared.');
    continue;
  }
  
  for (const [key, fn] of Object.entries(fnMap)) {
    const name = fn.name || '(anonymous)';
    const count = f[key] || 0;
    const covered = count > 0;
    console.log(`- Function: "${name}" at line ${fn.decl.start.line}, Covered: ${covered ? 'Yes (' + count + ' calls)' : 'No'}`);
  }
}
