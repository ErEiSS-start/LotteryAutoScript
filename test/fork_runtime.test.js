const assert = require('assert');
const {
    Searcher,
    extractCollectionDynamicLinks,
    isRecentCollectionDynamic,
    modifyTopicDynamicRes,
    normalizeTopicReference,
} = require('../lib/core/searcher');
const { Monitor, normalizeAiComment, selectUniqueCommentFallback } = require('../lib/core/monitor');
const { resolveRedirectUrl } = require('../lib/net/http');
const utils = require('../lib/utils');
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

assert.strictEqual(utils.isValidDynamicId('0'), false);
assert.strictEqual(utils.isValidDynamicId(0), false);
assert.strictEqual(utils.isValidDynamicId(''), false);
assert.strictEqual(utils.isValidDynamicId('1225299005006675986'), true);
assert.deepStrictEqual(
    normalizeTopicReference({ id: 1267572, name: '互动抽奖活动' }),
    { id: 1267572, name: '互动抽奖活动' }
);
assert.deepStrictEqual(
    normalizeTopicReference('互动抽奖活动'),
    { id: 0, name: '互动抽奖活动' }
);
assert.strictEqual(normalizeTopicReference({ id: 0, name: '无效' }), null);

const topicResponse = JSON.stringify({
    code: 0,
    data: {
        topic_card_list: {
            has_more: true,
            offset: 'next-page',
            items: [{
                dynamic_card_item: {
                    id_str: '1225299005006675986',
                    type: 'DYNAMIC_TYPE_WORD',
                    basic: { comment_id_str: '1' },
                    modules: {
                        module_author: { mid: 1, name: 'tester', pub_ts: now },
                        module_dynamic: {
                            desc: {
                                rich_text_nodes: [{
                                    type: 'RICH_TEXT_NODE_TYPE_TEXT',
                                    orig_text: '互动抽奖',
                                    text: '互动抽奖',
                                }]
                            }
                        },
                        module_stat: { like: { status: false } }
                    }
                }
            }]
        }
    }
});
const modifiedTopic = modifyTopicDynamicRes(topicResponse);
assert.strictEqual(modifiedTopic.modifyDynamicResArray.length, 1);
assert.strictEqual(modifiedTopic.modifyDynamicResArray[0].dynamic_id, '1225299005006675986');
assert.strictEqual(modifiedTopic.nextinfo.has_more, true);
assert.strictEqual(modifiedTopic.nextinfo.next_offset, 'next-page');

const exactTopicResponse = JSON.stringify({
    code: 0,
    data: {
        topic_items: [
            { id: 1, name: '互动抽奖分母' },
            { id: 1267572, name: '互动抽奖活动' },
        ]
    }
});
assert.deepStrictEqual(
    bili._findExactTopic(exactTopicResponse, '互动抽奖活动'),
    { id: 1267572, name: '互动抽奖活动' }
);
assert.strictEqual(bili._findExactTopic(exactTopicResponse, '互动抽奖'), null);

const fallbackContent = bili._serializeDynamicDetailContent({
    item: {
        modules: {
            module_dynamic: {
                major: {
                    opus: {
                        summary: {
                            rich_text_nodes: [
                                { jump_url: 'https://www.bilibili.com/opus/1224830776264097798' },
                                { orig_text: 'https://t.bilibili.com/1223011260637904914' },
                                { jump_url: 'https://b23.tv/AbCd123' },
                            ]
                        }
                    }
                }
            }
        }
    }
});
assert.deepStrictEqual(extractCollectionDynamicLinks(fallbackContent), {
    dyids: ['1224830776264097798', '1223011260637904914'],
    shortIds: ['AbCd123'],
});

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
const uidSource = Searcher.prototype.getLotteryInfoByUID.toString();
assert.ok(!filterSource.includes('getUniqueAiComment'));
assert.ok(filterSource.includes('isValidDynamicId'));
assert.ok(uidSource.includes('源动态ID无效'));
assert.ok(uidSource.indexOf('源动态ID无效') < uidSource.indexOf('getOneDynamicByDyid'));
assert.ok(goSource.includes('getUniqueAiComment'));
assert.ok(goSource.includes('return 6002'));
assert.ok(goSource.indexOf('return 6002') < goSource.indexOf('/* 评论 */'));

console.log('fork runtime tests passed');
