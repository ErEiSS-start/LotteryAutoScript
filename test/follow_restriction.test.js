const assert = require('assert');
const bili = require('../lib/net/bili');
const global_var = require('../lib/data/global_var');
const {
    Monitor,
    clearFollowRestrictions,
    followRestrictionThreshold,
    getFollowRestrictedTargets,
    rememberFollowRestriction,
    shouldEscalateFollowRestriction,
} = require('../lib/core/monitor');

(async () => {
    clearFollowRestrictions();
    assert.strictEqual(followRestrictionThreshold(0), 2);
    assert.strictEqual(followRestrictionThreshold(1), 2);
    assert.strictEqual(followRestrictionThreshold(3), 3);

    rememberFollowRestriction('10001', '20001');
    rememberFollowRestriction('10001', '20001');
    assert.deepStrictEqual(getFollowRestrictedTargets('10001'), ['20001']);
    assert.strictEqual(shouldEscalateFollowRestriction('10001', 2), false);
    rememberFollowRestriction('10001', '20002');
    assert.strictEqual(shouldEscalateFollowRestriction('10001', 2), true);
    assert.strictEqual(shouldEscalateFollowRestriction('10001', 3), false);

    const originalAutoAttention = bili.autoAttention;
    const originalSendChatWithOcr = bili.sendChatWithOcr;
    let commentCalls = 0;
    try {
        clearFollowRestrictions();
        global_var.set('myUID', '30001');
        bili.autoAttention = async uid => {
            assert.strictEqual(uid, 40001);
            return 4;
        };
        bili.sendChatWithOcr = async () => {
            commentCalls += 1;
            return 0;
        };

        const monitor = new Monitor(['APIs', 'file://lottery_info_1.json']);
        const status = await monitor.go({
            uid: [40001],
            dyid: '1234567890123456789',
            chat_type: 17,
            rid: '987654321',
            relay_chat: '',
            ctrl: [],
            chat: '参与一下',
            isAiChat: false,
            useAiComment: false,
            aiCommentSource: '',
        });

        assert.strictEqual(status, 2004);
        assert.strictEqual(commentCalls, 0, '关注受限时不得先留下评论');
        assert.deepStrictEqual(getFollowRestrictedTargets('30001'), ['40001']);
    } finally {
        bili.autoAttention = originalAutoAttention;
        bili.sendChatWithOcr = originalSendChatWithOcr;
        clearFollowRestrictions();
    }

    console.log('follow_restriction.test ... ok!');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
