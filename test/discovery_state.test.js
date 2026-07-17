const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    DiscoveryStateManager,
    buildDiscoveryPlan,
    normalizeDiscoveryMode,
} = require('../lib/helper/discovery_state');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-discovery-state-'));
let now = 2_000_000_000_000;
const config = {
    LotteryOrder: [2, 0, 0, 5],
    Articles: ['抽奖合集'],
    UIDs: [10001],
    CollectionUIDs: [20002],
    article_scan_page: 3,
    article_create_time: 30,
    uid_scan_page: 2,
    collection_uid_scan_page: 2,
    collection_dynamic_max_age_hours: 48,
    collection_dynamic_keywords: ['抽奖合集'],
    max_create_time: 60,
    check_if_duplicated: 1,
};

assert.strictEqual(normalizeDiscoveryMode(), 'collect');
assert.strictEqual(normalizeDiscoveryMode(' REUSE '), 'reuse');
assert.throws(() => normalizeDiscoveryMode('invalid'), /配置无效/);

const plan = buildDiscoveryPlan(config);
assert.strictEqual(plan.entries.length, 4);
assert.strictEqual(new Set(plan.entries.map(entry => entry.id)).size, 4);
assert.strictEqual(plan.entries[1].value, 10001);
assert.strictEqual(plan.entries[2].value, 10001);
assert.notStrictEqual(plan.entries[1].id, plan.entries[2].id);

const manager = new DiscoveryStateManager({ directory, now: () => now });
const fresh = manager.startFresh(config);
assert.strictEqual(fresh.pending.length, 4);
assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(directory, 'lottery_info_1.next.json'), 'utf8')),
    {}
);
fs.writeFileSync(
    path.join(directory, 'lottery_info_1.next.json'),
    JSON.stringify({ [plan.entries[0].id]: [] }),
    'utf8'
);
assert.strictEqual(manager.markCompleted(plan.entries[0].id), true);

const resumedManager = new DiscoveryStateManager({ directory, now: () => ++now });
const resumed = resumedManager.prepareResume(config);
assert.strictEqual(resumed.ok, true);
assert.deepStrictEqual(resumed.pending.map(entry => entry.id), plan.entries.slice(1).map(entry => entry.id));

const changedConfig = { ...config, uid_scan_page: 3 };
const mismatch = new DiscoveryStateManager({ directory }).prepareResume(changedConfig);
assert.strictEqual(mismatch.ok, false);
assert.match(mismatch.error, /签名不匹配/);

fs.writeFileSync(path.join(directory, 'lottery_info_1.next.json'), '{}', 'utf8');
const missingCompletedData = new DiscoveryStateManager({ directory }).prepareResume(config);
assert.strictEqual(missingCompletedData.ok, false);
assert.match(missingCompletedData.error, /缺少已完成来源/);

fs.writeFileSync(path.join(directory, 'lottery_info_1.next.json'), '{bad json', 'utf8');
const corrupt = new DiscoveryStateManager({ directory }).prepareResume(config);
assert.strictEqual(corrupt.ok, false);
assert.match(corrupt.error, /临时快照/);

manager.startFresh(config);
const validItem = { dyid: '1225299005006675986' };
fs.writeFileSync(
    path.join(directory, 'lottery_info_1.json'),
    JSON.stringify({ shared: [validItem] }),
    'utf8'
);
let reusable = manager.selectReusableSnapshot();
assert.strictEqual(reusable.valid, true);
assert.strictEqual(reusable.filename, 'lottery_info_1.json');
assert.strictEqual(reusable.fallback, undefined);

fs.writeFileSync(path.join(directory, 'lottery_info_1.json'), JSON.stringify({ shared: [] }), 'utf8');
fs.writeFileSync(
    path.join(directory, 'lottery_info_1.last-good.json'),
    JSON.stringify({ shared: [validItem] }),
    'utf8'
);
reusable = manager.selectReusableSnapshot();
assert.strictEqual(reusable.valid, true);
assert.strictEqual(reusable.filename, 'lottery_info_1.last-good.json');
assert.strictEqual(reusable.fallback, true);

fs.writeFileSync(path.join(directory, 'lottery_info_1.last-good.json'), '{}', 'utf8');
assert.strictEqual(manager.selectReusableSnapshot().valid, false);

resumedManager.finish();
assert.strictEqual(fs.existsSync(path.join(directory, 'lottery_info_1.discovery-state.json')), false);
fs.rmSync(directory, { recursive: true, force: true });

console.log('discovery state tests passed');
