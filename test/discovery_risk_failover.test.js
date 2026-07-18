const assert = require('assert');
const config = require('../lib/data/config');
const globalVar = require('../lib/data/global_var');
const bili = require('../lib/net/bili');
const utils = require('../lib/utils');
const {
    buildDiscoveryAttempts,
    executeDiscoveryFailover,
} = require('../main');

const previousDiscoveryOnly = process.env.LOTTERY_DISCOVERY_ONLY;
const previousNumber = process.env.NUMBER;
const previousOwner = process.env.LOTTERY_DISCOVERY_OWNER_NUMBER;
process.env.LOTTERY_DISCOVERY_ONLY = '1';
config.discovery_risk_threshold = 3;
config.discovery_risk_cooldown = 120000;
config.discovery_risk_retry_wait = 3000;
bili._dynamicDetailCircuitBreaker.reset();
globalVar.set('discoveryRiskTripped', false);
globalVar.set('discoveryRiskInfo', null);

assert.strictEqual(bili.getDiscoveryRiskCode('{"code":-352,"message":"request rejected"}'), '-352');
assert.strictEqual(bili.getDiscoveryRiskCode('[响应错误]HTTP状态码: 412'), '412');
assert.strictEqual(bili.isDiscoveryRiskResponse('{"code":0,"data":{}}'), false);
assert.strictEqual(bili.recordDiscoveryRisk('{"code":-352}', '测试接口').opened, false);
assert.strictEqual(bili.recordDiscoveryRisk('{"code":-412}', '测试接口').opened, false);
const opened = bili.recordDiscoveryRisk('[响应错误]HTTP状态码: 412', '测试接口');
assert.strictEqual(opened.opened, true);
assert.strictEqual(globalVar.get('discoveryRiskTripped'), true);
assert.strictEqual(globalVar.get('discoveryRiskInfo').code, '412');
assert.strictEqual(bili.isDynamicDetailCircuitOpen(), true);
bili.recordDiscoverySuccess('测试接口');
assert.strictEqual(bili.isDynamicDetailCircuitOpen(), false);

process.env.NUMBER = '2';
process.env.LOTTERY_DISCOVERY_OWNER_NUMBER = '1';
assert.strictEqual(utils.lotteryInfoNumber(), 1);
assert.strictEqual(globalVar.resolveConfigAccountNumber(2, {
    LOTTERY_DISCOVERY_ONLY: '1',
    LOTTERY_DISCOVERY_OWNER_NUMBER: '1',
}), 1);
assert.strictEqual(globalVar.resolveConfigAccountNumber(2, {}), 2);

if (previousDiscoveryOnly === undefined) delete process.env.LOTTERY_DISCOVERY_ONLY;
else process.env.LOTTERY_DISCOVERY_ONLY = previousDiscoveryOnly;
if (previousNumber === undefined) delete process.env.NUMBER;
else process.env.NUMBER = previousNumber;
if (previousOwner === undefined) delete process.env.LOTTERY_DISCOVERY_OWNER_NUMBER;
else process.env.LOTTERY_DISCOVERY_OWNER_NUMBER = previousOwner;
bili._dynamicDetailCircuitBreaker.reset();
globalVar.set('discoveryRiskTripped', false);
globalVar.set('discoveryRiskInfo', null);

const accounts = [1, 2, 3, 4, 5].map(NUMBER => ({ NUMBER }));
assert.deepStrictEqual(
    buildDiscoveryAttempts(accounts, [2]).map(({ account, role }) => [account.NUMBER, role]),
    [[1, 'primary'], [1, 'primary-retry'], [2, 'backup']]
);

(async () => {
    const calls = [];
    const waits = [];
    const outcomes = [
        { committed: false, riskTripped: true },
        { committed: false, riskTripped: true },
        { committed: true, riskTripped: false },
    ];
    const completed = await executeDiscoveryFailover({
        attempts: buildDiscoveryAttempts(accounts, [2]),
        initialMode: 'collect',
        cooldown: 120000,
        wait: async milliseconds => waits.push(milliseconds),
        runAttempt: async attempt => {
            calls.push([attempt.account.NUMBER, attempt.role, attempt.mode]);
            return outcomes.shift();
        },
    });
    assert.strictEqual(completed.committed, true);
    assert.deepStrictEqual(calls, [
        [1, 'primary', 'collect'],
        [1, 'primary-retry', 'resume'],
        [2, 'backup', 'resume'],
    ]);
    assert.deepStrictEqual(waits, [120000, 120000]);

    let attempts = 0;
    const stopped = await executeDiscoveryFailover({
        attempts: buildDiscoveryAttempts(accounts, [2]),
        initialMode: 'collect',
        cooldown: 120000,
        wait: async () => {},
        runAttempt: async () => {
            attempts += 1;
            return { committed: false, riskTripped: attempts < 2 };
        },
    });
    assert.strictEqual(attempts, 2);
    assert.strictEqual(stopped.riskTripped, false);

    console.log('discovery risk failover tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
