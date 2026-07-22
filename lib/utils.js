const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { send } = require('./net/http');
const { version } = require('../package.json');

/**
 * 基础工具
 */
const utils = {
    version,
    /**环境变量设置文件 */
    env_file: path.join(process.cwd(), 'env.js'),
    /**配置文件 */
    config_file: path.join(process.cwd(), 'my_config.js'),
    /**dyids存放目录 */
    dyids_dir: path.join(process.cwd(), 'dyids'),
    /**lottery_info存放目录 */
    lottery_info_dir: path.join(process.cwd(), 'lottery_info'),
    /**本地抽奖信息存放目录 */
    lottery_dyids: path.join(process.cwd(), 'lottery_dyids'),
    /**采集接管时始终沿用主采集帐号的固定快照编号。 */
    lotteryInfoNumber() {
        return Number(process.env.LOTTERY_DISCOVERY_OWNER_NUMBER || process.env.NUMBER);
    },
    /**
     * 判断动态ID是否为B站接口可接受的正64位整数。
     * number输入必须为安全整数，避免精度损坏后继续请求。
     * @param {string|number|bigint} dyid
     * @returns {boolean}
     */
    isValidDynamicId(dyid) {
        if (typeof dyid === 'number' && !Number.isSafeInteger(dyid)) return false;
        const value = String(dyid ?? '').trim();
        if (!/^[1-9]\d{0,18}$/.test(value)) return false;
        try {
            return BigInt(value) <= 9223372036854775807n;
        } catch (_) {
            return false;
        }
    },
    /**
     * 将版本号转为数字
     * @example
     * 1.2.3 => 1.0203
     * @param {string} version
     * @returns {Number}
     */
    checkVersion(version) {
        return (version.match(/\d.*/)[0]).split('.').reduce((a, v, i) => a + (0.01 ** i) * Number(v), 0);
    },
    /**
     * 安全的将JSON字符串转为对象
     * 超出精度的数转为字符串
     * @param {string} params
     * @return {object}
     * 返回对象 解析失败返回 `{}`
     */
    strToJson(params) {
        const isJSON = (str => {
            if (typeof str === 'string') {
                try {
                    const obj = JSON.parse(str);
                    return typeof obj === 'object' ? obj : false;
                } catch (e) {
                    utils.log.error('json解析', e + '\n' + params);
                    return false;
                }
            } else {
                return false;
            }
        })(params);
        return isJSON ? isJSON : {};
    },
    /**
     * @template T
     * @param {Array<T>} iter
     * @param {(value: T) => Promise<Boolean>} fn 返回true整体退出
     */
    async try_for_each(iter, fn) {
        for (const item of iter) {
            if (await fn(item)) break;
        }
    },
    /**
     * @template T
     * @param {number} max_times
     * @param {Array<T>} unexpected
     * @param {() => Promise<T>} fn
     * @return {Promise<T | null>}
     */
    async retryfn(max_times, unexpected, fn) {
        let ret = null;
        for (let times = 0; times < max_times; times++) {
            ret = await fn();
            if (unexpected.includes(ret)) {
                utils.log.warn('自动重试', `将在 ${times + 1} 分钟后再次尝试(${times + 1}/${max_times})`);
                await utils.delay(60 * 1000 * (times + 1));
            } else {
                break;
            }
        }
        return ret;
    },
    /**
     * 函数柯里化
     * @template T
     * @param {(arg, arg) => T} func
     * 要被柯里化的函数
     * @returns {(arg) => (arg) => T)}
     * 一次接受一个参数并返回一个接受余下参数的函数
     */
    curryify(func) {
        function _c(restNum, argsList) {
            return restNum === 0 ?
                func.apply(null, argsList) :
                function (x) {
                    return _c(restNum - 1, argsList.concat(x));
                };
        }

        return _c(func.length, []);
    },
    /**
     * 延时函数
     * @param {number} [time] ms
     * @returns {Promise<void>}
     */
    delay(time = 1000) {
        utils.log.info('时延', `${~~time}ms`);
        return new Promise(resolve => setTimeout(resolve, time));
    },
    /**
     * 计数器 0..Infinity
     * @typedef Counter
     * @property {()=>Number} next
     * @property {()=>boolean} clear
     * @property {()=>Number} value
     * @returns {Counter}
     */
    counter() {
        let c = {
            i: 0,
            next: () => c.i++,
            clear: () => {
                c.i = 0;
            },
            value: () => c.i
        };
        return c;
    },
    /**
     * 无限序列
     * `[0..]`
     */
    * infiniteNumber() {
        for (let index = 0; ; index++) {
            yield index;
        }
    },
    /**
     * 随机获取数组中的一个元素
     * @template T
     * @param {T[]} arr
     * @returns {T}
     */
    getRandomOne(arr) {
        let RandomOne = null;
        if (Array.isArray(arr) && arr.length) {
            RandomOne = arr[parseInt(Math.random() * arr.length)];
        }
        return RandomOne;
    },
    /**
     * Fisher–Yates shuffle洗牌
     * @template T
     * @param {Array<T>} array
     * @return {Array<T>}
     */
    shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    },
    /**
     * 关键词判断 优先级递增
     * @param {string} text
     * @param {string[]} key_words startwith '~' 表示黑名单
     * @return {boolean}
     */
    judge(text, key_words) {
        return key_words.reduce((acc, word) => {
            word.startsWith('~')
                ? RegExp(word.slice(1)).test(text) && (acc = false)
                : RegExp(word).test(text) && (acc = true);
            return acc;
        }, false);
    },
    /**
     * 是否有指定环境变量
     * @param {string} env_name
     * @returns
     */
    hasEnv(env_name) {
        return process.env[env_name] ? true : false;
    },
    /**
     * 严格解析功能开关，避免字符串 "false" 被当成已开启。
     * @param {string} env_name
     * @param {NodeJS.ProcessEnv|object} [env]
     * @returns {boolean}
     */
    isEnvEnabled(env_name, env = process.env) {
        return /^(?:1|true|yes|on)$/i.test(String(env?.[env_name] ?? '').trim());
    },
    /**
     * 非官方抽奖的旧版本地关键词判断：所有规则均须命中。
     * @param {string} description
     * @param {string[]} patterns
     * @returns {boolean}
     */
    matchesLotteryKeywords(description, patterns) {
        if (!Array.isArray(patterns) || !patterns.length) return false;
        const text = String(description || '');
        return patterns.every(pattern => new RegExp(pattern).test(text));
    },
    /**日志 */
    log: {
        _level: 3,
        _colors: [
            chalk.hex('#64B3FF'), chalk.grey, chalk.hex('#FFA500'),
            chalk.hex('#0070BB'), chalk.hex('#48BB31'), chalk.hex('#BFFF00'), chalk.hex('#BBBB23'), chalk.hex('#FF0006')
        ],
        _iso_time: () => new Date(Date.now() + 288e5).toISOString().slice(0, -1) + '+08',
        _cache: [],
        /**
         * 初始化默认level为3
         */
        init() {
            let _level = Number(process.env.LOTTERY_LOG_LEVEL);
            this._level = isNaN(_level) ? 3 : _level;
        },
        /**
         * @param {String|Array<String>} msg
         * @param {String} [split] 分隔符
         */
        proPrint(msg, split = ' ') {
            if (msg instanceof Array) {
                msg = msg.join(split);
            }
            console.log(msg);
        },
        /**
         * @param {Array<string>} msg
         * @returns
         */
        rainbow(msg) {
            this.proPrint(msg.map(it => it.split('').map(l => chalk.hex('#89cff0')(l)).join('')), '\n');
        },
        /**
         * @param {number} done
         * @param {number} total
         * @param {number} size
         */
        progress_bar(done, total, size = 30) {
            let perc = done >= total ? 1 : done / total,
                bar = ~~(perc * size),
                status_bar = `\r[${'='.repeat(bar) + '>' + ' '.repeat(size - bar)}] ${(perc * 100 + '    ').slice(0, 4)}%`;
            process.stdout.write(status_bar);
        },
        debug(context, msg) {
            if (this._level >= 4) {
                if (msg instanceof Object) msg = JSON.stringify(msg, null, 4);
                let color_text_pair = [
                    [this._colors[0], `[${this._iso_time()}]`],
                    [this._colors[1], '[Debug]'],
                    [this._colors[2], `[帐号${process.env['NUMBER']} ${context}]`],
                    [this._colors[3], `[\n${msg}\n]`],
                ];
                this.proPrint(color_text_pair.map(([color, text]) => color(text)));
            }
        },
        debug_return(context, obj) {
            this.debug(context, obj);
            return obj;
        },
        info(context, msg) {
            if (this._level >= 3) {
                let color_text_pair = [
                    [this._colors[0], `[${this._iso_time()}]`],
                    [this._colors[1], '[Info]'],
                    [this._colors[2], `[帐号${process.env['NUMBER']} ${context}]`],
                    [this._colors[4], `[${msg}]`],
                ];
                this._cache.push(color_text_pair.map(it => it[1]).join(' '));
                this.proPrint(color_text_pair.map(([color, text]) => color(text)));
            }
        },
        notice(context, msg) {
            if (this._level >= 2) {
                let color_text_pair = [
                    [this._colors[0], `[${this._iso_time()}]`],
                    [this._colors[1], '[Notice]'],
                    [this._colors[2], `[帐号${process.env['NUMBER']} ${context}]`],
                    [this._colors[5], `[${msg}]`],
                ];
                this._cache.push(color_text_pair.map(it => it[1]).join(' '));
                this.proPrint(color_text_pair.map(([color, text]) => color(text)));
            }
        },
        warn(context, msg) {
            if (this._level >= 1) {
                let color_text_pair = [
                    [this._colors[0], `[${this._iso_time()}]`],
                    [this._colors[1], '[Warn]'],
                    [this._colors[2], `[帐号${process.env['NUMBER']} ${context}]`],
                    [this._colors[6], `[\n${msg}\n]`],
                ];
                this._cache.push(color_text_pair.map(it => it[1]).join(' '));
                this.proPrint(color_text_pair.map(([color, text]) => color(text)));
            }
        },
        error(context, msg) {
            if (this._level >= 0) {
                let color_text_pair = [
                    [this._colors[0], `[${this._iso_time()}]`],
                    [this._colors[1], '[Error]'],
                    [this._colors[2], `[帐号${process.env['NUMBER']} ${context}]`],
                    [this._colors[7], `[\n${msg}\n]`],
                ];
                this._cache.push(color_text_pair.map(it => it[1]).join(' '));
                this.proPrint(color_text_pair.map(([color, text]) => color(text)));
            }
        }
    },
    /**
     * 验证码识别
     * @param {string} url
     * @returns {Promise<string>}
     */
    ocr(url) {
        return new Promise((resolve) => {
            send({
                method: 'POST',
                url: process.env['CHAT_CAPTCHA_OCR_URL'] || 'http://127.0.0.1:9898/ocr/url/text',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                },
                contents: { url },
                success: res => {
                    resolve(res.body);
                },
                failure: () => {
                    resolve(null);
                }
            });
        });
    },
    /**
     * 下载文件
     * @param {string} url
     * @param {string} file_name
     * @param {number} size
     * @returns {Promise<void | string>}
     */
    download(url, file_name, size) {
        return new Promise((resolve, reject) => {
            send({
                url,
                stream: true,
                config: {
                    redirect: true,
                    retry: false
                },
                success: ({ headers, resStream }) => {
                    const total_len = Number(headers['content-length']) || 16000000;
                    let recv_length = 0;
                    const wtbs = fs.createWriteStream(file_name);
                    resStream.on('data', chuck => {
                        recv_length += chuck.length;
                        utils.log.progress_bar(recv_length, total_len);
                    });
                    resStream.pipe(wtbs);
                    wtbs.on('finish', () => {
                        utils.log.proPrint('下载完成');
                        if (recv_length < size) {
                            reject(`未正确下载文件: ${recv_length}B < ${size}B`);
                        }
                        resolve();
                    }).on('error', error => {
                        wtbs.destroy();
                        reject(error);
                    });
                },
                failure: error => {
                    reject(error);
                }
            });
        });
    },
    /**
     * 是否存在文件或目录
     * @param {string} path
     * @returns
     */
    hasFileOrDir(path) {
        try {
            fs.accessSync(path, fs.constants.F_OK);
        } catch (_) {
            return false;
        }
        return true;
    },
    /**
     * 生成文件夹
     * @param {string} dirname
     * @returns {Promise<void>}
     */
    createDir(dirname) {
        return new Promise((resolve) => {
            fs.stat(dirname, (err) => {
                if (err) {
                    fs.mkdirSync(dirname);
                }
                resolve();
            });
        });
    },
    /**
     * CreateFile
     * @param {string} basename
     * @param {string} filename
     * @param {string} [defaultValue] 写入默认值
     * @param {string} flag
     * @returns {Promise<void>}
     */
    createFile(basename, filename, defaultValue, flag) {
        const fpath = path.join(basename, filename);
        const buffer = Buffer.from(defaultValue);
        return new Promise((resolve, rejects) => {
            fs.open(fpath, flag, (err, fd) => {
                if (err) {
                    rejects(err);
                } else {
                    fs.write(fd, buffer, 0, buffer.length, 0, err => {
                        fs.close(fd);
                        if (err) {
                            rejects(err);
                        } else {
                            resolve();
                        }
                    });
                }
            });
        });
    },
    /**
     * 读取dyid文件
     * @param {number} num
     * @returns {fs.ReadStream}
     */
    readDyidFile(num) {
        const fpath = num < 2 ? path.join(utils.dyids_dir, 'dyid.txt') : path.join(utils.dyids_dir, `dyid${num}.txt`);
        return fs.createReadStream(fpath, { encoding: 'utf8' });
    },
    /**
     * 追加dyid
     * @param {number} num
     * @returns {fs.WriteStream}
     */
    writeDyidFile(num) {
        const fpath = num < 2 ? path.join(utils.dyids_dir, 'dyid.txt') : path.join(utils.dyids_dir, `dyid${num}.txt`);
        return fs.createWriteStream(fpath, { flags: 'a' });
    },
    /**
     * 追加lotteryinfo
     * @param {string} from
     * @param {import('./core/searcher').LotteryInfo[]} lottery_info
     * @return {Promise<void>}
     */
    async appendLotteryInfoFile(from, lottery_info) {
        let all_lottery_info = {};
        const number = utils.lotteryInfoNumber();
        const filename = `lottery_info_${number}.next.json`;
        try {
            all_lottery_info = utils.strToJson(fs.readFileSync(path.join(utils.lottery_info_dir, filename)).toString());
        } catch (_) {
            all_lottery_info = {};
        }
        await utils.createDir(utils.lottery_info_dir);
        /* 来源级覆盖使resume重复执行同一来源时保持幂等。 */
        all_lottery_info[from] = lottery_info;
        const targetPath = path.join(utils.lottery_info_dir, filename);
        const temporaryPath = `${targetPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(all_lottery_info));
        fs.renameSync(temporaryPath, targetPath);
    },
    /**
     * 读取lottery_info
     * @param {string} filename
     * @return {Promise<import('./core/searcher').LotteryInfo[]>}
     */
    readLotteryInfoFile(filename) {
        return new Promise((resolve) => {
            fs.readFile(path.join(utils.lottery_info_dir, filename), (err, data) => {
                if (err) {
                    resolve([]);
                } else {
                    let all_lottery_info = utils.strToJson(data.toString('utf8'));
                    resolve(Object.values(all_lottery_info).flat());
                }
            });
        });
    },
    /**
     * 清空lottery_info file
     */
    async clearLotteryInfo() {
        await utils.createDir(utils.lottery_info_dir);
        const number = utils.lotteryInfoNumber();
        await utils.createFile(utils.lottery_info_dir, `lottery_info_${number}.next.json`, '{}', 'w');
    },
    /**
     * 完整扫描结束后提交本轮抽奖信息
     * - 新结果先写入 next 文件，避免中途失败清空上一份有效数据
     * - 仅提交本轮扫描结果，形成供所有帐号使用的固定快照
     * - 上一份有效结果另存为 last-good，不混入本轮快照
     * - 同目录rename保证正式文件原子替换
     * @param {number} maxAgeDays 最多保留多少天的历史动态
     * @returns {Promise<boolean>}
     */
    async commitLotteryInfo(maxAgeDays = Infinity) {
        const number = utils.lotteryInfoNumber(),
            finalFilename = `lottery_info_${number}.json`,
            nextFilename = `lottery_info_${number}.next.json`,
            commitFilename = `lottery_info_${number}.commit.json`,
            backupFilename = `lottery_info_${number}.last-good.json`,
            finalPath = path.join(utils.lottery_info_dir, finalFilename),
            nextPath = path.join(utils.lottery_info_dir, nextFilename),
            commitPath = path.join(utils.lottery_info_dir, commitFilename);

        let nextObject = {};
        try {
            nextObject = utils.strToJson(fs.readFileSync(nextPath).toString());
        } catch (_) {
            nextObject = {};
        }

        const rawNextItems = Object.values(nextObject)
            .flat()
            .filter(item => item && typeof item === 'object');
        const nextItems = rawNextItems.filter(item => utils.isValidDynamicId(item.dyid));
        const invalidCount = rawNextItems.length - nextItems.length;
        if (invalidCount) {
            utils.log.warn('保存抽奖信息', `过滤无效动态ID(${invalidCount})`);
        }
        if (!nextItems.length) {
            utils.log.warn('保存抽奖信息', '本轮没有得到有效结果，继续保留上一份共享文件');
            if (fs.existsSync(nextPath)) fs.unlinkSync(nextPath);
            return false;
        }

        const ageDays = Number(maxAgeDays),
            cutoff = Number.isFinite(ageDays)
                ? Date.now() / 1000 - ageDays * 86400
                : -Infinity,
            lotteryMap = new Map();

        for (const item of nextItems) {
            if (item.create_time && item.create_time < cutoff) continue;
            const dyid = String(item.dyid);
            if (!lotteryMap.has(dyid)) lotteryMap.set(dyid, item);
        }

        await utils.createFile(
            utils.lottery_info_dir,
            commitFilename,
            JSON.stringify({ shared: [...lotteryMap.values()] }),
            'w'
        );
        if (fs.existsSync(finalPath)) {
            fs.copyFileSync(finalPath, path.join(utils.lottery_info_dir, backupFilename));
        }
        fs.renameSync(commitPath, finalPath);
        if (fs.existsSync(nextPath)) fs.unlinkSync(nextPath);
        utils.log.info(
            '保存抽奖信息',
            `本轮固定快照更新完成，采集${nextItems.length}条，去重后${lotteryMap.size}条`
        );
        return true;
    },
    /**
     * 获取含抽奖dyids
     * @param {string} filename
     * @returns {Promise<Array<String>>}
     */
    getLocalLotteryTxt(filename) {
        return new Promise((resolve) => {
            fs.readFile(path.join(utils.lottery_dyids, filename), (err, data) => {
                if (err) {
                    resolve([]);
                } else {
                    resolve(data.toString('utf8').split(/[^0123456789]+/));
                }
            });
        });
    },
    getIpInfo() {
        return new Promise((resolve) => {
            send({
                url: 'https://myip.qq.com/',
                method: 'GET',
                success: res => resolve(res.body),
                failure: err => resolve(err)
            });
        });
    },
    printIpInfo(beforeProxy) {
        const printMessage = beforeProxy ? '当前IP----->' : '代理后IP=======>';
        utils.getIpInfo().then(res => {
            console.log(printMessage + res);
        }).catch((err) => {
            console.error('获取' + printMessage + '地址失败', err);
        });
    },
    /**
     * 获取ai
     * @param {string} url
     * @param {object} body
     * @param {string} prompt
     * @param {string} content
     * @returns {Promise<string|null>}
     */
    getAiContent(url, body, prompt, content) {
        return new Promise((resolve) => {
            send({
                method: 'POST',
                url,
                headers: {
                    'authorization': 'Bearer ' + process.env.AI_API_KEY,
                    'content-type': 'application/json'
                },
                config: {
                    timeout: 120000
                },
                contents: {
                    ...body,
                    'stream': false,
                    'response_format': { 'type': 'text' },
                    'messages': [
                        {
                            'role': 'system',
                            'content': prompt
                        },
                        {
                            'role': 'user',
                            'content': content
                        }
                    ]
                },
                success: res => {
                    const data = utils.strToJson(res.body);
                    resolve(utils.log.debug_return(content, data?.choices?.[0]?.message?.content) || null);
                },
                failure: () => {
                    resolve(null);
                }
            });
        });
    },
};


module.exports = utils;
