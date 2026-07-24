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
    buildAiCommentPackPrompt,
    completeCommentPack,
    getAiCommentSimilarity,
    getCommentPackContext,
    getCommentPackSignature,
    getMaxAiCommentSimilarity,
    normalizeAiComment,
    parseAiCommentPackResponse,
    parseAiCommentResponse,
    selectDiverseCommentFallback,
    selectUniqueCommentFallback,
    validateAiComment,
    deferFailedRelay,
} = require('../lib/core/monitor');
const { CommentHistoryStore } = require('../lib/helper/comment_history');
const { CommentPackStore } = require('../lib/helper/comment_pack_store');
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
assert.strictEqual(utils.isEnvEnabled('FLAG', { FLAG: true }), true);
assert.strictEqual(utils.isEnvEnabled('FLAG', { FLAG: 'ON' }), true);
assert.strictEqual(utils.isEnvEnabled('FLAG', { FLAG: false }), false);
assert.strictEqual(utils.isEnvEnabled('FLAG', { FLAG: 'false' }), false);
assert.strictEqual(utils.isEnvEnabled('FLAG', { FLAG: '0' }), false);
assert.strictEqual(
    utils.matchesLotteryKeywords('普通视频，感谢观看', ['[抽奖送揪]|福利', '[转关评粉赞]|参与']),
    false
);
assert.strictEqual(
    utils.matchesLotteryKeywords('转发并关注，抽一位送奖品', ['[抽奖送揪]|福利|奖品', '[转关评粉赞]|参与']),
    true
);
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
assert.strictEqual(bili._parseAutoRelayStatus('{"code":0}'), 0);
assert.strictEqual(bili._parseAutoRelayStatus('{"code":1101004}'), 2);
assert.strictEqual(bili._parseAutoRelayStatus('{"code":2201116}'), 3);
assert.strictEqual(bili._parseAutoRelayStatus('{"code":1101008}'), 4);
assert.strictEqual(bili._parseAutoRelayStatus('{"code":4126117}'), 5);
assert.strictEqual(bili._parseAutoRelayStatus('[请求失败]: 请求超时'), 1);

const deferredRelayCandidate = {
    dyid: '1227735301598740501',
    rid: 'comment-rid',
    chat: '已成功发送的评论',
    chat_type: 17,
};
let deferredDyid = '';
assert.strictEqual(
    deferFailedRelay({
        defer(dyid) {
            deferredDyid = dyid;
            return true;
        }
    }, deferredRelayCandidate),
    true
);
assert.strictEqual(deferredDyid, '1227735301598740501');
assert.strictEqual(deferredRelayCandidate.rid, undefined);
assert.strictEqual(deferredRelayCandidate.chat, undefined);
assert.strictEqual(deferredRelayCandidate.chat_type, 0);

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
assert.deepStrictEqual(
    parseAiCommentPackResponse(
        '{"comments":["蹲个结果","看看运气"],"has_explicit_requirement":false}'
    ),
    {
        comments: ['蹲个结果', '看看运气'],
        hasExplicitRequirement: false,
    }
);
assert.strictEqual(parseAiCommentPackResponse('not-json'), null);
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
assert.ok(buildAiCommentPackPrompt('', {
    accountCount: 5,
    previousComments: ['蹲个结果'],
}).includes('comments必须恰好包含5条'));

assert.deepStrictEqual(getCommentPackContext({
    LOTTERY_COMMENT_ACCOUNT_NUMBERS: '["1","2","3","4","5"]',
    LOTTERY_COMMENT_SLOT: '3',
    NUMBER: '4',
}), {
    accounts: ['1', '2', '3', '4', '5'],
    slot: 3,
});
assert.deepStrictEqual(getCommentPackContext({
    LOTTERY_COMMENT_ACCOUNT_NUMBERS: 'invalid',
    NUMBER: '5',
}), {
    accounts: ['5'],
    slot: 0,
});

const packSignature = getCommentPackSignature(
    '1223378158235942914',
    '原始动态正文',
    ['1', '2', '3', '4', '5'],
    {
        prompt: '生成评论',
        providers: [{ name: 'glm', url: 'https://example.test', body: { model: 'glm' } }],
    }
);
assert.strictEqual(packSignature.length, 64);
assert.notStrictEqual(
    packSignature,
    getCommentPackSignature(
        '1223378158235942914',
        '另一份动态正文',
        ['1', '2', '3', '4', '5'],
        {
            prompt: '生成评论',
            providers: [{ name: 'glm', url: 'https://example.test', body: { model: 'glm' } }],
        }
    )
);

const completedPack = completeCommentPack({
    dyid: '1223378158235942914',
    accountCount: 5,
    parsed: {
        comments: ['蹲个结果', '蹲个结果', '进群1064716925领好礼', '', '这个挺喜欢'],
        hasExplicitRequirement: false,
    },
    usedComments: new Map(),
    recentNormalized: new Set(),
    similarityThreshold: 0.57,
    maxLength: 15,
});
assert.strictEqual(completedPack.comments.length, 5);
assert.strictEqual(completedPack.aiCount, 2);
assert.strictEqual(completedPack.localCount, 3);
assert.strictEqual(new Set(completedPack.comments.map(normalizeAiComment)).size, 5);
completedPack.comments.forEach(comment => assert.strictEqual(validateAiComment(comment).valid, true));

const explicitPack = completeCommentPack({
    dyid: '1223378158235942914',
    accountCount: 5,
    parsed: {
        comments: ['指定口令'],
        hasExplicitRequirement: true,
    },
    usedComments: new Map(),
    recentNormalized: new Set(),
    similarityThreshold: 0.57,
    maxLength: 15,
});
assert.deepStrictEqual(explicitPack.comments, Array(5).fill('指定口令'));
assert.strictEqual(explicitPack.aiCount, 5);
assert.strictEqual(explicitPack.localCount, 0);

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

const packDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-comment-pack-'));
const packPath = path.join(packDirectory, 'ai_comment_packs.json');
let packNow = 2_000_000_000_000;
const packStore = new CommentPackStore({
    filePath: packPath,
    retentionDays: 30,
    now: () => packNow,
    logger: quietLogger,
});
assert.strictEqual(packStore.remember({
    dyid: '1223378158235942914',
    signature: packSignature,
    accounts: ['1', '2', '3', '4', '5'],
    comments: completedPack.comments,
    aiCount: completedPack.aiCount,
    localCount: completedPack.localCount,
}), true);
const reloadedPackStore = new CommentPackStore({
    filePath: packPath,
    retentionDays: 30,
    now: () => packNow,
    logger: quietLogger,
});
assert.deepStrictEqual(
    reloadedPackStore.get('1223378158235942914', packSignature).comments,
    completedPack.comments
);
packNow += 31 * 24 * 60 * 60 * 1000;
assert.strictEqual(
    reloadedPackStore.get('1223378158235942914', packSignature),
    null
);
fs.writeFileSync(packPath, '{invalid json', 'utf8');
const corruptPackStore = new CommentPackStore({
    filePath: packPath,
    retentionDays: 30,
    now: () => packNow,
    logger: quietLogger,
});
assert.strictEqual(corruptPackStore.get('1223378158235942914', packSignature), null);
fs.rmSync(packDirectory, { recursive: true, force: true });

const filterSource = Monitor.prototype.filterLotteryInfo.toString();
const goSource = Monitor.prototype.go.toString();
const uidSource = Searcher.prototype.getLotteryInfoByUID.toString();
assert.ok(!filterSource.includes('getUniqueAiComment'));
assert.ok(filterSource.includes('isValidDynamicId'));
assert.ok(uidSource.includes('源动态ID无效'));
assert.ok(uidSource.indexOf('源动态ID无效') < uidSource.indexOf('getOneDynamicByDyid'));
assert.ok(goSource.includes('getUniqueAiComment'));
assert.ok(goSource.includes('getPackedAiComment'));
assert.ok(goSource.includes('return 6002'));
assert.ok(goSource.indexOf('return 6002') < goSource.indexOf('/* 评论 */'));
assert.ok(goSource.indexOf('} else if (status)') < goSource.indexOf('rememberSuccessfulComment'));

console.log('fork runtime tests passed');
