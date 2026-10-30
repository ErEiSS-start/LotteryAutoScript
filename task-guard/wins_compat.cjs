'use strict';
// A rollback-only adapter for old public-notification renderers. Private notices
// already respect the compatible dismissal ledger in PendingWinStore.
const fs=require('fs'),path=require('path'),Module=require('module');
function text(value){if(typeof value==='object'&&value)return String(value.content||value.title||'');try{const p=JSON.parse(value);if(p&&typeof p==='object')return text(p);}catch(_){}return String(value||'');}
function filterPublic(description,rows,archived,uid){
 const suppressed=rows.filter(row=>String(row.accountUid||uid)===String(uid) && archived.has(String(uid)+':'+row.id));
 return String(description).split(/(?=^## (?:\[at\]检测结果|回复检测结果|疑似中奖回复|待领取中奖私信|疑似中奖私信（仅提醒一次）)\n)/m).filter(block=>{
  if(!block.includes('原内容:\n'))return true;
  const start=block.indexOf('原内容:\n')+'原内容:\n'.length;
  const end=block.indexOf('\n\n[直达链接]',start);
  if(end<start)return true;
  const content=block.slice(start,end).trim();
  return !suppressed.some(row=>text(row.content).trim()===content &&
   block.includes('UID '+String(row.senderUid||row.talkerId)+'）') &&
   block.includes('[直达链接]('+String(row.link)+')') &&
   block.includes('发生时间: '+new Date(Number(row.messageTimestamp)*1000).toLocaleString()));
 }).join('');
}
const load=Module._load;
Module._load=function(request,parent,isMain){
 const exported=load.apply(this,arguments);
 let filename;try{filename=Module._resolveFilename(request,parent);}catch(_){return exported;}
 if(typeof filename!=='string'||!filename.replace(/\\/g,'/').endsWith('/lib/helper/notify.js')||!exported.sendNotify||exported.__winsCompat)return exported;
 const original=exported.sendNotify;
 exported.sendNotify=async function(title,description,params){
  try{
   const globalVar=load.call(Module,path.join(path.dirname(filename),'../data/global_var.js'),parent,false);
   const uid=String(globalVar.get('myUID')||'');
   const ledger=JSON.parse(fs.readFileSync(path.join(process.cwd(),'web_state/dismissed-wins.json'),'utf8'));
   const document=JSON.parse(fs.readFileSync(path.join(process.cwd(),'lottery_info','pending_wins_'+uid+'.json'),'utf8'));
   const archived=new Set((ledger.records||[]).map(row=>String(row.accountUid)+':'+row.recordId));
   const filtered=filterPublic(description,document.records||[],archived,uid);
   if(!filtered.trim())return {suppressed:true};
   description=filtered;
  }catch(_){/* Missing legacy data must not hide an otherwise valid notice. */}
  return original.call(this,title,description,params);
 };
 exported.__winsCompat=true;return exported;
};
module.exports={filterPublic};
