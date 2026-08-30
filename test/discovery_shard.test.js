const assert = require('assert');
const globalVar = require('../lib/data/global_var');
const { accountName, instanceName } = require('../lib/utils');

assert.strictEqual(
    globalVar.resolveConfigAccountNumber(5, {
        LOTTERY_DISCOVERY_ONLY: '1',
        LOTTERY_DISCOVERY_CONFIG_NUMBER: '1',
    }),
    1
);
assert.strictEqual(
    globalVar.resolveConfigAccountNumber(5, {
        LOTTERY_DISCOVERY_ONLY: '1',
        LOTTERY_DISCOVERY_CONFIG_NUMBER: '',
    }),
    5
);
assert.strictEqual(
    globalVar.resolveConfigAccountNumber(5, {
        LOTTERY_DISCOVERY_CONFIG_NUMBER: '1',
    }),
    5
);

const shardConfig = {
    APIs: [
        'file://lottery_info_1.json',
        'file://lottery_info_2.json',
        'https://example.invalid/lottery.json',
    ],
};
globalVar.remapDiscoveryFileApis(shardConfig, {
    LOTTERY_DISCOVERY_ONLY: '1',
    LOTTERY_DISCOVERY_CONFIG_NUMBER: '1',
    LOTTERY_DISCOVERY_OWNER_NUMBER: '5',
});
assert.deepStrictEqual(shardConfig.APIs, [
    'file://lottery_info_5.json',
    'file://lottery_info_2.json',
    'https://example.invalid/lottery.json',
]);

assert.strictEqual(instanceName({ LOTTERY_INSTANCE_NAME: ' 副服务器 ' }), '副服务器');
assert.strictEqual(accountName(5, { LOTTERY_INSTANCE_NAME: '副服务器' }), '副服务器 帐号5');
assert.strictEqual(accountName(1, {}), '帐号1');

console.log('discovery shard tests passed');
