const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const os = require('os');
const sourceRoot = fs.existsSync(path.resolve(__dirname,'../main.js')) ? path.resolve(__dirname,'..')
    : fs.existsSync(path.resolve(__dirname,'../lottery/main.js')) ? path.resolve(__dirname,'../lottery')
        : path.join(__dirname,'releases/20261030-v1/lottery');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-result-test-'));
process.env.TASK_GUARD_RESULT_PATH = path.join(tmp, 'result.json');
const reporterPath = path.join(sourceRoot,'lib/helper/task_result.js');
function reporter() { delete require.cache[reporterPath]; return require(reporterPath); }
const log = new Proxy({_cache:[]}, {get:(t,k)=> t[k] || (()=>{})});
async function scenario(mode, failures, discovery = true, accounts = [1,2]) {
    const result = reporter();
    const state = {};
    const config = { init(){}, updata(){}, enable_lottery_round_robin:true, lottery_discovery_mode:'collect', save_lottery_info_to_file:true };
    const context = {module:{exports:{}},require(name) {
        if (name.includes('task_result')) return result;
        if (name === './lib/utils') return { log,delay:async()=>{},hasFileOrDir:()=>true,hasEnv:()=>false,printIpInfo(){},clearLotteryInfo:async()=>{} };
        if (name === './lib/helper/local_account_registry') return {writeLocalAccountRegistry:()=>[]};
        if (name === 'https-proxy-agent') return {};
        if (name === './lib/data/config') return config;
        if (name === './lib/data/global_var') return {init:async()=>{},get:k=>state[k],set:(k,v)=>state[k]=v};
        if (name === './lib/helper/discovery_state') return {normalizeDiscoveryMode:v=>v,discoveryState:{useAccount(){}, filenames:()=>({final:'fixture'}),startFresh:()=>({plan:{entries:[]}})}};
        if (name === './lib/index') return {checkCookie:async()=>!failures.includes(Number(process.env.NUMBER)),start:async()=>{state.discoveryCommitted=discovery;state.lotteryBatchResult={remaining:0};},isMe:async()=>{},clear:async()=>{}};
        return require(name);
    },process,console,setTimeout,Buffer};
    vm.runInNewContext(fs.readFileSync(path.join(sourceRoot,'main.js'),'utf8'), context);
    process.env.lottery_mode=mode;
    process.env.ENABLE_MULTIPLE_ACCOUNT='1';
    process.env.MULTIPLE_ACCOUNT_PARM=JSON.stringify(accounts.map(n=>({COOKIE:`DedeUserID=${n};`,NUMBER:n,CLEAR:true,WAIT:0})));
    const error = await context.module.exports.main();
    if(error && !result.hasFailures()) result.fail('CONFIG_INVALID','startup',true);
    const code=result.finish();
    const json=JSON.parse(fs.readFileSync(process.env.TASK_GUARD_RESULT_PATH));
    return {code,json};
}
(async()=>{
    let r=await scenario('check',[1]);
    assert.equal(r.code,2); assert.equal(r.json.accounts.length,2); assert.equal(r.json.accounts[1].status,'success');
    r=await scenario('start',[],false); assert.equal(r.code,1); assert.equal(r.json.issues[0].code,'DISCOVERY_INCOMPLETE');
    r=await scenario('check',[],true,[]); assert.equal(r.code,1); assert.equal(r.json.issues[0].code,'NO_ACCOUNTS');
    r=await scenario('check',[]); assert.equal(r.code,0);
    const result=reporter(); result.account({COOKIE:'DedeUserID=123; SESSDATA=must-not-persist;',NUMBER:3});result.warning('SHARE_RESTRICTED');result.warning('INSUFFICIENT_COINS');result.warning('PROTECTED_COINS');assert.equal(result.finish(),0);
    assert(!fs.readFileSync(process.env.TASK_GUARD_RESULT_PATH,'utf8').includes('SESSDATA'));
    for(const code of ['CHECK_INCOMPLETE','CLEAR_FAILED']) {const r=reporter();r.account({COOKIE:'DedeUserID=1;',NUMBER:1});r.fail(code,code==='CLEAR_FAILED'?'clear':'check');assert.equal(r.finish(),1);}
    for (const kind of ['empty','deleted','mutation-failed','page-failed','partition-failed']) {
        const r=reporter();r.account({COOKIE:'DedeUserID=1;',NUMBER:1});
        let mutations=0;
        const config={search_wait:0,clear_white_list:'',clear_max_day:0,clear_quick_remove_attention:false,
            clear_remove_dynamic:true,clear_remove_attention:true,clear_remove_delay:0,clear_dynamic_type:1,clear_partition:'fixture',get_partition_wait:0};
        const bili={checkMyPartition:async()=>kind==='partition-failed'?undefined:1,getPartitionUID:async(_,page)=>page===1?[2]:[],
            rmDynamic:async()=>{mutations++;return kind!=='mutation-failed';},cancelAttention:async()=>true};
        const utils={log,delay:async()=>{},infiniteNumber:function*(){yield 0;},retryfn:async(n,fail,fn)=>{let v;for(let i=0;i<n;i++){v=await fn();if(!fail.includes(v))return v;}return v;}};
        const source=fs.readFileSync(path.join(sourceRoot,'lib/clear.js'),'utf8');
        const ctx={module:{exports:{}},require(name){
            if(name.includes('task_result'))return r;
            if(name==='./utils')return utils;
            if(name==='./net/bili')return bili;
            if(name==='./data/config')return config;
            if(name==='./data/global_var')return {get:()=>1};
            if(name==='./core/searcher')return {Searcher:{checkAllDynamic:async()=>kind==='page-failed'?null:{allModifyDynamicResArray:kind==='empty'?[]:[{type:1,dynamic_id:'123',origin_uid:2,create_time:1}],offset:'0'}}};
            throw Error(name);
        }};
        vm.runInNewContext(source,ctx);await ctx.module.exports.clear();
        assert.equal(r.finish(),kind.endsWith('failed')?1:0,kind);
        if(kind==='mutation-failed')assert.equal(mutations,3);
    }
    fs.rmSync(tmp,{recursive:true});console.log('Lottery structured outcomes: 12 scenarios passed; no network/business actions');
})().catch(e=>{console.error(e);process.exitCode=1;});
