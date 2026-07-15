const GlobalVar = require('../data/global_var');
const { strToJson, log, ocr, hasEnv, delay } = require('../utils');
const { send } = require('./http');
const API = require('./api.bili');
const config = require('../data/config');

const DEFAULT_DYNAMIC_DETAIL_412_THRESHOLD = 10;
const DEFAULT_DYNAMIC_DETAIL_412_COOLDOWN = 10 * 60 * 1000;
const DEFAULT_ARTICLE_CONTENT_MAX_ATTEMPTS = 2;
const DEFAULT_ARTICLE_CONTENT_RETRY_WAIT = 5 * 1000;
const DEFAULT_ARTICLE_SEARCH_412_COOLDOWNS = [
    2 * 60 * 1000,
    3 * 60 * 1000,
    5 * 60 * 1000,
];
const DYNAMIC_DETAIL_TRANSIENT_FAILURE = Symbol('dynamic-detail-transient-failure');

function parseBiliJson(responseText) {
    if (typeof responseText !== 'string') return null;
    try {
        return JSON.parse(responseText);
    } catch (_) {
        const jsonStart = responseText.lastIndexOf('{"code"');
        if (jsonStart < 0) return null;
        try {
            return JSON.parse(responseText.slice(jsonStart).trim());
        } catch (_) {
            return null;
        }
    }
}

function summarizeBiliResponse(responseText, parsedResponse = null) {
    const status = typeof responseText === 'string'
        ? (responseText.match(/HTTP状态码:\s*\d+/) || [])[0]
        : '';
    if (parsedResponse && typeof parsedResponse.code !== 'undefined') {
        return [status, `code=${parsedResponse.code}`, parsedResponse.message]
            .filter(Boolean)
            .join(', ');
    }
    return status || '响应不是有效JSON';
}

function isDynamicDetail412(responseText) {
    return /HTTP状态码:\s*412|"code"\s*:\s*-412\b|request was banned/i.test(responseText);
}

function isUsableArticleContent(content) {
    return typeof content === 'string'
        && content.length >= 8000
        && /opus-text-rich|article-content|article-holder|__INITIAL_STATE__/i.test(content)
        && !/request was banned|HTTP状态码:\s*412/i.test(content);
}

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? Math.floor(number)
        : fallback;
}

function getArticleSearch412Cooldown(failureCount) {
    const configured = Array.isArray(config.article_search_412_cooldowns)
        ? config.article_search_412_cooldowns
            .map(value => positiveInteger(value, 0))
            .filter(Boolean)
        : [];
    const cooldowns = configured.length
        ? configured
        : DEFAULT_ARTICLE_SEARCH_412_COOLDOWNS;
    const index = Math.min(
        Math.max(0, positiveInteger(failureCount, 1) - 1),
        cooldowns.length - 1
    );
    return cooldowns[index];
}

function normalizeArticleOpusUrl(location, articleUrl) {
    try {
        const opusUrl = new URL(location, articleUrl);
        if ((opusUrl.hostname === 'bilibili.com'
            || opusUrl.hostname.endsWith('.bilibili.com'))
            && /^\/opus\/\d+/.test(opusUrl.pathname)) {
            return opusUrl.href;
        }
    } catch (_) {
        // 没有有效重定向地址
    }
    return '';
}

function markDiscoveryIncomplete(reason) {
    if (!process.env.LOTTERY_DISCOVERY_ONLY) return;
    GlobalVar.set('discoveryIncomplete', true);
    const reasons = GlobalVar.get('discoveryIncompleteReasons') || [];
    if (!reasons.includes(reason)) reasons.push(reason);
    GlobalVar.set('discoveryIncompleteReasons', reasons);
}

class DynamicDetailCircuitBreaker {
    constructor() {
        this.reset();
    }

    get threshold() {
        const threshold = Number(config.dynamic_detail_412_threshold);
        return Number.isFinite(threshold) && threshold > 0
            ? Math.floor(threshold)
            : DEFAULT_DYNAMIC_DETAIL_412_THRESHOLD;
    }

    get cooldown() {
        const cooldown = Number(config.dynamic_detail_412_cooldown);
        return Number.isFinite(cooldown) && cooldown > 0
            ? cooldown
            : DEFAULT_DYNAMIC_DETAIL_412_COOLDOWN;
    }

    reset() {
        this.consecutive412 = 0;
        this.openUntil = 0;
        this.probing = false;
    }

    canRequest(now = Date.now()) {
        if (!this.openUntil) return { allowed: true, probe: false };
        if (now < this.openUntil) return { allowed: false, probe: false };

        this.openUntil = 0;
        this.probing = true;
        return { allowed: true, probe: true };
    }

    recordSuccess() {
        const recovered = this.probing || this.consecutive412 > 0;
        this.reset();
        return { recovered };
    }

    recordFailure(responseText, now = Date.now()) {
        if (!isDynamicDetail412(responseText)) {
            this.consecutive412 = 0;
            this.probing = false;
            return { is412: false, opened: false, count: 0 };
        }

        this.consecutive412 += 1;
        const opened = this.probing || this.consecutive412 >= this.threshold;
        if (opened) {
            this.openUntil = now + this.cooldown;
            this.probing = false;
        }

        return {
            is412: true,
            opened,
            count: this.consecutive412,
            remainingMs: this.remainingMs(now)
        };
    }

    isOpen(now = Date.now()) {
        return this.openUntil > now;
    }

    remainingMs(now = Date.now()) {
        return Math.max(0, this.openUntil - now);
    }
}

const dynamicDetailCircuitBreaker = new DynamicDetailCircuitBreaker();

function recordShared412(responseText, scope) {
    const failure = dynamicDetailCircuitBreaker.recordFailure(responseText);
    if (!failure.is412) return failure;

    markDiscoveryIncomplete(`${scope}返回HTTP 412`);
    if (failure.opened) {
        log.warn(
            `${scope}熔断`,
            `连续${failure.count}次收到412，暂停相关B站请求${Math.ceil(failure.remainingMs / 60000)}分钟`
        );
    } else {
        log.warn(
            `${scope}熔断`,
            `收到412 (${failure.count}/${dynamicDetailCircuitBreaker.threshold})`
        );
    }
    return failure;
}

function parseArticleSearchResponse(responseText, keyword) {
    if (isDynamicDetail412(responseText)) {
        log.warn('专栏搜索重试', `关键词${keyword}收到412，等待受控重试`);
        return [];
    }

    const res = strToJson(responseText);
    if (res.code === 0 && res.data && Array.isArray(res.data.result)) {
        if (dynamicDetailCircuitBreaker.recordSuccess().recovered) {
            log.info('专栏搜索熔断', 'B站请求已恢复');
        }
        log.info('搜索专栏', '成功 关键词: ' + keyword);
        return res.data.result.map(it => ({
            pub_time: it.pub_time,
            id: it.id
        }));
    }

    dynamicDetailCircuitBreaker.recordFailure(responseText);
    markDiscoveryIncomplete(`专栏搜索失败(${keyword})`);
    log.error('搜索专栏', '失败 原因:\n' + responseText);
    return [];
}

async function searchArticlesWithRetry(keyword, requestFn, waitFn = delay) {
    let failureCount = 0;

    for (;;) {
        const gate = dynamicDetailCircuitBreaker.canRequest();
        if (!gate.allowed) {
            const remainingMs = dynamicDetailCircuitBreaker.remainingMs();
            log.warn(
                '专栏搜索重试',
                `共享熔断仍在冷却，${Math.ceil(remainingMs / 1000)}秒后重试关键词${keyword}`
            );
            await waitFn(Math.max(1, remainingMs));
            continue;
        }
        if (gate.probe) {
            log.info('专栏搜索重试', '共享熔断冷却结束，放行一次探测请求');
        }

        let responseText;
        try {
            responseText = await requestFn();
        } catch (error) {
            markDiscoveryIncomplete(`专栏搜索异常(${keyword})`);
            log.error('搜索专栏', `请求异常: ${error.message || error}`);
            return [];
        }

        if (!isDynamicDetail412(responseText)) {
            return parseArticleSearchResponse(responseText, keyword);
        }

        failureCount += 1;
        let cooldown = getArticleSearch412Cooldown(failureCount);
        if (gate.probe) {
            const failure = dynamicDetailCircuitBreaker.recordFailure(responseText);
            cooldown = Math.max(cooldown, failure.remainingMs || 0);
        }
        log.warn(
            '专栏搜索重试',
            `关键词${keyword}第${failureCount}次收到412，${Math.ceil(cooldown / 60000)}分钟后只重试该关键词`
        );
        await waitFn(cooldown);
    }
}

class Line {
    /**
     * 智能线路切换
     * @typedef {boolean} iSwitch 是否切换
     * @typedef {string} Msg 信息说明
     * @typedef {[iSwitch, any, Msg]} ResResult
     * @param {string} line_name
     * @param {Array<(...arg) => Promise<ResResult | string>>} requests
     * @param {(responseText: string) => ResResult} [pub_handler]
     */
    constructor(line_name, requests, pub_handler) {
        this.line_name = line_name;
        this.requests = requests;
        this.valid_line = 0;
        this.switch_times = 0;
        if (pub_handler) this.pub_handler = pub_handler;
        /**
         * @type {ResResult}
         */
        this.res_result = [false, null, ''];
    }

    /**
     * 切换线路
     * @returns {boolean}
     */
    switchLine() {
        const { valid_line, requests: { length }, switch_times } = this;
        this.valid_line = (valid_line + 1) % length;
        this.switch_times += 1;
        if (switch_times > length) {
            return false;
        } else {
            return true;
        }
    }

    /**
     * 存储当前有效线路
     * @param {number} line
     */
    storeLine(line) {
        this.valid_line = line;
        this.switch_times = 0;
    }

    /**
     * 启动
     * @param  {...any} args
     * @returns {Promise<any>}
     */
    async run(...args) {
        const
            { line_name, requests, valid_line } = this,
            resp = await requests[valid_line](...args);
        if (typeof resp === 'string') {
            this.res_result = this.pub_handler(resp);
        } else {
            this.res_result = resp;
        }
        const [i_switch, value, msg] = this.res_result;
        if (!i_switch) {
            log.info(line_name, msg);
            this.storeLine(valid_line);
            return value;
        }
        if (this.switchLine()) {
            log.warn(line_name, msg);
            log.warn(line_name, `切换线路(${valid_line + 1}/${requests.length})`);
            return await this.run();
        } else {
            log.error(line_name, msg);
            log.error(line_name, '所有备用线路均连接失败');
            return value;
        }
    }
}

/**
 * GET请求
 * @param {import('./http').RequestOptions} param0
 * @returns {Promise<string>}
 */
function get({ url, config, contents, query }) {
    return new Promise((resolve) => {
        send({
            url,
            method: 'GET',
            config,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'cookie': GlobalVar.get('cookie')
            },
            query,
            contents,
            success: res => resolve(log.debug_return(url, res.body)),
            failure: err => resolve(log.debug_return(url, err))
        });
    });
}

/**
 * POST请求
 * @param {import('./http').RequestOptions} param0
 * @returns {Promise<string>}
 */
function post({ url, config, contents, query }) {
    return new Promise((resolve) => {
        send({
            url,
            method: 'POST',
            config,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'cookie': GlobalVar.get('cookie')
            },
            query,
            contents,
            success: res => resolve(log.debug_return(url, res.body)),
            failure: err => resolve(log.debug_return(url, err))
        });
    });
}

/**
 * 网络请求
 */
const bili_client = {
    /**
     * 判断是否成功登录
     * @returns {Promise<Object?>}
     */
    async getMyinfo() {
        const
            responseText = await get({
                url: API.SPACE_MYINFO
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            GlobalVar.set('myUNAME', res.data.name);
            return res.data;
        } else {
            return null;
        }
    },
    /**
     * 帐号统计
     * @returns {Promise<Object?>}
     */
    async getStat() {
        const
            responseText = await get({
                url: API.WEB_INTERFACE_NAV_STAT
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            return res.data;
        } else {
            return null;
        }
    },
    /**
     * 获取被at的信息
     * @typedef AtInfo
     * @property {number} at_time
     * @property {string} up_uname
     * @property {string} business
     * @property {string} source_content
     * @property {string} url
     * @returns {Promise<AtInfo[]>}
     */
    async getMyAtInfo() {
        const
            responseText = await get({
                url: API.MSGFEED_AT
            }),
            res = strToJson(responseText);
        let atInfo = [];
        if (res.code === 0) {
            const items = res.data.items;
            if (items.length !== 0) {
                items.forEach(i => {
                    const { at_time, item, user } = i, { nickname: up_uname } = user, { business, uri: url, source_content } = item;
                    atInfo.push({
                        at_time,
                        up_uname,
                        business,
                        source_content,
                        url
                    });
                });
            }
            return atInfo;
        } else {
            return atInfo;
        }
    },
    /**
     * 获取未读信息数量
     * @returns {Promise<{at: number, reply: number}>}
     */
    async getUnreadNum() {
        const
            responseText = await get({
                url: API.MSGFEED_UNREAD
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('获取未读信息', '成功');
            return res.data;
        } else {
            log.error('获取未读信息', `失败\n${responseText}`);
            return {};
        }
    },
    /**
     * 获取一页回复
     * @returns {Promise<Array<{nickname: string, source: string, uri: string, timestamp: number}>}>}
     */
    async getReplyMsg() {
        const
            responseText = await get({
                url: API.MSGFEED_REPLAY
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            const data = res.data || {},
                items = data.items || [];
            log.info('获取一页回复', `成功(${items.length})`);
            return items
                .filter(it => it.item !== undefined
                    && it.user !== undefined
                    && it.reply_time !== undefined)
                .map(it => {
                    return {
                        nickname: it.user.nickname,
                        source: it.item.source_content,
                        uri: it.item.uri,
                        timestamp: it.reply_time
                    };
                });
        } else {
            log.error('获取一页回复', '失败');
            return [];
        }
    },
    /**
     * 获取一页私信
     * @typedef SessionData
     * @property {string} session_ts
     * @property {number} timestamp
     * @property {number} unread_count
     * @property {number} sender_uid
     * @property {number} talker_id
     * @property {number} msg_seqno
     *
     * @typedef SessionInfo
     * @property {number} has_more
     * @property {SessionData[]} data
     *
     * @param {number} session_type 1 已关注 2 未关注 3 应援团
     * @param {string} [ts_16]
     * @returns {Promise<SessionInfo>}
     */
    async getSessionInfo(session_type, ts_16 = '') {
        const
            responseText = await get({
                url: API.SESSION_SVR_GET_SESSIONS,
                query: {
                    session_type,
                    end_ts: ts_16,
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('获取一页私信(20)', '成功 ' + (ts_16 ? 'end_ts->' + ts_16 : '第一页'));
            /**@type {Array} */
            const
                sessions = res.data.session_list || [],
                has_more = res.data.has_more,
                data = sessions.map(session => {
                    const
                        { session_ts, last_msg, unread_count, talker_id } = session,
                        { timestamp = 0, sender_uid = 0, msg_seqno } = last_msg || {};
                    return { session_ts, timestamp, sender_uid, unread_count, talker_id, msg_seqno };
                });
            return { has_more, data };
        } else if (res.code === 2) {
            log.error('获取私信', 'API抽风...请再次尝试');
            return { has_more: 0, data: [] };
        } else {
            log.error('获取私信', `失败\n${responseText}`);
            return { has_more: 0, data: [] };
        }
    },
    /**
     * 获取私信细节
     * @param {number} talker_id
     * @param {number} size
     */
    async fetch_session_msgs(talker_id, size) {
        const
            responseText = await get({
                url: API.FETCH_SESSION_MSGS,
                query: {
                    talker_id,
                    session_type: 1,
                    size
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            const msgs = res.data.messages;
            if (msgs instanceof Array) {
                log.info('私信细节', `${talker_id}有${size}条未读私信`);
                return msgs.filter(it => ![8].includes(it.msg_source)).map(it => it.content).join('\n');
            } else {
                log.warn('私信细节', `${talker_id}无私信`);
            }
        }
        log.error('私信细节', '获取失败');
        return '';
    },
    /**
     * 获取未读私信数量
     * @returns {Promise<{ unfollow_unread: number, follow_unread: number }>}
     */
    async getUnreadSessionNum() {
        const
            responseText = await get({
                url: API.SESSION_SVR_SINGLE_UNREAD
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            const { unfollow_unread = 0, follow_unread = 0 } = res.data;
            log.info('获取未读私信', `成功 已关注未读数: ${follow_unread}, 未关注未读数 ${unfollow_unread}`);
            return { unfollow_unread, follow_unread };
        } else {
            log.error('获取未读私信', `失败\n${responseText}`);
            return null;
        }
    },
    /**
     * 私信已读
     * @param {number} talker_id
     * @param {number} session_type
     * @param {number} msg_seqno
     */
    async updateSessionStatus(talker_id, session_type, msg_seqno) {
        const
            responseText = await post({
                url: API.SESSION_SVR_UPDATE_ACK,
                config: {
                    retry: false
                },
                contents: {
                    talker_id,
                    session_type,
                    ack_seqno: msg_seqno,
                    csrf_token: GlobalVar.get('csrf'),
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('私信已读', `成功 -> talker_id: ${talker_id}`);
        } else {
            log.error('私信已读', `失败 -> talker_id: ${talker_id}\n${responseText}`);
        }
    },
    /**
     * 获取关注列表
     * @param {number} uid
     * @returns {Promise<string | null>}
     */
    async getAttentionList(uid) {
        const
            responseText = await get({
                url: API.FEED_GET_ATTENTION_LIST,
                query: {
                    uid
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('获取关注列表', '成功');
            return res.data.list.toString();
        } else {
            log.error('获取关注列表', `失败\n${responseText}`);
            return null;
        }
    },
    /**
     * @param {string} short_id
     * @returns {Promise<string>}
     */
    async shortDynamicIdToDyid(short_id) {
        return get({
            url: API.SHORTLINK.replace('{{short_id}}', short_id),
            config: {
                redirect: false,
            }
        }).then(a => {
            const dyid = (a.match(/[0-9]{18,}/) || [])[0];
            log.info('短连接转换', `${short_id} -> ${dyid}`);
            return dyid;
        });
    },
    _getOneDynamicByDyid: new Line(
        '获取一个动态的细节',
        [
            (id) => get({
                url: API.X_POLYMER_WEB_DYNAMIC_V1_DETAIL,
                config: { retry: false },
                query: {
                    id,
                    features: 'itemOpusStyle'
                }
            }),
        ]
        , responseText => {
            if (isDynamicDetail412(responseText)) {
                const failure = recordShared412(responseText, '动态详情');
                return [
                    false,
                    undefined,
                    failure.opened
                        ? '触发412软熔断'
                        : `收到412 (${failure.count}/${dynamicDetailCircuitBreaker.threshold})`
                ];
            }

            const res = parseBiliJson(responseText);
            if (!res) {
                return [
                    false,
                    undefined,
                    `响应不可用，跳过 (${summarizeBiliResponse(responseText)})`
                ];
            }

            const { code, data, message } = res;
            switch (code) {
                case 0:
                    if (dynamicDetailCircuitBreaker.recordSuccess().recovered) {
                        log.info('动态详情熔断', '动态详情请求已恢复');
                    }
                    return [false, data, 'ok'];
                case 4101139:
                case 500:
                    dynamicDetailCircuitBreaker.recordFailure(responseText);
                    return [
                        false,
                        DYNAMIC_DETAIL_TRANSIENT_FAILURE,
                        `临时错误 (${summarizeBiliResponse(responseText, res)})`
                    ];
                case 4101152:
                case -404:
                    dynamicDetailCircuitBreaker.recordFailure(responseText);
                    return [
                        false,
                        undefined,
                        `动态不可用，跳过 (code=${code}${message ? `, ${message}` : ''})`
                    ];
                default:
                    dynamicDetailCircuitBreaker.recordFailure(responseText);
                    return [
                        false,
                        undefined,
                        `请求失败，跳过 (${summarizeBiliResponse(responseText, res)})`
                    ];
            }
        }),
    /**
     * 获取一个动态的细节
     * @param {string} dynamic_id
     * @return {Promise<JSON>} 失败返回undefined
     */
    async getOneDynamicByDyid(dynamic_id) {
        const gate = dynamicDetailCircuitBreaker.canRequest();
        if (!gate.allowed) return undefined;
        if (gate.probe) {
            log.info('动态详情熔断', '冷却结束，放行一次探测请求');
        }
        let result = await this._getOneDynamicByDyid.run(dynamic_id);
        if (result !== DYNAMIC_DETAIL_TRANSIENT_FAILURE) return result;

        const retryWait = positiveInteger(config.get_dynamic_detail_wait, 8 * 1000);
        log.warn(
            '动态详情重试',
            `dyid(${dynamic_id})遇到临时错误，${Math.ceil(retryWait / 1000)}秒后重试一次`
        );
        await delay(retryWait);

        const retryGate = dynamicDetailCircuitBreaker.canRequest();
        if (!retryGate.allowed) return undefined;
        if (retryGate.probe) {
            log.info('动态详情熔断', '冷却结束，放行一次探测请求');
        }
        result = await this._getOneDynamicByDyid.run(dynamic_id);
        if (result === DYNAMIC_DETAIL_TRANSIENT_FAILURE) {
            log.warn('动态详情重试', `dyid(${dynamic_id})重试后仍失败，本轮跳过`);
            return undefined;
        }
        return result;
    },
    isDynamicDetailCircuitOpen() {
        return dynamicDetailCircuitBreaker.isOpen();
    },
    getDynamicDetailCircuitRemainingMs() {
        return dynamicDetailCircuitBreaker.remainingMs();
    },
    _dynamicDetailCircuitBreaker: dynamicDetailCircuitBreaker,
    /**
     * 获取一组动态的信息
     * @param {number} host_uid 被查看者的uid
     * @param {string} offset_dynamic_id 此动态偏移量 初始为 0
     * @returns {Promise<string>}
     */
    getOneDynamicInfoByUID(host_mid, offset) {
        /* 鉴别工作交由modifyDynamicRes完成 */
        /* 新版似乎没有 visitor_uid */
        const query = {
            host_mid,
            timezone_offset: -480,
            features: [
                'itemOpusStyle', 'listOnlyfans', 'opusBigCover', 'onlyFansVote',
                'decorationCard', 'forwardListHidden', 'ugcDelete', 'onlyFansQaCard',
                'commentsNewVersion', 'onlyFansAssetsV2', 'onlyFansVoteV2',
                'opusCollectionNew'
            ].join(','),
            web_location: '333.1387'
        };
        /**首次请求不能携带空 offset，否则可能返回 -352 */
        if (offset) query.offset = offset;
        return get({
            url: API.X_POLYMER_WEB_DYNAMIC_V1_FEED_SPACE,
            query,
            config: {
                retry: false
            }
        });
    },
    /**
     * 通过tag名获取tag的id
     * @param {string} tag_name
     * tag名
     * @returns {Promise<number | -1>}
     * 正确:tag_ID
     * 错误:-1
     */
    async getTagIDByTagName(tag_name) {
        const responseText = await get({
                url: API.TAG_INFO,
                query: {
                    tag_name
                },
                config: {
                    retry: false
                }
            });
        const res = parseBiliJson(responseText);
        if (!res || res.code !== 0 || !res.data || !res.data.tag_id) {
            log.warn(
                '获取TagID',
                `话题#${tag_name}#接口不可用，跳过 (${summarizeBiliResponse(responseText, res)})`
            );
            return -1;
        } else {
            return res.data.tag_id;
        }
    },
    /**
     * 获取tag下的热门动态以及一条最新动态
     * @param {number} tagid
     * @returns {Promise<string>}
     */
    async getHotDynamicInfoByTagID(tagid) {
        const responseText = await get({
            url: API.TOPIC_SVR_TOPIC_NEW,
            query: {
                topic_id: tagid
            },
            config: {
                retry: false
            }
        });
        const res = parseBiliJson(responseText);
        if (!res || res.code !== 0) {
            log.warn('获取话题动态', `热门接口不可用，跳过 (${summarizeBiliResponse(responseText, res)})`);
            return null;
        }
        return responseText;
    },
    /**
     * 获取tag下的最新动态
     * @param {string} tagname
     * @param {string} offset
     * @returns {Promise<string>}
     */
    async getOneDynamicInfoByTag(tagname, offset) {
        const responseText = await get({
            url: API.TOPIC_SVR_TOPIC_HISTORY,
            query: {
                topic_name: tagname,
                offset_dynamic_id: offset
            },
            config: {
                retry: false
            }
        });
        const res = parseBiliJson(responseText);
        if (!res || res.code !== 0) {
            log.warn(
                '获取话题动态',
                `话题#${tagname}#分页接口不可用，停止读取 (${summarizeBiliResponse(responseText, res)})`
            );
            return null;
        }
        return responseText;
    },
    /**
     * 搜索专栏
     * @param {string} keyword
     * @return {Promise<Array<{pub_time: number, id: number}>>}
     */
    async searchArticlesByKeyword(keyword) {
        return searchArticlesWithRetry(
            keyword,
            () => get({
                url: API.WEB_INTERFACE_SEARCH_TYPE,
                query: {
                    keyword,
                    page: 1,
                    order: 'pubdate',
                    search_type: 'article'
                },
                config: {
                    retry: false
                }
            })
        );
    },
    _parseArticleSearchResponse: parseArticleSearchResponse,
    _searchArticlesWithRetry: searchArticlesWithRetry,
    _getArticleSearch412Cooldown: getArticleSearch412Cooldown,
    /**
     * 获取专栏内容
     * @param {number} cv
     * @returns {Promise<string>}
     */
    _getArticleOpusUrl(cv) {
        const articleUrl = API.READ_CV.replace('{{cv}}', cv),
            redirectUrl = new URL(articleUrl);
        redirectUrl.searchParams.set('from', 'search');
        return new Promise(resolve => {
            send({
                url: redirectUrl.href,
                method: 'GET',
                config: {
                    redirect: false,
                    retry: false
                },
                headers: {
                    'accept': 'text/html,application/xhtml+xml',
                    'cookie': GlobalVar.get('cookie')
                },
                success: ({ headers }) => {
                    resolve(normalizeArticleOpusUrl(headers.location, articleUrl));
                },
                failure: () => resolve('')
            });
        });
    },
    async getOneArticleByCv(cv) {
        const articleUrl = API.READ_CV.replace('{{cv}}', cv),
            maxAttempts = positiveInteger(
                config.article_content_max_attempts,
                DEFAULT_ARTICLE_CONTENT_MAX_ATTEMPTS
            ),
            retryWait = positiveInteger(
                config.article_content_retry_wait,
                DEFAULT_ARTICLE_CONTENT_RETRY_WAIT
            );
        let requestUrl = articleUrl;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const gate = dynamicDetailCircuitBreaker.canRequest();
            if (!gate.allowed) {
                markDiscoveryIncomplete(`专栏(${cv})正文因熔断跳过`);
                log.warn('读取专栏正文', `专栏(${cv})因熔断跳过`);
                return '';
            }
            if (gate.probe) {
                log.info('读取专栏正文', '冷却结束，放行一次探测请求');
            }
            const content = await get({
                url: requestUrl,
                config: {
                    redirect: true,
                    retry: false
                }
            });
            if (isUsableArticleContent(content)) {
                if (dynamicDetailCircuitBreaker.recordSuccess().recovered) {
                    log.info('读取专栏正文', 'B站请求已恢复');
                }
                return content;
            }

            if (isDynamicDetail412(content)) {
                const failure = recordShared412(content, '专栏正文');
                if (failure.opened) break;
            }

            log.warn(
                '读取专栏正文',
                `专栏(${cv})返回内容异常(${content.length || 0}字节) (${attempt}/${maxAttempts})`
            );
            if (attempt >= maxAttempts) break;

            const opusUrl = await this._getArticleOpusUrl(cv);
            if (opusUrl) {
                requestUrl = opusUrl;
                log.info('读取专栏正文', `改用新版Opus备用入口(${opusUrl})`);
            }
            await delay(retryWait * attempt);
        }

        log.error('读取专栏正文', `专栏(${cv})正文读取失败，跳过本篇`);
        markDiscoveryIncomplete(`专栏(${cv})正文读取失败`);
        return '';
    },
    /**
     * 获取指定动态的新版Opus正文，用于合集UID来源提取正文链接
     * @param {string} dyid
     * @returns {Promise<string>}
     */
    async getOneOpusByDyid(dyid) {
        const opusUrl = API.OPUS.replace('{{dyid}}', dyid),
            maxAttempts = positiveInteger(
                config.article_content_max_attempts,
                DEFAULT_ARTICLE_CONTENT_MAX_ATTEMPTS
            ),
            retryWait = positiveInteger(
                config.article_content_retry_wait,
                DEFAULT_ARTICLE_CONTENT_RETRY_WAIT
            );

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const gate = dynamicDetailCircuitBreaker.canRequest();
            if (!gate.allowed) {
                markDiscoveryIncomplete(`合集动态(${dyid})正文因熔断跳过`);
                log.warn('读取合集正文', `合集动态(${dyid})因熔断跳过`);
                return '';
            }
            if (gate.probe) {
                log.info('读取合集正文', '冷却结束，放行一次探测请求');
            }

            const content = await get({
                url: opusUrl,
                config: {
                    redirect: true,
                    retry: false
                }
            });
            if (isUsableArticleContent(content)) {
                if (dynamicDetailCircuitBreaker.recordSuccess().recovered) {
                    log.info('读取合集正文', 'B站请求已恢复');
                }
                return content;
            }
            if (isDynamicDetail412(content)) {
                const failure = recordShared412(content, '合集正文');
                if (failure.opened) break;
            }
            log.warn(
                '读取合集正文',
                `合集动态(${dyid})返回内容异常(${content.length || 0}字节) (${attempt}/${maxAttempts})`
            );
            if (attempt < maxAttempts) await delay(retryWait * attempt);
        }

        log.warn('读取合集正文', `合集动态(${dyid})正文读取失败，跳过`);
        return '';
    },
    _isUsableArticleContent: isUsableArticleContent,
    _normalizeArticleOpusUrl: normalizeArticleOpusUrl,
    /**
     * 获取粉丝数的所有有效方式
     */
    _getUserInfo: new Line('获取粉丝数', [
        /**
         * 线路一
         * @param {number} uid
         * @returns {Promise<string>}
         */
        (uid) => get({
            url: API.WEB_INTERFACE_CARD,
            query: {
                mid: uid,
                photo: false
            },
            config: {
                retry: false
            }
        }),
        /**
         * 线路二
         * @param {number} uid
         * @returns {Promise<string>}
         */
        (uid) => get({
            url: API.RELATION_STAT,
            query: {
                vmid: uid
            }
        }),
        /**
         * 线路三
         * @param {number} uid
         * @returns {Promise<string>}
         */
        (uid) => get({
            url: 'https://tenapi.cn/bilibilifo/',
            query: {
                uid
            }
        })
    ], responseText => {
        const res = strToJson(responseText);
        if (res.code === 0) {
            return [false, res.data.follower, 'ok'];
        } else {
            return [true, -1, `出错 可能是访问过频繁\n${responseText}`];
        }
    }),
    /**
     * 获取粉丝数
     * @param {number} uid
     * @returns {Promise<number | -1>}
     */
    getUserInfo(uid) {
        return this._getUserInfo.run(uid);
    },
    /**
     * 获取开奖信息
     * @param {string} dyid
     * 动态id
     * @typedef LotteryNotice
     * @property {number} ts
     * @returns {Promise<LotteryNotice>} 开奖时间
     */
    async getLotteryNotice(dyid) {
        const
            responseText = await get({
                url: API.LOTTERY_SVR_LOTTERY_NOTICE,
                query: {
                    dynamic_id: dyid
                }
            }),
            res = strToJson(responseText);
        switch (res.code) {
            case 0:
                return {
                    ts: res.data.lottery_time
                };
            case -9999:
                log.warn('获取开奖信息', `${dyid}已撤销抽奖`);
                return {
                    ts: -9999
                };
            default:
                log.error('获取开奖信息', `${dyid}失败\n${responseText}`);
                return {
                    ts: -1
                };
        }
    },
    _autoAttention: new Line('自动关注', [
        (uid) => post({
            url: API.RELATION_MODIFY,
            config: {
                retry: false
            },
            contents: {
                fid: uid,
                act: 1,
                re_src: 0,
                csrf: GlobalVar.get('csrf')
            }
        }),
        (uid) => post({
            url: API.FEED_SETUSERFOLLOW,
            contents: {
                type: 1,
                follow: uid,
                csrf: GlobalVar.get('csrf')
            }
        }),
        (uid) => post({
            url: API.RELATION_BATCH_MODIFY,
            contents: {
                fids: uid,
                act: 1,
                re_src: 1,
                csrf: GlobalVar.get('csrf')
            }
        })
    ], responseText => {
        const res = strToJson(responseText);
        switch (res.code) {
            case 0:
                return [false, 0, '关注+1'];
            case 22002:
                return [false, 2, '您已被对方拉入黑名单'];
            case 22003:
                return [false, 3, '黑名单用户无法关注'];
            case 22015:
                return [false, 4, '账号异常'];
            case 22009:
                return [false, 5, '关注已达上限'];
            case 22014:
                return [false, 6, '已经关注用户，无法重复关注'];
            default:
                return [true, 1, `未知错误\n${responseText}`];
        }
    }),
    /**
     * 之前不检查是否重复关注
     * 自动关注
     * 并转移分组
     * @param {Number} uid
     * 被关注者的UID
     * @returns {Promise<number>}
     * - 成功 0
     * - 未知错误 1
     * - 您已被对方拉入黑名单 2
     * - 黑名单用户无法关注 3
     * - 账号异常 4
     * - 关注已达上限 5
     * - 已经关注用户 6
     */
    autoAttention(uid) {
        return this._autoAttention.run(uid);
    },
    /**
     * 移动分区
     * @param {number} uid
     * @param {number} tagid 关注分区的ID
     * @returns {Promise<number>}
     * - 成功 0
     * - 失败 1
     */
    async movePartition(uid, tagid) {
        const responseText = await post({
            url: API.RELATION_TAGS_ADDUSERS,
            contents: {
                fids: uid,
                tagids: tagid,
                csrf: GlobalVar.get('csrf')
            }
        });
        /* 重复移动code also equal 0 */
        if (/^{"code":0/.test(responseText)) {
            log.info('移动分区', 'up主分区移动成功');
            return 0;
        } else {
            log.error('移动分区', `up主分区移动失败分区 可于设置处关闭移动分区\n${responseText}`);
            return 1;
        }
    },
    /**
     * 取消关注
     * @param {number} uid
     * @returns {Promise<boolean>}
     */
    async cancelAttention(uid) {
        const
            responseText = await post({
                url: API.RELATION_MODIFY,
                config: {
                    retry: false
                },
                contents: {
                    fid: uid,
                    act: 2,
                    re_src: 0,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('自动取关', `取关成功(${uid})`);
            return true;
        } else {
            log.error('自动取关', `取关失败(${uid})\n${responseText}`);
            return false;
        }
    },
    /**
     * 动态自动点赞
     * @param {string} dyid
     * @returns {Promise<number>}
     * - 成功 0
     * - 未知错误 1
     * - 点赞异常 2
     * - 点赞频繁 3
     * - 已赞过 4
     * - 账号异常，点赞失败 5
     */
    async autolike(dyid) {
        const
            responseText = await post({
                url: API.DYNAMIC_LIKE_THUMB,
                contents: {
                    uid: GlobalVar.get('myUID'),
                    dynamic_id: dyid,
                    up: 1,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        switch (res.code) {
            case 0:
                log.info('自动点赞', '点赞成功');
                return 0;
            case 1000113:
                log.warn('自动点赞', '点赞异常');
                return 2;
            case 1000001:
                log.warn('自动点赞', '点赞频繁');
                return 3;
            case 65006:
                log.warn('自动点赞', '已赞过');
                return 4;
            case 4128014:
                log.warn('自动点赞', '账号异常，点赞失败');
                return 5;
            default:
                log.error('自动点赞', `未知错误\n${responseText}`);
                return 1;
        }
    },
    /**
     * 转发前应查看是否重复转发
     * 自动转发
     * @param {Number} uid
     * 自己的UID
     * @param {string} dyid
     * @param {string} [msg]
     * 动态的ID
     * @returns {Promise<number>}
     * - 成功 0
     * - 未知错误 1
     * - 该动态不能转发分享 2
     * - 请求数据发生错误，请刷新或稍后重试 3
     * - 操作太频繁了，请稍后重试 4
     * - 源动态禁止转发 5
     */
    async autoRelay(uid, dyid, msg = '转发动态', ctrl = '[]') {
        const len = msg.length;
        if (len > 233) {
            msg = msg.slice(0, 233 - len);
        }
        const
            responseText = await post({
                url: API.DYNAMIC_REPOST_REPOST,
                config: {
                    retry: false
                },
                contents: {
                    uid: `${uid}`,
                    dynamic_id: dyid,
                    content: msg,
                    ctrl,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        switch (res.code) {
            case 0:
                log.info('转发动态', '成功转发一条动态');
                return 0;
            case 1101004:
                log.warn('转发动态', '该动态不能转发分享');
                return 2;
            case 2201116:
                log.warn('转发动态', '请求数据发生错误，请刷新或稍后重试');
                return 3;
            case 1101008:
                log.warn('转发动态', '操作太频繁了，请稍后重试');
                return 4;
            case 4126117:
                log.warn('转发动态', '源动态禁止转发');
                return 5;
            default:
                log.error('转发动态', `未知错误\n${responseText}`);
                return 1;
        }
    },
    /**
     * 预约抽奖
     * @param {string} reserve_id
     * @returns
     */
    async reserve_lottery(reserve_id) {
        const
            responseText = await post({
                url: API.DYNAMIC_MIX_RESERVE_ATTACH_CARD_BUTTON,
                contents: {
                    cur_btn_status: '1',
                    reserve_id,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        switch (res.code) {
            case 0:
                log.info('预约抽奖', '预约成功');
                return 0;
            case 7604003:
                log.warn('预约抽奖', '重复预约');
                return 0;
            default:
                log.error('预约抽奖', `未知错误\n${responseText}`);
                return 1;
        }
    },
    /**
     * @typedef Picture
     * @property {string} img_src
     * @property {number} img_width
     * @property {number} img_height
     * 发布一条动态
     * @param { string | Picture[] } content
     * @return {Promise<boolean>} isError true
     */
    async createDynamic(content) {
        let
            contents = {
                csrf: GlobalVar.get('csrf'),
                extension: '{"emoji_type":1,"from":{"emoji_type":1},"flag_cfg":{}}',
            },
            url = '';
        if (content instanceof Array) {
            url = API.DYNAMIC_SVR_CREATE_DRAW;
            contents = {
                ...contents,
                biz: 3,
                category: 3,
                pictures: JSON.stringify(content)
            };
        } else {
            url = API.DYNAMIC_SVR_CREATE;
            contents = {
                ...contents,
                type: 4,
                content,
            };
        }
        const responseText = await post({
            url,
            contents,
        });
        if (/^{"code":0/.test(responseText)) {
            log.info('发布动态', `成功创建一条随机内容的动态\n${JSON.stringify(content)}\n`);
            return false;
        } else {
            log.error('发布动态', `发布动态失败\n${JSON.stringify(content)}\n${responseText}`);
            return true;
        }
    },
    _getTopRcmd: new Line('获取推荐', [
        () => get({
            url: API.TOP_RCMD
        }),
        () => get({
            url: API.TOP_FEED_RCMD
        })
    ], responseText => {
        const res = strToJson(responseText);
        if (res.code === 0) {
            return [false, res.data.item.map(it => {
                return [it.owner.mid, it.id];
            }), '成功'];
        } else {
            return [true, [], `获取推荐失败\n${responseText}`];
        }
    }),
    /**
     * 获取推荐
     * @returns {Promise<Array<[number, number]>>}
     */
    async getTopRcmd() {
        return this._getTopRcmd.run();
    },
    /**
     * 分享视频
     * @param {number} uid
     * @param {number} aid
     * @return {Promise<boolean>} isError true
     */
    async shareVideo(uid, aid) {
        const
            responseText = await post({
                url: API.DYNAMIC_REPOST_SHARE,
                contents: {
                    platform: 'pc',
                    uid,
                    type: 8,
                    content: '分享视频',
                    repost_code: 20000,
                    rid: aid,
                    csrf_token: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        switch (res.code) {
            case 0:
                log.info('转发视频', `成功转发视频(av${aid})`);
                return false;
            case 1101015:
                log.warn('转发视频', `该动态不能转发分享(av${aid})`);
                return false;
            default:
                log.error('转发视频', `转发失败\n${responseText}`);
                return true;
        }
    },
    /**
     * 移除动态
     * @param {string} dyid
     * @returns {Promise<boolean>}
     */
    async rmDynamic(dyid) {
        const responseText = await post({
            url: API.DYNAMIC_SVR_RM_DYNAMIC,
            contents: {
                dynamic_id: dyid,
                csrf: GlobalVar.get('csrf')
            },
            config: {
                retry: false
            }
        });
        if (/^{"code":0/.test(responseText)) {
            log.info('删除动态', `成功删除一条动态(${dyid})`);
            return true;
        } else {
            log.error('删除动态', `删除动态失败(${dyid})\n${responseText}`);
            return false;
        }
    },
    /**
     * 发送评论
     * @param {string} rid
     * cid_str
     * @param {string} msg
     * @param {number} type
     * @param {string} code
     * 1(视频)
     * 11(有图)
     * 17(无图)
     * @returns {Promise<number|string>}
     * - 成功 0
     * - 未知错误 1
     * - 原动态已删除 2
     * - 评论区已关闭 3
     * - 需要输入验证码 4 -> url
     * - 已被对方拉入黑名单 5
     * - 黑名单用户无法互动 6
     * - UP主已关闭评论区 7
     * - 评论内容包含敏感信息 8
     * - 重复评论 9
     * - 帐号未登录 10
     * - 关注UP主7天以上的人可发评论 11
     * - 验证码错误 12
     * - 达到当前评论发送上限 13
     */
    async sendChat(rid, msg, type, code) {
        const
            responseText = await post({
                url: API.REPLY_ADD,
                contents: {
                    oid: rid,
                    type: type,
                    message: msg,
                    code,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        switch (res.code) {
            case 0:
                log.info('自动评论', `评论成功: ${msg}`);
                return 0;
            case -404:
                log.error('自动评论', '原动态已删除');
                return 2;
            case 12002:
                log.error('自动评论', '评论区已关闭');
                return 3;
            case 12015:
                log.error('自动评论', '需要输入验证码');
                return res.data.url;
            case 12035:
                log.error('自动评论', '已被对方拉入黑名单');
                return 5;
            case 12053:
                log.error('自动评论', '黑名单用户无法互动');
                return 6;
            case 12061:
                log.error('自动评论', 'UP主已关闭评论区');
                return 7;
            case 12016:
                log.error('自动评论', '评论内容包含敏感信息');
                return 8;
            case 12051:
                log.error('自动评论', '重复评论');
                return 9;
            case -101:
                log.error('自动评论', '帐号未登录');
                return 10;
            case 12078:
                log.error('自动评论', '关注UP主7天以上的人可发评论');
                return 11;
            case 12073:
                log.error('自动评论', '验证码错误');
                return 12;
            case 12014:
                log.warn('自动评论', '已达到当前评论发送上限，本次运行将停用该帐号的评论操作');
                return 13;
            default:
                log.error('自动评论', `未知错误\n${responseText}`);
                return 1;
        }
    },
    /**
     * 发送评论 自动识别验证码
     * @param {string} rid
     * cid_str
     * @param {string} msg
     * @param {number} type
     * 1(视频)
     * 11(有图)
     * 17(无图)
     * @returns {Promise<number>}
     * - 成功 0
     * - 未知错误 1
     * - 原动态已删除 2
     * - 评论区已关闭 3
     * - 需要输入验证码 4 -> url
     * - 已被对方拉入黑名单 5
     * - 黑名单用户无法互动 6
     * - UP主已关闭评论区 7
     * - 评论内容包含敏感信息 8
     * - 重复评论 9
     * - 帐号未登录 10
     * - 关注UP主7天以上的人可发评论 11
     * - 验证码错误 12
     * - 达到当前评论发送上限 13
     */
    async sendChatWithOcr(rid, msg, type) {
        let need_captcha = false;
        let url = '';
        let status = 0;
        do {
            if (need_captcha) {
                const code = await ocr(url);
                if (code) {
                    log.info('验证码识别', `${url} -> ${code}`);
                    status = await bili_client.sendChat(
                        rid,
                        msg,
                        type,
                        code
                    );
                    if (status === 0) {
                        need_captcha = false;
                    } else if (status === 12) {
                        need_captcha = true;
                    } else {
                        need_captcha = false;
                    }
                } else {
                    log.error('验证码识别', '失败');
                    break;
                }
            } else {
                url = await bili_client.sendChat(
                    rid,
                    msg,
                    type
                );
                if (typeof url === 'string'
                    && hasEnv('ENABLE_CHAT_CAPTCHA_OCR')) {
                    need_captcha = true;
                } else {
                    status = url;
                }
            }
        } while (need_captcha);
        return status;
    },
    /**
     * 查询评论
     * @param {*} rid
     * @param {*} type
     * @returns {Promise<Array<[string,string]>>} [[uname,chat],]
     */
    async getChat(rid, type) {
        const
            responseText = await get({
                url: API.V2_REPLAY,
                query: {
                    oid: rid,
                    type: type,
                }
            }),
            res = strToJson(responseText);
        switch (res.code) {
            case 0:
                log.info('查询评论', '成功');
                try {
                    const upmid = res.data.upper.mid;
                    return res.data.replies
                        .filter(it => it.mid !== upmid)
                        .map(it => [it.member.uname, it.content.message]);
                } catch (_) {
                    return [];
                }
            default:
                log.error('查询评论', `未知错误\n${responseText}`);
                return [];
        }
    },
    /**
     * 检查分区
     * 不存在指定分区时创建
     * 获取到tagid添加为对象的属性
     * @param {string} [name]
     * @returns {Promise<number>}
     */
    async checkMyPartition(name) {
        if (!name) name = '此处存放因抽奖临时关注的up';
        const
            responseText = await get({
                url: API.RELATION_TAGS
            }),
            res = strToJson(responseText);
        let tagid = undefined;
        if (res.code === 0) {
            const data = res.data.filter((it) => it.name === name);
            if (data.length) {
                log.info('获取分区id', `成功 ${name}`);
                tagid = data[0].tagid;
            } else {
                log.warn('获取分区id', `失败 无指定分区名${name}`);
            }
            if (name === '此处存放因抽奖临时关注的up') {
                if (typeof tagid === 'undefined') {
                    return bili_client.createPartition(name);
                } else {
                    return tagid;
                }
            } else {
                return tagid;
            }
        } else {
            log.error('获取分区id', `访问出错 可在my_config里手动填入\n${responseText}`);
            return tagid;
        }
    },
    /**
     * 创造分区
     * @param {string} partition_name
     * @returns {Promise<number>}
     */
    async createPartition(partition_name) {
        const
            responseText = await post({
                url: API.RELATION_TAG_CREATE,
                contents: {
                    tag: partition_name,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            obj = strToJson(responseText);
        if (obj.code === 0) {
            /* 获取tagid */
            let { tagid } = obj.data;
            log.info('新建分区', '分区新建成功');
            return tagid;
        } else {
            log.error('新建分区', `分区新建失败\n${responseText}`);
            return undefined;
        }
    },
    /**
     * 获取一个分区中50个的id
     * @param {number} tagid
     * @param {number} n 1->
     * @returns {Promise<number[]>}
     */
    async getPartitionUID(tagid, n) {
        const
            responseText = await get({
                url: API.RELATION_TAG,
                query: {
                    mid: GlobalVar.get('myUID'),
                    tagid: tagid,
                    pn: n,
                    ps: 50
                }
            }),
            res = strToJson(responseText);
        let uids = [];
        if (res.code === 0) {
            res.data.forEach(d => {
                uids.push(d.mid);
            });
            log.info(`获取分组id${tagid}`, `成功获取取关分区列表${n}`);
            return uids;
        } else {
            log.error(`获取分组id${tagid}`, `获取取关分区列表失败\n${responseText}`);
            return uids;
        }
    }
};


module.exports = bili_client;
