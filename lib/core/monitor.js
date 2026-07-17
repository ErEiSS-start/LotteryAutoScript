const {
    log, hasEnv, shuffle, getRandomOne, getAiContent, delay,
    try_for_each, retryfn, appendLotteryInfoFile, isValidDynamicId
} = require('../utils');
const { send } = require('../net/http');
const bili = require('../net/bili');
const { sendNotify } = require('../helper/notify');
const event_bus = require('../helper/event_bus');
const { randomDynamic } = require('../helper/randomDynamic');
const { Searcher } = require('./searcher');
const global_var = require('../data/global_var');
const config = require('../data/config');
const d_storage = require('../helper/d_storage');
const { CommentHistoryStore } = require('../helper/comment_history');

const successfulCommentsByDyid = new Map();
const DEFAULT_UNIQUE_COMMENT_FALLBACKS = [
    '来试试手气', '蹲个结果', '期待一下', '希望有好运',
    '这个挺喜欢', '看看运气', '报名参与', '想要这个',
    '我也来试试', '等开奖啦', '希望能中', '冲一次',
    '来碰碰运气', '挺心动的', '这个不错', '参与一下',
    '默默蹲结果', '来凑个热闹', '许个小愿望', '试试今天运气',
    '有点心动', '先来占个位置', '蹲一手好运', '我来试试看',
];
const COMMENT_STYLE_HINTS = [
    '像随手路过一样，只表达想参与，使用4至7个字',
    '用克制的期待语气，使用5至10个字，不用感叹号',
    '只提奖品或主题中的一个具体点，使用5至12个字',
    '使用轻松口语，使用3至8个字，不要写完整宣传句',
    '使用中性自然的短句，使用5至12个字',
];
let commentHistoryStore;

function normalizeAiComment(comment) {
    return String(comment || '')
        .trim()
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, '')
        .replace(/\d+/g, '0');
}

function getNgramSet(text, size) {
    const value = normalizeAiComment(text);
    const grams = new Set();
    if (!value) return grams;
    if (value.length < size) {
        grams.add(value);
        return grams;
    }
    for (let index = 0; index <= value.length - size; index++) {
        grams.add(value.slice(index, index + size));
    }
    return grams;
}

function diceCoefficient(left, right, size) {
    const leftSet = getNgramSet(left, size);
    const rightSet = getNgramSet(right, size);
    if (!leftSet.size || !rightSet.size) return 0;
    let intersection = 0;
    leftSet.forEach(value => {
        if (rightSet.has(value)) intersection += 1;
    });
    return 2 * intersection / (leftSet.size + rightSet.size);
}

function getAiCommentSimilarity(left, right) {
    const normalizedLeft = normalizeAiComment(left);
    const normalizedRight = normalizeAiComment(right);
    if (!normalizedLeft || !normalizedRight) return 0;
    if (normalizedLeft === normalizedRight) return 1;
    if (Math.min(normalizedLeft.length, normalizedRight.length) < 4) return 0;
    return Math.max(
        diceCoefficient(normalizedLeft, normalizedRight, 1),
        diceCoefficient(normalizedLeft, normalizedRight, 2)
    );
}

function getCommentValues(comments) {
    if (comments instanceof Map) return [...comments.values()];
    if (comments instanceof Set) return [...comments.values()];
    return Array.isArray(comments) ? comments : [];
}

function getMaxAiCommentSimilarity(comment, comments) {
    return getCommentValues(comments).reduce(
        (maximum, previous) => Math.max(maximum, getAiCommentSimilarity(comment, previous)),
        0
    );
}

function parseAiCommentResponse(response) {
    const raw = String(response || '').trim();
    if (!raw) return { comment: '', hasExplicitRequirement: false };
    const jsonText = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    try {
        const parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed.comment === 'string') {
            return {
                comment: parsed.comment.trim(),
                hasExplicitRequirement: parsed.has_explicit_requirement === true,
            };
        }
    } catch (_) {
        // 兼容未按JSON格式返回的模型。
    }
    return { comment: raw, hasExplicitRequirement: false };
}

function validateAiComment(comment, { hasExplicitRequirement = false, maxLength = 15 } = {}) {
    const value = String(comment || '').trim();
    const normalized = normalizeAiComment(value);
    if (!normalized) return { valid: false, reason: '结果为空' };
    if (normalized.length < 2) return { valid: false, reason: '内容过短' };
    if (!hasExplicitRequirement && normalized.length > Math.max(2, Number(maxLength) || 15)) {
        return { valid: false, reason: `超过${maxLength}字` };
    }
    if (/https?:\/\/|www\.|b23\.tv/i.test(value)) {
        return { valid: false, reason: '包含链接' };
    }
    if (/(?:QQ群|群号|进群|加群|群聊|抢购|购买|下单|扫码)|\d{5,}/i.test(value)) {
        return { valid: false, reason: '复述联系方式或广告引导' };
    }
    if (/\p{Extended_Pictographic}/u.test(value)) {
        return { valid: false, reason: '包含表情符号' };
    }
    return { valid: true, reason: '' };
}

function stableCommentOffset(dyid, accountNumber, attempt = 0) {
    const seed = `${dyid}:${accountNumber}:${attempt}`;
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return hash;
}

function getCommentHistoryStore() {
    if (!commentHistoryStore) {
        commentHistoryStore = new CommentHistoryStore({
            retentionDays: config.ai_comment_history_days,
        });
    }
    return commentHistoryStore;
}

function getSuccessfulComments(dyid) {
    if (!successfulCommentsByDyid.has(dyid)) {
        const comments = new Map();
        getCommentHistoryStore().getByDyid(dyid).forEach(entry => {
            const normalized = normalizeAiComment(entry.comment);
            if (normalized) comments.set(normalized, entry.comment);
        });
        successfulCommentsByDyid.set(dyid, comments);
    }
    return successfulCommentsByDyid.get(dyid);
}

function rememberSuccessfulComment(dyid, comment) {
    const normalized = normalizeAiComment(comment);
    if (!normalized) return;
    const value = String(comment).trim();
    getSuccessfulComments(dyid).set(normalized, value);
    getCommentHistoryStore().remember(dyid, value, process.env.NUMBER);
}

function selectUniqueCommentFallback(candidates, usedComments, offset = 0) {
    const usable = candidates
        .map(comment => String(comment || '').trim())
        .filter(comment => normalizeAiComment(comment));
    if (!usable.length) return '';

    const start = Math.abs(Number(offset) || 0) % usable.length;
    for (let index = 0; index < usable.length; index++) {
        const comment = usable[(start + index) % usable.length];
        if (!usedComments.has(normalizeAiComment(comment))) return comment;
    }
    return '';
}

function selectDiverseCommentFallback(candidates, usedComments, offset = 0, threshold = 0.57) {
    const usable = candidates
        .map(comment => String(comment || '').trim())
        .filter(comment => validateAiComment(comment).valid);
    if (!usable.length) return '';
    const start = Math.abs(Number(offset) || 0) % usable.length;
    for (let index = 0; index < usable.length; index++) {
        const comment = usable[(start + index) % usable.length];
        if (getMaxAiCommentSimilarity(comment, usedComments) < threshold) return comment;
    }
    return '';
}

function buildAiCommentPrompt(basePrompt, {
    accountNumber, dyid, attempt, previousComments, rejectionReason
}) {
    const styleIndex = stableCommentOffset(dyid, accountNumber, attempt) % COMMENT_STYLE_HINTS.length;
    const previous = previousComments.length
        ? `\n同一动态其他帐号已经发布：${previousComments.slice(-5).join('；')}。不得复用其措辞、句式或信息顺序。`
        : '';
    const retry = rejectionReason
        ? `\n上一次结果被拒绝，原因：${rejectionReason}。请完全换一个表达角度。`
        : '';
    return `${String(basePrompt || '').trim()}
你是普通B站用户，正在参与动态活动。请只输出JSON：{"comment":"评论正文","has_explicit_requirement":false}。
规则：
1. 如果原文明确要求评论指定口令、选项或回答，优先照做，并将has_explicit_requirement设为true；仅要求“评论”但未指定内容时必须设为false。
2. 否则只写2至15个汉字的自然短评，不总结或改写活动文案。
3. 不得复述群号、长数字、链接、进群、购买或抢购引导。
4. 不使用表情、话题标签、@、营销口吻，也不编造体验。
5. 本次表达方式：${COMMENT_STYLE_HINTS[styleIndex]}。
不要提及帐号编号。${previous}${retry}`.trim();
}

async function getUniqueAiComment(dyid, source) {
    const usedComments = getSuccessfulComments(dyid);
    const accountNumber = Math.max(1, Number(process.env.NUMBER) || 1);
    const { url, body, prompt } = config.ai_comments_parm;
    const configuredRetryCount = Number(config.ai_comment_retry_count);
    const retryCount = Number.isInteger(configuredRetryCount) && configuredRetryCount >= 0
        ? configuredRetryCount
        : 2;
    const similarityThreshold = Math.min(
        1,
        Math.max(0.1, Number(config.ai_comment_similarity_threshold) || 0.57)
    );
    const maxLength = Math.max(2, Number(config.ai_comment_short_max_length) || 15);
    const recentComments = getCommentHistoryStore().getRecent();
    const recentNormalized = new Set(recentComments.map(entry => normalizeAiComment(entry.comment)));
    let rejectionReason = '';

    for (let attempt = 0; attempt <= retryCount; attempt++) {
        const aiResponse = await getAiContent(
            url,
            body,
            buildAiCommentPrompt(prompt, {
                accountNumber,
                dyid,
                attempt,
                previousComments: [...usedComments.values()],
                rejectionReason,
            }),
            source
        );
        const parsed = parseAiCommentResponse(aiResponse);
        const quality = validateAiComment(parsed.comment, {
            hasExplicitRequirement: parsed.hasExplicitRequirement,
            maxLength,
        });
        if (!quality.valid) {
            rejectionReason = quality.reason;
        } else if (parsed.hasExplicitRequirement) {
            return parsed.comment;
        } else {
            const similarity = getMaxAiCommentSimilarity(parsed.comment, usedComments);
            const normalized = normalizeAiComment(parsed.comment);
            if (similarity >= similarityThreshold) {
                rejectionReason = `与同动态已有评论相似度${similarity.toFixed(2)}`;
            } else if (recentNormalized.has(normalized)) {
                rejectionReason = '与30天内其他动态评论完全重复';
            } else {
                return parsed.comment;
            }
        }
        log.warn(
            'AI评论去重',
            `dyid(${dyid})第${attempt + 1}次结果不可用(${rejectionReason})`
        );
    }

    const fallback = selectDiverseCommentFallback(
        DEFAULT_UNIQUE_COMMENT_FALLBACKS,
        usedComments,
        stableCommentOffset(dyid, accountNumber),
        similarityThreshold
    );
    log.warn('AI评论去重', `dyid(${dyid})改用低相似本地短评`);
    return fallback || DEFAULT_UNIQUE_COMMENT_FALLBACKS[
        stableCommentOffset(dyid, accountNumber) % DEFAULT_UNIQUE_COMMENT_FALLBACKS.length
    ];
}

/**
 * 监视器
 */
class Monitor extends Searcher {
    /**
     * @constructor
     * @param {[string, number | string]} lottery_param
     */
    constructor(lottery_param) {
        super();
        this.lottery_param = lottery_param;
        this.tagid = config.partition_id; /* tagid初始化 */
        this.attentionList = ''; /* 转为字符串的所有关注的up主uid */
        this.LotteryInfoMap = new Map([
            ['UIDs', this.getLotteryInfoByUID.bind(this)],
            ['TAGs', this.getLotteryInfoByTag.bind(this)],
            ['Articles', this.getLotteryInfoByArticle.bind(this)],
            ['APIs', this.getLotteryInfoByAPI.bind(this)],
            ['TxT', this.getLotteryInfoByTxT.bind(this)],
            ['CollectionUIDs', this.getLotteryInfoByCollectionUID.bind(this)]
        ]);
    }
    /**
     * 初始化
     */
    async init() {
        if (config.model === '00') {
            event_bus.emit('Turn_off_the_Monitor', '已关闭所有转发行为');
            return;
        }
        /**采集阶段只生成固定快照，不读取帐号状态，也不执行任何参与动作 */
        if (process.env.LOTTERY_DISCOVERY_ONLY) {
            await this.startLottery();
            event_bus.emit('Turn_on_the_Monitor');
            return;
        }
        if (!this.tagid
            && config.is_not_create_partition !== true) {
            this.tagid = await bili.checkMyPartition(); /* 检查关注分区 */
            if (!this.tagid) {
                event_bus.emit('Turn_off_the_Monitor', '分区获取失败');
                return;
            }
        }
        /** 关注列表初始化 */
        this.attentionList = await bili.getAttentionList(global_var.get('myUID'));
        const status = await this.startLottery();
        switch (status) {
            case 0:
                event_bus.emit('Turn_on_the_Monitor');
                break;
            case 1013:
                event_bus.emit('Turn_off_the_Monitor', '评论达到发送上限，暂停该帐号本轮并保留候选到下一轮');
                break;
            case 1001:
                event_bus.emit('Turn_off_the_Monitor', '评论失败');
                break;
            case 1010:
                event_bus.emit('Turn_off_the_Monitor', '已掉号');
                break;
            case 1004:
                event_bus.emit('Turn_off_the_Monitor', '需要输入验证码');
                break;
            case 2001:
                event_bus.emit('Turn_off_the_Monitor', '关注出错');
                break;
            case 2004:
            case 4005:
                log.warn(`账号异常${status}`, `UID(${global_var.get('myUID')})异常号只会对部分UP出现异常`);
                if (!config.is_exception) {
                    await sendNotify(
                        `[动态抽奖]账号异常${status}通知`,
                        `UID: ${global_var.get('myUID')}\n异常号只会对部分UP出现异常\n可在设置中令is_exception为true关闭此推送\n${log._cache.filter(it => /Error|\s抽奖信息\]/.test(it)).join('\n')}`
                    );
                }
                config.is_exception = true;
                event_bus.emit('Turn_on_the_Monitor');
                break;
            case 2005:
                log.warn('关注已达上限', `UID(${global_var.get('myUID')})关注已达上限,已临时进入只转已关注模式`);
                if (!config.is_outof_maxfollow) {
                    await sendNotify(
                        '[动态抽奖]关注已达上限',
                        `UID: ${global_var.get('myUID')}\n关注已达上限,已临时进入只转已关注模式\n可在设置中令is_outof_maxfollow为true关闭此推送\n${log._cache.filter(it => /Error|\s抽奖信息\]/.test(it)).join('\n')}`
                    );
                }
                config.is_outof_maxfollow = true;
                config.only_followed = true;
                event_bus.emit('Turn_on_the_Monitor');
                break;
            case 5001:
                event_bus.emit('Turn_off_the_Monitor', '转发失败');
                break;
            default:
                event_bus.emit('Turn_off_the_Monitor', `??? 未知错误: ${status}`);
                break;
        }
    }
    /**
     * 启动
     * @returns {Promise<number>}
     */
    async startLottery() {
        const allLottery = await this.filterLotteryInfo()
            , len = allLottery.length
            , { create_dy, create_dy_mode, wait, filter_wait } = config
            , isBatchMode = Boolean(process.env.LOTTERY_SHARED_ONLY)
            , batchSize = Math.max(1, Number(config.lottery_batch_size) || 7)
            , batchResult = global_var.get('lotteryBatchResult') || {
                successful: 0,
                attempted: 0,
                needsAnotherRound: false,
                errorStatus: 0,
            };

        global_var.set('lotteryBatchResult', batchResult);

        log.info('筛选动态', `筛选完毕(${len})`);

        if (len) {
            let
                status = 0,
                is_exception = 0,
                is_outof_maxfollow = 0,
                pauseCurrentRound = false,
                relayed_nums = 0,
                total_nums = 0;
            for (const [index, lottery] of shuffle(allLottery).entries()) {
                total_nums += 1;
                let is_shutdown = false;
                if (
                    is_outof_maxfollow
                    && lottery.uid.length
                    && (new RegExp(lottery.uid.join('|'))).test(this.attentionList)
                ) {
                    log.info('过滤', `已关注(${lottery.uid.join(',')})`);
                    continue;
                }

                if (hasEnv('ENABLE_AI_JUDGE') && lottery.drawtime !== -1 && lottery.drawtime < Date.now() / 1000) {
                    log.info('AI过滤', '已过开奖时间');
                    d_storage.updateDyid(lottery.dyid);
                    await delay(filter_wait);
                    continue;
                }

                if (lottery.isOfficialLottery) {
                    let { ts } = await bili.getLotteryNotice(lottery.dyid);
                    const ts_10 = Date.now() / 1000;
                    if (ts === -1) {
                        log.warn('过滤', '无法判断开奖时间');
                        await delay(filter_wait);
                        continue;
                    }
                    if (ts === -9999) {
                        log.info('过滤', '已撤销抽奖');
                        d_storage.updateDyid(lottery.dyid);
                        await delay(filter_wait);
                        continue;
                    }
                    if (ts < ts_10) {
                        log.info('过滤', '已过开奖时间');
                        d_storage.updateDyid(lottery.dyid);
                        await delay(filter_wait);
                        continue;
                    }
                    if (ts > ts_10 + config.maxday * 86400) {
                        log.info('过滤', '超过指定开奖时间');
                        d_storage.updateDyid(lottery.dyid);
                        await delay(filter_wait);
                        continue;
                    }
                } else if (lottery.uid[0]) {
                    const { minfollower } = config;
                    if (minfollower > 0) {
                        const followerNum = await bili.getUserInfo(lottery.uid[0]);
                        if (followerNum === -1) {
                            log.warn('过滤', `粉丝数(${followerNum})获取失败`);
                            await delay(filter_wait);
                            continue;
                        }
                        if (followerNum < minfollower) {
                            log.info('过滤', `粉丝数(${followerNum})小于指定数量`);
                            d_storage.updateDyid(lottery.dyid);
                            await delay(filter_wait);
                            continue;
                        }
                    } else {
                        log.info('过滤', '不过滤粉丝数');
                    }
                }

                if (!isBatchMode
                    && create_dy
                    && create_dy_mode instanceof Array
                    && index > 0
                    && index % getRandomOne(create_dy_mode[0]) === 0
                ) {
                    const number = getRandomOne(create_dy_mode[1]) || 0;
                    randomDynamic(number);
                }

                status = await this.go(lottery);
                batchResult.attempted += 1;
                switch (status) {
                    case 0:
                        relayed_nums += 1;
                        batchResult.successful += 1;
                        break;
                    case 1002:
                    case 1003:
                    case 1005:
                    case 1006:
                    case 1007:
                    case 1008:
                    case 1009:
                    case 1011:
                    case 2002:
                    case 2003:
                    case 3001:
                    case 4001:
                    case 4002:
                    case 4003:
                    case 4004:
                    case 5002:
                    case 5003:
                    case 5004:
                    case 5005:
                    case 6002:
                        status = 0;
                        break;
                    case 1013:
                        pauseCurrentRound = true;
                        batchResult.errorStatus = 0;
                        batchResult.needsAnotherRound = true;
                        break;
                    case 2004:
                        is_exception = 2004;
                        break;
                    case 4005:
                        is_exception = 4005;
                        break;
                    case 2005:
                        is_outof_maxfollow = 2005;
                        break;
                    case 1001:
                    case 1010:
                    case 1004:
                    case 2001:
                    case 5001:
                        is_shutdown = true;
                        break;
                    default:
                        break;
                }

                if (pauseCurrentRound) {
                    log.warn(
                        '轮转批次',
                        '评论达到发送上限：当前候选未记为已处理，暂停该帐号本轮，下一轮重新尝试'
                    );
                    break;
                }

                if (is_shutdown) {
                    batchResult.errorStatus = status;
                    batchResult.needsAnotherRound = false;
                    break;
                }

                await d_storage.updateDyid(lottery.dyid);

                await delay(wait * (Math.random() + 0.5));

                if (isBatchMode && batchResult.successful >= batchSize) {
                    batchResult.needsAnotherRound = index < len - 1;
                    log.info(
                        '轮转批次',
                        batchResult.needsAnotherRound
                            ? `本帐号已成功参与${batchResult.successful}条，保留剩余候选到下一轮`
                            : `本帐号已成功参与${batchResult.successful}条，固定快照已处理完毕`
                    );
                    break;
                }
            }
            log.info('抽奖', `本轮共处理${total_nums}条,成功参与${relayed_nums}条`);
            return is_exception
                || is_outof_maxfollow
                || status;
        } else {
            log.info('抽奖', '无未转发抽奖');
            return 0;
        }
    }

    /**
     * 抽奖配置
     * @typedef {object} LotteryOptions
     * @property {number[]} uid 用户标识
     * @property {string} dyid 动态标识
     * @property {boolean} isOfficialLottery 是否官方抽奖
     * @property {number} drawtime 开奖时间t10
     * @property {string} relay_chat 转发词
     * @property {string} ctrl 定位@
     * @property {string} [rid] 评论标识
     * @property {number} chat_type 评论类型
     * @property {string} [chat] 评论词
     * @property {boolean} [isAiChat] 是否为AI生成的评论
     * @property {boolean} [useAiComment] 是否在真正参与时生成AI评论
     * @property {string} [aiCommentSource] AI评论所需的动态正文
     */
    /**
     * @returns {Promise<LotteryOptions[]>}
     */
    async filterLotteryInfo() {
        const { lottery_param, LotteryInfoMap, attentionList } = this;
        /**
         * @type {import("./searcher").LotteryInfo[]}
         */
        let protoLotteryInfo = await LotteryInfoMap.get(lottery_param[0])(lottery_param[1]);

        if (protoLotteryInfo === null)
            return [];

        log.info('筛选动态', `开始筛选(${protoLotteryInfo.length})`);

        let invalidDynamicCount = 0;
        let emptyDynamicCount = 0;
        protoLotteryInfo = protoLotteryInfo.filter(item => {
            if (!isValidDynamicId(item?.dyid)) {
                invalidDynamicCount += 1;
                return false;
            }
            if (!item.des && !item.hasOfficialLottery && !item.reserve_id) {
                emptyDynamicCount += 1;
                return false;
            }
            return true;
        });
        if (invalidDynamicCount || emptyDynamicCount) {
            log.warn(
                '筛选动态',
                `预过滤无效ID(${invalidDynamicCount})、无正文普通动态(${emptyDynamicCount})`
            );
        }

        /** 所有抽奖信息 */
        let alllotteryinfo = [];
        const
            {
                check_if_duplicated, save_lottery_info_to_file,
                set_lottery_info_url, disable_reserve_lottery,
                is_not_relay_reserve_lottery,
                reserve_lottery_wait, sneaktower, key_words,
                model, chatmodel, chat: chats, relay: relays,
                block_dynamic_type, max_create_time, is_imitator,
                only_followed, at_users, blockword, blacklist,
                ai_judge_parm,
            } = config,
            now_ts = Date.now() / 1000;

        /**
         * @type {Map<String, Boolean>}
         */
        let dyids_map = new Map();

        /**去重 */
        protoLotteryInfo = protoLotteryInfo.filter(({ dyid }) => {
            if (dyids_map.has(dyid)) {
                return false;
            }
            dyids_map.set(dyid, false);
            return true;
        });

        log.info('筛选动态', `去重后(${protoLotteryInfo.length})`);

        /**并发查询dyid */
        if (check_if_duplicated >= 1) {
            await Promise.all(
                [...dyids_map.keys()]
                    .map(it => d_storage
                        .searchDyid(it)
                        .then(hasIt => dyids_map.set(it, hasIt))
                    )
            );
            log.info('筛选动态', '并发查询本地dyid完毕');
        }

        if (lottery_param[0] !== 'APIs' && save_lottery_info_to_file && protoLotteryInfo.length) {
            log.info('保存抽奖信息', '保存开始');
            await appendLotteryInfoFile(lottery_param[1].toString(), protoLotteryInfo);
        }

        if (lottery_param[0] !== 'APIs' && set_lottery_info_url && protoLotteryInfo.length) {
            log.info('上传抽奖信息', '上传开始');
            await new Promise((resolve) => {
                send({
                    url: set_lottery_info_url,
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json'
                    },
                    contents: protoLotteryInfo,
                    success: ({ body }) => {
                        log.info('发送获取到的动态数据', body);
                        resolve();
                    },
                    failure: err => {
                        log.error('发送获取到的动态数据', err);
                        resolve();
                    }
                });
            });
        }

        if (process.env.LOTTERY_DISCOVERY_ONLY) {
            log.info('采集模式', `已保存${protoLotteryInfo.length}条候选，本阶段不执行参与操作`);
            return [];
        }

        /* 检查动态是否满足要求 */
        await try_for_each(protoLotteryInfo, async function (lottery_info) {
            const {
                lottery_info_type, is_liked,
                uids, uname, dyid, reserve_id,
                reserve_lottery_text,
                is_charge_lottery,
                create_time, chat_type,
                ctrl, rid, des, type,
                hasOfficialLottery
            } = lottery_info;

            log.debug('正在筛选的动态信息', lottery_info);

            if (!des && !hasOfficialLottery && !reserve_id) {
                log.info('筛选动态', `获取动态内容为空(https://t.bilibili.com/${dyid})风控`);
                return false;
            }

            if (lottery_info_type.startsWith('sneak') && sneaktower) {
                log.info('筛选动态', `偷塔模式不检查是否已转发(https://t.bilibili.com/${dyid})`);
            } else {
                /* 遇到转发过就退出 */
                if (
                    ((!check_if_duplicated || check_if_duplicated >= 2) && is_liked)
                    || ((check_if_duplicated >= 1) && dyids_map.get(dyid))
                ) {
                    log.info('筛选动态', `已转发(https://t.bilibili.com/${dyid})`);
                    return false;
                }
            }

            /* 超过指定时间退出 */
            if (create_time && now_ts - create_time > max_create_time * 86400) {
                log.info('筛选动态', `过时动态(https://t.bilibili.com/${dyid})`);
                return false;
            }

            if (is_charge_lottery) {
                log.info('筛选动态', `充电抽奖(https://t.bilibili.com/${dyid})`);
                return false;
            }

            let
                [m_uid, ori_uid] = uids,
                mIsFollowed = !m_uid || (new RegExp(m_uid)).test(attentionList),
                oriIsFollowed = !ori_uid || (new RegExp(ori_uid)).test(attentionList),
                /**判断是转发源动态还是现动态 实际发奖人*/
                [real_uid, realIsFollowed] = lottery_info_type === 'uid'
                    ? [ori_uid, oriIsFollowed]
                    : [m_uid, mIsFollowed],
                description = des.split(/\/\/@.*?:/)[0],
                needAt = /(?:@|艾特)[^@|(艾特)]*?好友/.test(description),
                needTopic = [...new Set(description.match(/(?<=[带加]上?(?:话题|tag).*)#.+?#|(?<=[带加])上?#.+?#(?=话题|tag)/ig) || [])].join(' '),
                isRelayDynamic = type === 1,
                has_key_words = key_words.every(it => new RegExp(it).test(description)),
                isBlock = blockword.length && new RegExp(blockword.join('|')).test(description + reserve_lottery_text),
                isLottery =
                    (is_imitator && lottery_info_type === 'uid' && model !== '00')
                    || (hasOfficialLottery && model[0] === '1')
                    || (!hasOfficialLottery && model[1] === '1' && has_key_words),
                isSendChat =
                    (hasOfficialLottery && chatmodel[0] === '1')
                    || (!hasOfficialLottery && chatmodel[1] === '1'),
                drawtime = -1,
                keys = [dyid, m_uid, ori_uid];

            log.debug('筛选动态', { real_uid, mIsFollowed, oriIsFollowed, realIsFollowed, needAt, needTopic, type, isRelayDynamic, key_words, has_key_words, blockword, isBlock, isLottery, isSendChat });

            if (
                blacklist.split(',').some(id => keys.some(key => {
                    if (key + '' === id) {
                        log.info('筛选动态', `黑名单匹配(${id})(https://t.bilibili.com/${dyid})`);
                        return true;
                    } else {
                        return false;
                    }
                }))
            ) {
                return false;
            }

            if (block_dynamic_type.includes(type)) {
                log.warn('筛选动态', `屏蔽动态类型 ${type}`);
                return false;
            }

            /**屏蔽词 */
            if (isBlock) {
                log.info('筛选动态', `包含屏蔽词(https://t.bilibili.com/${dyid})`);
                return false;
            }

            if (reserve_id) {
                if (disable_reserve_lottery) {
                    log.info('预约抽奖', '已关闭预约抽奖功能');
                } else if (process.env.LOTTERY_SHARED_ONLY) {
                    log.info('预约抽奖', '已加入当前帐号的轮转参与队列');
                } else {
                    log.info('预约抽奖', '开始');
                    log.info('预约抽奖', `奖品: ${reserve_lottery_text}`);
                    if (hasEnv('NOT_GO_LOTTERY')) {
                        log.info('NOT_GO_LOTTERY', 'ON');
                    } else {
                        await delay(reserve_lottery_wait);
                        await bili.reserve_lottery(reserve_id);
                    }
                }
                if (is_not_relay_reserve_lottery === true) {
                    log.info('预约抽奖', '已关闭预约抽奖转关功能');
                    if (process.env.LOTTERY_SHARED_ONLY && !disable_reserve_lottery) {
                        alllotteryinfo.push({
                            isOfficialLottery: hasOfficialLottery,
                            drawtime: -1,
                            uid: [],
                            dyid,
                            relay_chat: '',
                            ctrl: '[]',
                            chat_type: 0,
                            reserve_id,
                            reserve_lottery_text,
                            reserveOnly: true,
                        });
                    }
                    return false;
                }
            }

            if (!hasOfficialLottery && model[1] === '1') {
                if (hasEnv('ENABLE_AI_JUDGE')) {
                    let msg = await getAiContent(
                        ai_judge_parm.url,
                        ai_judge_parm.body,
                        ai_judge_parm.prompt,
                        lottery_info.des
                    );
                    try {
                        let msg_json = JSON.parse(msg);
                        if (typeof msg_json.has_key_words == 'boolean') {
                            has_key_words = msg_json.has_key_words;
                            isLottery = has_key_words;
                        } else {
                            log.warn('ai判断抽奖', 'no has_key_words');
                        }
                        if (typeof msg_json.needAt == 'boolean') {
                            needAt = msg_json.needAt;
                        } else {
                            log.warn('ai判断抽奖', 'no needAt');
                        }
                        if (typeof msg_json.needTopic == 'string') {
                            needTopic = msg_json.needTopic;
                        } else {
                            log.warn('ai判断抽奖', 'no needTopic');
                        }
                        if (typeof msg_json.drawtime == 'number') {
                            drawtime = msg_json.drawtime;
                        } else {
                            log.warn('ai判断抽奖', 'no drawtime');
                        }
                        log.info('ai判断抽奖', msg_json.more);
                    } catch (_) {
                        log.error('ai判断抽奖', `未返回JSON格式${msg}`);
                    }
                }
                if (!has_key_words && description) {
                    log.warn('筛选动态', `无关键词动态的描述: ${description}\n\n考虑是否修改设置key_words或ai提示词`);
                }
            }

            /**若勾选只转已关注 */
            if (only_followed
                && (!mIsFollowed || !oriIsFollowed)
            ) {
                log.info('筛选动态', `只转已关注(https://t.bilibili.com/${dyid})`);
                return false;
            }

            if (isLottery) {
                let onelotteryinfo = {};

                onelotteryinfo.isOfficialLottery = hasOfficialLottery;

                onelotteryinfo.drawtime = drawtime;

                /**初始化待关注列表 */
                onelotteryinfo.uid = [];

                if (!realIsFollowed) {
                    onelotteryinfo.uid.push(real_uid);
                }

                onelotteryinfo.dyid = dyid;

                if (process.env.LOTTERY_SHARED_ONLY && reserve_id && !disable_reserve_lottery) {
                    onelotteryinfo.reserve_id = reserve_id;
                    onelotteryinfo.reserve_lottery_text = reserve_lottery_text;
                }

                let
                    /**转发评语 */
                    RandomStr = (getRandomOne(relays) || '!!!')
                        .replace(/\$\{uname\}/g, uname),
                    /**控制字段 */
                    new_ctrl = [];

                /* 是否需要带话题 */
                if (needTopic) {
                    RandomStr += needTopic;
                }

                /* 是否需要@ */
                if (needAt) {
                    at_users.forEach(it => {
                        new_ctrl.push({
                            data: String(it[1]),
                            location: RandomStr.length,
                            length: it[0].length + 1,
                            type: 1
                        });
                        RandomStr += '@' + it[0];
                    });
                }

                /* 是否是转发的动态 */
                if (isRelayDynamic) {
                    /* 转发内容长度+'//'+'@'+用户名+':'+源内容 */
                    const addlength = RandomStr.length + 2 + uname.length + 1 + 1;
                    onelotteryinfo.relay_chat = RandomStr + `//@${uname}:` + des;
                    new_ctrl.push({
                        data: String(real_uid),
                        location: RandomStr.length + 2,
                        length: uname.length + 1,
                        type: 1
                    });
                    ctrl.map(item => {
                        item.location += addlength;
                        return item;
                    }).forEach(it => new_ctrl.push(it));
                    if (!oriIsFollowed) {
                        onelotteryinfo.uid.push(ori_uid);
                    }
                } else {
                    onelotteryinfo.relay_chat = RandomStr;
                }

                onelotteryinfo.ctrl = JSON.stringify(new_ctrl);

                /* 根据动态的类型决定评论的类型 */
                onelotteryinfo.chat_type = chat_type;

                /* 是否评论 */
                if (isSendChat) {
                    onelotteryinfo.rid = rid;
                    if (hasEnv('ENABLE_AI_COMMENTS')) {
                        onelotteryinfo.useAiComment = true;
                        onelotteryinfo.aiCommentSource = lottery_info.des;
                    } else {
                        onelotteryinfo.chat = (getRandomOne(chats) || '!!!').replace(/\$\{uname\}/g, uname);
                    }
                }

                alllotteryinfo.push(onelotteryinfo);
            } else {
                log.info('筛选动态', `非抽奖动态(https://t.bilibili.com/${dyid})`);
            }
        });

        return alllotteryinfo;
    }
    /**
     * 关注转发评论
     * @param {LotteryOptions} option
     * @returns {Promise<number>}
     * - 成功 0
     * - 评论 未知错误 1001
     * - 评论 原动态已删除 1002
     * - 评论 评论区已关闭 1003
     * - 评论 需要输入验证码 1004
     * - 评论 已被对方拉入黑名单 1005
     * - 评论 黑名单用户无法互动 1006
     * - 评论 UP主已关闭评论区 1007
     * - 评论 内容包含敏感信息 1008
     * - 评论 重复评论 1009
     * - 评论 帐号未登录 1010
     * - 评论 关注UP主7天以上的人可发评论 1011
     * - 评论 达到当前发送上限，暂停当前帐号本轮 1013
     * - 关注 未知错误 2001
     * - 关注 您已被对方拉入黑名单 2002
     * - 关注 黑名单用户无法关注 2003
     * - 关注 账号异常 2004
     * - 关注 关注已达上限 2005
     * - 分区 移动失败 3001
     * - 点赞 未知错误 4001
     * - 点赞 点赞异常 4002
     * - 点赞 点赞频繁 4003
     * - 点赞 已赞过 4004
     * - 点赞 账号异常，点赞失败 4005
     * - 转发 未知错误 5001
     * - 转发 该动态不能转发分享 5002
     * - 转发 请求数据发生错误，请刷新或稍后重试 5003
     * - 转发 操作太频繁了，请稍后重试 5004
     * - 转发 源动态禁止转发 5005
     * - 预约 活动已结束，跳过后续互动 6002
     */
    async go(option) {
        log.debug('正在转发的动态信息', option);
        if (hasEnv('NOT_GO_LOTTERY')) {
            log.info('NOT_GO_LOTTERY', 'ON');
            return 0;
        }

        let
            status = 0,
            {
                uid, dyid, chat_type, rid, relay_chat, ctrl, chat, isAiChat,
                useAiComment, aiCommentSource,
                reserve_id, reserve_lottery_text, reserveOnly,
            } = option,
            {
                check_if_duplicated, is_copy_chat, copy_blockword,
                is_repost_then_chat, is_not_create_partition, reserve_lottery_wait,
            } = config;

        /* 轮转模式下预约操作也计入当前批次，避免筛选阶段一次性预约全部候选 */
        if (reserve_id) {
            log.info('预约抽奖', `开始: ${reserve_lottery_text}`);
            await delay(reserve_lottery_wait);
            status = await bili.reserve_lottery(reserve_id);
            if (status === 2) return 6002;
            if (reserveOnly) return status ? 6001 : 0;
        }

        /* 评论 */
        if (rid && chat_type) {
            if (useAiComment && !is_copy_chat) {
                log.info('开始获取Ai评论', `(https://t.bilibili.com/${dyid})`);
                chat = await getUniqueAiComment(dyid, aiCommentSource);
                isAiChat = true;
                log.info('获取到Ai评论内容', `${chat}`);
            }

            if (is_copy_chat) {
                const copy_chat = getRandomOne(
                    (await bili.getChat(rid, chat_type))
                        .filter(it => !(new RegExp(copy_blockword.join('|')).test(it[1])))
                ) || [';;;;;;;;;', chat || '!!!'];
                chat = copy_chat[1]
                    .replace(
                        new RegExp(copy_chat[0], 'g'),
                        global_var.get('myUNAME') || '');
            } else {
                if (is_repost_then_chat) {
                    if (isAiChat) {
                        relay_chat = chat;
                    } else {
                        chat = chat + relay_chat;
                    }
                }
            }

            let postedChat = chat;
            status = await retryfn(
                6,
                [4],
                () => bili.sendChatWithOcr(
                    rid,
                    chat,
                    chat_type
                )
            );

            if (status === 8 ||
                status === 9) {
                postedChat = selectDiverseCommentFallback(
                    DEFAULT_UNIQUE_COMMENT_FALLBACKS,
                    getSuccessfulComments(dyid),
                    stableCommentOffset(dyid, Number(process.env.NUMBER)),
                    Number(config.ai_comment_similarity_threshold) || 0.57
                ) || '来试试手气';
                status = await bili.sendChatWithOcr(
                    rid,
                    postedChat,
                    chat_type
                );
            }

            if (status === 13) {
                log.warn(
                    '评论限额',
                    `dyid: ${dyid} 评论达到发送上限；不再执行该候选的关注、点赞和转发，保留到下一轮`
                );
                return 1013;
            } else if (status) {
                log.warn('抽奖信息', `dyid: ${dyid}, rid: ${rid}, chat_type: ${chat_type}`);
                return 1000 + status;
            }

            if (useAiComment) rememberSuccessfulComment(dyid, postedChat);
        }

        /* 关注 */
        if (uid.length) {
            await try_for_each(uid, async (u) => {
                status = await bili.autoAttention(u);
                if (status === 6) {
                    status = 0;
                    return false;
                }
                if (status) {
                    log.warn('抽奖信息', `dyid: ${dyid}, uid: ${u}`);
                    return true;
                } else {
                    if (is_not_create_partition !== true) {
                        if (await bili.movePartition(u, this.tagid)) {
                            log.warn('抽奖信息', `dyid: ${dyid}, uid: ${u} tagid: ${this.tagid}`);
                            /* 3000系错误 */
                            status = 1001;
                            return true;
                        } else {
                            return false;
                        }
                    } else {
                        return false;
                    }
                }
            });
            if (status) return 2000 + status;
        }

        /* 点赞 */
        if (!check_if_duplicated || check_if_duplicated === 3) {
            status = await retryfn(
                5,
                [3],
                () => bili.autolike(dyid)
            );

            if (status) {
                log.warn('抽奖信息', `dyid: ${dyid}`);
                return 4000 + status;
            }
        }

        /* 转发 */
        if (dyid) {
            status = await retryfn(
                5,
                [3, 4],
                () => bili.autoRelay(
                    global_var.get('myUID'),
                    dyid,
                    relay_chat,
                    ctrl)
            );

            if (status) {
                log.warn('抽奖信息', `dyid: ${dyid}`);
                return 5000 + status;
            }
        }

        return status;
    }
}


module.exports = {
    Monitor,
    buildAiCommentPrompt,
    getAiCommentSimilarity,
    getMaxAiCommentSimilarity,
    normalizeAiComment,
    parseAiCommentResponse,
    selectDiverseCommentFallback,
    selectUniqueCommentFallback,
    validateAiComment,
};
