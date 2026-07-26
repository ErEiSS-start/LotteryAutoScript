const assert = require('assert');
const bili_client = require('../lib/net/bili');

const articleUrl = 'https://www.bilibili.com/read/cv51787572';
assert.deepStrictEqual(
    bili_client._classifyArticleRedirect('/opus/1229003796553662467', articleUrl),
    {
        kind: 'opus',
        url: 'https://www.bilibili.com/opus/1229003796553662467',
    }
);
assert.deepStrictEqual(
    bili_client._classifyArticleRedirect('/read/error?from=search', articleUrl),
    {
        kind: 'unavailable',
        url: 'https://www.bilibili.com/read/error?from=search',
    }
);
assert.deepStrictEqual(
    bili_client._classifyArticleRedirect('https://example.com/read/error', articleUrl),
    { kind: 'unknown', url: '' }
);
assert.deepStrictEqual(
    bili_client._classifyArticleRedirect('/read/login', articleUrl),
    { kind: 'unknown', url: '' }
);

(async () => {
    const incompleteReasons = [];
    const unavailable = await bili_client.getOneArticleByCv(51787572, {
        requestFn: async () => '<html>error</html>',
        redirectFn: async () => ({ kind: 'unavailable', url: `${articleUrl}/error` }),
        waitFn: async () => assert.fail('永久失效专栏不应等待重试'),
        markIncompleteFn: reason => incompleteReasons.push(reason),
        maxAttempts: 2,
        retryWait: 1,
    });
    assert.strictEqual(unavailable, null);
    assert.deepStrictEqual(incompleteReasons, []);

    let failedRequests = 0;
    const waits = [];
    const failed = await bili_client.getOneArticleByCv(51787573, {
        requestFn: async () => {
            failedRequests += 1;
            return '[请求失败]: timeout';
        },
        redirectFn: async () => ({ kind: 'unknown', url: '' }),
        waitFn: async milliseconds => waits.push(milliseconds),
        markIncompleteFn: reason => incompleteReasons.push(reason),
        maxAttempts: 2,
        retryWait: 1,
    });
    assert.strictEqual(failed, '');
    assert.strictEqual(failedRequests, 2);
    assert.deepStrictEqual(waits, [1]);
    assert.deepStrictEqual(incompleteReasons, ['专栏(51787573)正文读取失败']);

    const requestedUrls = [];
    const validContent = `${'x'.repeat(8000)}<div class="article-content">正文</div>`;
    const recovered = await bili_client.getOneArticleByCv(51787574, {
        requestFn: async ({ url }) => {
            requestedUrls.push(url);
            return requestedUrls.length === 1 ? '<html>redirect</html>' : validContent;
        },
        redirectFn: async () => ({
            kind: 'opus',
            url: 'https://www.bilibili.com/opus/1229003796553662467',
        }),
        waitFn: async () => {},
        maxAttempts: 2,
        retryWait: 1,
    });
    assert.strictEqual(recovered, validContent);
    assert.strictEqual(
        requestedUrls[1],
        'https://www.bilibili.com/opus/1229003796553662467'
    );

    console.log('article.test ... ok!');
})();
