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

const ignored = store.ignoreWhere(
    record => record.content.includes('预约成功'),
    'test-non-winner'
);
assert.strictEqual(ignored.length, 0, '真实中奖记录不得被无关过滤条件归档');
const falsePositive = store.add({
    talkerId: '30003',
    senderUid: '30003',
    messageSequence: '20',
    messageTimestamp: 200,
    content: '预约成功，并参与了抽奖',
});
assert.strictEqual(falsePositive.created, true);
assert.strictEqual(store.ignoreWhere(
    record => record.content.includes('预约成功'),
    'filtered-non-winner-message'
).length, 1);
assert.strictEqual(store.pending().length, 1, '被归档的误报不得继续进入待提醒列表');
assert.strictEqual(
    JSON.parse(fs.readFileSync(filePath, 'utf8')).records.find(record => record.id === falsePositive.record.id).status,
    'ignored',
    '误报归档状态必须持久化'
);

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

const reviewFilePath = path.join(directory, 'review.json');
const reviewStore = new PendingWinStore({
    accountUid: '40004',
    accountNumber: 4,
    filePath: reviewFilePath,
    now: () => now,
    logger,
    dismissedFilePath: path.join(directory, 'web_state', 'review-dismissed.json'),
});
const legacyWeakRecord = reviewStore.add({
    talkerId: '50005',
    senderUid: '50005',
    messageSequence: '30',
    messageTimestamp: 300,
    content: '您的大会员兑换码为 ABCD-1234',
});
reviewStore.markNotified([legacyWeakRecord.record.id]);
const migrated = reviewStore.reclassify(record => (
    record.content.includes('兑换码') ? 'review' : 'winner'
));
assert.strictEqual(migrated.review.length, 1, '旧弱关键词记录应迁移为待确认');
assert.strictEqual(reviewStore.pending().length, 0);
assert.strictEqual(reviewStore.reviews().length, 1);
assert.strictEqual(reviewStore.dueReviews().length, 0, '已经提醒过的旧记录迁移后不得再次推送');

const newReview = reviewStore.add({
    talkerId: '60006',
    senderUid: '60006',
    messageSequence: '40',
    messageTimestamp: 400,
    content: '请核对这条疑似中奖消息',
    status: 'review',
});
assert.strictEqual(newReview.record.status, 'review');
assert.strictEqual(reviewStore.dueReviews().length, 1, '新疑似记录只能进入首次提醒队列');
reviewStore.markNotified([newReview.record.id]);
assert.strictEqual(reviewStore.dueReviews().length, 0, '疑似记录提醒一次后不得重复提醒');

const ignoredReview = reviewStore.reclassify(record => (
    record.id === newReview.record.id ? 'ignored' : 'review'
));
assert.strictEqual(ignoredReview.ignored.length, 1);
assert.strictEqual(reviewStore.reviews().length, 1, '归档误报不得继续出现在待确认列表');
fs.rmSync(directory, { recursive: true, force: true });
