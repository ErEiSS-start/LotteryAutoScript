const assert = require('assert');
const { buildSessionQuery, scanUnreadSessions } = require('../lib/helper/session_scan');
const { parseOpusContent } = require('../lib/helper/opus_content');
const bili = require('../lib/net/bili');
const result = require('../lib/helper/task_result');

async function run() {
    assert.deepStrictEqual(buildSessionQuery('1','123'),{session_type:9,group_fold:1,unfollow_fold:0,sort_rule:2,size:20,end_ts:'123'});
    assert.strictEqual(buildSessionQuery('2').session_type,2);
    const cursors=[], read=[], waits=[];
    const pinned={talker_id:'101',session_type:1,session_ts:'50',top_ts:500,unread_count:5};
    const pages=[
        {has_more:1,data:[pinned,{talker_id:'102',session_type:1,session_ts:'100',unread_count:0}]},
        {has_more:1,data:[pinned,{talker_id:'103',session_type:1,session_ts:'90',unread_count:1}]},
        {has_more:1,data:[{talker_id:'104',session_type:1,session_ts:'80',unread_count:1}]},
    ];
    const scanned=await scanUnreadSessions({expectedUnread:7,getPage:async c=>{cursors.push(c);return pages.shift();},
        onSession:async s=>read.push(s.talker_id),wait:async n=>waits.push(n),delayMs:3000});
    assert.strictEqual(scanned.complete,true);
    assert.strictEqual(scanned.covered,7);
    assert.deepStrictEqual(read,['101','103','104']);
    assert.deepStrictEqual(cursors,['','100','90']);
    assert.deepStrictEqual(waits,[3000,3000]);
    let calls=0;
    const capped=await scanUnreadSessions({expectedUnread:100,maxPages:2,
        getPage:async()=>({has_more:1,data:[{talker_id:String(++calls),session_ts:String(100-calls),unread_count:1}]}),
        onSession:async()=>{}});
    assert.strictEqual(capped.reason,'page_limit');assert.strictEqual(calls,2);
    const stalled=await scanUnreadSessions({expectedUnread:9,getPage:async()=>({has_more:1,data:[pinned]}),onSession:async()=>{}});
    assert.strictEqual(stalled.complete,false);assert.strictEqual(stalled.reason,'cursor_stalled');
    const exhausted=await scanUnreadSessions({expectedUnread:117,getPage:async()=>({has_more:0,data:[]}),onSession:async()=>{}});
    assert.strictEqual(exhausted.complete,true);assert.strictEqual(exhausted.reason,'exhausted');
    for(const page of [{errorCode:-509,has_more:0,data:[]},{has_more:0},{has_more:undefined,data:[]}]) {
        assert.strictEqual((await scanUnreadSessions({expectedUnread:2,getPage:async()=>page,onSession:async()=>{}})).complete,false);
    }
    const adapter=await bili.getSessionInfo('1','123',{requestFn:async req=>{
        assert.deepStrictEqual(req.query,buildSessionQuery('1','123'));
        return JSON.stringify({code:0,data:{session_list:null,has_more:0}});
    }});
    assert.deepStrictEqual(adapter,{has_more:0,data:[]});
    assert.strictEqual((await bili.getSessionInfo('1','',{requestFn:async()=>'<html>bad</html>'})).errorCode,-1);
    assert.strictEqual((await bili.getSessionInfo('1','',{requestFn:async()=>JSON.stringify({code:0,data:{session_list:[]}})})).errorCode,-1);
    const wasFailed=result.hasFailures();
    const empty=await bili.getSessionMessages('123',20,{requestFn:async()=>JSON.stringify({code:0,data:{messages:null}})});
    assert.deepStrictEqual(empty,[]);assert.strictEqual(result.hasFailures(),wasFailed,'An empty successful conversation is normal');

    const id='1263389970470535193', dynamic='1234567890123456789';
    const fixture={code:0,data:{item:{id_str:id,basic:{uid:'9999999999999999999'},modules:[
        {module_type:'MODULE_TYPE_AUTHOR',module_author:{jump_url:'https://t.bilibili.com/9999999999999999999'}},
        {module_type:'MODULE_TYPE_CONTENT',module_content:{paragraphs:[
            {para_type:1,text:{nodes:[{word:{words:'抽奖 '+dynamic}},{rich:{text:'活动链接',jump_url:'//t.bilibili.com/'+dynamic}}]}},
            {para_type:2,pic:{url:'https://image.example/8888888888888888888.jpg'}},
        ]}},
        {module_type:'MODULE_TYPE_BOTTOM',recommendations:[{id:'7777777777777777777'}]},
    ]}}};
    const body=parseOpusContent(fixture,id);
    assert(body.includes(dynamic));assert(body.includes('活动链接'));
    for(const metadata of [id,'9999999999999999999','8888888888888888888','7777777777777777777'])assert(!body.includes(metadata));
    assert.strictEqual(parseOpusContent(fixture,'1'),null);
    assert.strictEqual(parseOpusContent({code:-352},id),null);
    assert.strictEqual(parseOpusContent({code:0,data:{fallback:{type:2,id:123}}},id),null);
    const reasons=[];let fallbackCalls=0;
    const recovered=await bili.getOneArticleByCv(53612143,{
        requestFn:async()=>'<html>short-shell</html>',redirectFn:async()=>({kind:'opus',url:'https://www.bilibili.com/opus/'+id}),
        waitFn:async()=>{},markIncompleteFn:r=>reasons.push(r),maxAttempts:2,
        opusContentFn:async()=>{fallbackCalls++;return body;},
    });
    assert.strictEqual(recovered,body);assert.strictEqual(fallbackCalls,1);assert.deepStrictEqual(reasons,[]);
    const failed=await bili.getOneArticleByCv(53612143,{
        requestFn:async()=>'<html>short-shell</html>',redirectFn:async()=>({kind:'opus',url:'https://www.bilibili.com/opus/'+id}),
        waitFn:async()=>{},markIncompleteFn:r=>reasons.push(r),maxAttempts:2,opusContentFn:async()=>'',
    });
    assert.strictEqual(failed,'');assert.strictEqual(reasons.length,1,'All failed sources must still invalidate discovery');
    const content=await bili.getArticleOpusContent('https://www.bilibili.com/opus/'+id,{requestFn:async req=>{
        assert.strictEqual(req.query.features,'htmlNewStyle');assert.strictEqual(req.query.id,id);return JSON.stringify(fixture);
    }});
    assert.strictEqual(content,body);
    console.log('alert_reading_regression.test ... ok (no network or business interactions)');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
