const { getRandomOne, createDir, createFile, dyids_dir } = require('../utils');
const config = require('../data/config');
const { buildDiscoveryPlan, discoveryState } = require('../helper/discovery_state');

function resolveConfigAccountNumber(num, env = process.env) {
    const discoveryOwner = Number(env.LOTTERY_DISCOVERY_OWNER_NUMBER);
    return env.LOTTERY_DISCOVERY_ONLY
        && Number.isSafeInteger(discoveryOwner)
        && discoveryOwner > 0
        ? discoveryOwner
        : num;
}

let global_var = {
    inner: {},
    get(key) {
        return this.inner[key];
    },
    set(key, value) {
        this.inner[key] = value;
    },
    /**
     * 全局变量初始化
     * 更新config
     * @param {string} cookie
     * @param {string} num
     */
    async init(cookie, num) {
        if (cookie) {
            const key_map = new Map([
                ['DedeUserID', 'myUID'],
                ['bili_jct', 'csrf']]);

            config.updata(resolveConfigAccountNumber(num));

            this.set('accountCookieValid', false);
            this.set('discoveryCommitted', false);
            this.set('discoveryIncomplete', false);
            this.set('discoveryIncompleteReasons', []);
            this.set('lotteryBatchResult', {
                successful: 0,
                attempted: 0,
                needsAnotherRound: false,
                errorStatus: 0,
            });

            /**轮转参与阶段所有帐号只读取帐号1生成的固定快照 */
            if (process.env.LOTTERY_SHARED_ONLY) {
                config.LotteryOrder = [3];
                config.APIs = [`file://${process.env.LOTTERY_SHARED_SNAPSHOT_FILE || 'lottery_info_1.json'}`];
                config.save_lottery_info_to_file = false;
            }

            if (!/buvid3/.test(cookie)) {
                const charset = '0123456789ABCDEF'.split('');
                const buvid3 = 'x'.repeat(8).split('').map(() => getRandomOne(charset)).join('')
                    + '-'
                    + 'x'.repeat(4).split('').map(() => getRandomOne(charset)).join('')
                    + '-'
                    + 'x'.repeat(4).split('').map(() => getRandomOne(charset)).join('')
                    + '-'
                    + 'x'.repeat(4).split('').map(() => getRandomOne(charset)).join('')
                    + '-'
                    + 'x'.repeat(17).split('').map(() => getRandomOne(charset)).join('')
                    + 'infoc';
                this.set('cookie', cookie + ';' + buvid3);
            } else {
                this.set('cookie', cookie);
            }

            cookie.split(/\s*;\s*/).forEach(item => {
                const _item = item.split('=');
                if (key_map.has(_item[0]))
                    this.set(key_map.get(_item[0]), _item[1]);
            });

            const entries = process.env.LOTTERY_DISCOVERY_ONLY
                && process.env.LOTTERY_DISCOVERY_MODE === 'resume'
                ? discoveryState.getPendingEntries(config)
                : buildDiscoveryPlan(config).entries;
            this.set('Lottery', entries.map(entry => [entry.type, entry.value, entry.id]));
        }
        await createDir('dyids');
        await createFile(dyids_dir, num < 2 ? 'dyid.txt' : `dyid${num}.txt`, '', 'a');
    }
};

global_var.resolveConfigAccountNumber = resolveConfigAccountNumber;


module.exports = global_var;
