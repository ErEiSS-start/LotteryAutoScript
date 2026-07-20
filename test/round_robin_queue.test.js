const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RoundRobinQueue } = require('../lib/helper/round_robin_queue');

(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-queue-'));
    const snapshotFilename = 'lottery_info_1.json';
    fs.writeFileSync(path.join(directory, snapshotFilename), JSON.stringify([{ dyid: '1' }, { dyid: '2' }]));
    let now = 1000;
    let builds = 0;
    const create = () => {
        builds += 1;
        return [{ dyid: '1' }, { dyid: '2' }];
    };
    const config = { key_words: ['抽奖'], ai_judge_parm: { prompt: 'v1' } };
    const first = new RoundRobinQueue({ account: 1, directory, now: () => now });
    assert.strictEqual((await first.loadOrCreate({ snapshotFilename, config, createCandidates: create })).created, true);
    assert.strictEqual(first.remaining, 2);
    first.complete('1', 'successful');
    assert.strictEqual(first.remaining, 1);

    const resumed = new RoundRobinQueue({ account: 1, directory, now: () => now });
    assert.strictEqual((await resumed.loadOrCreate({ snapshotFilename, config, createCandidates: create })).created, false);
    assert.strictEqual(resumed.remaining, 1);
    assert.strictEqual(builds, 1, '有效队列续接时不得重新筛选');
    resumed.defer('2');
    assert.strictEqual(resumed.summary().deferred, 1);

    now += 1;
    fs.writeFileSync(path.join(directory, snapshotFilename), JSON.stringify([{ dyid: '3' }]));
    const replaced = new RoundRobinQueue({ account: 1, directory, now: () => now });
    assert.strictEqual((await replaced.loadOrCreate({
        snapshotFilename,
        config,
        createCandidates: () => [{ dyid: '3' }],
    })).created, true);
    assert.deepStrictEqual(replaced.pending.map(item => item.dyid), ['3']);
    assert(fs.readdirSync(directory).some(file => file.includes('.stale-')), '快照变化时应保留旧队列备份');

    fs.rmSync(directory, { recursive: true, force: true });
    console.log('round_robin_queue.test ... ok!');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
