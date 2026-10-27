import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {prepareAvatarTurn} from './avatar-context.js';
import {createAvatarSession} from './qq-avatar.js';
import {ConversationMemory} from './conversation-memory.js';
import {RecentMedia} from './recent-media.js';
import {handleTurn} from './index.js';
import {Brain} from './brain.js';
import {Role} from './role.js';
const root=path.resolve('tmp/avatar-context-tests');fs.mkdirSync(root,{recursive:true});
const temp=()=>fs.mkdtempSync(path.join(root,'case-'));
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQmQAAAAASUVORK5CYII=';
function fixture(){
 const now=Date.now(),dir=temp(),memory=new ConversationMemory({dir});
 const q=(id,text,images=[],time=now-30000)=>({id,senderId:'1',messageType:'private',sourceKey:'private:1',isSelf:false,ownText:text,text,images,time});
 const refs={'10':q('10','小助手，你把头像换这个',[{file:'old-image'}],now-7200000),'20':q('20','换这个',[],now-15*60000),'30':q('30','你再用那个图片试着换一下')};
 const incoming=(id,text,time,extra={})=>({id:'napcat-'+id,messageId:id,context:false,source:'napcat-inbound',where:'private:1',userId:'1',text,reply:'',replyTo:'',t:time,...extra});
 const archive=[incoming('20','换这个',now-15*60000,{replyTo:'10'}),incoming('30','你再用那个图片试着换一下',now-30000),incoming('31','不是开了吗',now-15000)];
 const write=rows=>fs.writeFileSync(memory.files('private:1').archive,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');write(archive);
 let reads=0;const bot={messageReference:async id=>{reads++;return refs[id]||null;},imageToDataUrl:async()=>png};
 const msg=(text,extra={})=>({key:'private:1',isGroup:false,userId:'1',name:'主人',messageId:'40',time:now,text,raw:text?[{type:'text',data:{text}}]:[],images:[],...extra});
 const prepare=items=>prepareAvatarTurn({items,ownerIds:['1'],memory,bot,dataDir:dir,now:()=>now});
 const session=turn=>createAvatarSession({...turn,ownerIds:['1'],recentMedia:new RecentMedia(),dataDir:dir,bot,now:()=>now});
 return {now,dir,memory,refs,archive,write,bot,msg,prepare,session,reads:()=>reads};
}

test('不引用的“再用那个图片换一下”从本人近期私聊找回已核验头像图，重启后仍能接上',async()=>{
 const f=fixture(),turn=await f.prepare([f.msg('你再用那个图片试着换一下')]),s=f.session(turn);
 assert.equal(turn.context.anchor.id,'10');assert.equal(s.source.messageId,'10');s.bindPreview(png);assert.equal(s.available,true);
 assert.equal(s.request.currentOwnerText,'你再用那个图片试着换一下');assert.ok(f.reads()<=6);
 const restarted=new ConversationMemory({dir:f.dir});
 const again=await prepareAvatarTurn({items:[f.msg('再用那个图换一下')],ownerIds:['1'],memory:restarted,bot:f.bot,dataDir:f.dir,now:()=>f.now});
 assert.equal(f.session(again).source.messageId,'10');
});

test('先要求、插一句追问、后补唯一图：复用两分钟内未完成的本人请求且保留正确命令ID',async()=>{
 const f=fixture(),photo=f.msg('',{images:[{file:'new-image'}]}),turn=await f.prepare([photo]),s=f.session(turn);
 assert.equal(turn.items[0].messageId,'30');assert.equal(s.source.messageId,'40');assert.equal(s.source.seg.file,'new-image');
 assert.equal(s.request.commandMessageId,'30');assert.equal(s.request.imageProvidedAfterRequest,true);s.bindPreview(png);assert.ok(s.available);
});

test('取消、已执行、过期、不同人/群、未知来源、多图与引用查不到都不自动补单',async()=>{
 for(const type of ['cancel','expired','processed','group-source','other-source']){
  const f=fixture();
  if(type==='cancel')f.write([...f.archive,{...f.archive.at(-1),messageId:'32',id:'napcat-32',text:'先别换了',t:f.now-10000}]);
  if(type==='expired')f.write(f.archive.map(r=>r.messageId==='30'?{...r,t:f.now-180000}:r));
  if(type==='processed')fs.writeFileSync(path.join(f.dir,'avatar-changes.json'),JSON.stringify([{requestKey:'private:1:30',status:'confirmed'}]));
  if(type==='group-source')f.refs['10'].messageType='group';
  if(type==='other-source')f.refs['10'].senderId='2';
  assert.equal(f.session(await f.prepare([f.msg('',{images:[{file:'new-image'}]})])),null,type);
 }
 const f=fixture();
 assert.equal(f.session(await f.prepare([f.msg('',{images:[{file:'a'},{file:'b'}]})])),null);
 await f.prepare([f.msg('再换一下',{isGroup:true,key:'group:1'})]);assert.equal(f.reads(),0);
 await f.prepare([f.msg('再换一下',{userId:'2',key:'private:2'})]);assert.equal(f.reads(),0);
 const explicit=f.msg('把头像换成这张',{replyTo:'999'});const s=f.session(await f.prepare([explicit]));assert.equal(s.source,null);
});

test('跨轮补图完整入口可执行头像工具，不被图片独立一轮截断',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;let calls=0,replyText='';
 try{
  f.bot.api=async action=>{assert.equal(action,'set_qq_avatar');calls++;return {ok:true,data:{status:'ok',retcode:0}};};
  globalThis.fetch=async(url,init)=>{
   assert.equal(url,'https://model.test/chat/completions');const b=JSON.parse(init.body);assert.ok(b.tools.some(t=>t.function.name==='set_qq_avatar'));
   const req=b.messages.find(m=>typeof m.content==='string'&&m.content.includes('"avatarRequest"'));assert.match(req.content,/你再用那个图片试着换一下/);
   return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'a',type:'function',function:{name:'set_qq_avatar',arguments:'{}'}}]}}]}));
  };
  const brain=new Brain({apiKey:'test',baseUrl:'https://model.test',ownerIds:['1'],role:new Role({}),memory:f.memory});
  const actual=brain.reply.bind(brain);brain.reply=async input=>{const r=await actual(input);replyText=r.text;return {...r,text:'',actions:[]};};
  await handleTurn({bot:f.bot,brain,memory:f.memory,recentMedia:new RecentMedia(),human:{},waker:{}},[f.msg('',{images:[{file:'new-image'}]})],{ownerIds:['1'],dataDir:f.dir,vision:{enabled:true}});
  assert.equal(calls,1);assert.match(replyText,/换好了/);
 }finally{globalThis.fetch=oldFetch;}
});
