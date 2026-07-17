const assert = require('assert');
const {
    requestAiWithFailover,
    _resetAiProviderState,
} = require('../lib/helper/ai_client');

(async () => {
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

    delete process.env.TEST_AI_KEY;
    _resetAiProviderState();
    console.log('ai_failover.test ... ok!');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
