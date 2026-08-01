const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    PendingWinStore,
    isReplyAfter,
    messageText,
} = require('../lib/helper/pending_win_store');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-pending-wins-'));
const filePath = path.join(directory, 'pending.json');
const dismissedFilePath = path.join(directory, 'web_state', 'dismissed-wins.json');
let now = Date.parse('2026-07-29T00:00:00+08:00');
const logger = { warn() {} };
const store = new PendingWinStore({
    accountUid: '10001',
    accountNumber: 1,
    filePath,
    now: () => now,
    logger,
    dismissedFilePath,
});

assert.strictEqual(messageText('{"content":"请填写地址"}'), '请填写地址');
assert.strictEqual(
    isReplyAfter(
        { messageSequence: '10', messageTimestamp: 100 },
        { sender_uid: 10001, msg_seqno: 11, timestamp: 101, content: '{"content":"收到"}' },
        '10001'
    ),
    true
);
assert.strictEqual(
    isReplyAfter(
        { messageSequence: '10', messageTimestamp: 100 },
        { sender_uid: 20002, msg_seqno: 11, timestamp: 101, content: '{"content":"请回复"}' },
        '10001'
    ),
    false
);

const added = store.add({
    talkerId: '20002',
    senderUid: '20002',
    senderName: '发信用户',
    accountName: '中奖帐号',
    messageSequence: '10',
    messageTimestamp: 100,
    content: '{"content":"恭喜中奖，请填写地址"}',
    link: 'https://message.bilibili.com/#/whisper/mid20002',
});
assert.strictEqual(added.created, true);
assert.strictEqual(added.record.senderName, '发信用户');
assert.strictEqual(added.record.accountName, '中奖帐号');
assert.strictEqual(store.add({
    talkerId: '20002',
    senderUid: '20002',
    messageSequence: '10',
    messageTimestamp: 100,
    content: '{"content":"恭喜中奖，请填写地址"}',
}).created, false);
assert.strictEqual(store.pending().length, 1);
assert.strictEqual(store.due(2 * 60 * 60 * 1000).length, 1);

fs.mkdirSync(path.dirname(dismissedFilePath), { recursive: true });
fs.writeFileSync(dismissedFilePath, JSON.stringify({
    version: 1,
    records: [{
        accountUid: '10001',
        recordId: added.record.id,
        dismissedAt: now,
    }],
}));
assert.strictEqual(store.pending().length, 0, 'Web 账本中的记录应立即停止提醒');
assert.strictEqual(store.due(0).length, 0);

fs.writeFileSync(dismissedFilePath, JSON.stringify({ version: 1, records: [] }));
assert.strictEqual(store.pending().length, 1, '从 Web 账本恢复后应立即重新进入待提醒');

fs.writeFileSync(dismissedFilePath, '{broken');
assert.strictEqual(store.pending().length, 1, '取消提醒账本损坏时应 fail-open，避免漏报中奖');
fs.writeFileSync(dismissedFilePath, JSON.stringify({ version: 1, records: [] }));

store.markNotified([added.record.id]);
now += 60 * 60 * 1000;
assert.strictEqual(store.due(2 * 60 * 60 * 1000).length, 0);
now += 60 * 60 * 1000;
assert.strictEqual(store.due(2 * 60 * 60 * 1000).length, 1);

const reloaded = new PendingWinStore({
    accountUid: '10001',
    accountNumber: 1,
    filePath,
    now: () => now,
    logger,
    dismissedFilePath,
});
assert.strictEqual(reloaded.pending().length, 1, '待领取记录应跨进程保留');
assert.strictEqual(reloaded.acknowledgeByMessages('20002', [{
    sender_uid: '10001',
    msg_seqno: '11',
    timestamp: 101,
    content: '{"content":"已回复领取信息"}',
}], '10001').length, 1);
assert.strictEqual(reloaded.pending().length, 0);

const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
assert.strictEqual(persisted.records[0].status, 'acknowledged');
fs.rmSync(directory, { recursive: true, force: true });
