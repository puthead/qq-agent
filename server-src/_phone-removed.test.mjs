import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as tools from './tools.js';
import {Brain} from './brain.js';
import {Role} from './role.js';
import {ConversationMemory} from './conversation-memory.js';
import {loadConfig} from './index.js';
import {cleanPhoneState,cleanPhoneRecord,planPhoneCleanup,applyPhoneCleanup} from '../tools/remove-phone-data.mjs';
const root=path.resolve('tmp/phone-removal-tests');fs.mkdirSync(root,{recursive:true});
const temp=()=>fs.mkdtempSync(path.join(root,'case-'));

test('旧手机配置不能重新开放工具，伪造调用上下文也没有执行代码',async()=>{
 const old=globalThis.fetch;let network=0;globalThis.fetch=()=>{network++;throw new Error('Phone network must not run');};
 try{
  assert.equal('PHONE_DEFS' in tools,false);
  assert.equal(tools.toolDefsFor({phone:{enabled:true,url:'http://phone.test'}}).some(t=>/^phone/.test(t.function.name)),false);
  for(const name of ['phone','phone_help','phone_dump','phone_screenshot']){
   const result=await tools.runTool(name,{action:'tap'},{isOwner:true,key:'private:1',userId:'1',phone:{enabled:true,url:'http://phone.test'},allowedTools:new Set([name])});
   assert.match(result,/没有这个工具/);
  }
  assert.equal(network,0);
  const file=path.join(temp(),'config.json');fs.writeFileSync(file,JSON.stringify({phone:{enabled:true,url:'http://phone.test',token:'legacy'},ownerIds:['1']}));
  const cfg=loadConfig(file);assert.equal('phone' in cfg,false);assert.deepEqual(cfg.ownerIds,['1']);
 }finally{globalThis.fetch=old;}
});

test('主人私聊、非主人、群聊与主动轮均无手机工具，当前能力边界进入请求',async()=>{
 const old=globalThis.fetch;
 try{
  globalThis.fetch=async(url,init)=>{assert.equal(url,'https://model.test/chat/completions');const body=JSON.parse(init.body);
   assert.equal((body.tools||[]).some(t=>/^phone/.test(t.function.name)),false);
   assert.match(body.messages[0].content,/现在没有操控手机/);
   return new Response(JSON.stringify({choices:[{message:{content:'现在不能操作手机'}}]}));
  };
  const b=new Brain({apiKey:'test',baseUrl:'https://model.test',ownerIds:['1'],memory:new ConversationMemory({dir:temp()}),role:new Role({}),phone:{enabled:true,url:'http://phone.test'}});
  assert.equal('phone' in b,false);
  for(const ctx of [{key:'private:1',userId:'1'},{key:'private:2',userId:'2'},{key:'group:1',userId:'1'},{key:'private:1',userId:'1',proactive:true}])
   await b.reply({...ctx,text:'帮我打开手机应用',record:false,dryRun:true});
 }finally{globalThis.fetch=old;}
});

test('记忆清理只删除已核实能力内容，保留普通手机事实、同条其他约定及原用户问题',()=>{
 const state={key:'private:1',summary:'阿青的手机发烫',mood:{value:70},memories:[
  {id:'5d37504f-22e9-4b90-ab21-e9b24cd29ed1',text:'小助手表示自己没有实体手机，但可以替用户操作手机应用并看到屏幕内容，无法感知设备温度。'},
  {id:'mmmvky9vv8440',text:'只在本机部署，杭州那台容器不动也不用；手机控制走本机 127.0.0.1:8899 的桥，聊天在线不等于手机桥在线。'},
  {id:'ordinary',text:'阿青的手机发烫'},
 ],recent:[{id:'365b9689-4a47-41b8-9cbd-5cdd6409f71e',text:'',reply:'手机那边连不上，我这边没法把头像替你换上。'},{id:'safe',text:'周六比赛',reply:''}]};
 const c=cleanPhoneState(state);assert.equal(c.removed,1);assert.equal(c.edited,1);assert.equal(c.recent,1);
 assert.equal(c.value.memories[0].text,'只在本机部署，杭州那台容器不动也不用。');assert.equal(c.value.memories[1].text,'阿青的手机发烫');
 assert.equal(c.value.summary,state.summary);assert.deepEqual(c.value.mood,state.mood);assert.equal(c.value.recent[0].id,'safe');
 const row={id:'legacy-turn:384',text:'你用过手机吗',reply:'我手上没手机，但能替这台机子点几下、开个应用什么的，屏幕上发生什么也看得见。就是摸不出烫不烫，得靠你告诉我'};
 assert.deepEqual(cleanPhoneRecord(row),{...row,reply:''});
 assert.throws(()=>cleanPhoneState({...state,memories:[{id:state.memories[0].id,text:'这条已被另一个任务更新'}]}));
});

test('清掉近期末尾记录后重启不从归档恢复，历史检索也不会找回删除的能力',async()=>{
 const dir=temp(),memory=new ConversationMemory({dir});
 memory.logTurn({where:'private:1',id:'safe',who:'主人',text:'周六比赛'});
 memory.logTurn({where:'private:1',id:'365b9689-4a47-41b8-9cbd-5cdd6409f71e',who:'小助手',reply:'手机那边连不上，我这边没法把头像替你换上。'});
 const plan=planPhoneCleanup(dir);assert.equal(plan.counts.archiveRepliesRemoved,1);applyPhoneCleanup(dir,plan);
 const restored=new ConversationMemory({dir});assert.equal(restored.state('private:1').recent.length,1);
 assert.doesNotMatch(await restored.search('private:1','手机'),/手机那边连不上/);
 assert.match(await restored.search('private:1','周六比赛'),/周六比赛/);
 assert.equal(planPhoneCleanup(dir).changes.length,0);
});
