// Runtime persistence bridge for Render.
// The game currently stores users.json/messages.json with Node's fs API.
// This bridge redirects those two files to PERSISTENT_DATA_DIR so the
// existing account/friends/chat code can keep working without a rewrite.
const fs = require('fs');
const path = require('path');

const dataDir = process.env.PERSISTENT_DATA_DIR || '/var/data';
fs.mkdirSync(dataDir, { recursive: true });

const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);

function redirect(filePath) {
  if (typeof filePath !== 'string') return filePath;
  const base = path.basename(filePath);
  if (base === 'users.json' || base === 'messages.json') {
    return path.join(dataDir, base);
  }
  return filePath;
}

fs.readFileSync = (filePath, options) => originalReadFileSync(redirect(filePath), options);
fs.writeFileSync = (filePath, data, options) => originalWriteFileSync(redirect(filePath), data, options);

console.log('[persistence] data directory:', dataDir);
