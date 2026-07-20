const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('../lib/data/config');
const {
    AiJudgeCache,
    validateJudgment,
    buildJudgePrompt,
    judgeLotteryInfo,
    preJudgeSharedSnapshot,
    _resetAiJudgeState,
} = require('../lib/helper/ai_judge');

(() => {
    const filePath = path.join('/tmp', `lottery-ai-judge-cache-${process.pid}.json`);
    let now = Date.parse('2026-07-17T00:00:00Z');
    const cache = new AiJudgeCache({ filePath, now: () => now, flushEvery: 1 });
    const item = { dyid: '1224830776264097798', des: '转发并关注，明天开奖', create_time: 1784246400 };
    const activeUnknown = {
        is_lottery: true,
        is_ended: false,
        need_at: false,
        need_topic: '',
        draw_time: -1,
        reason: '存在明确奖品和参与条件',
    };

    cache.set(item, 'signature', activeUnknown, 'gemini-3.5-flash');
    assert.deepStrictEqual(cache.get(item, 'signature'), activeUnknown);
    assert.strictEqual(cache.get({ ...item, des: '正文已修改' }, 'signature'), null);
    assert.strictEqual(cache.get(item, 'other-signature'), null);

    now += 24 * 60 * 60 * 1000 + 1;
    assert.strictEqual(cache.get(item, 'signature'), null, '未知开奖时间结果应在24小时后失效');

    const ended = { ...activeUnknown, is_ended: true, draw_time: 1784246400 };
    cache.set(item, 'signature', ended, 'glm-4.7-flash');
    now += 29 * 24 * 60 * 60 * 1000;
    assert.deepStrictEqual(cache.get(item, 'signature'), ended);

    const normalized = validateJudgment(JSON.stringify({
        is_lottery: true,
        is_ended: false,
        need_at: true,
        need_topic: '#互动抽奖#',
        draw_time: 1784246400000,
        reason: '测试',
    }));
    assert.strictEqual(normalized.draw_time, 1784246400);
    assert.strictEqual(validateJudgment('{"is_lottery":true}'), null);

    const prompt = buildJudgePrompt('判断抽奖', item, Date.parse('2026-07-17T01:00:00Z'));
    assert(prompt.includes('当前北京时间'));
    assert(prompt.includes('draw_time'));

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.log('ai_judge_cache.test ... ok!');
})();

(async () => {
    const previousEnabled = process.env.ENABLE_AI_JUDGE;
    const previousInterval = config.ai_judge_interval;
    const previousMaxOutageWait = config.ai_prejudge_max_outage_wait;
    process.env.ENABLE_AI_JUDGE = 'true';
    config.ai_judge_interval = 123;
    config.ai_prejudge_max_outage_wait = 10 * 60 * 1000;
    _resetAiJudgeState();

    const previousParm = config.ai_judge_parm;
    const previousKey = process.env.ZHIPU_API_KEY_1;
    process.env.ZHIPU_API_KEY_1 = 'test-key';
    config.ai_judge_parm = {
        providers: [{
            name: 'test-provider',
            url: 'https://example.invalid',
            api_key_env: 'ZHIPU_API_KEY',
            body: { model: 'test-model' },
        }],
        prompt: 'test',
    };
    const unavailableResult = await judgeLotteryInfo({
        dyid: '99',
        des: '测试抽奖',
        hasOfficialLottery: false,
    }, {
        cache: { get: () => null, set: () => {} },
        now: () => 123456,
        request: async () => null,
    });
    assert.strictEqual(unavailableResult.stopBatch, false, '可用供应商单条失败不应抛异常或停止整批');
    config.ai_judge_parm = previousParm;
    if (previousKey === undefined) delete process.env.ZHIPU_API_KEY_1;
    else process.env.ZHIPU_API_KEY_1 = previousKey;
    _resetAiJudgeState();

    const items = [1, 2, 3, 4].map(number => ({
        dyid: String(number),
        des: `候选${number}`,
        hasOfficialLottery: false,
    }));
    const waits = [];
    const calls = [];
    let now = 1000;
    const attempts = new Map();
    const cache = {
        get: () => null,
        flush: () => {},
    };
    const stats = await preJudgeSharedSnapshot('unused.json', {
        items,
        cache,
        judge: async item => {
            calls.push(item.dyid);
            attempts.set(item.dyid, (attempts.get(item.dyid) || 0) + 1);
            if (item.dyid === '2') return { result: { is_lottery: true }, cached: true, attempted: false };
            if (item.dyid === '3' && attempts.get(item.dyid) === 1) {
                return { result: null, failed: true, attempted: true, stopBatch: true, retryAfter: now + 60000 };
            }
            if (item.dyid === '4') return { result: null, failed: true, attempted: true };
            return { result: { is_lottery: true }, attempted: true };
        },
        wait: async milliseconds => {
            waits.push(milliseconds);
            now += milliseconds;
        },
        now: () => now,
    });
    assert.deepStrictEqual(calls, ['1', '2', '3', '3', '4'], '临时不可用后应重试同一候选再继续');
    assert.deepStrictEqual(waits, [123, 60000, 123], '限流等待不应计作关键词降级');
    assert.deepStrictEqual(stats, { total: 4, cached: 1, requested: 2, fallback: 1 });

    config.ai_judge_interval = previousInterval;
    config.ai_prejudge_max_outage_wait = previousMaxOutageWait;
    if (previousEnabled === undefined) delete process.env.ENABLE_AI_JUDGE;
    else process.env.ENABLE_AI_JUDGE = previousEnabled;
    _resetAiJudgeState();
    console.log('ai_judge_serial.test ... ok!');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
