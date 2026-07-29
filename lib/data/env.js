const { env_file } = require('../utils');

function mergeEnvValues(current = {}, incoming = {}) {
    const merged = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
        const incomingIsEmpty = value === '' || value === null || value === undefined;
        const currentHasValue = merged[key] !== '' && merged[key] !== null && merged[key] !== undefined;
        if (incomingIsEmpty && currentHasValue) continue;
        merged[key] = value;
    }
    return merged;
}

const env = {
    /**
     * 原始环境
     * @returns {Object}
     */
    raw_env() {
        delete require.cache[env_file];
        return require(env_file);
    },
    init() {
        const raw_env = this.raw_env();
        this.setEnv({
            ...raw_env['account_parm'],
            ...raw_env['push_parm'],
            ...raw_env['ai_parm']
        });
    },
    /**
     * @returns {Object[]}
     */
    get_multiple_account() {
        return this.raw_env()['multiple_account_parm'];
    },
    setEnv(o) {
        process.env = mergeEnvValues(process.env, o);
    }
};


module.exports = env;
module.exports.mergeEnvValues = mergeEnvValues;
