const {
    version: ve,
    env_file,
    config_file,
    log,
    hasEnv,
    delay,
    hasFileOrDir,
    clearLotteryInfo, printIpInfo
} = require('./lib/utils');
const { HttpsProxyAgent } = require('https-proxy-agent');
const request = require('https');
const metainfo = [
    '  _           _   _                   _____           _       _   ',
    ' | |         | | | |                 / ____|         (_)     | |  ',
    ' | |     ___ | |_| |_ ___ _ __ _   _| (___   ___ _ __ _ _ __ | |_ ',
    ' | |    / _ \\| __| __/ _ \\ \'__| | | |\\___ \\ / __| \'__| | \'_ \\| __|',
    ' | |___| (_) | |_| ||  __/ |  | |_| |____) | (__| |  | | |_) | |_ ',
    ' |______\\___/ \\__|\\__\\___|_|   \\__, |_____/ \\___|_|  |_| .__/ \\__|',
    '                                __/ |                  | |        ',
    '                               |___/                   |_|        ',
    '                                                                  ',
    `    This: v${ve}     Nodejs: ${process.version}     Written By shanmite`,
];
/**多账号存储 */
let multiple_account = [];
/**循环等待时间 */
let loop_wait = 0;
/**账号状态标记 1正常 -1失效 */
// eslint-disable-next-line no-unused-vars
let ck_flag = 0;

/**
 * 写入单个帐号的运行环境
 * @param {object} account
 */
function setAccountEnv(account) {
    for (const key of ['COOKIE', 'NUMBER', 'CLEAR', 'NOTE', 'ACCOUNT_UA']) {
        if (account[key] === undefined || account[key] === null) {
            delete process.env[key];
        } else {
            process.env[key] = String(account[key]);
        }
    }
}

/**
 * 设置单个帐号代理并执行一次
 * @param {object} account
 * @param {import('https').Agent} localhost
 * @returns {Promise<string|undefined>}
 */
async function runAccount(account, localhost) {
    setAccountEnv(account);
    ck_flag = 0;
    if (account.PROXY_HOST) {
        printIpInfo(true);
        const proxyUrl = account.PROXY_USER
            ? 'http://' + account.PROXY_USER + ':' + account.PROXY_PASS + '@' + account.PROXY_HOST + ':' + account.PROXY_PORT
            : 'http://' + account.PROXY_HOST + ':' + account.PROXY_PORT;
        request.globalAgent = new HttpsProxyAgent(proxyUrl);
        printIpInfo(false);
    } else {
        request.globalAgent = localhost;
    }
    try {
        return await main();
    } finally {
        request.globalAgent = localhost;
    }
}

/**
 * 帐号1先采集固定快照，然后五个帐号按批次轮流参与，直至各自队列清空
 * @param {object[]} accounts
 * @param {import('https').Agent} localhost
 * @returns {Promise<string|undefined>}
 */
async function runRoundRobin(accounts, localhost) {
    const config = require('./lib/data/config');
    const global_var = require('./lib/data/global_var');
    const batchSize = Math.max(1, Number(config.lottery_batch_size) || 7);
    const roundCooldown = Math.max(0, Number(config.lottery_round_cooldown) || 15 * 60 * 1000);
    const firstAccount = accounts[0];

    if (!firstAccount) return '未配置可用帐号';

    loop_wait = 0;
    process.env.LOTTERY_DISCOVERY_ONLY = '1';
    delete process.env.LOTTERY_SHARED_ONLY;
    log.info('轮转采集', `帐号${firstAccount.NUMBER}开始生成本轮固定快照`);
    let errMsg = await runAccount(firstAccount, localhost);
    delete process.env.LOTTERY_DISCOVERY_ONLY;
    if (errMsg) return errMsg;
    if (!global_var.get('accountCookieValid')) {
        return `帐号${firstAccount.NUMBER} Cookie失效，无法生成固定快照`;
    }
    if (!global_var.get('discoveryCommitted')) {
        return '本轮没有生成有效固定快照，已保留上一份文件且不会开始参与';
    }

    if (Number(firstAccount.WAIT) > 0) {
        log.info('轮转采集', `固定快照完成，${Number(firstAccount.WAIT) / 1000}秒后开始第一轮`);
        await delay(Number(firstAccount.WAIT));
    }

    process.env.LOTTERY_SHARED_ONLY = '1';
    let pendingAccounts = [...accounts];
    let round = 0;
    while (pendingAccounts.length) {
        round += 1;
        const nextRound = [];
        log.info('轮转参与', `第${round}轮开始：${pendingAccounts.length}个帐号，每帐号最多成功参与${batchSize}条`);

        for (const [index, account] of pendingAccounts.entries()) {
            errMsg = await runAccount(account, localhost);
            if (errMsg) return errMsg;

            const cookieValid = global_var.get('accountCookieValid');
            const result = global_var.get('lotteryBatchResult') || {};
            if (!cookieValid) {
                log.warn('轮转参与', `帐号${account.NUMBER} Cookie失效，停止该帐号后续轮次`);
            } else if (result.errorStatus) {
                log.warn('轮转参与', `帐号${account.NUMBER}遇到停止状态${result.errorStatus}，停止该帐号后续轮次`);
            } else if (result.needsAnotherRound) {
                nextRound.push(account);
            }

            log.info(
                '轮转参与',
                `帐号${account.NUMBER}本轮尝试${Number(result.attempted) || 0}条，成功${Number(result.successful) || 0}条`
            );

            if (index < pendingAccounts.length - 1) {
                await delay(cookieValid ? Number(account.WAIT) || 0 : 3 * 1000);
            }
        }

        pendingAccounts = nextRound;
        if (pendingAccounts.length) {
            log.info(
                '轮转休息',
                `第${round}轮结束，仍有${pendingAccounts.length}个帐号未处理完，统一休息${roundCooldown / 60000}分钟`
            );
            await delay(roundCooldown);
        }
    }

    delete process.env.LOTTERY_SHARED_ONLY;
    log.info('轮转参与', `全部帐号已处理完本轮固定快照，共完成${round}轮`);
}

/**
 * @returns {Promise<string>} 错误信息
 */
async function main() {
    const { COOKIE, NUMBER, CLEAR, ENABLE_MULTIPLE_ACCOUNT, MULTIPLE_ACCOUNT_PARM } = process.env;
    if (ENABLE_MULTIPLE_ACCOUNT) {
        let muti_acco = multiple_account.length
            ? multiple_account
            : JSON.parse(MULTIPLE_ACCOUNT_PARM);

        process.env.ENABLE_MULTIPLE_ACCOUNT = '';
        const localhost = request.globalAgent;
        try {
            const config = require('./lib/data/config');
            if (process.env.lottery_mode === 'start' && config.enable_lottery_round_robin) {
                return await runRoundRobin(muti_acco, localhost);
            }

            for (const acco of muti_acco) {
                const err_msg = await runAccount(acco, localhost);
                if (err_msg) return err_msg;
                await delay(ck_flag === 1 ? Number(acco.WAIT) || 0 : 3 * 1000);
            }
        } finally {
            delete process.env.LOTTERY_DISCOVERY_ONLY;
            delete process.env.LOTTERY_SHARED_ONLY;
            request.globalAgent = localhost;
            /**多账号状态还原 */
            process.env.ENABLE_MULTIPLE_ACCOUNT = ENABLE_MULTIPLE_ACCOUNT;
        }
    } else if (COOKIE) {
        const global_var = require('./lib/data/global_var');
        await global_var.init(COOKIE, NUMBER);

        /**引入基础功能 */
        const { start, isMe, clear, account, checkCookie, login } = require('./lib/index');

        log.info('main', '当前为第' + NUMBER + '个账号');
        log._cache.length = 0;

        const mode = process.env.lottery_mode;
        const help_msg = '用法: lottery [OPTIONS]\n\nOPTIONS:\n\tstart  启动抽奖\n\tcheck  中奖检查\n\tacount 查看帐号信息\n\tclear  清理动态和关注\n\tlogin 扫码登录更新CK\n\tupdate 检查更新\n\thelp   帮助信息';
        if (await checkCookie(NUMBER)) {
            global_var.set('accountCookieValid', true);
            const {
                lottery_loop_wait,
                check_loop_wait,
                clear_loop_wait,
                save_lottery_info_to_file
            } = require('./lib/data/config');
            ck_flag = 1;
            switch (mode) {
                case 'start':
                    log.info('抽奖', '开始运行');
                    loop_wait = lottery_loop_wait;
                    if (save_lottery_info_to_file) {
                        await clearLotteryInfo();
                    }
                    await start(NUMBER);
                    break;
                case 'check':
                    log.info('中奖检测', '检查是否中奖');
                    loop_wait = check_loop_wait;
                    await isMe(NUMBER);
                    break;
                case 'clear':
                    if (CLEAR) {
                        log.info('清理动态', '开始运行');
                        loop_wait = clear_loop_wait;
                        await clear();
                    }
                    break;
                case 'login':
                    log.info('登录状态', '正常，跳过扫码');
                    break;
                case 'help':
                    return help_msg;
                case 'account':
                    log.info('检查帐号信息', '开始运行');
                    await account();
                    break;
                case undefined:
                    return '未提供以下参数\n\t[OPTIONS]\n\n' + help_msg;
                default:
                    return `提供了错误的[OPTIONS] -> ${mode}\n\n` + help_msg;
            }
        } else {
            log.error('Cookie已失效', '切换账号时不要点击退出账号而应直接删除Cookie退出');
            ck_flag = -1;
            if (mode === 'login') {
                log.info('登陆', '开始扫码');
                await login(NUMBER);
                await delay(1000);
            }
        }
    } else {
        return '请查看README文件, 在env.js指定位置填入cookie';
    }
}

/**
 * 初始化环境
 * @returns {boolean} 出错true
 */
function initEnv() {
    if (hasFileOrDir(env_file)) {
        const
            env = require('./lib/data/env'),
            multiple_account_parm = env.get_multiple_account();

        if (multiple_account_parm) {
            multiple_account = multiple_account_parm;
        }

        env.init();
        log.init();
        log.info('环境变量初始化', '成功加载env.js文件');
    } else if (hasEnv('COOKIE') || hasEnv('MULTIPLE_ACCOUNT_PARM')) {
        log.init();
        log.info('环境变量初始化', '成功从环境变量中读取COOKIE设置');
    } else {
        log.init();
        log.error('环境变量初始化', '未在当前目录下找到env.js文件或者在环境变量中设置所需参数');
        return true;
    }

    return false;
}

/**
 * 初始化设置
 * @returns {boolean} 出错true
 */
function initConfig() {
    if (hasFileOrDir(config_file)) {
        const config = require('./lib/data/config');
        config.init();
        log.info('配置文件初始化', '成功加载my_config.js文件');
    } else {
        log.error('配置文件初始化', '未在当前目录下找到my_config.js文件');
        return true;
    }

    return false;
}

(async function () {
    log.rainbow(metainfo);

    if (initEnv() || initConfig()) return;

    /**OPTIONS */
    process.env.lottery_mode = process.argv[2];

    log.info('检查更新', '开始');

    if (process.env.lottery_mode === 'update') {
        await require('./lib/update').update(true);
        return;
    } else {
        await require('./lib/update').update(false);
    }

    const err_msg = await main();
    if (err_msg) {
        log.error('错误', err_msg);
        log.warn('结束运行', '5秒后自动退出');
        await delay(5 * 1000);
    } else {
        while (loop_wait) {
            log.info('程序休眠', `${loop_wait / 1000}秒后再次启动`);
            await delay(loop_wait);
            if (initEnv() || initConfig()) return;
            await main();
        }
        log.info('结束运行', '未在my_config.js中设置休眠时间');
    }

    process.exit(0);
})();
