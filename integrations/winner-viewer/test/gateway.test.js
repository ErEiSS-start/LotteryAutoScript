'use strict';
const assert=require('assert'),fs=require('fs'),net=require('net'),os=require('os'),path=require('path');
const {createGateway}=require('../gateway');
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'winner-rpc-')),socket=path.join(directory,'rpc.sock');
 const server=net.createServer(client=>{
  let input='';client.setEncoding('utf8');client.on('data',chunk=>{
   input+=chunk;if(!input.includes('\n'))return;
   const request=JSON.parse(input);
   const response=Buffer.from(JSON.stringify(request.method==='list'?{records:[{owner:'朋友甲'}]}:{error:'模拟离线'})+'\n');
   const split=response.indexOf(Buffer.from('朋'))+1;
   client.write(response.subarray(0,split));setImmediate(()=>client.end(response.subarray(split)));
  });
 });
 await new Promise(resolve=>server.listen(socket,resolve));
 try{
  const gateway=createGateway(socket),result=await gateway({method:'list'});
  assert.strictEqual(result.records[0].owner,'朋友甲');
  await assert.rejects(()=>gateway({method:'action'}),error=>error.statusCode===503);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});}
 console.log('winner gateway socket tests passed');
})().catch(error=>{console.error(error);process.exit(1);});
