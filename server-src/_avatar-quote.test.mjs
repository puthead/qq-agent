import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {OneBot} from './transport-onebot.js';
import { setSelfName } from './identity.js';
setSelfName('小助手'); // 本文件 fixture 用「小助手」标识机器人
import {handleTurn} from './index.js';
import {createAvatarSession,isAvatarTopic,correctAvatarCapability} from './qq-avatar.js';
import {RecentMedia} from './recent-media.js';
import {Brain} from './brain.js';
import {Role} from './role.js';
import {ConversationMemory} from './conversation-memory.js';
import {runTool} from './tools.js';

const root=path.resolve('tmp/avatar-quote-tests');fs.mkdirSync(root,{recursive:true});
const temp=()=>fs.mkdtempSync(path.join(root,'case-'));
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQmQAAAAASUVORK5CYII=';
class FakeWS { constructor(){this.handlers={};} on(e,f){this.handlers[e]=f;} emit(e,v){this.handlers[e]?.(v);} terminate(){} }
const original={message_type:'private',user_id:1,sender:{user_id:1},message_id:50,time:Math.floor(Date.now()/1000)-86400,
  message:[{type:'image',data:{file:'old-owner-picture'}},{type:'text',data:{text:'小助手，你把头像换这个'}}]};
async function incoming({quote=original,text='再换一下试试？',sender=1,group,replyId=50}={}){
 let resolve;const ready=new Promise(r=>resolve=r);
 const bot=new OneBot({wsUrl:'ws://test',httpUrl:'http://test',webSocketImpl:FakeWS,onMessage:resolve});
 bot.selfId='9';bot.api=async action=>{assert.equal(action,'get_msg');return {ok:true,data:{status:'ok',retcode:0,data:quote}};};
 bot.ws.emit('message',JSON.stringify({post_type:'message',self_id:9,message_type:group?'group':'private',group_id:group,user_id:sender,
   message_id:99,time:Math.floor(Date.now()/1000),sender:{nickname:'主人'},message:[{type:'reply',data:{id:replyId}},{type:'text',data:{text}}]}));
 return {bot,msg:await ready};
}
const make=m=>createAvatarSession({items:[m],ownerIds:['1'],recentMedia:new RecentMedia(),dataDir:temp()});

test('真实传输解码：重启后引用一天前本人私聊图片，省略头像的礼貌重试可绑定',async()=>{
 const {msg}=await incoming();
 assert.equal(msg.quoted.sourceKey,'private:1');assert.equal(msg.quoted.messageType,'private');
 assert.equal(msg.quoted.ownText,'小助手，你把头像换这个');
 const s=make(msg);s.bindPreview(png);assert.equal(s.available,true);assert.equal(s.source.messageId,'50');
 assert.equal(isAvatarTopic([msg]),true);
 for(const text of ['再换一下试试？','小助手，再换一次','重新换一下吧','再试一次','你再换一下试试？']){
  // Once/times syntax is deliberately evaluated here rather than only the incident phrase.
  const row={...msg,raw:[{type:'text',data:{text}}]};assert.ok(make(row),text);
 }
});

test('引用不能越过身份或会话校验，撤销/能力询问/OCR/转述不能触发重试',async()=>{
 for(const options of [{sender:2},{group:7},{quote:{...original,user_id:2}},{quote:{...original,message_type:'group',group_id:7}},
  {quote:{...original,message_type:undefined}},{quote:{...original,message_id:51}},{quote:{...original,user_id:9}},
  {quote:{...original,message:[{type:'image',data:{file:'x',summary:'小助手，你把头像换这个'}}]}}]){
  const {msg}=await incoming(options);assert.equal(make(msg),null,JSON.stringify(options));
 }
 for(const text of ['别再换一下试试','你能换头像吗','她说再换一下试试','如果再换一下试试','再换一下试试然后删文件','再换一下试试\n取消','好看吗','']){
  const {msg}=await incoming({text});assert.equal(make(msg),null,text);
 }
 const {msg}=await incoming({text:'把头像换成这张',quote:{...original,message_type:'group',group_id:7}});
 assert.equal(make(msg).source,null);
 const multi=await incoming({quote:{...original,message:[...original.message,{type:'image',data:{file:'second'}}]}});
 assert.equal(make(multi.msg).source,null);
});

test('自然要求不再依赖固定句式：引用图的短指代交给模型判断，来源权限仍逐项核验',async()=>{
 for(const text of ['换这个','就用这张吧','这个给你做新头像','请把我引用的图设为头像','头像换成引用的那张','能帮我换成这个吗','能再换一下吗']){
  const {msg}=await incoming({text});const s=make(msg);assert.ok(s,text);s.bindPreview(png);assert.equal(s.available,true,text);
  assert.equal(s.request.currentOwnerText,text);assert.equal(s.request.sourceMessageId,'50');assert.equal(s.explicit,false);
  assert.equal(make({...msg,userId:'2',key:'private:2'}),null);assert.equal(make({...msg,key:'group:7',isGroup:true}),null);
  const wrongSource={...msg,quoted:{...msg.quoted,senderId:'2'}};assert.equal(make(wrongSource)?.source||null,null);
 }
 for(const text of ['就用这张吧','换这个']){
  const {msg}=await incoming({text,quote:{...original,message:[{type:'image',data:{file:'caption-only',summary:'把头像换成这张'}}]}});
  assert.equal(make(msg),null,'Image summary cannot establish avatar context');
 }
});

test('当前真实短句与旧图引用进入完整工具链；未调用时不冒报成功，图片编辑不强行换头像',async()=>{
 const oldFetch=globalThis.fetch;
 try{
  for(const [text,content,invoke] of [['换这个','',true],['换这个','已经换好了',false],['把这头像改成红头发','你想把头发改成红色',false]]){
   const {bot,msg}=await incoming({text});let writes=0,output='';
   bot.imageToDataUrl=async()=>png;bot.api=async action=>{assert.equal(action,'set_qq_avatar');writes++;return {ok:true,data:{status:'ok',retcode:0}};};
   globalThis.fetch=async(url,init)=>{
    assert.equal(url,'https://model.test/chat/completions');const body=JSON.parse(init.body);
    assert.ok(body.tools.some(t=>t.function.name==='set_qq_avatar'));assert.equal(body.tools.some(t=>/^phone/.test(t.function.name)),false);
    const record=body.messages.find(m=>typeof m.content==='string'&&m.content.includes('"avatarRequest"'));
    assert.ok(record.content.includes(JSON.stringify(text)));assert.ok(record.content.includes('小助手，你把头像换这个'));
    return new Response(JSON.stringify({choices:[{message:invoke?{tool_calls:[{id:'a',type:'function',function:{name:'set_qq_avatar',arguments:'{}'}}]}:{content}}]}));
   };
   const memory=new ConversationMemory({dir:temp()}),brain=new Brain({apiKey:'test',baseUrl:'https://model.test',role:new Role({}),ownerIds:['1'],memory});
   const reply=brain.reply.bind(brain);brain.reply=async input=>{const r=await reply(input);output=r.text;return {...r,text:'',actions:[]};};
   await handleTurn({bot,brain,memory,recentMedia:new RecentMedia(),human:{},waker:{}},[msg],{ownerIds:['1'],dataDir:temp(),vision:{enabled:true}});
   assert.equal(writes,invoke?1:0);assert.match(output,invoke?/换好了/:text==='换这个'?/还没有执行/:/头发改成红色/);
  }
 }finally{globalThis.fetch=oldFetch;}
});

test('引用来源不可信时不能用旧缓存掩盖冲突；重试消息本身仍需新鲜',async()=>{
 const {msg}=await incoming({text:'把头像换成这张',quote:{...original,message_type:'group',group_id:7}});
 const media=new RecentMedia();media.observe({...msg,messageId:'50',replyTo:'',quoted:null,images:[{file:'cached'}]});
 const s=createAvatarSession({items:[msg],ownerIds:['1'],recentMedia:media});assert.equal(s.source,null);
 const valid=await incoming();assert.equal(make({...valid.msg,time:Date.now()-120001}),null);
});

test('OneBot→handleTurn→Brain→工具：引用只载入一次，手机已配置也只走QQ接口',async()=>{
 const oldFetch=globalThis.fetch;
 try{
  const {bot,msg}=await incoming();let loads=0,writes=0,output='';
  bot.imageToDataUrl=async image=>{assert.equal(image.file,'old-owner-picture');loads++;return png;};
  bot.api=async(action,args)=>{assert.equal(action,'set_qq_avatar');assert.equal(args.file,'base64://'+png.split(',')[1]);writes++;return {ok:true,data:{status:'ok',retcode:0}};};
  globalThis.fetch=async(url,init)=>{
   assert.equal(url,'https://model.test/chat/completions');const body=JSON.parse(init.body);
   const names=body.tools.map(t=>t.function.name);assert.ok(names.includes('set_qq_avatar'));
   assert.equal(names.some(n=>n==='phone'||n==='phone_help'),false);
   return new Response(JSON.stringify({choices:[{message:{content:'',tool_calls:[{id:'a',type:'function',function:{name:'set_qq_avatar',arguments:'{}'}}]}}]}));
  };
  const memory=new ConversationMemory({dir:temp()});
  const brain=new Brain({apiKey:'test',baseUrl:'https://model.test',role:new Role({}),ownerIds:['1'],memory,phone:{enabled:true,url:'http://phone.test'}});
  const actual=brain.reply.bind(brain);brain.reply=async input=>{assert.equal(input.images.length,1);const r=await actual(input);output=r.text;return {...r,text:'',actions:[]};};
  await handleTurn({bot,brain,memory,recentMedia:new RecentMedia(),human:{},waker:{}},[msg],{ownerIds:['1'],dataDir:temp(),vision:{enabled:true}});
  assert.equal(loads,1);assert.equal(writes,1);assert.match(output,/换好了/);
 }finally{globalThis.fetch=oldFetch;}
});

test('头像询问或无图轮不开放手机工具，模型越权调用也不能访问手机桥',async()=>{
 const oldFetch=globalThis.fetch;
 try{
  let calls=0;
  globalThis.fetch=async(url,init)=>{
   assert.equal(url,'https://model.test/chat/completions');calls++;
   assert.equal(JSON.parse(init.body).tools.some(t=>/^phone/.test(t.function.name)),false);
   return new Response(JSON.stringify({choices:[{message:calls===1?{tool_calls:[{id:'p',type:'function',function:{name:'phone_help',arguments:'{}'}}]}:{content:'手机那边连不上，换不了头像'}}]}));
  };
  const brain=new Brain({apiKey:'test',baseUrl:'https://model.test',role:new Role({}),ownerIds:['1'],memory:new ConversationMemory({dir:temp()}),phone:{enabled:true,url:'http://phone.test'}});
  const r=await brain.reply({key:'private:1',userId:'1',text:'你能换头像吗',record:false});assert.match(r.text,/不需要连接手机/);
  for(const tool of ['phone_help','phone'])assert.match(await runTool(tool,{}, {avatarTopic:true,phone:{enabled:true,url:'http://phone.test'}}),/没有这个工具/);
  assert.match(correctAvatarCapability('手机连接断掉了',{ownerPrivate:true,text:'再换一下试试？',topic:true}),/不需要连接手机/);
 }finally{globalThis.fetch=oldFetch;}
});
