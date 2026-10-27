import test from 'node:test';
import assert from 'node:assert/strict';
import {runGroupChimeTurn,queueLate} from './index.js';
import {GroupContext} from './group-context.js';
import {Waker} from './wake.js';
for(const failure of [false,true])test('主动插话'+(failure?'抛错':'因新消息取消')+'后补答已排队的@，仅消费一次',async()=>{
 const key='group:queue'+Number(failure),g=new GroupContext(),waker=new Waker();
 g.add(key,{userId:'2',messageId:'old',text:'晚饭吃什么',time:Date.now()});
 let calls=0,finished=0,resolve;const replied=new Promise(r=>resolve=r);
 const msg={key,isGroup:true,userId:'1',name:'甲',messageId:'direct',isAtMe:true,atIds:['9'],text:'@9 你还记得我教的说话习惯吗',time:Date.now(),images:[]};
 const deps={key,groupCtx:g,waker,gate:{check:()=>({ok:true}),begin(){},finish(){finished++;}},memory:{recentTurns:()=>[],logTurn(){},touch(){}},bot:{send:async()=>({ok:true}),setTyping(){}},
  brain:{reply:async i=>{calls++;if(!i.proactive){assert.match(i.text,/说话习惯/);resolve();return {text:'嗯',actions:[]};}return {text:'我选面',actions:[]};}},
  human:{say:async (s,opts)=>{if(s==='我选面'){queueLate(msg);g.add(key,msg);if(failure)throw new Error('synthetic send failed');assert.equal(opts.shouldContinue(),false);return {sent:0,parts:[]};}await opts.send(s);return {sent:1,parts:[s]};}},chime:{}};
 const work=runGroupChimeTurn(deps,{dryRun:false,vision:{enabled:false},ownerIds:[]});
 if(failure)await assert.rejects(work,/synthetic send failed/);else assert.equal((await work).spoke,false);
 let timeout;await Promise.race([replied,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('queued request not drained')),3000);})]);clearTimeout(timeout);
 assert.equal(calls,2);assert.ok(finished>=1);
});
