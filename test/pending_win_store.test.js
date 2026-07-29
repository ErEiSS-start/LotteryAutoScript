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
let now = Date.parse('2026-07-29T00:00:00+08:00');
const logger = { warn() {} };
const store = new PendingWinStore({
    accountUid: '10001',
    accountNumber: 1,
    filePath,
    now: () => now,
    logger,
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
    messageSequence: '10',
    messageTimestamp: 100,
    content: '{"content":"恭喜中奖，请填写地址"}',
    link: 'https://message.bilibili.com/#/whisper/mid20002',
});
assert.strictEqual(added.created, true);
assert.strictEqual(store.add({
    talkerId: '20002',
    senderUid: '20002',
    messageSequence: '10',
    messageTimestamp: 100,
    content: '{"content":"恭喜中奖，请填写地址"}',
}).created, false);
assert.strictEqual(store.pending().length, 1);
assert.strictEqual(store.due(2 * 60 * 60 * 1000).length, 1);

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
