const assert = require('assert');
const config = require('../lib/data/config');
const API = require('../lib/net/api.bili');
const bili = require('../lib/net/bili');
const { parseDynamicCard } = require('../lib/core/searcher');
const main = require('../main');

const previousNumber = process.env.NUMBER;
const previousRiskCooldowns = config.dynamic_detail_risk_cooldowns;
const previousArticleCooldowns = config.article_search_412_cooldowns;
const client = Object.create(bili);
client._dynamicDetailRiskController = bili._createDynamicDetailRiskController();

assert.strictEqual(bili.getDiscoveryRiskCode('{"code":-352,"message":"request rejected"}'), '-352');
assert.strictEqual(bili.getDiscoveryRiskCode('[响应错误]HTTP状态码: 412'), '412');
assert.strictEqual(bili.isDiscoveryRiskResponse('{"code":0,"data":{}}'), false);
assert.strictEqual(main.buildDiscoveryAttempts, undefined);
assert.strictEqual(main.executeDiscoveryFailover, undefined);

(async () => {
    try {
        config.dynamic_detail_risk_cooldowns = [3, 10, 30, 120];
        process.env.NUMBER = '1';
        client._dynamicDetailRiskController.reset();

        const dynamicId = '123456789012345678';
        const accountOneCalls = [];
        client._requestDynamicDetail = async (endpoint, id, desktop) => {
            accountOneCalls.push({ endpoint, id, desktop });
            if (!desktop) return '{"code":-352,"message":"风控校验失败"}';
            return JSON.stringify({
                code: 0,
                data: {
                    item: {
                        basic: { rid_str: '400981655' },
                        id_str: id,
                        type: 'DYNAMIC_TYPE_DRAW',
                        modules: [
                            {
                                module_type: 'MODULE_TYPE_AUTHOR',
                                module_author: {
                                    pub_ts: 1234567890,
                                    user: { mid: 12345, name: '测试用户' },
                                },
                            },
                            {
                                module_type: 'MODULE_TYPE_DESC',
                                module_desc: {
                                    rich_text_nodes: [{
                                        type: 'RICH_TEXT_NODE_TYPE_TEXT',
                                        orig_text: '转发并关注参与抽奖',
                                        text: '转发并关注参与抽奖',
                                    }],
                                },
                            },
                            {
                                module_type: 'MODULE_TYPE_STAT',
                                module_stat: { like: { like_state: true } },
                            },
                        ],
                    },
                },
            });
        };
        client._dynamicDetailWait = async () => {
            throw new Error('desktop备用成功时不应等待');
        };

        const first = await client.getOneDynamicByDyid(dynamicId);
        assert.strictEqual(first.item.id_str, dynamicId);
        const parsedDesktop = parseDynamicCard(first);
        assert.deepStrictEqual(
            {
                uid: parsedDesktop.uid,
                uname: parsedDesktop.uname,
                is_liked: parsedDesktop.is_liked,
                rid: parsedDesktop.rid_str,
                des: parsedDesktop.description,
            },
            {
                uid: 12345,
                uname: '测试用户',
                is_liked: true,
                rid: '400981655',
                des: '转发并关注参与抽奖',
            }
        );
        assert.deepStrictEqual(accountOneCalls.map(call => call.endpoint), [
            API.X_POLYMER_WEB_DYNAMIC_V1_DETAIL,
            API.X_POLYMER_WEB_DYNAMIC_DESKTOP_V1_DETAIL,
        ]);
        await client.getOneDynamicByDyid(dynamicId);
        assert.strictEqual(accountOneCalls.length, 2, '同帐号同动态应命中成功缓存');

        process.env.NUMBER = '2';
        const accountTwoCalls = [];
        client._requestDynamicDetail = async (endpoint, id, desktop) => {
            accountTwoCalls.push({ endpoint, id, desktop });
            return `{"code":0,"data":{"item":{"id_str":"${id}"}}}`;
        };
        await client.getOneDynamicByDyid(dynamicId);
        assert.strictEqual(accountTwoCalls.length, 1, '不同帐号不得复用详情缓存');

        process.env.NUMBER = '1';
        client._dynamicDetailRiskController.reset();
        const riskId = '223456789012345678';
        const riskCalls = [];
        const riskWaits = [];
        client._requestDynamicDetail = async (endpoint, id, desktop) => {
            riskCalls.push({ endpoint, id, desktop });
            if (riskCalls.length <= 2) return '{"code":-352,"message":"风控校验失败"}';
            return `{"code":0,"data":{"item":{"id_str":"${id}"}}}`;
        };
        client._dynamicDetailWait = async milliseconds => riskWaits.push(milliseconds);
        const recovered = await client.getOneDynamicByDyid(riskId);
        assert.strictEqual(recovered.item.id_str, riskId);
        assert.deepStrictEqual(riskWaits, [3], '主备均-352只应累计一次风控失败');
        assert.strictEqual(riskCalls.length, 3);
        assert.strictEqual(client._dynamicDetailRiskController.consecutiveRisk, 0);

        client._dynamicDetailRiskController.reset();
        const bannedId = '323456789012345678';
        const bannedCalls = [];
        const bannedWaits = [];
        client._requestDynamicDetail = async (endpoint, id, desktop) => {
            bannedCalls.push({ endpoint, id, desktop });
            if (bannedCalls.length === 1) {
                return '[响应错误]HTTP状态码: 412 响应数据:\n{"code":-412,"message":"request was banned"}';
            }
            return `{"code":0,"data":{"item":{"id_str":"${id}"}}}`;
        };
        client._dynamicDetailWait = async milliseconds => bannedWaits.push(milliseconds);
        await client.getOneDynamicByDyid(bannedId);
        assert.strictEqual(bannedCalls.length, 2, '412后应重试普通入口');
        assert.strictEqual(bannedCalls.some(call => call.desktop), false, '412不得请求desktop入口');
        assert.deepStrictEqual(bannedWaits, [3]);

        const missingId = '423456789012345678';
        let missingCalls = 0;
        client._requestDynamicDetail = async () => {
            missingCalls += 1;
            return '{"code":-404,"message":"啥都木有"}';
        };
        await client.getOneDynamicByDyid(missingId);
        await client.getOneDynamicByDyid(missingId);
        assert.strictEqual(missingCalls, 2, '失败响应不应写入缓存');

        config.article_search_412_cooldowns = [120000, 180000, 300000];
        const articleResponses = [
            '{"code":-412,"message":"request was banned"}',
            '{"code":-412,"message":"request was banned"}',
            '{"code":-412,"message":"request was banned"}',
            '{"code":-412,"message":"request was banned"}',
            '{"code":0,"data":{"result":[]}}',
        ];
        const articleWaits = [];
        await bili._searchArticlesWithRetry(
            '抽奖合集',
            async () => articleResponses.shift(),
            async milliseconds => articleWaits.push(milliseconds)
        );
        assert.deepStrictEqual(articleWaits, [120000, 180000, 300000, 300000]);

        console.log('dynamic detail risk handling tests passed');
    } finally {
        if (previousNumber === undefined) delete process.env.NUMBER;
        else process.env.NUMBER = previousNumber;
        config.dynamic_detail_risk_cooldowns = previousRiskCooldowns;
        config.article_search_412_cooldowns = previousArticleCooldowns;
        client._dynamicDetailRiskController.reset();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
