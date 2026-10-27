import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {thinkingSchedule,replyEffort} from './thinking-schedule.js';
import {Brain} from './brain.js';
import {Role} from './role.js';
import {ConversationMemory} from './conversation-memory.js';
test('北京时间工作日边界及周末，不受主机时区影响',()=>{
 for(const [date,work] of [['2026-10-26T08:59:59+08:00',false],['2026-10-26T09:00:00+08:00',true],['2026-10-30T17:59:59+08:00',true],['2026-10-30T18:00:00+08:00',false],['2026-10-31T12:00:00+08:00',false],['2026-11-01T12:00:00+08:00',false],['2026-11-02T09:00:00+08:00',true]]){
  const t=Date.parse(date);assert.equal(thinkingSchedule(t).workHours,work,date);
  assert.equal(thinkingSchedule(t).scene,work?'low':'high');
  assert.equal(replyEffort('high',t),work?'low':'high');assert.equal(replyEffort('low',t),'low');assert.equal(replyEffort('max',t),work?'low':'high');
 }
});
test('实际请求：工作时段覆盖高难场景，其他时段理解high、回复动态；私聊也遵守low时段',async()=>{
 const root=path.resolve('tmp/thinking-schedule');fs.mkdirSync(root,{recursive:true});
 const originalFetch=globalThis.fetch,originalNow=Date.now;
 try{
  for(const work of [true,false])for(const effort of ['low','high'])for(const group of [true,false]){
   Date.now=()=>Date.parse(work?'2026-10-27T12:00:00+08:00':'2026-10-27T20:00:00+08:00');
   const requests=[];
   globalThis.fetch=async(_u,i)=>{const body=JSON.parse(i.body);requests.push(body);return new Response(JSON.stringify({choices:[{message:{content:body.response_format?JSON.stringify({mode:'reaction',addressedTo:'self',confidence:.95,effort}):'嗯'}}]}));};
   const b=new Brain({apiKey:'test',model:'deepseek-flash',effort:'high',role:new Role({}),memory:new ConversationMemory({dir:fs.mkdtempSync(path.join(root,'case-'))}),tools:false,dialogue:{sceneEnabled:true}});
   await b.reply({key:group?'group:1':'private:1',userId:'1',text:'你好',record:false,dryRun:true});
   assert.equal(requests.length,group?2:1);
   if(group)assert.equal(requests[0].reasoning_effort,work?'low':'high');
   assert.equal(requests.at(-1).reasoning_effort,work?'low':group?effort:'high');
  }
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
});
