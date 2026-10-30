'use strict';
const net = require('net');
function createGateway(socketPath) {
    return request => new Promise((resolve, reject) => {
        const client = net.createConnection({path: socketPath});
        client.setEncoding('utf8');
        let data = '', settled = false;
        function fail() { if(settled)return;settled=true;client.destroy();reject(Object.assign(new Error('记录所在服务器未完成操作，请刷新后重试'),{statusCode:503})); }
        client.setTimeout(20000,fail);client.on('error',fail);
        client.on('connect',()=>client.write(JSON.stringify(request)+'\n'));
        client.on('data',chunk=>{
            data+=chunk.toString('utf8');if(data.length>8*1024*1024)return fail();
            if(!data.includes('\n'))return;
            try{const result=JSON.parse(data);if(result.error)return fail();settled=true;client.end();resolve(result);}catch(_){fail();}
        });
        client.on('end',()=>{if(!settled)fail();});
    });
}
module.exports = { createGateway };
