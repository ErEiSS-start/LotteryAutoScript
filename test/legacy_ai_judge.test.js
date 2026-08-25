const assert = require('assert');
const { getLegacyAiJudgeRequest } = require('../lib/core/monitor');

async function run() {
    const legacy = getLegacyAiJudgeRequest({
        url: 'https://legacy.example/v1/chat',
        body: { model: 'legacy-model' },
        prompt: 'legacy prompt',
    });
    assert.deepStrictEqual(legacy, {
        url: 'https://legacy.example/v1/chat',
        body: { model: 'legacy-model' },
        prompt: 'legacy prompt',
        apiKeyEnv: 'AI_API_KEY',
    });

    const provider = getLegacyAiJudgeRequest({
        prompt: 'provider prompt',
        providers: [
            {
                name: 'first',
                url: 'https://first.example/v1/chat',
                api_key_env: 'ZHIPU_API_KEY',
                body: { model: 'first-model' },
            },
            {
                name: 'second',
                url: 'https://second.example/v1/chat',
                api_key_env: 'ZHIPU_API_KEY_2',
                body: { model: 'second-model' },
            },
        ],
    });
    assert.deepStrictEqual(provider, {
        url: 'https://first.example/v1/chat',
        body: { model: 'first-model' },
        prompt: 'provider prompt',
        apiKeyEnv: 'ZHIPU_API_KEY',
    });

    assert.strictEqual(getLegacyAiJudgeRequest({ providers: [{ url: 'https://no-prompt.example' }] }), null);
    console.log('legacy_ai_judge.test ... ok!');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
