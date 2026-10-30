const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeLocalAccountRegistry } = require('../lib/helper/local_account_registry');
const { PendingWinStore } = require('../lib/helper/pending_win_store');

if (process.platform !== 'win32') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-permissions-'));
    const oldMask = process.umask(0o077);
    try {
        const registry = path.join(root, 'web_state', 'local-accounts.json');
        const pending = path.join(root, 'lottery_info', 'pending_wins_123.json');
        for (let iteration = 0; iteration < 2; iteration++) {
            writeLocalAccountRegistry([{ COOKIE: 'DedeUserID=123;', NUMBER: 1 }], { filePath: registry });
            const store = new PendingWinStore({accountUid: '123', accountNumber: 1,
                filePath: pending, logger: {warn(message) { throw new Error(message); }}});
            assert.strictEqual(store.save(), true);
            for (const filename of [registry, pending]) {
                const stat = fs.statSync(filename);
                assert.strictEqual(stat.mode & 0o777, 0o640);
                assert.strictEqual(stat.gid, fs.statSync(path.dirname(registry)).gid);
                JSON.parse(fs.readFileSync(filename, 'utf8'));
            }
            if (iteration === 0 && process.getuid() === 0) {
                // Simulate a viewer-owned group distinct from the task's group.
                fs.chownSync(path.dirname(registry), process.getuid(), process.getgid() + 1);
            }
        }
    } finally {
        process.umask(oldMask);
        fs.rmSync(root, {recursive: true, force: true});
    }
}
console.log('shared state permission tests passed');
