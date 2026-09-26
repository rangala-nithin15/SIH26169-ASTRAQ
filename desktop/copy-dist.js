// Copies the production web build (../web/dist) into ./app for packaging.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'web', 'dist');
const dst = path.join(__dirname, 'app');
if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('web/dist not found — run "npm run build" in ../web first.');
  process.exit(1);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log('copied web/dist → desktop/app');
