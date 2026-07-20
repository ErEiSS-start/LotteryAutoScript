const { config_file } = require('../utils');

const config = {
    /**
     * 监视更转的用户uid
     */
    UIDs: [],

    /**
     * 发布抽奖合集动态的用户uid
     */
    CollectionUIDs: [],

    /**
     * - 每个合集UID读取的动态页数
     */
    collection_uid_scan_page: 2,

    /**
     * - 只读取最近多少小时内发布的合集动态
     * - 按合集动态自身的发布时间计算
     */
    collection_dynamic_max_age_hours: 48,

    /**
     * - 用于识别合集动态的关键词；空数组表示检查合集UID的所有原创动态
     */
    collection_dynamic_keywords: [
        '抽奖合集', '抽奖汇总', '抽奖整理', '抽奖集合', '抽奖清单', '福利合集'
    ],

    /**
     * - 合集UID单页收到 -352 后的渐进重试间隔
     */
    collection_uid_page_352_cooldowns: [
        5 * 1000,
        10 * 1000,
        20 * 1000
    ],

    /**
     * 监视的话题。
     * 推荐显式配置 { id, name }；字符串仅接受新版话题搜索的完全同名结果。
     */

    TAGs: [],
    /**
     * 监视的专栏关键词
     */
    Articles: [],

    /**
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
     * @property {string} rid
     * @property {string} des
     * @property {number} type
     * @property {boolean} hasOfficialLottery 是否官方
     * @typedef {object} RespondBody
     * @property {string} err_msg 错误信息
     * @property {LotteryInfo[]} lottery_info
     * 
     * - 从API接口中获取抽奖信息
     * 获取抽奖信息的链接字符串
     * @example
     * ["https://github.com/spiritLHL/sync_lottery"]
     * 
     * - 从当前路径下符合要求的文件中获取
     * 文件名
     * @example
     * ["file://lottery_info_1.json"]
     */
    APIs: [],

    /**
     * lottery_dyids目录下抽奖动态文件名(如dyids.txt)
     * 一行一个dyids
     */
    TxT: [],

    /**
     * 抽奖参与顺序组合
     * * 0 - UIDs
     * * 1 - TAGs
     * * 2 - Articles
     * * 3 - APIs
     * * 4 - TxT
     * * 5 - CollectionUIDs（扫描合集动态正文）
     * @example
     * [3,2,1,0]
     * [1,2,1,2,1]
     */
    LotteryOrder: [2, 5, 0, 1, 3],

    /**
     * 保存抽奖信息至文件
     */
    save_lottery_info_to_file: false,

    /**
     * 轮转采集模式：collect重新采集；reuse复用快照；resume从来源级断点续采
     */
    lottery_discovery_mode: 'collect',

    /** 每个帐号每轮成功参与的数量 */
    lottery_batch_size: 8,

    /** 所有帐号完成一轮后的统一休息时间 */
    lottery_round_cooldown: 5 * 60 * 1000,

    /** 轮转筛选汇总中每类最多显示的样例数，0表示只显示数量 */
    lottery_filter_log_detail_limit: 5,

    /**
     * 动态详情遇到 -352/412 后重试当前动态的渐进冷却时间
     */
    dynamic_detail_risk_cooldowns: [
        3 * 1000,
        10 * 1000,
        30 * 1000,
        2 * 60 * 1000,
    ],

    /**
     * API发送数据类型 {LotteryInfo[]}
     * 上传抽奖信息的链接字符串
     */
    set_lottery_info_url: '',

    /**
     * 动态中的关键词(表示须同时满足以下条件)
     * 符合js正则表达式的字符串
     */
    key_words: [
        '[抽奖送揪]|福利',
        '[转关评粉]|参与'
    ],

    /** AI供应商通用控制 */
    ai_request_timeout: 30 * 1000,
    ai_provider_retry_count: 1,
    ai_circuit_failure_threshold: 3,
    ai_circuit_cooldown: 10 * 60 * 1000,
    /** 模型公共资源繁忙(code 1305)时的模型级冷却 */
    ai_model_busy_cooldown: 2 * 60 * 1000,
    /** AI预判全部供应商不可用时允许持续等待的最长时间 */
    ai_prejudge_max_outage_wait: 30 * 60 * 1000,
    /** AI预判固定串行；保留旧配置项用于兼容 */
    ai_judge_concurrency: 1,
    /** 两次真实AI预判请求之间的最小间隔，缓存命中不等待 */
    ai_judge_interval: 3 * 1000,
    /** 单个候选在同一智谱帐号上的额外重试次数 */
    ai_judge_provider_retry_count: 0,

    ai_judge_parm: {
        providers: [],
        /** 兼容旧版单供应商配置 */
        url: '',
        body: {},
        prompt: ''
    },
    
    /**
     * - '00' 关闭自动抽奖
     * - '10' 只转发官方抽奖
     * - '01' 只转发非官方抽奖
     * - '11' 都转
     */
    model: '11',

    /**
     * - '00'关闭自动评论
     * - '10'只评论官抽
     * - '01'只评论非官抽
     * - '11'都评论
     */
    chatmodel: '01',

    /**
     * 不参与预约抽奖
     */
    disable_reserve_lottery: false,

    /**
     * 不转发预约抽奖
     * - 预约抽奖可能与转发抽奖并存
     */
    is_not_relay_reserve_lottery: false,

    /**
     * 检查是否重复转发
     * - 不检查 -1
     * - 通过是否点赞判断(自动点赞) 0
     * - 检索本地dyids文件 1
     * - 通过是否点赞判断(不自动点赞)+检索本地dyids文件 2
     * - 通过是否点赞判断(自动点赞)+检索本地dyids文件 3
     */
    check_if_duplicated: 1,

    /**
     * 偷塔模式不检查是否重复转发
     * * 偷塔模式: 临近开奖时参与抽奖
     */
    sneaktower: true,

    /**
     * 屏蔽动态类型
     * 
     * | 动态类型   | type值 |
     * | :------- |:----- |
     * | 转发       | `1`    |
     * | 含图片     | `2`    |
     * | 无图纯文字  | `4`    |
     * | 视频       | `8`    |
     * | 番剧       | `512`  |
     * | 活动       | `2048` |
     * | 专栏       | `64`   |
     */
    block_dynamic_type: [0],

    /**
     * - 动态创建时间
     * - 多少天前
     */
    max_create_time: 60,

    /**
     * 不加判断的转发所监视的uid转发的动态
     */
    is_imitator: false,

    /**
     * - 在uid里检索的页数
     */
    uid_scan_page: 3,

    /**
     * - 每个话题最多读取的总页数
     */
    tag_scan_page: 3,

    /**
     * - 获取专栏数量
     */
    article_scan_page: 3,

    /**
     * - 专栏创建时间距离现在的最大天数
     */
    article_create_time: 7,

    /**
     * - 不检查专栏是否看过，若选择检查可以提高检测效率
     * - 默认false(检查)
     */
    not_check_article: false,

    /**
     * - 开奖时间距离现在的最大天数
     * - 默认不限制
     */
    maxday: Infinity,

    /**
     *  - 循环等待时间(指所有操作完毕后的休眠时间)
     *  - 单位毫秒
     */
    lottery_loop_wait: 0,
    check_loop_wait: 0,
    clear_loop_wait: 0,

    /**
     * - 转发间隔时间
     * - 单位毫秒
     * - 上下浮动50%
     */
    wait: 30 * 1000,

    /**
     * - 检索动态间隔
     * - 单位毫秒
     */
    search_wait: 2000,

    /**
     * - 读取下一页私信间隔
     * - 单位毫秒
     */
    get_session_wait: 3000,

    /**
     * - 已读私信间隔
     * - 单位毫秒
     */
    update_session_wait: 1000,

    /**
     * - 读取下一页关注列表间隔
     * - 单位毫秒
     */
    get_partition_wait: 2000,

    /**
     * - 获取动态细节间隔
     * - 单位毫秒
     */
    get_dynamic_detail_wait: 2000,

    /**
     * - 过滤间隔(开奖时间/粉丝数)
     * - 单位毫秒
     */
    filter_wait: 1000,

    /**
     * - 随机动态间隔
     * - 单位毫秒
     */
    random_dynamic_wait: 2000,

    /**
     * - 预约抽奖间隔
     * - 单位毫秒
     */
    reserve_lottery_wait: 6000,

    /**
     * - up主粉丝数限制
     */
    minfollower: 1000,

    /**
     * - 只转发已关注的
     */
    only_followed: false,

    /**
     * - 是否发送随机动态(防止被开奖机过滤)
     */
    create_dy: false,

    /**
     * 随机动态类型
     * - 0 自定义文字与图片
     * - 1 推荐视频
     * - -1 混合
     */
    create_dy_type: 0,

    /**
     * - 结束运行时发送随机动态的数量
     */
    create_dy_num: 1,

    /**
     * - 随机动态内容
     * - 类型 `content[]`
     * @typedef Picture
     * @property {string} img_src 站内源
     * @property {number} img_width
     * @property {number} img_height
     * @param { string | Picture[] } content
     */
    dy_contents: ['[doge]', '[doge][doge]'],

    /**
     * - 每转发x条抽奖动态就发送x条随机动态
     * - @example [[10,11,9],[6,8,9]] 每转发9,10,11条抽奖动态就发送6,8,9条随机动态
     */
    create_dy_mode: [[0], [0]],

    /**
     * 转发时[at]的用户
     */
    at_users: [['转发抽奖娘', 294887687], ['你的工具人老公', 100680137]],

    /**
     * - 英文逗号分隔 如: 1,2,3
     */
    blacklist: '',

    /**
     * 屏蔽词
     */
    blockword: ['脚本', '抽奖号', '钓鱼'],

    /**
     * 转发并评论
     * - 评论内容与转发内容相同
     */
    is_repost_then_chat: false,

    /**
     * 转发评语
     */
    relay: ['转发动态'],

    /**
     * 评论内容
     */
    chat: [
        '[OK]', '[星星眼]', '[歪嘴]', '[喜欢]', '[偷笑]', '[笑]', '[喜极而泣]', '[辣眼睛]', '[吃瓜]', '[奋斗]',
        '永不缺席 永不中奖 永不放弃！', '万一呢', '在', '冲吖~', '来了', '万一', '[保佑][保佑]', '从未中，从未停', '[吃瓜]', '[抠鼻][抠鼻]',
        '来力', '秋梨膏', '[呲牙]', '从不缺席', '分子', '可以', '恰', '不会吧', '1', '好',
        'rush', '来来来', 'ok', '冲', '凑热闹', '我要我要[打call]', '我还能中！让我中！！！', '大家都散了吧，已经抽完了，是我的', '我是天选之子', '给我中一次吧！',
        '坚持不懈，迎难而上，开拓创新！', '[OK][OK]', '我来抽个奖', '中中中中中中', '[doge][doge][doge]', '我我我',
    ],

    ai_comments_parm: {
        providers: [],
        /** 兼容旧版单供应商配置 */
        url: '',
        body: {},
        prompt: ''
    },

    /**
     * AI评论首次结果不合格后的最大重试次数
     */
    ai_comment_retry_count: 2,

    /**
     * 同一动态评论相似度阈值，达到该值会重新生成
     */
    ai_comment_similarity_threshold: 0.57,

    /**
     * 成功AI评论的本地历史保留天数
     */
    ai_comment_history_days: 30,

    /**
     * 没有明确评论口令时的自然短评最大字数
     */
    ai_comment_short_max_length: 15,

    /**
     * 是否抄热评
     */
    is_copy_chat: false,

    /**
     * 热评屏蔽词
     */
    copy_blockword: [],

    /**
     * - 抽奖UP用户分组id(网页端点击分区后地址栏中的tagid)
     * - 自动获取
     */
    partition_id: 0,

    /**
     * - 是否不为抽奖UP单独设置关注分区
     */
    is_not_create_partition: false,

    /**
     * 是否异常
     */
    is_exception: false,

    /**
     * 是否关注已达上限
     */
    is_outof_maxfollow: false,

    /**
     * - 中奖通知关键词(满足一个就推送)
     * - 符合js正则表达式的字符串
     * - 若以 ~ 开头则表示为黑名单规则
     * - 优先级递增
     */
    notice_key_words: [
        '~预约成功|预约主题',
        '中奖|获得|填写|写上|提供|收货地址|支付宝账号|码|大会员',
        '~你的账号在新设备或平台登录成功',
        '~你预约的直播已开始'
    ],

    /**
     * 是否发送运行状态通知
     */
    notice_running_state: false,

    /**
     * - 获取私信页数
     */
    check_session_pages: 16,

    /**
     * - 清理白名单uid或dyid
     * - 英文逗号分隔 如: 1,2,3
     */
    clear_white_list: '',

    /**
     * - 取关分区
     * - 默认为: 此处存放因抽奖临时关注的up
     */
    clear_partition: '',

    /**
     * 清理多少天之前的动态或关注
     */
    clear_max_day: 30,

    /**
     * - 快速移除关注
     * - 不加判断只去除关注
     */
    clear_quick_remove_attention: false,

    /**
     * - 快速移除关注
     * - 不加判断只去除关注
     * - 移除粉丝数小于指定数量的
     */
    clear_quick_remove_attention_fans_number_smallest: Infinity,

    /**
     * 是否移除动态
     */
    clear_remove_dynamic: true,

    /**
     * 是否移除关注
     */
    clear_remove_attention: true,

    /**
     * 清除延时(毫秒)
     */
    clear_remove_delay: 8000,

    /**
     * 清除动态类型
     * 
     * | 动态类型   | type值 |
     * | :------- |:----- |
     * | 无        | `0`    |
     * | 转发       | `1`    |
     * | 含图片     | `2`    |
     * | 无图纯文字  | `4`    |
     * | 视频       | `8`    |
     * | 番剧       | `512`  |
     * | 活动       | `2048` |
     * | 专栏       | `64`   |
     * 
     * @example
     * 1
     * [1,2,4]
     */
    clear_dynamic_type: [1],

    /**
     * 原始设置
     * @returns {Object}
     */
    raw_config() {
        delete require.cache[config_file];
        return require(config_file);
    },

    /**
     * @param {string} n
     */
    updata(n) {
        this.init();
        this.setObject(this.raw_config()[`config_${n}`]);
    },

    init() {
        this.setObject(this.raw_config()['default_config']);
    },

    setObject(o = {}) {
        Object.entries(o).forEach(([k, v]) => this[k] = v);
    }
};


module.exports = config;
