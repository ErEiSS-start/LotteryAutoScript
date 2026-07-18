const assert = require('assert');
const {
    requestAiWithFailover,
    getNumberedZhipuCredentials,
    getAiProviderAvailability,
    _expandProviderCredentials,
    _resetAiProviderState,
} = require('../lib/helper/ai_client');

(async () => {
    const credentials = getNumberedZhipuCredentials({
        ZHIPU_API_KEY_10: 'key-c',
        ZHIPU_API_KEY_2: 'key-b',
        ZHIPU_API_KEY_1: 'key-a',
        ZHIPU_API_KEY_3: 'key-b',
        ZHIPU_API_KEY_4: ' ',
    });
    assert.deepStrictEqual(credentials.map(item => item.number), [1, 2, 10]);
    assert.deepStrictEqual(credentials.map(item => item.key), ['key-a', 'key-b', 'key-c']);
    const expanded = _expandProviderCredentials({
        name: 'glm-4.7-flash',
        url: 'https://zhipu.invalid',
        api_key_env: 'ZHIPU_API_KEY',
        body: { model: 'glm-4.7-flash' },
    }, {
        ZHIPU_API_KEY_5: 'key-5',
        ZHIPU_API_KEY_1: 'key-1',
    });
    assert.deepStrictEqual(expanded.map(item => item.api_key_env), ['ZHIPU_API_KEY_1', 'ZHIPU_API_KEY_5']);

    process.env.TEST_AI_KEY = 'test-only';
    const providers = [
        { name: 'primary', url: 'https://primary.invalid', api_key_env: 'TEST_AI_KEY', body: {} },
        { name: 'fallback', url: 'https://fallback.invalid', api_key_env: 'TEST_AI_KEY', body: {} },
    ];

    _resetAiProviderState();
    const calls = [];
    const fallback = await requestAiWithFailover({
        providers,
        prompt: 'json',
        content: 'test',
        retryCount: 0,
        validate: value => JSON.parse(value),
        transport: async provider => {
            calls.push(provider.name);
            return provider.name === 'primary'
                ? { ok: false, error: 'timeout' }
                : { ok: true, content: '{"ok":true}' };
        },
    });
    assert.strictEqual(fallback.provider, 'fallback');
    assert.deepStrictEqual(calls, ['primary', 'fallback']);

    _resetAiProviderState();
    const invalidJsonFallback = await requestAiWithFailover({
        providers,
        prompt: 'json',
        content: 'test',
        retryCount: 0,
        validate: value => JSON.parse(value),
        transport: async provider => provider.name === 'primary'
            ? { ok: true, content: 'not-json' }
            : { ok: true, content: '{"valid":true}' },
    });
    assert.strictEqual(invalidJsonFallback.provider, 'fallback');

    _resetAiProviderState();
    let circuitCalls = 0;
    let now = 1000;
    const alwaysFail = async () => {
        circuitCalls += 1;
        return { ok: false, error: '503' };
    };
    const circuitOptions = {
        providers: [providers[0]],
        retryCount: 0,
        failureThreshold: 2,
        circuitCooldown: 60000,
        now: () => now,
        transport: alwaysFail,
    };
    await requestAiWithFailover(circuitOptions);
    await requestAiWithFailover(circuitOptions);
    await requestAiWithFailover(circuitOptions);
    assert.strictEqual(circuitCalls, 2, '熔断后不应继续调用供应商');
    now += 60001;
    await requestAiWithFailover(circuitOptions);
    assert.strictEqual(circuitCalls, 3, '冷却结束后应允许半开探测');

    _resetAiProviderState();
    let rateLimitCalls = 0;
    const rateLimitOptions = {
        providers: [providers[0]],
        retryCount: 1,
        circuitCooldown: 60000,
        now: () => now,
        transport: async () => {
            rateLimitCalls += 1;
            return { ok: false, error: 'HTTP状态码: 429 速率限制' };
        },
    };
    await requestAiWithFailover(rateLimitOptions);
    await requestAiWithFailover(rateLimitOptions);
    assert.strictEqual(rateLimitCalls, 1, '429应立即熔断且不进行无效重试');

    process.env.TEST_POOL_KEY_1 = 'one';
    process.env.TEST_POOL_KEY_2 = 'two';
    process.env.TEST_POOL_KEY_3 = 'three';
    const poolKey = 'test-zhipu-pool';
    const poolProviders = [1, 2, 3].map(number => ({
        name: `account-${number}`,
        url: 'https://zhipu.invalid',
        api_key_env: `TEST_POOL_KEY_${number}`,
        body: {},
        state_key: `${poolKey}-${number}`,
        credential_pool_key: poolKey,
    }));
    _resetAiProviderState();
    const roundRobinCalls = [];
    for (let request = 0; request < 4; request++) {
        await requestAiWithFailover({
            providers: poolProviders,
            retryCount: 0,
            validate: value => JSON.parse(value),
            transport: async provider => {
                roundRobinCalls.push(provider.name);
                return { ok: true, content: '{"ok":true}' };
            },
        });
    }
    assert.deepStrictEqual(roundRobinCalls, ['account-1', 'account-2', 'account-3', 'account-1']);

    _resetAiProviderState();
    const rateLimitPoolCalls = [];
    const poolNow = () => 2000;
    const switched = await requestAiWithFailover({
        providers: poolProviders,
        retryCount: 0,
        circuitCooldown: 60000,
        now: poolNow,
        validate: value => JSON.parse(value),
        transport: async provider => {
            rateLimitPoolCalls.push(provider.name);
            return provider.name === 'account-1'
                ? { ok: false, error: 'code: 1302, API 调用并发数达到上限' }
                : { ok: true, content: '{"ok":true}' };
        },
    });
    assert.strictEqual(switched.provider, 'account-2');
    assert.deepStrictEqual(rateLimitPoolCalls, ['account-1', 'account-2']);
    assert.deepStrictEqual(getAiProviderAvailability(poolProviders, poolNow), {
        configured: 3,
        available: 2,
        allUnavailable: false,
    });

    _resetAiProviderState();
    await requestAiWithFailover({
        providers: poolProviders,
        retryCount: 0,
        circuitCooldown: 60000,
        now: poolNow,
        transport: async () => ({ ok: false, error: 'HTTP状态码: 429' }),
    });
    assert.strictEqual(getAiProviderAvailability(poolProviders, poolNow).allUnavailable, true);

    delete process.env.TEST_AI_KEY;
    delete process.env.TEST_POOL_KEY_1;
    delete process.env.TEST_POOL_KEY_2;
    delete process.env.TEST_POOL_KEY_3;
    _resetAiProviderState();
    console.log('ai_failover.test ... ok!');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
