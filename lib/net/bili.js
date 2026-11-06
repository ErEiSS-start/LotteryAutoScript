const taskResult = require('../helper/task_result');
const GlobalVar = require('../data/global_var');
const { strToJson, log, ocr, hasEnv, delay, isValidDynamicId } = require('../utils');
const { send } = require('./http');
const API = require('./api.bili');
const config = require('../data/config');
const { parseOpusContent } = require('../helper/opus_content');
const { buildSessionQuery } = require('../helper/session_scan');

const DEFAULT_DYNAMIC_DETAIL_RISK_COOLDOWNS = [
    3 * 1000,
    10 * 1000,
    30 * 1000,
    2 * 60 * 1000,
];
const DEFAULT_ARTICLE_CONTENT_MAX_ATTEMPTS = 2;
const DEFAULT_ARTICLE_CONTENT_RETRY_WAIT = 5 * 1000;
const DEFAULT_ARTICLE_SEARCH_412_COOLDOWNS = [
    2 * 60 * 1000,
    3 * 60 * 1000,
    5 * 60 * 1000,
];
const dynamicDetailCache = new Map();

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

function parseAutoRelayStatus(responseText) {
    const res = parseBiliJson(responseText);
    if (!res) return 1;
    switch (res.code) {
        case 0:
            return res.data?.result == null || res.data.result === 0 ? 0 : 1;
        case 1101004:
            return 2;
        case 2201116:
            return 3;
        case 1101008:
            return 4;
        case 4126117:
            return 5;
        default:
            return 1;
    }
}

function getDiscoveryRiskCode(responseText) {
    const text = String(responseText || '');
    if (/"code"\s*:\s*-352\b/.test(text)) return '-352';
    if (/HTTP状态码:\s*412|"code"\s*:\s*-412\b|request was banned/i.test(text)) return '412';
    return '';
}

function isDiscoveryRiskResponse(responseText) {
    return Boolean(getDiscoveryRiskCode(responseText));
}

function is412Response(responseText) {
    const text = String(responseText || '');
    return /HTTP状态码:\s*412|"code"\s*:\s*-412\b|request was banned/i.test(text);
}

function isUsableArticleContent(content) {
    return typeof content === 'string'
        && content.length >= 8000
        && /opus-text-rich|article-content|article-holder|__INITIAL_STATE__/i.test(content)
        && !/request was banned|HTTP状态码:\s*412|"code"\s*:\s*-(?:352|412)\b/i.test(content);
}

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? Math.floor(number)
        : fallback;
}

function getReserveLotteryStatus(code) {
    if (code === 0 || code === 7604003) return 0;
    if (code === 75003) return 2;
    return 1;
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
    const redirect = classifyArticleRedirect(location, articleUrl);
    return redirect.kind === 'opus' ? redirect.url : '';
}

function classifyArticleRedirect(location, articleUrl) {
    try {
        const redirectUrl = new URL(location, articleUrl);
        const isBilibili = redirectUrl.hostname === 'bilibili.com'
            || redirectUrl.hostname.endsWith('.bilibili.com');
        if (!isBilibili) return { kind: 'unknown', url: '' };
        if (/^\/opus\/\d+\/?$/.test(redirectUrl.pathname)) {
            return { kind: 'opus', url: redirectUrl.href };
        }
        if (/^\/read\/error\/?$/.test(redirectUrl.pathname)) {
            return { kind: 'unavailable', url: redirectUrl.href };
        }
    } catch (_) {
        // 没有有效重定向地址
    }
    return { kind: 'unknown', url: '' };
}

function findExactTopic(responseText, topicName) {
    const parsed = parseBiliJson(responseText);
    const expectedName = String(topicName || '').trim();
    if (!parsed || parsed.code !== 0 || !expectedName) return null;
    const topics = Array.isArray(parsed?.data?.topic_items)
        ? parsed.data.topic_items
        : [];
    const exact = topics.find(topic => String(topic?.name || '').trim() === expectedName);
    const id = Number(exact?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { id, name: expectedName };
}

async function readWinnerJson(requestFn, options, wait = delay, waitMs = 15000) {
    let res;
    for (let attempt=1;attempt<=3;attempt++) {
        res=parseBiliJson(await requestFn(options));
        if (!res || Number(res.code)!==-509 || attempt===3) return res;
        await wait(Math.max(15000,Number(waitMs)||0)*attempt);
    }
    return res;
}

function parseAtInfoItems(items) {
    return (Array.isArray(items) ? items : [])
        .filter(entry => entry?.item && entry?.user && entry.at_time !== undefined)
        .map(entry => ({
            at_time: entry.at_time,
            senderUid: String(entry.user.mid ?? entry.user.uid ?? '').trim(),
            senderName: String(entry.user.nickname ?? entry.user.uname ?? '').trim(),
            business: entry.item.business,
            source_content: entry.item.source_content,
            url: entry.item.uri,
        }));
}

function parseReplyInfoItems(items) {
    return (Array.isArray(items) ? items : [])
        .filter(entry => entry?.item && entry?.user && entry.reply_time !== undefined)
        .map(entry => ({
            senderUid: String(entry.user.mid ?? entry.user.uid ?? '').trim(),
            senderName: String(entry.user.nickname ?? entry.user.uname ?? '').trim(),
            source: entry.item.source_content,
            uri: entry.item.uri,
            timestamp: entry.reply_time,
        }));
}

function serializeDynamicDetailContent(detail) {
    if (!detail?.item) return '';
    try {
        return JSON.stringify(detail);
    } catch (_) {
        return '';
    }
}

function markDiscoveryIncomplete(reason) {
    if (!process.env.LOTTERY_DISCOVERY_ONLY) return;
    GlobalVar.set('discoveryIncomplete', true);
    const reasons = GlobalVar.get('discoveryIncompleteReasons') || [];
    if (!reasons.includes(reason)) reasons.push(reason);
    GlobalVar.set('discoveryIncompleteReasons', reasons);
}

class DynamicDetailRiskController {
    constructor() {
        this.reset();
    }

    get cooldowns() {
        const configured = Array.isArray(config.dynamic_detail_risk_cooldowns)
            ? config.dynamic_detail_risk_cooldowns
                .map(value => Number(value))
                .filter(value => Number.isFinite(value) && value > 0)
            : [];
        return configured.length ? configured : DEFAULT_DYNAMIC_DETAIL_RISK_COOLDOWNS;
    }

    reset() {
        this.consecutiveRisk = 0;
        this.lastCode = '';
    }

    recordFailure(responseText) {
        const code = getDiscoveryRiskCode(responseText);
        if (!code) return { isRisk: false, count: this.consecutiveRisk, wait: 0 };
        this.consecutiveRisk += 1;
        this.lastCode = code;
        const cooldowns = this.cooldowns;
        return {
            isRisk: true,
            code,
            count: this.consecutiveRisk,
            wait: cooldowns[Math.min(this.consecutiveRisk - 1, cooldowns.length - 1)],
        };
    }

    recordSuccess() {
        const recovered = this.consecutiveRisk > 0;
        this.reset();
        return { recovered };
    }
}

const dynamicDetailRiskController = new DynamicDetailRiskController();

function recordDynamicDetailSuccess(scope = '动态详情', controller = dynamicDetailRiskController) {
    const result = controller.recordSuccess();
    if (result.recovered) log.info('动态详情风控', `${scope}请求已恢复`);
    return result;
}

function parseArticleSearchResponse(responseText, keyword) {
    if (is412Response(responseText)) {
        log.warn('专栏搜索重试', `关键词${keyword}收到${getDiscoveryRiskCode(responseText)}，等待受控重试`);
        return [];
    }

    const res = strToJson(responseText);
    if (res.code === 0 && res.data && Array.isArray(res.data.result)) {
        log.info('搜索专栏', '成功 关键词: ' + keyword);
        return res.data.result.map(it => ({
            pub_time: it.pub_time,
            id: it.id
        }));
    }

    markDiscoveryIncomplete(`专栏搜索失败(${keyword})`);
    log.error('搜索专栏', '失败 原因:\n' + responseText);
    return [];
}

async function searchArticlesWithRetry(keyword, requestFn, waitFn = delay) {
    let failureCount = 0;

    for (;;) {
        let responseText;
        try {
            responseText = await requestFn();
        } catch (error) {
            markDiscoveryIncomplete(`专栏搜索异常(${keyword})`);
            log.error('搜索专栏', `请求异常: ${error.message || error}`);
            return [];
        }

        if (!is412Response(responseText)) {
            return parseArticleSearchResponse(responseText, keyword);
        }

        failureCount += 1;
        const cooldown = getArticleSearch412Cooldown(failureCount);
        log.warn(
            '专栏搜索重试',
            `关键词${keyword}第${failureCount}次收到412，${Math.ceil(cooldown / 1000)}秒后只重试该关键词`
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
function get({ url, config, contents, query, headers = {} }) {
    return new Promise((resolve) => {
        send({
            url,
            method: 'GET',
            config,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'referer': 'https://www.bilibili.com/',
                'cookie': GlobalVar.get('cookie'),
                ...headers,
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
function post({ url, config, contents, query, json = false }) {
    return new Promise((resolve) => {
        send({
            url,
            method: 'POST',
            config,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded; charset=UTF-8',
                'referer': 'https://www.bilibili.com/',
                'cookie': GlobalVar.get('cookie')
            },
            query,
            contents,
            success: res => resolve(log.debug_return(url, res.body)),
            failure: err => resolve(log.debug_return(url, err))
        });
    });
}

function classifyDynamicDetailResponse(responseText) {
    const riskCode = getDiscoveryRiskCode(responseText);
    if (riskCode) return { kind: 'risk', code: riskCode, responseText };

    const parsed = parseBiliJson(responseText);
    if (!parsed) return { kind: 'invalid', responseText };
    const { code, data, message } = parsed;
    if (code === 0 && data) return { kind: 'success', data, parsed };
    if (code === 4101139 || code === 500) return { kind: 'transient', parsed };
    if (code === 4101152 || code === -404) return { kind: 'unavailable', parsed };
    return { kind: 'failure', parsed, message };
}

function dynamicDetailCacheKey(dynamicId) {
    return `${process.env.NUMBER || '0'}:${dynamicId}`;
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
     * @property {string} senderUid
     * @property {string} senderName
     * @property {string} business
     * @property {string} source_content
     * @property {string} url
     * @returns {Promise<AtInfo[]>}
     */
    async getWinnerFeedPage(type, cursor = '', { requestFn = get, wait = delay, waitMs = 15000 } = {}) {
        if (!['at', 'reply'].includes(type)) throw new Error('Invalid winner feed');
        const query = {};
        if (cursor) {
            const value = JSON.parse(cursor);
            query.id = value.id;
            query[type === 'at' ? 'at_time' : 'reply_time'] = value.time;
        }
        const res = await readWinnerJson(requestFn,{ url: type === 'at' ? API.MSGFEED_AT : API.MSGFEED_REPLAY, query },wait,waitMs);
        const data = res && res.data;
        if (!res || res.code !== 0 || !data || !Array.isArray(data.items) || !data.cursor
            || ![true,false,0,1].includes(data.cursor.is_end)) return { errorCode: res && res.code || -1 };
        const next = data.cursor;
        const items = data.items.filter(row => row && row.item && row.user).map(row => ({
            sourceMessageId: String(row.id || ''), senderUid: String(row.user.mid || row.user.uid || ''),
            senderName: row.user.nickname || row.user.uname || '',
            messageTimestamp: Number(row.at_time || row.reply_time) || 0,
            content: String(row.item.source_content || row.item.title || ''), link: String(row.item.uri || ''),
            mentions: (Array.isArray(row.item.at_details || row.at_details) ? (row.item.at_details || row.at_details) : []).map(it => ({uid:String(it.mid || it.uid || ''),name:String(it.nickname || it.uname || it.name || '')})),
        }));
        if (items.some(row => !row.sourceMessageId || !/^[1-9]\d*$/.test(row.senderUid))) return { errorCode: -1 };
        return { items, end: Boolean(next.is_end), cursor: next.id && next.time
            ? JSON.stringify({ id: String(next.id), time: Number(next.time) }) : '' };
    },
    async getWinnerPrivateMessages(talkerId, expected, { requestFn = get, maxPages = 64,
        wait = delay, waitMs = 3000, onlyReplies = false } = {}) {
        const messages = [], seen = new Set();
        let cursor = '', covered = 0;
        for (let index = 0; index < maxPages; index++) {
            const query = { talker_id: talkerId, session_type: 1, size: 20 };
            if (cursor) query.end_seqno = cursor;
            const res = await readWinnerJson(requestFn,{ url: API.FETCH_SESSION_MSGS, query },wait,waitMs);
            if (!res || res.code !== 0 || !res.data || res.data.has_more == null || ![0,1].includes(Number(res.data.has_more))
                || !(res.data.messages === null || Array.isArray(res.data.messages))) return { messages, complete: false };
            const rows = res.data.messages || [];
            for (const row of rows) {
                const key = String(row.msg_key || row.msg_seqno || '');
                if (!key || seen.has(key)) continue;
                seen.add(key); messages.push(row);
                if (onlyReplies || String(row.sender_uid) !== String(GlobalVar.get('myUID'))) covered++;
            }
            if (covered >= expected || !Number(res.data.has_more)) return { messages, complete: true };
            const times = rows.map(row => String(row.msg_seqno || '')).filter(value => /^[1-9]\d*$/.test(value));
            const next = times.reduce((min, t) => !min || BigInt(t) < BigInt(min) ? t : min, '');
            if (!next || (cursor && BigInt(next) >= BigInt(cursor))) return { messages, complete: false };
            cursor = next;
            await wait(waitMs);
        }
        return { messages, complete: false };
    },
    async getMyAtInfo() {
        const
            responseText = await get({
                url: API.MSGFEED_AT
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            return parseAtInfoItems(res?.data?.items);
        } else {
            taskResult.fail('CHECK_INCOMPLETE', 'check');
            return [];
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
            taskResult.fail('CHECK_INCOMPLETE', 'check');
            return null;
        }
    },
    /**
     * 获取一页回复
     * @returns {Promise<Array<{senderUid: string, senderName: string, source: string, uri: string, timestamp: number}>}>}
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
            return parseReplyInfoItems(items);
        } else {
            log.error('获取一页回复', '失败');
            taskResult.fail('CHECK_INCOMPLETE', 'check');
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
     * @property {number} [errorCode]
     * @property {string} [errorMessage]
     *
     * @param {number|string} session_type Internal scope: 1 followed/system, 2 unfollowed.
     * @param {string} [ts_16]
     * @returns {Promise<SessionInfo>}
     */
    async getSessionInfo(session_type, ts_16 = '', { requestFn = get } = {}) {
        const
            responseText = await requestFn({
                url: API.SESSION_SVR_GET_SESSIONS,
                query: buildSessionQuery(session_type, ts_16),
            }),
            res = parseBiliJson(responseText);
        if (res?.code === 0 && res.data && res.data.has_more != null && [0, 1].includes(Number(res.data.has_more))
            && (Array.isArray(res.data.session_list) || res.data.session_list === null)) {
            log.info('获取一页私信(20)', '成功 ' + (ts_16 ? 'end_ts->' + ts_16 : '第一页'));
            /**@type {Array} */
            const
                sessions = res.data.session_list || [],
                has_more = res.data.has_more,
                data = sessions.map(session => {
                    const
                        { session_ts, last_msg, unread_count, talker_id, account_info, top_ts, session_type: conversationType } = session,
                        { timestamp = 0, sender_uid = 0, msg_seqno } = last_msg || {};
                    const sender_name = String(
                        account_info?.name || account_info?.uname || account_info?.nickname || ''
                    ).trim();
                    return {
                        session_ts,
                        top_ts,
                        session_type: conversationType,
                        timestamp,
                        sender_uid,
                        sender_name,
                        unread_count,
                        talker_id,
                        msg_seqno,
                    };
                });
            return { has_more, data };
        } else {
            const code = res?.code === 0 ? -1 : (Number.isFinite(res?.code) ? res.code : -1);
            log.error('获取私信', `读取失败(code=${code})`);
            return { has_more: 0, data: [], errorCode: code, errorMessage: '会话列表读取失败' };
        }
    },
    /**
     * 获取私信消息列表
     * @param {number|string} talker_id
     * @param {number} size
     * @returns {Promise<Array<object>>}
     */
    async getSessionMessages(talker_id, size = 20, { requestFn = get } = {}) {
        const
            responseText = await requestFn({
                url: API.FETCH_SESSION_MSGS,
                query: {
                    talker_id,
                    session_type: 1,
                    size: Math.max(1, Math.min(20, Number(size) || 20))
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0 && res.data && typeof res.data === 'object') {
            const msgs = res.data.messages;
            if (msgs instanceof Array) {
                const messages = msgs.filter(it => ![8].includes(it.msg_source));
                log.info('私信细节', `${talker_id}读取到${messages.length}条近期消息`);
                return messages;
            } else if (msgs == null) {
                log.info('私信细节', `${talker_id}无可读取私信`);
                return [];
            }
        }
        taskResult.fail('CHECK_INCOMPLETE', 'check');
        log.error('私信细节', '获取失败');
        return [];
    },
    /**
     * 获取私信文本（兼容旧调用）
     * @param {number|string} talker_id
     * @param {number} size
     */
    async fetch_session_msgs(talker_id, size) {
        const messages = await this.getSessionMessages(talker_id, size);
        return messages.map(it => it.content).join('\n');
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
        const ids = [];
        const pageSize = 50;
        log.info('获取关注列表', '开始分页读取');
        for (let page = 1; ; page++) {
            const responseText = await get({
                url: API.RELATION_FOLLOWINGS,
                query: { vmid: uid, pn: page, ps: pageSize }
            });
            const res = strToJson(responseText);
            const data = res && res.data;
            if (res?.code !== 0 || !data || !Array.isArray(data.list)
                || !Number.isInteger(data.total) || data.total < 0
                || data.list.some(item => !item || !/^\d+$/.test(String(item.mid)))) {
                log.error('获取关注列表', `第${page}页失败\n${responseText}`);
                return null;
            }
            const pageIds = data.list.map(item => String(item.mid));
            if (new Set([...ids, ...pageIds]).size !== ids.length + pageIds.length) {
                log.error('获取关注列表', `第${page}页包含重复用户，关注列表可能不完整`);
                return null;
            }
            ids.push(...pageIds);
            log.info('获取关注列表', `第${page}页读取${pageIds.length}个，已读取${ids.length}/${data.total}个`);
            if (ids.length >= data.total) {
                log.info('获取关注列表', `成功，共${ids.length}个`);
                return ids.join(',');
            }
            if (!data.list.length) {
                log.error('获取关注列表', `第${page}页为空，关注列表不完整`);
                return null;
            }
            await delay(config.get_partition_wait);
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
            return isValidDynamicId(dyid) ? dyid : undefined;
        });
    },
    _dynamicDetailWait: delay,
    _requestDynamicDetail(endpoint, dynamicId, desktop = false) {
        return get({
            url: endpoint,
            config: { retry: false },
            headers: {
                referer: `https://t.bilibili.com/${dynamicId}`,
            },
            query: desktop
                ? { id: dynamicId }
                : {
                    id: dynamicId,
                    timezone_offset: -480,
                    features: 'itemOpusStyle',
                },
        });
    },
    async _fetchDynamicDetailUncached(dynamicId) {
        let transientRetried = false;
        for (;;) {
            const primaryText = await this._requestDynamicDetail(
                API.X_POLYMER_WEB_DYNAMIC_V1_DETAIL,
                dynamicId,
                false
            );
            let result = classifyDynamicDetailResponse(primaryText);

            if (result.kind === 'success') {
                recordDynamicDetailSuccess('动态详情', this._dynamicDetailRiskController);
                log.info('获取一个动态的细节', '普通入口成功');
                return result.data;
            }

            let riskText = primaryText;
            if (result.kind === 'risk' && result.code === '-352') {
                log.warn('动态详情备用', `dyid(${dynamicId})普通入口收到-352，尝试desktop入口`);
                const desktopText = await this._requestDynamicDetail(
                    API.X_POLYMER_WEB_DYNAMIC_DESKTOP_V1_DETAIL,
                    dynamicId,
                    true
                );
                const desktopResult = classifyDynamicDetailResponse(desktopText);
                if (desktopResult.kind === 'success') {
                    recordDynamicDetailSuccess('desktop动态详情', this._dynamicDetailRiskController);
                    log.info('动态详情备用', `dyid(${dynamicId})desktop入口成功`);
                    return desktopResult.data;
                }
                if (desktopResult.kind === 'risk') riskText = desktopText;
            }

            if (result.kind === 'risk') {
                const failure = this._dynamicDetailRiskController.recordFailure(riskText);
                log.warn(
                    '动态详情风控',
                    `dyid(${dynamicId})第${failure.count}次收到${failure.code}，${Math.ceil(failure.wait / 1000)}秒后重试当前动态`
                );
                await this._dynamicDetailWait(failure.wait);
                continue;
            }

            recordDynamicDetailSuccess('动态详情', this._dynamicDetailRiskController);

            if (result.kind === 'transient' && !transientRetried) {
                transientRetried = true;
                const retryWait = positiveInteger(config.get_dynamic_detail_wait, 8 * 1000);
                log.warn(
                    '动态详情重试',
                    `dyid(${dynamicId})遇到临时错误，${Math.ceil(retryWait / 1000)}秒后重试一次`
                );
                await this._dynamicDetailWait(retryWait);
                continue;
            }

            if (result.kind === 'unavailable') {
                const { code, message } = result.parsed;
                log.warn(
                    '获取一个动态的细节',
                    `动态不可用，跳过 (code=${code}${message ? `, ${message}` : ''})`
                );
                return undefined;
            }

            log.warn(
                '获取一个动态的细节',
                `请求失败，跳过 (${summarizeBiliResponse(primaryText, result.parsed)})`
            );
            return undefined;
        }
    },
    /**
     * 获取一个动态的细节
     * @param {string} dynamic_id
     * @return {Promise<JSON>} 失败返回undefined
     */
    async getOneDynamicByDyid(dynamic_id) {
        if (!isValidDynamicId(dynamic_id)) {
            log.warn('获取一个动态的细节', `动态ID无效(${dynamic_id ?? '空'})，跳过请求`);
            return undefined;
        }
        const key = dynamicDetailCacheKey(dynamic_id);
        if (dynamicDetailCache.has(key)) {
            log.info('动态详情缓存', `帐号${process.env.NUMBER || '0'}命中dyid(${dynamic_id})`);
            return dynamicDetailCache.get(key);
        }

        const pending = this._fetchDynamicDetailUncached(dynamic_id);
        dynamicDetailCache.set(key, pending);
        try {
            const result = await pending;
            if (!result) dynamicDetailCache.delete(key);
            return result;
        } catch (error) {
            dynamicDetailCache.delete(key);
            throw error;
        }
    },
    isDiscoveryRiskResponse,
    getDiscoveryRiskCode,
    _classifyDynamicDetailResponse: classifyDynamicDetailResponse,
    _dynamicDetailRiskController: dynamicDetailRiskController,
    _createDynamicDetailRiskController() {
        return new DynamicDetailRiskController();
    },
    _clearDynamicDetailCache() {
        dynamicDetailCache.clear();
    },
    /**
     * 获取一组动态的信息
     * @param {number} host_uid 被查看者的uid
     * @param {string} offset_dynamic_id 此动态偏移量 初始为 0
     * @returns {Promise<string>}
     */
    async getOneDynamicInfoByUID(host_mid, offset) {
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
     * 通过精确名称查找新版话题。模糊结果不自动采用，避免扫入无关动态。
     * @param {string} topicName
     * @returns {Promise<{id:number,name:string}|null>}
     */
    async searchExactTopicByName(topicName) {
        const responseText = await get({
            url: API.TOPIC_PUB_SEARCH,
            query: {
                keywords: topicName,
                page_size: 20
            },
            config: {
                retry: false
            }
        });
        const topic = findExactTopic(responseText, topicName);
        if (!topic) {
            log.warn('获取话题ID', `未找到完全同名话题#${topicName}#，请配置显式{id,name}`);
            return null;
        }
        log.info('获取话题ID', `#${topic.name}# -> ${topic.id}`);
        return topic;
    },
    /**
     * 获取新版话题动态分页。
     * @param {number} topicId
     * @param {string} offset
     * @returns {Promise<string|null>}
     */
    async getTopicDynamicPage(topicId, offset = '') {
        const query = {
            topic_id: topicId,
            sort_by: 3,
            page_size: 20,
            source: 'Web',
            features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard'
        };
        if (offset) query.offset = offset;
        const responseText = await get({
            url: API.X_POLYMER_WEB_DYNAMIC_V1_FEED_TOPIC,
            query,
            config: {
                retry: false
            }
        });
        const res = parseBiliJson(responseText);
        if (!res || res.code !== 0 || !res?.data?.topic_card_list) {
            log.warn('获取话题动态', `新版话题接口不可用 (${summarizeBiliResponse(responseText, res)})`);
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
     * 探测旧版专栏入口的重定向类型
     * @param {number} cv
     * @returns {Promise<{kind:string,url:string}>}
     */
    _getArticleRedirect(cv) {
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
                    resolve(classifyArticleRedirect(headers.location, articleUrl));
                },
                failure: () => resolve({ kind: 'unknown', url: '' })
            });
        });
    },
    async _getArticleOpusUrl(cv) {
        const redirect = await this._getArticleRedirect(cv);
        return redirect.kind === 'opus' ? redirect.url : '';
    },
    /**
     * 获取专栏内容
     * @param {number} cv
     * @returns {Promise<string|null>} null表示专栏已明确永久失效
     */
    async getOneArticleByCv(cv, {
        requestFn = get,
        redirectFn = () => this._getArticleRedirect(cv),
        waitFn = delay,
        markIncompleteFn = markDiscoveryIncomplete,
        maxAttempts: maxAttemptsOverride,
        retryWait: retryWaitOverride,
        opusContentFn = url => this.getArticleOpusContent(url),
    } = {}) {
        const articleUrl = API.READ_CV.replace('{{cv}}', cv),
            maxAttempts = positiveInteger(
                maxAttemptsOverride || config.article_content_max_attempts,
                DEFAULT_ARTICLE_CONTENT_MAX_ATTEMPTS
            ),
            retryWait = positiveInteger(
                retryWaitOverride || config.article_content_retry_wait,
                DEFAULT_ARTICLE_CONTENT_RETRY_WAIT
            );
        let requestUrl = articleUrl;
        let opusUrl = '';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const content = await requestFn({
                url: requestUrl,
                config: {
                    redirect: true,
                    retry: false
                }
            });
            if (isUsableArticleContent(content)) {
                return content;
            }

            log.warn(
                '读取专栏正文',
                `专栏(${cv})返回内容异常(${content.length || 0}字节) (${attempt}/${maxAttempts})`
            );

            const redirect = await redirectFn();
            if (redirect?.kind === 'unavailable') {
                log.warn(
                    '读取专栏正文',
                    `专栏(${cv})已跳转/read/error，视为永久失效来源并跳过`
                );
                return null;
            }
            if (redirect?.kind === 'opus') {
                requestUrl = redirect.url;
                opusUrl = redirect.url;
                log.info('读取专栏正文', `改用新版Opus备用入口(${redirect.url})`);
            }
            if (attempt >= maxAttempts) break;
            await waitFn(retryWait * attempt);
        }

        if (opusUrl) {
            const body = await opusContentFn(opusUrl);
            if (body !== null && typeof body === 'string' && body) {
                log.info('读取专栏正文', `专栏(${cv})Opus正文JSON入口成功`);
                return body;
            }
        }
        log.error('读取专栏正文', `专栏(${cv})正文读取失败，跳过本篇`);
        markIncompleteFn(`专栏(${cv})正文读取失败`);
        return '';
    },
    async getArticleOpusContent(opusUrl, { requestFn = get } = {}) {
        const redirect = classifyArticleRedirect(opusUrl, 'https://www.bilibili.com/');
        if (redirect.kind !== 'opus') return '';
        const id = new URL(redirect.url).pathname.split('/')[2];
        const raw = await requestFn({
            url: API.X_POLYMER_WEB_DYNAMIC_V1_OPUS_DETAIL,
            query: { id, timezone_offset: -480, features: 'htmlNewStyle' },
            config: { retry: false },
            headers: { referer: redirect.url },
        });
        const parsed = parseBiliJson(raw);
        const body = parseOpusContent(parsed, id);
        if (body === null) log.warn('读取专栏正文', `Opus正文JSON读取失败(code=${parsed?.code ?? 'invalid'})`);
        return body || '';
    },
    /**
     * 获取指定动态的新版Opus正文，用于合集UID来源提取正文链接
     * @param {string} dyid
     * @returns {Promise<string>}
     */
    async getOneOpusByDyid(dyid) {
        if (!isValidDynamicId(dyid)) {
            log.warn('读取合集正文', `合集动态ID无效(${dyid ?? '空'})，跳过`);
            return '';
        }
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
            const content = await get({
                url: opusUrl,
                config: {
                    redirect: true,
                    retry: false
                }
            });
            if (isUsableArticleContent(content)) {
                return content;
            }
            log.warn(
                '读取合集正文',
                `合集动态(${dyid})返回内容异常(${content.length || 0}字节) (${attempt}/${maxAttempts})`
            );
            if (attempt < maxAttempts) {
                await delay(retryWait * attempt);
            }
        }

        log.warn('读取合集正文', `合集动态(${dyid})网页正文读取失败，改用动态详情JSON`);
        const detail = await this.getOneDynamicByDyid(dyid);
        const detailContent = serializeDynamicDetailContent(detail);
        if (detailContent) {
            log.info('读取合集正文', `合集动态(${dyid})动态详情JSON备用入口成功`);
            return detailContent;
        }

        log.warn('读取合集正文', `合集动态(${dyid})所有正文入口均失败，跳过`);
        markDiscoveryIncomplete(`合集动态(${dyid})正文读取失败`);
        return '';
    },
    _isUsableArticleContent: isUsableArticleContent,
    _classifyArticleRedirect: classifyArticleRedirect,
    _normalizeArticleOpusUrl: normalizeArticleOpusUrl,
    _findExactTopic: findExactTopic,
    _serializeDynamicDetailContent: serializeDynamicDetailContent,
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
        // 旧接口的 ctrl 用 UTF-16 偏移描述 @；新接口需要有序的富文本节点。
        let mentions;
        try {
            mentions = JSON.parse(ctrl).filter(item => item.type === 1)
                .sort((a, b) => a.location - b.location);
            let end = 0;
            for (const item of mentions) {
                if (!Number.isInteger(item.location) || !Number.isInteger(item.length)
                    || item.location < end || item.length <= 0
                    || item.location + item.length > msg.length
                    || !/^\d+$/.test(String(item.data))
                    || msg[item.location] !== '@') throw new Error('无效的 @ 控制字段');
                end = item.location + item.length;
            }
        } catch (error) {
            log.error('转发动态', `无法解析 @ 信息: ${error.message}`);
            return 1;
        }
        if (msg.length > 233) {
            let limit = 233;
            const crossing = mentions.find(item => item.location < limit && item.location + item.length > limit);
            if (crossing) limit = crossing.location;
            // 不截断 UTF-16 代理对。
            if (limit > 0 && /[\uD800-\uDBFF]/.test(msg[limit - 1])) limit--;
            msg = msg.slice(0, limit);
        }
        const contents = [];
        let offset = 0;
        for (const item of mentions) {
            if (item.location + item.length > msg.length) break;
            if (item.location > offset) contents.push({ raw_text: msg.slice(offset, item.location), type: 1, biz_id: '' });
            contents.push({ raw_text: msg.slice(item.location, item.location + item.length), type: 2, biz_id: String(item.data) });
            offset = item.location + item.length;
        }
        if (offset < msg.length) contents.push({ raw_text: msg.slice(offset), type: 1, biz_id: '' });
        if (!contents.length) contents.push({ raw_text: '转发动态', type: 1, biz_id: '' });
        const
            responseText = await post({
                url: API.DYNAMIC_CREATE,
                config: { retry: false },
                json: true,
                query: { csrf: GlobalVar.get('csrf'), platform: 'web' },
                contents: {
                    dyn_req: {
                        content: { contents },
                        scene: 4,
                        meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } }
                    },
                    web_repost_src: { dyn_id_str: String(dyid) }
                }
            }),
            status = parseAutoRelayStatus(responseText);
        switch (status) {
            case 0:
                log.info('转发动态', '成功转发一条动态');
                return 0;
            case 2:
                log.warn('转发动态', '该动态不能转发分享');
                return 2;
            case 3:
                log.warn('转发动态', '请求数据发生错误，请刷新或稍后重试');
                return 3;
            case 4:
                log.warn('转发动态', '操作太频繁了，请稍后重试');
                return 4;
            case 5:
                log.warn('转发动态', '源动态禁止转发');
                return 5;
            default:
                log.warn(
                    '转发动态',
                    `请求未返回可确认的成功结果，按临时失败处理\n${responseText}`
                );
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
        const status = getReserveLotteryStatus(res.code);
        if (status === 0) {
            if (res.code === 7604003) log.warn('预约抽奖', '重复预约');
            else log.info('预约抽奖', '预约成功');
            return 0;
        }
        if (status === 2) {
            log.info('预约抽奖', '活动已结束，跳过该候选后续互动');
            return 2;
        }
        log.error('预约抽奖', `未知错误\n${responseText}`);
        return 1;
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
        } else if (strToJson(responseText).code === -404) {
            log.info('删除动态', `动态(${dyid})已不存在，无需重复清理`);
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
                config: { retry: false },
                contents: {
                    oid: rid,
                    type: type,
                    message: msg,
                    code,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0 && res.data?.need_captcha) {
            log.error('自动评论', '需要输入验证码');
            return res.data.url || 4;
        }
        switch (res.code) {
            case 0:
                log.info('自动评论', `评论成功: ${msg}`);
                return 0;
            case -404:
                log.error('自动评论', '原动态已删除');
                return 2;
            case 12002:
            case 12052:
                log.error('自动评论', '评论区已关闭');
                return 3;
            case 12015:
                log.error('自动评论', '需要输入验证码');
                return res.data?.url || 4;
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
                    status = 4;
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
                    status = typeof url === 'string' ? 4 : url;
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
                return tagid === undefined ? null : tagid;
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
            return null;
        }
    }
};

bili_client._getReserveLotteryStatus = getReserveLotteryStatus;
bili_client._parseAutoRelayStatus = parseAutoRelayStatus;
bili_client._parseAtInfoItems = parseAtInfoItems;
bili_client._parseReplyInfoItems = parseReplyInfoItems;

module.exports = bili_client;
