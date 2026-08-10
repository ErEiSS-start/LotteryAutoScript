const assert = require('assert');
const {
    enrichPrivateMessageRecords,
    getSessionInfoWithRetry,
    identity,
    isWinnerMessage,
    privateMessageDescription,
} = require('../lib/check');

async function run() {
    assert.strictEqual(identity('发信用户', '20002'), '发信用户（UID 20002）');
    assert.strictEqual(identity('', '20002'), '昵称暂未获取（UID 20002）');
    const keywords = ['中奖|获得|填写|提供|收货地址|支付宝账号|码|大会员'];
    assert.strictEqual(
        isWinnerMessage('恭喜您中奖，请填写收货地址', keywords),
        true
    );
    assert.strictEqual(
        isWinnerMessage('预约成功，并参与了抽奖\n奖品: 月度大会员', keywords),
        false
    );
    assert.strictEqual(
        isWinnerMessage('【有奖调研】诚邀你参与调研，完成后可能发放奖品', keywords),
        false
    );
    assert.strictEqual(
        isWinnerMessage('【有奖活动】完成拼图可以获得奖励，点击链接即刻参与活动', keywords),
        false
    );
    assert.strictEqual(
        isWinnerMessage('恭喜你在本次有奖活动中中奖，请联系工作人员领奖', keywords),
        true,
        '明确中奖信号必须优先于活动邀请屏蔽词'
    );

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

    let attempts = 0;
    const waits = [];
    const retried = await getSessionInfoWithRetry('1', 'cursor', {
        client: {
            async getSessionInfo(type, cursor) {
                attempts += 1;
                assert.strictEqual(type, '1');
                assert.strictEqual(cursor, 'cursor');
                if (attempts < 3) return { has_more: 0, data: [], errorCode: -509 };
                return { has_more: 0, data: [{ talker_id: 20002 }] };
            },
        },
        delayFn: async waitMs => { waits.push(waitMs); },
        logger: { warn() {} },
        baseWaitMs: 1000,
    });
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(waits, [1000, 2000]);
    assert.strictEqual(retried.data.length, 1);

    attempts = 0;
    await getSessionInfoWithRetry('2', '', {
        client: {
            async getSessionInfo() {
                attempts += 1;
                return { has_more: 0, data: [], errorCode: -101 };
            },
        },
        delayFn: async () => {},
        logger: { warn() {} },
    });
    assert.strictEqual(attempts, 1, '非-509错误不得机械重试');
}

run().then(() => {
    console.log('check notification tests passed');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
