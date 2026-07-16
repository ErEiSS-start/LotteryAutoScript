const assert = require('assert');
const { isRecentCollectionDynamic } = require('../lib/core/searcher');
const { Monitor, normalizeAiComment, selectUniqueCommentFallback } = require('../lib/core/monitor');
const { resolveRedirectUrl } = require('../lib/net/http');
const bili = require('../lib/net/bili');

const now = 2_000_000_000;
assert.strictEqual(
    isRecentCollectionDynamic({ create_time: now - 47 * 60 * 60 }, now, 48),
    true
);
assert.strictEqual(
    isRecentCollectionDynamic({ create_time: now - 49 * 60 * 60 }, now, 48),
    false
);
assert.strictEqual(isRecentCollectionDynamic({}, now, 48), false);

assert.strictEqual(
    resolveRedirectUrl('//t.bilibili.com/1223847331863986184', 'https://www.bilibili.com/opus/1'),
    'https://t.bilibili.com/1223847331863986184'
);
assert.strictEqual(
    resolveRedirectUrl('/opus/1223847331863986184', 'https://www.bilibili.com/read/cv1'),
    'https://www.bilibili.com/opus/1223847331863986184'
);
assert.strictEqual(
    resolveRedirectUrl('https://www.bilibili.com/opus/2', 'https://www.bilibili.com/read/cv1'),
    'https://www.bilibili.com/opus/2'
);

assert.strictEqual(bili._getReserveLotteryStatus(0), 0);
assert.strictEqual(bili._getReserveLotteryStatus(7604003), 0);
assert.strictEqual(bili._getReserveLotteryStatus(75003), 2);
assert.strictEqual(bili._getReserveLotteryStatus(-1), 1);

assert.strictEqual(normalizeAiComment(' 参与一下，期待开奖！🎉 '), '参与一下期待开奖');
const usedComments = new Map([
    [normalizeAiComment('参与一下，期待开奖！'), '参与一下，期待开奖！'],
]);
assert.strictEqual(
    selectUniqueCommentFallback(
        ['参与一下，期待开奖！', '来试试手气，祝大家好运！'],
        usedComments
    ),
    '来试试手气，祝大家好运！'
);

const filterSource = Monitor.prototype.filterLotteryInfo.toString();
const goSource = Monitor.prototype.go.toString();
assert.ok(!filterSource.includes('getUniqueAiComment'));
assert.ok(goSource.includes('getUniqueAiComment'));
assert.ok(goSource.includes('return 6002'));
assert.ok(goSource.indexOf('return 6002') < goSource.indexOf('/* 评论 */'));

console.log('fork runtime tests passed');
