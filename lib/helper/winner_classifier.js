'use strict';
// Kept dependency-free and compatible with the host's Node 12 for legacy import.
const VERSION = 2;
function textOf(value) {
    if (value && typeof value === 'object') return String(value.content || value.title || '');
    try { const parsed = JSON.parse(String(value)); if (parsed && typeof parsed === 'object') return textOf(parsed); } catch (_) {}
    return String(value || '');
}
function classify(input) {
    const text = textOf(input.content).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    const result = (category, reason) => ({ category, reason, ruleVersion: VERSION });
    if (!text) return result('ignored', '空消息');
    if (/你预约的直播已开始|您预约的直播已开始|预约的直播即将开始/.test(text)
        && !/(?:你|您)(?:已)?(?:中奖|获奖|抽中)/.test(text)) return result('reservation', '直播预约开播提醒');
    if (/预约成功.{0,40}(参与|参加).*抽奖|(?:已|成功)(?:参与|参加)(?:了|本次)?抽奖/.test(text)
        && !/(?:您|你)(?:已)?(?:中奖|获奖|抽中)/.test(text)) return result('reservation', '预约或参与成功确认');
    const award = /中奖|获奖|抽中|获得|荣获|奖品|领奖|收货地址/.test(text);
    const names = [];
    const re = /[@＠]([^\s@＠，,。!！:：]{1,60})/g;
    let m;
    while ((m = re.exec(text))) names.push(m[1].split(/获得|获奖|中奖|抽中|荣获/)[0].trim());
    const mentions = Array.isArray(input.mentions) ? input.mentions : [];
    const accountNames = [input.accountName].concat(input.aliases || [], mentions.filter(it => it && typeof it==='object' && String(it.uid||it.mid)===String(input.accountUid)).map(it=>it.name||it.nickname||it.uname)).filter(Boolean).map(String);
    const ownMention = mentions.some(it => String(it.uid || it.mid || it) === String(input.accountUid || ''));
    const ownName = names.some(name => accountNames.includes(name));
    const list = /(?:恭喜|祝贺)(?:以下|用户|幸运用户)?\s*[@＠]|[@＠][^@＠，。;；]{1,40}(?:获得|获奖|中奖|抽中|荣获)|(?:一等奖|二等奖|三等奖|中奖名单|获奖名单|中奖用户|获奖用户)/.test(text);
    if (list && award) {
        const escapedNames = accountNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const associated = escapedNames.some(name => new RegExp('[@＠]' + name + '(?:\\s|[，,:：])*[^@＠，。;；]{0,24}(?:获得|获奖|中奖|抽中|荣获)').test(text));
        const namedDetails = mentions.filter(it => it && typeof it === 'object' && accountNames.includes(String(it.name || it.nickname || it.uname || '')));
        if (namedDetails.length && !namedDetails.some(it => String(it.uid || it.mid) === String(input.accountUid))) return result('ignored', '开奖提及的是其他UID的同名账号');
        if (associated && (ownName || ownMention)) return result('winner', '开奖条目明确关联当前账号');
        if (names.length && accountNames.length && !ownName && !ownMention) return result('ignored', '开奖名单仅提及其他账号');
        return result('review', '开奖公告与当前账号的获奖关联不足');
    }
    if (/预约成功|预约提醒|预约已成功/.test(text)) return result('reservation', '预约确认');
    const strong = /(?:恭喜|祝贺)(?:您|你)?.{0,16}(?:中奖|获奖|抽中|获得)|(?:你|您).{0,16}(?:中奖|获奖|被抽中)|(?:中奖|获奖)(?:通知|提醒)|(?:请|麻烦)(?:您|你)?.{0,24}(?:填写|提供|回复|提交).{0,24}(?:收货|地址|姓名|电话|手机|联系方式|支付宝|领奖|兑奖)|(?:联系|添加).{0,16}(?:客服|工作人员).{0,16}(?:领奖|领取|兑奖)|(?:领取|兑换)(?:您的|你的|本次)?.{0,8}(?:奖品|奖励)/.test(text);
    if (strong) return result(input.source === 'at' ? 'review' : 'winner', input.source === 'at' ? '@消息需要核实获奖对象' : '个人中奖或领奖通知');
    if (/(?:感谢|谢谢|欢迎).{0,20}关注|(?:获得|获取)(?:你|您|您的|你的)?(?:的)?关注|(?:保持|持续)关注|进群|加群|粉丝群|交流群|全平台正式上线|下载登录游戏/.test(text)
        && !/奖品|领奖|收货地址|兑换码|激活码/.test(text)) {
        return result('ignored', '关注欢迎或推广消息，缺少个人获奖证据');
    }
    if (/必得红包|(?:扫码|点击|打开).{0,12}(?:领|领取|抢).{0,8}(?:红包|优惠券|福利)|【有奖(?:调研|活动)】|(?:邀请|诚邀).{0,20}(?:调研|问卷)|(?:点击|前往).{0,24}(?:参与活动|填写问卷|完成任务)/.test(text)) return result('ignored', '促销或活动邀请');
    const keywords = Array.isArray(input.keywords) ? input.keywords : input.keywords ? [input.keywords] : [];
    let weak = /中奖|获奖|抽中|荣获|奖品|领奖|兑奖|收货地址|支付宝账号|兑换码|激活码|领奖码|大会员兑换/.test(text);
    for (const pattern of keywords) {
        const tokens = String(pattern).split('|').filter(token => token && !/^(码|获得|填写|提供|大会员)$/.test(token));
        for (const token of tokens) { try { if (new RegExp(token).test(text)) weak = true; } catch (_) {} }
    }
    return result(weak ? 'review' : 'ignored', weak ? '仅有弱中奖线索' : '没有中奖线索');
}
module.exports = { classify, textOf, VERSION };
if (require.main === module) {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; if (data.length > 16 * 1024 * 1024) process.exit(64); });
    process.stdin.on('end', () => { try { process.stdout.write(JSON.stringify(JSON.parse(data).map(classify))); } catch (_) { process.exitCode = 64; } });
}
