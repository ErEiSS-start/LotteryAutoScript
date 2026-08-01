const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProfileResolver } = require('../lib/helper/profile_resolver');

async function run() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-profile-cache-'));
    const cacheFile = path.join(directory, 'profile-cache.json');
    let requests = 0;
    const resolver = createProfileResolver({
        cacheFile,
        fetchName: async uid => {
            requests += 1;
            return uid === '20002' ? '发信用户' : '中奖帐号';
        },
        logger: { warn() {} },
    });

    assert.deepStrictEqual(await resolver.resolveMany(['20002', '10001']), {
        10001: '中奖帐号',
        20002: '发信用户',
    });
    assert.strictEqual(requests, 2);
    assert.strictEqual((await resolver.resolveMany(['20002']))['20002'], '发信用户');
    assert.strictEqual(requests, 2, '30天缓存有效期内不应重复查询昵称');

    const reloaded = createProfileResolver({
        cacheFile,
        fetchName: async () => {
            throw new Error('磁盘缓存存在时不应联网');
        },
        logger: { warn() {} },
    });
    assert.strictEqual((await reloaded.resolveMany(['10001']))['10001'], '中奖帐号');
    fs.rmSync(directory, { recursive: true, force: true });
}

run().then(() => {
    console.log('profile resolver tests passed');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
