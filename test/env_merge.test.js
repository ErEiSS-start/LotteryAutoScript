const assert = require('assert');
const { mergeEnvValues } = require('../lib/data/env');

assert.deepStrictEqual(
    mergeEnvValues(
        {
            PUSH_PLUS_TOKEN: 'qinglong-token',
            COOKIE: 'qinglong-cookie',
            EMPTY: '',
        },
        {
            PUSH_PLUS_TOKEN: '',
            COOKIE: 'local-cookie',
            EMPTY: '',
            ENABLE_AI_JUDGE: false,
        }
    ),
    {
        PUSH_PLUS_TOKEN: 'qinglong-token',
        COOKIE: 'local-cookie',
        EMPTY: '',
        ENABLE_AI_JUDGE: false,
    }
);
