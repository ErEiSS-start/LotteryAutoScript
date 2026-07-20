const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    Searcher,
    extractCollectionDynamicLinks,
    isRecentCollectionDynamic,
    modifyTopicDynamicRes,
    normalizeTopicReference,
} = require('../lib/core/searcher');
const {
    Monitor,
    buildAiCommentPrompt,
    getAiCommentSimilarity,
    getMaxAiCommentSimilarity,
    normalizeAiComment,
    parseAiCommentResponse,
    selectDiverseCommentFallback,
    selectUniqueCommentFallback,
    validateAiComment,
} = require('../lib/core/monitor');
const { CommentHistoryStore } = require('../lib/helper/comment_history');
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
assert.strictEqual(utils.isValidDynamicId('9223372036854775808'), false);
assert.strictEqual(utils.isValidDynamicId('9999999999999999999'), false);
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

const similarEarphoneComments = [
    '新品耳机亮相不久，评论区热闹非凡，快来抢购同款，加入群聊赢好礼！🎉群号：1064716925🎉',
    '新耳机上市，快来评论区晒同款，进群还有好礼相送哦！🎉群号：1064716925🎉',
    '新耳机上市不久，评论区热闹非凡，快来试试同款耳机，进群还有好礼相送哦！🎉（群号：1064716925）',
    '新耳机亮相不久，评论区已有达人晒同款，快来加入群聊，一起赢取好礼吧！🎉（群号：1064716925）',
];
for (let index = 1; index < similarEarphoneComments.length; index++) {
    assert.ok(
        getMaxAiCommentSimilarity(
            similarEarphoneComments[index],
            similarEarphoneComments.slice(0, index)
        ) >= 0.57
    );
}
assert.strictEqual(getAiCommentSimilarity('来试试手气', '这个挺喜欢') < 0.57, true);
assert.deepStrictEqual(
    parseAiCommentResponse('{"comment":"蹲个结果","has_explicit_requirement":false}'),
    { comment: '蹲个结果', hasExplicitRequirement: false }
);
assert.strictEqual(validateAiComment('蹲个结果').valid, true);
assert.strictEqual(validateAiComment('进群1064716925领好礼').valid, false);
assert.strictEqual(validateAiComment('快来参与🎉').valid, false);
assert.strictEqual(validateAiComment('这是一条超过十五个字但属于明确评论口令的完整回答', {
    hasExplicitRequirement: true,
}).valid, true);
assert.strictEqual(
    selectDiverseCommentFallback(
        ['蹲个结果', '这个挺喜欢'],
        new Map([[normalizeAiComment('蹲个结果'), '蹲个结果']]),
        0,
        0.57
    ),
    '这个挺喜欢'
);
assert.notStrictEqual(
    buildAiCommentPrompt('', {
        accountNumber: 1,
        dyid: '1223378158235942914',
        attempt: 0,
        previousComments: [],
        rejectionReason: '',
    }),
    buildAiCommentPrompt('', {
        accountNumber: 2,
        dyid: '1223378158235942914',
        attempt: 0,
        previousComments: [],
        rejectionReason: '',
    })
);

const historyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-comment-history-'));
const historyPath = path.join(historyDirectory, 'successful_comments.json');
let historyNow = 2_000_000_000_000;
const quietLogger = { warn() {} };
const history = new CommentHistoryStore({
    filePath: historyPath,
    retentionDays: 30,
    now: () => historyNow,
    logger: quietLogger,
});
assert.strictEqual(history.remember('1223378158235942914', '蹲个结果', 1), true);
const reloadedHistory = new CommentHistoryStore({
    filePath: historyPath,
    retentionDays: 30,
    now: () => historyNow,
    logger: quietLogger,
});
assert.strictEqual(reloadedHistory.getByDyid('1223378158235942914')[0].comment, '蹲个结果');
historyNow += 31 * 24 * 60 * 60 * 1000;
assert.strictEqual(reloadedHistory.prune().length, 0);
fs.writeFileSync(historyPath, '{invalid json', 'utf8');
const corruptHistory = new CommentHistoryStore({
    filePath: historyPath,
    retentionDays: 30,
    now: () => historyNow,
    logger: quietLogger,
});
assert.deepStrictEqual(corruptHistory.getRecent(), []);
fs.rmSync(historyDirectory, { recursive: true, force: true });

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
assert.ok(goSource.indexOf('} else if (status)') < goSource.indexOf('rememberSuccessfulComment'));

console.log('fork runtime tests passed');
