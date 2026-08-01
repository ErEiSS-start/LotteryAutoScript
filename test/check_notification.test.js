const assert = require('assert');
const {
    enrichPrivateMessageRecords,
    identity,
    privateMessageDescription,
} = require('../lib/check');

async function run() {
    assert.strictEqual(identity('发信用户', '20002'), '发信用户（UID 20002）');
    assert.strictEqual(identity('', '20002'), '昵称暂未获取（UID 20002）');

    let resolverCalls = 0;
    const records = await enrichPrivateMessageRecords([{
        id: 'record-1',
        accountUid: '10001',
        accountName: '',
        senderUid: '20002',
        senderName: '',
        messageTimestamp: 100,
        content: '恭喜中奖，请填写地址',
        link: 'https://message.bilibili.com/#/whisper/mid20002',
        notifyCount: 0,
    }], '中奖帐号', {
        async resolveMany(uids) {
            resolverCalls += 1;
            assert.deepStrictEqual(uids, ['20002']);
            return { 20002: '发信用户' };
        },
    });

    assert.strictEqual(resolverCalls, 1);
    assert.strictEqual(records[0].senderName, '发信用户');
    assert.strictEqual(records[0].accountName, '中奖帐号');

    const description = privateMessageDescription(records);
    assert.match(description, /发信人: 发信用户（UID 20002）/);
    assert.match(description, /中奖账号: 中奖帐号（UID 10001）/);
    assert.match(description, /私信内容:\n恭喜中奖，请填写地址/);

    await enrichPrivateMessageRecords(records, '中奖帐号', {
        async resolveMany() {
            throw new Error('已有昵称时不应查询');
        },
    });
}

run().then(() => {
    console.log('check notification tests passed');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
