import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Brain} from './brain.js';
import {Role} from './role.js';
import {ConversationMemory} from './conversation-memory.js';
const root=path.resolve('tmp/reply-tests');fs.mkdirSync(root,{recursive:true});
async function check({key='group:synthetic',status='ok',text='哦，是我刚才说的',silent=false}={}){
 const requests=[],writes=[];
 const memory=new ConversationMemory({dir:fs.mkdtempSync(path.join(root,'memory-'))});
 const b=new Brain({apiKey:'SECRET-test-12345678',role:new Role({}),memory,tools:false,dialogue:{sceneEnabled:true,replyHarness:{enabled:true}}});
 b.replyHarness.judge=async(payload)=>{writes.push(payload);return {status,text,model:'kimi-k3.1-pro',elapsedMs:1};};
 const before=globalThis.fetch;globalThis.fetch=async(_u,i)=>{const req=JSON.parse(i.body);requests.push(req);return new Response(JSON.stringify({choices:[{message:{content:req.response_format?JSON.stringify({mode:silent?'silent':'repair',addressedTo:silent?'other':'self',confidence:.95,meaning:'核对引用原话',evidence:'别赖鱼'}):'DS内部草稿'}}]}));};
 try{return {result:await b.reply({key,userId:'fake',text:'你说过别赖鱼',situation:'虚构引用：小助手说别赖鱼',proactive:silent,record:false,dryRun:true}),requests,writes};}finally{globalThis.fetch=before;}
}
test('DS先理解，最终发送外部模型输出，原话与草稿都进入写作资料',async()=>{
 const r=await check();assert.equal(r.requests.length,2);assert.ok(r.requests[0].response_format);assert.equal(r.writes.length,1);assert.equal(r.result.text,'哦，是我刚才说的');assert.equal(r.writes[0].groundedDraft,'DS内部草稿');assert.match(JSON.stringify(r.writes[0].reference),/你说过别赖鱼/);assert.ok(!JSON.stringify(r.writes).includes('SECRET-test-12345678'));assert.equal(r.result.actions.length,0);
});
test('外部输出超时用DS草稿兜底，不重复工具循环',async()=>{const r=await check({status:'timeout'});assert.equal(r.result.text,'DS内部草稿');assert.equal(r.requests.length,2);});
test('私聊不走外部输出',async()=>{const r=await check({key:'private:synthetic'});assert.equal(r.writes.length,0);assert.equal(r.requests.length,1);});
test('DS决定不插话时，不多调用写作模型',async()=>{const r=await check({silent:true});assert.equal(r.writes.length,0);assert.equal(r.result.text,'[不接]');});
test('外部输出仍经过已有泄露拦截',async()=>{const r=await check({text:'SECRET-test-12345678'});assert.equal(r.result.blocked,true);assert.ok(!r.result.text.includes('SECRET'));});
