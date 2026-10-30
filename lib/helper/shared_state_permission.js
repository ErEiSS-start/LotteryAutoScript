const fs = require('fs');
const path = require('path');

// The viewer owns web_state. Share only its two input documents with that group;
// keep cookies, task results and other business files private.
function shareWithViewer(filename, registryDirectory = path.join(process.cwd(), 'web_state')) {
    if (process.platform === 'win32') return;
    const directory = fs.statSync(registryDirectory);
    const file = fs.statSync(filename);
    if (file.gid !== directory.gid) fs.chownSync(filename, file.uid, directory.gid);
    fs.chmodSync(filename, 0o640);
}

module.exports = { shareWithViewer };
