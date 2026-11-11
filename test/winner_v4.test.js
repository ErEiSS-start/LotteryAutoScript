const assert = require('assert');
const {classify} = require('../lib/helper/winner_classifier');
const bili = require('../lib/net/bili');
const current = {accountUid:'10001',accountName:'我的账号',source:'private'};
const category = content => classify({...current,content}).category;
assert.strictEqual(category('恭喜您中奖，请填写收货地址'), 'winner');
assert.strictEqual(category('预约成功，并参与了抽奖 奖品：红包（联系客服领取）'), 'reservation');
assert.strictEqual(category('恭喜@书中有异颜如玉 获得一等奖荣耀magic7 RSR，恭喜@偷揽一片月色 获得二等奖魅族21，恭喜@J1987 获得三等奖OPPO A15 PR'), 'ignored');
assert.strictEqual(category('恭喜@我的账号 获得一等奖手机，恭喜@别人 获得二等奖'), 'winner');
assert.strictEqual(classify({source:'at',accountUid:'10001',content:'中奖名单已经公布'}).category,'review');
assert.strictEqual(category('您的大会员兑换码为 ABCD-1234'),'review');
assert.strictEqual(category('【必得红包】支付宝扫码领红包'),'ignored');
assert.strictEqual(category('恭喜中奖，请扫码领取红包'),'winner');
for (const content of [
  '[自动回复] 感谢关注！主要分享有趣的数码产品',
  '能获得你的关注，是我的缘分，进粉丝群一起交流',
  '欢迎关注，群内有不定期抽奖，中奖率很高',
  '欢迎关注！游戏全平台正式上线，下载登录游戏福利好礼送不停',
  '这里提供数码产品介绍',
]) assert.strictEqual(classify({...current, content, keywords:['中奖|获得|填写|提供|收货地址|支付宝账号|码|大会员']}).category, 'ignored');
assert.strictEqual(category('你预约的直播已开始，预约主题：今天开奖'), 'reservation');
assert.strictEqual(category('感谢关注！恭喜你抽中手机，请提供收货地址'), 'winner');
assert.strictEqual(category('您的游戏激活码为 ABCD-1234'), 'review');
assert.strictEqual(category('恭喜您中奖，请联系@客服领取奖品'),'winner');
assert.strictEqual(classify({...current,content:'恭喜@我的账号 获得手机',mentions:[{mid:'99999',nickname:'我的账号'}]}).category,'ignored');
assert.strictEqual(classify({...current,source:'at',content:'恭喜中奖'}).category,'review');
const {filterPublic}=require('../task-guard/wins_compat.cjs');
const timestamp=100;
const archivedRecord={id:'a'.repeat(24),accountUid:'10001',senderUid:'20002',messageTimestamp:timestamp,content:'恭喜中奖',link:'https://www.bilibili.com/opus/123'};
const announcement='## [at]检测结果\n\n发生时间: '+new Date(timestamp*1000).toLocaleString()+'\n\n发信人: 活动方（UID 20002）\n\n原内容:\n恭喜中奖\n\n[直达链接](https://www.bilibili.com/opus/123)\n\n';
const archived=new Set(['10001:'+archivedRecord.id]);
assert.strictEqual(filterPublic(announcement,[archivedRecord],archived,'10001'),'');
assert.strictEqual(filterPublic(announcement.replace('UID 20002','UID 30003'),[archivedRecord],archived,'10001').includes('恭喜中奖'),true);
assert.strictEqual(filterPublic(announcement,[archivedRecord],archived,'10002'),announcement);
(async()=>{
  let calls=0;
  const paged=await bili.getWinnerPrivateMessages('20002',2,{requestFn:async ({query})=>{
    calls++;
    if(calls===1){assert.strictEqual(query.end_seqno,undefined);return JSON.stringify({code:0,data:{has_more:1,messages:[{msg_seqno:9,sender_uid:20002,content:'a'}]}});}
    assert.strictEqual(query.end_seqno,'9');return JSON.stringify({code:0,data:{has_more:0,messages:[{msg_seqno:8,sender_uid:20002,content:'b'}]}});
  },wait:async()=>{}});
  assert.strictEqual(paged.complete,true);assert.strictEqual(paged.messages.length,2);
  const bad=await bili.getWinnerPrivateMessages('20002',30,{maxPages:2,wait:async()=>{},requestFn:async()=>JSON.stringify({code:0,data:{has_more:1,messages:[{msg_seqno:9,sender_uid:20002}]}})});
  assert.strictEqual(bad.complete,false);
  const missing=await bili.getWinnerPrivateMessages('20002',1,{requestFn:async()=>'{"code":0,"data":{}}'});
  assert.strictEqual(missing.complete,false);
  const feed=await bili.getWinnerFeedPage('at','',{requestFn:async()=>JSON.stringify({code:0,data:{items:[{id:11,at_time:100,user:{mid:20002},item:{source_content:'开奖',uri:'https://t.bilibili.com/123'}}],cursor:{is_end:false,id:11,time:100}}}) });
  assert.strictEqual(feed.items[0].sourceMessageId,'11');assert.strictEqual(feed.end,false);assert(feed.cursor);
  const fs=require('fs'),vm=require('vm'),path=require('path');
  const observed=[],failures=[];
  let feedPages=0;
  const fakeClient={getUnreadNum:async()=>({at:2,reply:0}),getUnreadSessionNum:async()=>({follow_unread:1,unfollow_unread:0}),
    getWinnerFeedPage:async()=>({items:[{sourceMessageId:String(++feedPages),senderUid:'20002',content:'开奖名单',messageTimestamp:100}],end:feedPages===2,cursor:String(feedPages)}),
    getWinnerPrivateMessages:async()=>({complete:false,messages:[{sender_uid:'10001',msg_seqno:9,timestamp:110,content:'回复正文不可持久化'}]})};
  const moduleRecord={exports:{}};
  const dependencies={fs:{existsSync:()=>false},'./utils':{log:{info:()=>{}},delay:async()=>{}},
    './data/config':{check_session_pages:2,get_session_wait:1},'./data/global_var':{get:key=>key==='myUID'?'10001':'我的账号'},
    './net/bili':fakeClient,'./helper/task_result':{fail:code=>failures.push(code)},
    './helper/winner_events':{message:row=>{observed.push(row);return {...row,...classify(row)};},reply:row=>observed.push(row)},
    './helper/pending_win_store':{PendingWinStore:class{load(){return [];}add(){throw Error('No private prize in fixture');}},normalizeSessionMessage:row=>({senderUid:String(row.sender_uid),sequence:String(row.msg_seqno),timestamp:row.timestamp,content:row.content})},
    './helper/session_scan':require('../lib/helper/session_scan'),
    './check':{getSessionInfoWithRetry:async()=>({has_more:0,data:[{talker_id:'20002',unread_count:1,session_ts:'100',session_type:1}]})}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/winner_check.js'),'utf8'),{module:moduleRecord,exports:moduleRecord.exports,process:{env:{}},require:name=>{
    assert(Object.prototype.hasOwnProperty.call(dependencies,name),'Unexpected dependency: '+name);return dependencies[name];
  }});
  await moduleRecord.exports.run(1);
  assert.strictEqual(feedPages,2);assert.strictEqual(observed.length,3);
  assert(failures.includes('CHECK_INCOMPLETE'));
  assert(!JSON.stringify(observed).includes('回复正文不可持久化'));
  console.log('winner v4 classification and paging tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
