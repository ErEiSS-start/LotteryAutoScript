const utils = require('../utils');
const bili = require('../net/bili');
const { send } = require('../net/http');
const {
    check_if_duplicated, article_scan_page, article_create_time, not_check_article,
    get_dynamic_detail_wait, uid_scan_page, collection_uid_scan_page,
    collection_dynamic_max_age_hours, collection_dynamic_keywords,
    collection_uid_page_352_cooldowns,
    search_wait, tag_scan_page
} = require('../data/config');
const d_storage = require('../helper/d_storage');
const global_var = require('../data/global_var');

const { log } = utils;

function markDiscoveryIncomplete(reason) {
    if (!process.env.LOTTERY_DISCOVERY_ONLY) return;
    global_var.set('discoveryIncomplete', true);
    const reasons = global_var.get('discoveryIncompleteReasons') || [];
    if (!reasons.includes(reason)) reasons.push(reason);
    global_var.set('discoveryIncompleteReasons', reasons);
}

function extractCollectionDynamicLinks(content) {
    if (typeof content !== 'string') return { dyids: [], shortIds: [] };

    const dyids = [];
    const directPatterns = [
        /(?:www\.)?bilibili\.com\/opus\/([0-9]{18,})/gi,
        /t\.bilibili\.com\/([0-9]{18,})/gi,
    ];
    for (const pattern of directPatterns) {
        for (const match of content.matchAll(pattern)) dyids.push(match[1]);
    }

    const shortIds = [...content.matchAll(/b23\.tv\/([a-zA-Z0-9]{5,16})/g)]
        .map(match => match[1]);
    return {
        dyids: [...new Set(dyids)],
        shortIds: [...new Set(shortIds)],
    };
}

function normalizeTopicReference(topic) {
    if (topic && typeof topic === 'object') {
        const id = Number(topic.id);
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        return {
            id,
            name: String(topic.name || id).trim(),
        };
    }
    const name = String(topic || '').trim();
    return name ? { id: 0, name } : null;
}

function modifyTopicDynamicRes(res) {
    const parsed = utils.strToJson(res);
    const topicList = parsed?.data?.topic_card_list;
    if (parsed.code !== 0 || !topicList) {
        log.warn('处理话题动态', '新版话题响应不可用');
        return null;
    }

    const items = Array.isArray(topicList.items)
        ? topicList.items
            .map(item => item?.dynamic_card_item)
            .filter(Boolean)
        : [];
    return {
        modifyDynamicResArray: items.map(item => parseDynamicCard({ item })),
        nextinfo: {
            has_more: Boolean(topicList.has_more),
            next_offset: topicList.offset || '',
        }
    };
}

function isRecentCollectionDynamic(item, nowTs = Date.now() / 1000, maxAgeHours = 48) {
    const createTime = Number(item?.create_time);
    const ageHours = Number(maxAgeHours);
    if (!Number.isFinite(createTime) || createTime <= 0) return false;
    if (!Number.isFinite(ageHours) || ageHours <= 0) return false;
    return createTime >= nowTs - ageHours * 60 * 60;
}

/**
 * 解析dynamic_detail_card
 * 提取出的有用动态信息
 * @typedef {object} UsefulDynamicInfo
 * @property {number} uid
 * @property {string} uname
 * @property {boolean} is_liked
 * @property {number} create_time 10
 * @property {string} rid_str
 * @property {number} chat_type
 * @property {string} dynamic_id
 * @property {number} type
 * @property {string} description
 * @property {string} reserve_id
 * @property {string} reserve_lottery_text
 * @property {boolean} is_charge_lottery
 * @property {boolean} hasOfficialLottery
 * @property {Array<Object.<string,string|number>>} ctrl
 * @property {number} origin.create_time 10
 * @property {number} origin.uid
 * @property {string} origin.uname
 * @property {string} origin.rid_str
 * @property {number} origin.chat_type
 * @property {string} origin.dynamic_id
 * @property {number} origin.type
 * @property {string} origin.description
 * @property {string} origin.reserve_id
 * @property {string} origin.reserve_lottery_text
 * @property {boolean} origin.is_charge_lottery
 * @property {boolean} origin.hasOfficialLottery
 * 
 * 整理后的抽奖信息
 * @typedef {object} LotteryInfo
 * @property {string} lottery_info_type
 * @property {number} create_time
 * @property {boolean} is_liked
 * @property {number[]} uids `[uid,ouid]`
 * @property {string} uname
 * @property {Array<{}>} ctrl
 * @property {string} dyid
 * @property {string} reserve_id
 * @property {string} reserve_lottery_text
 * @property {boolean} is_charge_lottery
 * @property {string} rid
 * @property {number} chat_type
 * @property {string} des
 * @property {number} type
 * @property {boolean} hasOfficialLottery 是否官方
 * 
 * @param {object} data
 * @return {UsefulDynamicInfo}
 */
function parseDynamicCard(data) {
    // 如果是多个 items，返回一个数组
    if (Array.isArray(data?.items)) {
        return data.items.map(item => parseDynamicCard({ item }));
    }

    let ditem = data?.item;
    /**临时储存单个动态中的信息 */
    let obj = {};
    try {
        const dy_typeenum2num = new Map([
            ['DYNAMIC_TYPE_FORWARD', 1],
            ['DYNAMIC_TYPE_DRAW', 2],
            ['DYNAMIC_TYPE_WORD', 4],
            ['DYNAMIC_TYPE_AV', 8],
            ['DYNAMIC_TYPE_ARTICLE', 64]
        ]);
        const dy_type2chat_type = new Map([
            ['DYNAMIC_TYPE_FORWARD', 17],
            ['DYNAMIC_TYPE_DRAW', 11],
            ['DYNAMIC_TYPE_WORD', 17],
            ['DYNAMIC_TYPE_AV', 1],
            ['DYNAMIC_TYPE_ARTICLE', 12]
        ]);
        const modules = Array.isArray(ditem?.modules)
                ? Object.assign({}, ...ditem.modules)
                : (ditem?.modules || {}),
            moduleAuthor = modules.module_author || {},
            moduleDynamic = modules.module_dynamic || {},
            moduleStat = modules.module_stat || {},
            moduleDesc = modules.module_desc || moduleDynamic.desc || {},
            additional = moduleDynamic.additional || moduleDynamic.dyn_additional || {};
        /* 转发者的UID */
        obj.uid = moduleAuthor.mid || moduleAuthor.user?.mid || 0;
        /* 转发者的name */
        obj.uname = moduleAuthor.name || moduleAuthor.user?.name || '';
        /* 动态是否点过赞 */
        obj.is_liked = moduleStat.like?.status ?? moduleStat.like?.like_state ?? false;
        /* 动态的ts10 */
        obj.create_time = moduleAuthor.pub_ts || 0;
        /* 动态类型 */
        obj.type = dy_typeenum2num.get(ditem?.type) || 0;
        /* 用于发送评论 无法获取到源动态的rid_str*/
        obj.rid_str = ditem?.basic?.comment_id_str
            || ditem?.basic?.rid_str
            || moduleStat.comment?.comment_id
            || '';
        /* 用于发送评论 */
        obj.chat_type = dy_type2chat_type.get(ditem?.type) || 0;
        /* 转发者的动态ID !!!!此为大数需使用字符串值,不然JSON.parse()会有丢失精度 */
        obj.dynamic_id = ditem?.id_str || '';
        /* 定位@信息 */
        obj.ctrl = [];
        /* 是否有官方抽奖 */
        obj.hasOfficialLottery = false;
        /* 转发描述 */
        obj.description = moduleDynamic.major?.archive?.desc
            || moduleDynamic.dyn_archive?.desc
            || '';
        let _total_len = 0;
        let rich_text_nodes = moduleDesc.rich_text_nodes
            || moduleDynamic.major?.opus?.summary?.rich_text_nodes
            || [];
        rich_text_nodes.forEach(node => {
            if (node.type === 'RICH_TEXT_NODE_TYPE_AT') {
                obj.ctrl.push({
                    data: node.rid,
                    location: _total_len,
                    length: node.text.length,
                    type: 1
                });
            }
            /* 是否有官方抽奖 */
            if (node.type === 'RICH_TEXT_NODE_TYPE_LOTTERY') {
                obj.hasOfficialLottery = true;
            }
            obj.description += node.orig_text;
            _total_len += node.text.length;
        });
        /* 预约抽奖信息 */
        obj.reserve_id = additional.reserve?.rid || 0;
        obj.reserve_lottery_text = additional.reserve?.title || '未获取到';
        /* 充电抽奖 */
        obj.is_charge_lottery = false;
        if (additional.type === 'ADDITIONAL_TYPE_UPOWER_LOTTERY') {
            obj.is_charge_lottery = true;
        }
        /* 转发 */
        if (obj.type === 1) {
            obj.origin = parseDynamicCard({item: ditem.orig});
        } else {
            obj.origin = {};
        }
    } catch (e) {
        log.error('动态卡片解析', e);
    }

    return obj;
}

/**
 * 处理来自个人动态或话题页面的一组动态数据
 * @param {String} res
 * @returns {{modifyDynamicResArray: UsefulDynamicInfo[], nextinfo: {has_more: number, next_offset: string}} | UsefulDynamicInfo |null}
 */
function modifyDynamicRes(res) {
    let
        { data, code } = utils.strToJson(res),
        { items, has_more, offset } = data || {};

    if (code !== 0) {
        log.error('处理动态数据', '获取动态数据出错,可能是访问太频繁 \n' + res);
        return null;
    }
    /**
    * !cards已经能涵盖cards == null，你在想什么？
    */
    if (!items || !items.length) {
        log.warn('处理动态数据', '未找到任何动态信息');
        items = [];
    }

    if (typeof has_more === 'undefined'
        && typeof offset === 'undefined') {
        log.error('处理动态数据', '该功能已失效');
        return null;
    }

    const
        /**
         * 字符串offset防止损失精度
         */
        next = {
            has_more,
            next_offset: offset
        },
        /**
         * 储存获取到的一组动态中的信息
         */
        array = next.has_more === 0
            ? []
            : items.map(item => parseDynamicCard({ item }));

    log.info('处理动态数据', `动态数据读取完毕(${items.length})(${next.has_more})`);

    return {
        modifyDynamicResArray: array,
        nextinfo: next
    };
}

/**
 * 基础搜索功能
 */
class Searcher {
    constructor() { }
    /**
     * 检查指定用户的所有的动态信息
     * @param {number} hostuid 指定的用户UID
     * @param {number} pages 读取页数
     * @param {number} time 时延
     * @param {string} [offset] 默认'0'
     * @param {{retry352Cooldowns?: number[], markDiscoveryIncomplete?: boolean, scope?: string}} [options]
     * @returns {Promise<{allModifyDynamicResArray: UsefulDynamicInfo[], offset: string} | null>} 获取前 `pages*12` 个动态信息
     */
    static async checkAllDynamic(host_mid, pages, time = 0, offset = '0', options = {}) {
        log.info('检查所有动态', `准备读取${pages}页动态`);

        const { getOneDynamicInfoByUID } = bili,
            /**
             * 柯里化请求函数
             */
            curriedGetOneDynamicInfoByUID = utils.curryify(getOneDynamicInfoByUID),
            /**
             * 储存了特定UID的请求函数
             */
            hadUidGetOneDynamicInfoByUID = curriedGetOneDynamicInfoByUID(host_mid);

        /**
         * 储存所有经过整理后信息
         * @type { UsefulDynamicInfo[] }
         */
        let allModifyDynamicResArray = [];

        const retry352Cooldowns = Array.isArray(options.retry352Cooldowns)
            ? options.retry352Cooldowns
                .map(value => Number(value))
                .filter(value => Number.isFinite(value) && value > 0)
            : [];

        for (let i = 0; i < pages; i++) {
            log.info('检查所有动态', `正在读取其中第${i + 1}页动态`);

            let mDRdata = null;
            for (let attempt = 0; attempt <= retry352Cooldowns.length; attempt++) {
                const oneDynamicInfo = offset === '0'
                    ? await hadUidGetOneDynamicInfoByUID()
                    : await hadUidGetOneDynamicInfoByUID(offset);
                mDRdata = modifyDynamicRes(oneDynamicInfo);
                if (mDRdata !== null) break;

                const is352 = /"code"\s*:\s*-352\b/.test(oneDynamicInfo);
                if (!is352 || attempt >= retry352Cooldowns.length) break;
                const cooldown = retry352Cooldowns[attempt];
                log.warn(
                    '空间动态重试',
                    `用户${host_mid}第${i + 1}页收到-352，${Math.ceil(cooldown / 1000)}秒后只重试当前页 (${attempt + 1}/${retry352Cooldowns.length})`
                );
                await utils.delay(cooldown);
            }

            if (mDRdata === null) {
                if (options.markDiscoveryIncomplete) {
                    markDiscoveryIncomplete(
                        `${options.scope || `用户${host_mid}`}第${i + 1}页动态读取失败`
                    );
                }
                return null;
            }

            const
                /**
                 * 一片动态
                 */
                mDRArry = mDRdata.modifyDynamicResArray,
                nextinfo = mDRdata.nextinfo;

            /**先保存本页；旧逻辑会漏掉 has_more=false 的最后一页 */
            allModifyDynamicResArray.push.apply(allModifyDynamicResArray, mDRArry);

            if (!nextinfo.has_more) {
                offset = nextinfo.next_offset;
                log.info('检查所有动态', '已经是最后一页了故无法读取更多');
                break;
            } else {
                offset = nextinfo.next_offset;
            }

            if (i < pages - 1) await utils.delay(time);
        }

        log.info('检查所有动态', `${pages}页信息读取完成`);

        return ({ allModifyDynamicResArray, offset });
    }

    /**
     * 获取最新动态信息(转发子动态)
     * 并初步整理
     * @param {string} UID
     * @returns {Promise<LotteryInfo[] | null>}
     */
    async getLotteryInfoByUID(UID) {
        log.info('获取动态', `开始获取用户${UID}的动态信息`);
        const AllDynamic = await Searcher.checkAllDynamic(UID, uid_scan_page, search_wait);

        if (AllDynamic === null) return null;

        let { allModifyDynamicResArray } = AllDynamic,
            { length } = allModifyDynamicResArray;

        if (!length) return null;

        const dynamicList = allModifyDynamicResArray
            .filter(d => {
                if (d.type === 1) {
                    return true;
                } else {
                    length--;
                    return false;
                }
            });
        const fomatdata = [];

        for (const cur of dynamicList) {
            const originDyid = String(cur?.origin?.dynamic_id || '').trim();
            if (!utils.isValidDynamicId(originDyid)) {
                log.warn('获取动态', `源动态ID无效(${originDyid || '空'})，跳过该转发动态`);
                length--;
                continue;
            }

            const card = await bili.getOneDynamicByDyid(originDyid);
            log.info('获取动态', `查看源动态(${originDyid})详细信息获取rid用于评论 (${length--})`);
            if (!card) {
                log.warn('获取动态', `源动态详情获取失败(${originDyid})，跳过该转发动态`);
                await utils.delay(get_dynamic_detail_wait);
                continue;
            }
            cur.origin = parseDynamicCard(card);
            if (!utils.isValidDynamicId(cur.origin.dynamic_id)) {
                log.warn('获取动态', `源动态解析后ID无效(${originDyid})，跳过该转发动态`);
                await utils.delay(get_dynamic_detail_wait);
                continue;
            }
            await utils.delay(get_dynamic_detail_wait);

            fomatdata.push({
                lottery_info_type: 'uid',
                create_time: cur.origin.create_time,
                is_liked: cur.origin.is_liked,
                uids: [cur.uid, cur.origin.uid],
                uname: cur.origin.uname,
                ctrl: cur.origin.ctrl,
                dyid: cur.origin.dynamic_id,
                reserve_id: cur.origin.reserve_id,
                reserve_lottery_text: cur.origin.reserve_lottery_text,
                is_charge_lottery: cur.origin.is_charge_lottery,
                rid: cur.origin.rid_str,
                chat_type: cur.origin.chat_type,
                des: cur.origin.description,
                type: cur.origin.type,
                hasOfficialLottery: cur.origin.hasOfficialLottery
            });
        }

        log.info('获取动态', `成功获取用户${UID}的动态信息`);

        return fomatdata;
    }

    /**
     * 扫描指定UID发布的合集动态，从正文链接中批量提取抽奖动态ID
     * @param {string} UID
     * @returns {Promise<LotteryInfo[] | null>}
     */
    async getLotteryInfoByCollectionUID(UID) {
        const scanPages = Math.max(1, Number(collection_uid_scan_page) || 2);
        const maxAgeHours = Math.max(1, Number(collection_dynamic_max_age_hours) || 48);
        const keywords = Array.isArray(collection_dynamic_keywords)
            ? collection_dynamic_keywords.filter(Boolean)
            : [];
        log.info('获取合集动态', `开始扫描用户${UID}的${scanPages}页动态`);

        const allDynamic = await Searcher.checkAllDynamic(
            UID,
            scanPages,
            search_wait,
            '0',
            {
                retry352Cooldowns: collection_uid_page_352_cooldowns,
                markDiscoveryIncomplete: true,
                scope: `合集用户${UID}`
            }
        );
        if (allDynamic === null) return null;

        let skippedByAge = 0;
        const nowTs = Date.now() / 1000;
        const candidates = allDynamic.allModifyDynamicResArray.filter(item => {
            if (item.type === 1) return false;
            if (!isRecentCollectionDynamic(item, nowTs, maxAgeHours)) {
                skippedByAge += 1;
                return false;
            }
            if (!keywords.length) return true;
            const description = item.description || '';
            return keywords.some(keyword => description.includes(keyword));
        });
        log.info(
            '获取合集动态',
            `用户${UID}找到最近${maxAgeHours}小时疑似合集动态(${candidates.length})，按时间跳过(${skippedByAge})`
        );

        const seenDyids = new Set();
        const dyinfos = [];
        for (const collection of candidates) {
            const collectionDyid = String(collection.dynamic_id || '');
            if (!utils.isValidDynamicId(collectionDyid)) {
                log.warn('获取合集动态', `合集动态ID无效(${collectionDyid || '空'})，跳过`);
                continue;
            }
            const content = await bili.getOneOpusByDyid(collectionDyid);
            if (!content) {
                log.warn('获取合集动态', `合集动态(${collectionDyid})正文不可用，跳过`);
                continue;
            }

            const extracted = extractCollectionDynamicLinks(content);
            const shortDyids = [];
            for (const shortId of extracted.shortIds) {
                const dyid = await bili.shortDynamicIdToDyid(shortId);
                if (utils.isValidDynamicId(dyid)) shortDyids.push(String(dyid));
            }
            const dyids = [...new Set([...extracted.dyids, ...shortDyids])]
                .filter(dyid => utils.isValidDynamicId(dyid)
                    && dyid !== collectionDyid
                    && !seenDyids.has(dyid));
            log.info('获取合集动态', `合集动态(${collectionDyid})提取链接动态ID(${dyids.length})`);

            for (const dyid of dyids) {
                seenDyids.add(dyid);
                const card = await bili.getOneDynamicByDyid(dyid);
                if (!card) {
                    log.warn('获取合集动态', `动态细节获取失败(${dyid})`);
                    continue;
                }

                await utils.delay(get_dynamic_detail_wait);
                const parsedCard = parseDynamicCard(card);
                if (
                    (((!check_if_duplicated || check_if_duplicated >= 2)
                        && parsedCard.is_liked)
                        || ((check_if_duplicated >= 1)
                            && await d_storage.searchDyid(dyid)))
                ) {
                    log.info('获取合集动态', `动态(${dyid})已转发过`);
                    continue;
                }
                dyinfos.push(parsedCard);
            }
        }

        const formatted = dyinfos.map(o => ({
            lottery_info_type: 'collection_uid',
            create_time: o.create_time,
            is_liked: o.is_liked,
            uids: [o.uid, o.origin.uid],
            uname: o.uname,
            ctrl: o.ctrl,
            dyid: o.dynamic_id,
            reserve_id: o.reserve_id,
            reserve_lottery_text: o.reserve_lottery_text,
            is_charge_lottery: o.is_charge_lottery,
            rid: o.rid_str,
            chat_type: o.chat_type,
            des: o.description,
            type: o.type,
            hasOfficialLottery: o.hasOfficialLottery
        }));
        log.info('获取合集动态', `成功从用户${UID}的合集正文获取动态(${formatted.length})`);
        return formatted;
    }

    /**
     * 获取tag下的抽奖信息(转发母动态)  
     * 并初步整理
     * @param {string|{id:number,name:string}} topicOption
     * @returns {Promise<LotteryInfo[] | null>}
     */
    async getLotteryInfoByTag(topicOption) {
        const configuredTopic = normalizeTopicReference(topicOption);
        if (!configuredTopic) {
            log.warn('获取话题动态', '话题配置无效，跳过');
            return [];
        }
        const topic = configuredTopic.id
            ? configuredTopic
            : await bili.searchExactTopicByName(configuredTopic.name);
        if (!topic) return [];

        const pages = Math.max(1, Number(tag_scan_page) || 1);
        const mDRdata = [];
        let nextOffset = '';
        log.info('获取话题动态', `开始读取#${topic.name}#(${topic.id})，最多${pages}页`);
        for (let index = 0; index < pages; index++) {
            const response = await bili.getTopicDynamicPage(topic.id, nextOffset);
            const modified = response ? modifyTopicDynamicRes(response) : null;
            if (!modified) {
                markDiscoveryIncomplete(`话题#${topic.name}#第${index + 1}页读取失败`);
                return null;
            }
            mDRdata.push(...modified.modifyDynamicResArray);
            nextOffset = modified.nextinfo.next_offset;
            log.info(
                '获取话题动态',
                `#${topic.name}#第${index + 1}页读取完成(${modified.modifyDynamicResArray.length})`
            );
            if (!modified.nextinfo.has_more) break;
            if (index < pages - 1) await utils.delay(search_wait);
        }
        const fomatdata = mDRdata.map(o => {
            return {
                lottery_info_type: 'tag',
                create_time: o.create_time,
                is_liked: o.is_liked,
                uids: [o.uid, o.origin.uid],
                uname: o.uname,
                ctrl: o.ctrl,
                dyid: o.dynamic_id,
                reserve_id: o.reserve_id,
                reserve_lottery_text: o.reserve_lottery_text,
                is_charge_lottery: o.is_charge_lottery,
                rid: o.rid_str,
                chat_type: o.chat_type,
                des: o.description,
                type: o.type,
                hasOfficialLottery: o.hasOfficialLottery
            };
        });
        log.info('获取动态', `成功获取带话题#${topic.name}#的动态信息(${fomatdata.length})`);

        return fomatdata;
    }

    /**
     * 从专栏中获取抽奖信息
     * @param {string} key_words
     * @returns {Promise<LotteryInfo[] | null>}
     */
    async getLotteryInfoByArticle(key_words) {
        log.info('获取动态', `开始获取含关键词${key_words}的专栏信息`);
        const cvs = (await bili.searchArticlesByKeyword(key_words)).slice(0, article_scan_page);

        /**存储所有专栏中的dyid */
        let dyinfos = [];
        /**遍历专栏s */
        for (const { id, pub_time } of cvs) {
            let now_time = Math.floor(Date.now() / 1000);
            if ((now_time - pub_time) / 86400 > article_create_time) {
                log.warn('获取动态', `该专栏(${id})创建时间大于设定天数(${article_create_time}天)`);
                continue;
            }
            const articleContent = await bili.getOneArticleByCv(id);
            if (!articleContent) {
                log.warn('获取动态', `专栏(${id})正文为空或疑似风控，跳过`);
                continue;
            }
            const
                content = articleContent.split('推荐文章')[0],
                dyids = content.match(/[0-9]{18,}/g) || [],
                short_ids = content.match(/(?<=b23.tv\/)[a-zA-Z0-9]{7}/g) || [],
                short_id_set = [...new Set(short_ids)],
                short_ids_to_dyids = await Promise.all(short_id_set.map(bili.shortDynamicIdToDyid)),
                dyid_set = [...new Set([...dyids, ...short_ids_to_dyids])]
                    .filter(utils.isValidDynamicId),
                /**判断此专栏是否查看过的权重 */
                weight = dyid_set.length / 2;

            let { length } = dyid_set,
                /**初始权重 */
                _weight = 0,
                /**单个专栏中的dyid */
                _dyinfos = [];
            log.info('获取动态', `提取专栏(${id})中提及的dyid(${length})`);

            /**遍历某专栏中的dyids */
            for (const dyid of dyid_set) {
                log.info('获取动态', `查看专栏中所提及动态(${dyid}) (${length--})`);
                const card = await bili.getOneDynamicByDyid(dyid);

                if (card) {
                    await utils.delay(get_dynamic_detail_wait);

                    const parsed_card = parseDynamicCard(card)
                        , { is_liked } = parsed_card;

                    if (
                        ((!check_if_duplicated || check_if_duplicated >= 2)
                            && is_liked)
                        || ((check_if_duplicated >= 1)
                            && await d_storage.searchDyid(dyid))
                    ) {
                        log.info('获取动态', `动态(${dyid})已转发过`);
                        _weight += 1;
                    }

                    if (_weight >= weight && !not_check_article) {
                        log.warn('获取动态', '1/2动态曾经转过,该专栏或已查看,故中止');
                        _dyinfos = [];
                        break;
                    }

                    _dyinfos.push(parsed_card);
                } else {
                    log.warn('获取动态', `动态细节获取失败(${dyid})`);
                }
            }
            dyinfos.push(..._dyinfos);
        }
        const fomatdata = dyinfos.map(o => {
            return {
                lottery_info_type: 'article',
                create_time: o.create_time,
                is_liked: o.is_liked,
                uids: [o.uid, o.origin.uid],
                uname: o.uname,
                ctrl: o.ctrl,
                dyid: o.dynamic_id,
                reserve_id: o.reserve_id,
                reserve_lottery_text: o.reserve_lottery_text,
                is_charge_lottery: o.is_charge_lottery,
                rid: o.rid_str,
                chat_type: o.chat_type,
                des: o.description,
                type: o.type,
                hasOfficialLottery: o.hasOfficialLottery
            };
        });
        log.info('获取动态', `成功获取含关键词${key_words}的专栏信息`);

        return fomatdata;
    }

    /**
     * 从特定格式的api响应数据中获取抽奖信息
     * @param {string} api
     * @returns {Promise<LotteryInfo[] | null>}
     */
    getLotteryInfoByAPI(api) {
        return new Promise((resolve) => {
            if (api) {
                const { strToJson } = utils;
                log.info('获取动态', `开始获取链接(${api})中的抽奖信息`);
                if (api.startsWith('file://')) {
                    utils.readLotteryInfoFile(api.substring(7)).then(resolve);
                } else {
                    send({
                        url: api,
                        config: {
                            redirect: true
                        },
                        method: 'GET',
                        success: ({ body }) => {
                            if (body.err_msg) {
                                log.error('从API响应数据中获取抽奖信息', body.err_msg);
                                resolve(null);
                            } else {
                                const raw_lottery_info = strToJson(body).lottery_info;

                                if (raw_lottery_info) {
                                    let { length } = raw_lottery_info;
                                    if (length) {
                                        const lottery_info = raw_lottery_info
                                            .reduce(async (pre, cur) => {
                                                let results = await pre
                                                    , { dyid } = cur;

                                                if (!check_if_duplicated || check_if_duplicated >= 2) {
                                                    log.info('获取动态', `查看动态(${dyid})是否点赞 (${length--})`);
                                                    const card = await bili.getOneDynamicByDyid(dyid);

                                                    if (card) {
                                                        await utils.delay(get_dynamic_detail_wait);

                                                        const { is_liked } = parseDynamicCard(card);

                                                        if (is_liked) {
                                                            log.info('获取动态', `动态(${dyid})已转发过`);
                                                        } else {
                                                            cur.is_liked = is_liked;
                                                            results.push(cur);
                                                        }
                                                    }
                                                } else {
                                                    results.push(cur);
                                                }

                                                return results;

                                            }, Promise.resolve([]));

                                        resolve(lottery_info);
                                        return;
                                    }
                                }
                                log.error('从API响应数据中获取抽奖信息', '非Json数据或没有lottery_info或lottery为空');
                                resolve(null);
                            }
                        },
                        failure: err => {
                            log.error('从API响应数据中获取抽奖信息', err);
                            resolve(null);
                        }
                    });
                }
            } else {
                log.warn('获取动态', '链接为空');
                resolve(null);
            }
        });
    }

    /**
     * 从本地文件中获取抽奖信息
     * @param {string} txt
     * @returns {Promise<LotteryInfo[] | null>}
     */
    async getLotteryInfoByTxT(txt) {
        log.info('获取动态', `开始获取${utils.lottery_dyids}`);
        const dyids = await utils.getLocalLotteryTxt(txt);
        let
            length = dyids.length,
            dyinfos = [];

        for (const dyid of dyids) {
            log.info('获取动态', `查看Txt中所提及动态(${dyid}) (${length--})`);
            const card = await bili.getOneDynamicByDyid(dyid);

            if (card) {
                await utils.delay(get_dynamic_detail_wait);

                const parsed_card = parseDynamicCard(card)
                    , { is_liked } = parsed_card;

                if (
                    ((!check_if_duplicated || check_if_duplicated >= 2)
                        && is_liked)
                    || ((check_if_duplicated >= 1)
                        && await d_storage.searchDyid(dyid))
                ) {
                    log.info('获取动态', `动态(${dyid})已转发过`);
                    continue;
                }

                dyinfos.push(parsed_card);
            } else {
                log.warn('获取动态', `动态细节获取失败(${dyid})`);
            }

        }
        const fomatdata = dyinfos.map(o => {
            return {
                lottery_info_type: 'txt',
                create_time: o.create_time,
                is_liked: o.is_liked,
                uids: [o.uid, o.origin.uid],
                uname: o.uname,
                ctrl: o.ctrl,
                dyid: o.dynamic_id,
                reserve_id: o.reserve_id,
                reserve_lottery_text: o.reserve_lottery_text,
                is_charge_lottery: o.is_charge_lottery,
                rid: o.rid_str,
                chat_type: o.chat_type,
                des: o.description,
                type: o.type,
                hasOfficialLottery: o.hasOfficialLottery
            };
        });
        log.info('获取动态', '成功获取txt信息');

        return fomatdata;
    }
}

module.exports = {
    Searcher,
    parseDynamicCard,
    extractCollectionDynamicLinks,
    isRecentCollectionDynamic,
    normalizeTopicReference,
    modifyTopicDynamicRes,
};
