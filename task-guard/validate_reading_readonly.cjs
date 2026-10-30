// Read-only diagnostics: credentials arrive on stdin, and only counts are printed.
const fs = require('fs');
const https = require('https');
const path = require('path');
const root = path.resolve(__dirname, '..');
const bili = require(path.join(root, 'lib/net/bili'));
const globalVar = require(path.join(root, 'lib/data/global_var'));
const { scanUnreadSessions } = require(path.join(root, 'lib/helper/session_scan'));
const { log } = require(path.join(root, 'lib/utils'));
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
globalVar.set('cookie', input.cookie);
for (const key of ['info','warn','error','notice','debug']) log[key] = () => {};
log.debug_return = (_, body) => body;
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';
function requestFn({ url, query = {}, headers = {} }) {
    const target = new URL(url);
    if (!['api.bilibili.com','api.vc.bilibili.com'].includes(target.hostname)) throw new Error('Unexpected read-only host');
    if (!['/x/polymer/web-dynamic/v1/opus/detail','/session_svr/v1/session_svr/get_sessions'].includes(target.pathname)) throw new Error('Unexpected read-only endpoint');
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
    return new Promise((resolve,reject) => {
        const req = https.get(target, { timeout: 20000, headers: { Cookie: input.cookie, 'User-Agent': ua,
            Accept: 'application/json', Referer: 'https://www.bilibili.com/', ...headers } }, res => {
            let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve(body));res.on('error',reject);
        });
        req.on('timeout',()=>req.destroy(new Error('Read timeout')));req.on('error',reject);
    });
}
(async()=>{
    if (input.mode === 'articles') {
        const ids=['1263389970470535193','1263138770726682632','1262969999994126338','1262765980441903113','1262669902026637314'];
        const rows=[];
        for(const id of ids) {
            const body=await bili.getArticleOpusContent('https://www.bilibili.com/opus/'+id,{requestFn});
            rows.push({id,readable:Boolean(body),body_length:body.length,reference_ids:new Set(body.match(/[0-9]{18,}/g)||[]).size});
        }
        console.log(JSON.stringify({mode:'articles',results:rows}));
        if(rows.some(r=>!r.readable))process.exitCode=1;
    } else if (input.mode === 'sessions') {
        const unread=await bili.getUnreadSessionNum();
        if(!unread)throw new Error('Unread counts unavailable');
        const rows=[];
        for(const [kind,count] of [['1',unread.follow_unread],['2',unread.unfollow_unread]]) {
            const scan=await scanUnreadSessions({expectedUnread:count,maxPages:64,
                getPage:cursor=>bili.getSessionInfo(kind,cursor,{requestFn}),onSession:async()=>{},
                wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),delayMs:3000});
            rows.push({scope:kind==='1'?'followed':'unfollowed',...scan});
        }
        console.log(JSON.stringify({mode:'sessions',results:rows}));
        if(rows.some(r=>!r.complete))process.exitCode=1;
    } else throw new Error('Unknown diagnostic mode');
})().catch(error=>{console.error('Read-only validation failed: '+error.name);process.exitCode=1;});
