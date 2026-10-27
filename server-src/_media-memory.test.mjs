import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RecentMedia } from './recent-media.js';
import { ConversationMemory } from './conversation-memory.js';
import { StickerBook } from './stickers.js';
import { Brain } from './brain.js';
import { Role } from './role.js';
import { runTool } from './tools.js';
import { handleTurn,saveIncomingSticker } from './index.js';
const root=path.resolve('tmp/media-memory-tests');fs.mkdirSync(root,{recursive:true});
const temp=()=>fs.mkdtempSync(path.join(root,'case-'));
const key='private:1';
test('图片后补存这个可关联；隔离会话/人/过期/未来，不越过其他人新图',()=>{
 let now=Date.now();const m=new RecentMedia({now:()=>now,maxKeys:2});
 const msg={key,userId:'1',messageId:'image-a',images:[{file:'a'}]};m.observe(msg);
 const request={key,userId:'1',text:'你存这个'};
 assert.equal(m.forSaveFollowup(request)[0].messageId,'image-a');
 assert.deepEqual(m.forSaveFollowup({...request,text:'随便聊聊'}),[]);
 assert.deepEqual(m.forSaveFollowup({...request,key:'group:1'}),[]);
 assert.deepEqual(m.forSaveFollowup({...request,userId:'2'}),[]);
 assert.deepEqual(m.forSaveFollowup({...request,before:now-1}),[]);
 now+=1000;m.observe({...msg,messageId:'b',userId:'2'});
 assert.deepEqual(m.forSaveFollowup(request),[],'不能跨过别人更新的图猜成自己上一张');
 now+=120001;assert.deepEqual(m.forSaveFollowup(request),[]);
 assert.equal(m.rows.size,0);
 for(let i=0;i<100;i++)m.forSaveFollowup({...request,key:'private:'+i});assert.equal(m.rows.size,0);
 m.observe({...msg,isSelf:true});assert.equal(m.rows.size,0);
});
test('生产故障复现：图片轮真实保存，后补存图轮仍能看到并去重，成功记录跨重启',async()=>{
 const dir=temp(),m=new ConversationMemory({dir}),book=new StickerBook({dir:path.join(dir,'stickers')}),recentMedia=new RecentMedia();
 let step=0;const seg={file:'synthetic-image'},bytes=Buffer.from('local fake image bytes');
 const bot={imageToDataUrl:async()=> 'data:image/png;base64,'+bytes.toString('base64'),imageBytes:async()=>({buffer:bytes,mime:'image/png'})};
 const brain={stickers:book,reply:async input=>{
   assert.equal(input.images.length,1);
   if(++step===2){assert.match(input.situation,/不是新发图/);assert.equal(m.stickerSaves(key)[0].sourceMessageId,'image-a');}
   const result=await input.saveImage({name:'测试反应',tags:'无语'});
   assert.match(result,step===1?/存好了/:/已经存过/);return {text:'',actions:[]};
 }};
 const deps={bot,brain,memory:m,recentMedia,human:{},waker:{}};
 const cfg={vision:{enabled:true,maxBytes:1000000},dryRun:false};
 const base={key,userId:'1',name:'甲',isGroup:false};
 await handleTurn(deps,[{...base,messageId:'image-a',text:'[图片]',images:[seg]}],cfg);
 await handleTurn(deps,[{...base,messageId:'followup',text:'你存这个',images:[]}],cfg);
 assert.equal(book.scan({force:true}).length,1);
 assert.equal(new ConversationMemory({dir}).stickerSaves(key)[0].id,'测试反应');
 assert.equal(m.stickerSaves('private:2').length,0);
});
test('新图片失败或明确引用缺失时不偷换上一张；dryRun与失败不会生成成功记录',async()=>{
 const recentMedia=new RecentMedia();recentMedia.observe({key,userId:'1',messageId:'old',images:['old']});
 let saw;const deps={recentMedia,bot:{imageToDataUrl:async()=>null},brain:{reply:async i=>{saw=i;return {text:'',actions:[]};}},memory:{recentTurns:()=>[],logTurn(){}},human:{},waker:{}};
 for(const extra of [{images:['new']},{replyTo:'missing',images:[]}]){
  await handleTurn(deps,[{key,userId:'1',messageId:'now',text:'存这个',...extra}],{vision:{enabled:true},dryRun:true});
  assert.equal(saw.images.length,0);assert.equal(saw.saveImage,undefined);
 }
 let recorded=0;const opts={seg:{},name:'x',book:{maxBytes:100,save:()=>({ok:false,reason:'disk failed'})},bot:{imageBytes:async()=>({buffer:Buffer.from('a')})},onSaved:()=>recorded++};
 assert.match(await saveIncomingSticker(opts),/disk failed/);
 await saveIncomingSticker({...opts,dryRun:true});assert.equal(recorded,0);
});
test('表达偏好在无关键词的下一轮仍召回，撤回旧项不抹原记录，私群隔离',async()=>{
 const m=new ConversationMemory({dir:temp()});
 await runTool('remember',{text:'2026-10-24，甲希望允许疑问句表达情绪',kind:'style',stable:true},{memory:m,key,userId:'1'});
 assert.match(m.context(key,'？'),/允许疑问句/);
 assert.ok(!m.context('group:1','？').includes('允许疑问句'));
 const s=m.state(key);s.memories[0].supersededAt=Date.now();m.save(key,s);
 assert.ok(!m.context(key,'疑问').includes('允许疑问句'));assert.equal(m.state(key).memories.length,1);
});
test('模型下一轮获得同会话真实保存结果与日期，文件移走则不再宣称当前可用',async()=>{
 const dir=temp(),m=new ConversationMemory({dir}),book=new StickerBook({dir:path.join(dir,'stickers')});
 const saved=book.save({name:'真实保存',buffer:Buffer.from('local image'),mime:'image/png'});
 m.recordStickerSave(key,{id:saved.entry.id,file:saved.entry.file,sourceMessageId:'image'});
 const b=new Brain({apiKey:'test',memory:m,stickers:book,role:new Role({}),tools:false});
 let request;const old=globalThis.fetch;globalThis.fetch=async(_u,i)=>{request=JSON.parse(i.body);return new Response(JSON.stringify({choices:[{message:{content:'嗯'}}]}));};
 try{
  await b.reply({key,userId:'1',text:'存了吗',record:false,dryRun:true});
  const data=JSON.parse(request.messages[1].content.split('\n').slice(1).join('\n'));
  assert.equal(data.savedStickers[0].sourceMessageId,'image');assert.ok(!JSON.stringify(data.savedStickers).includes(dir));
  assert.match(request.messages[0].content,/"today":"\d{4}-\d{2}-\d{2}"/);
  await b.reply({key:'private:2',userId:'2',text:'存了吗',record:false,dryRun:true});
  assert.equal(JSON.parse(request.messages[1].content.split('\n').slice(1).join('\n')).savedStickers.length,0);
  fs.unlinkSync(saved.entry.path);book.scan({force:true});
  await b.reply({key,userId:'1',text:'存了吗',record:false,dryRun:true});
  assert.equal(JSON.parse(request.messages[1].content.split('\n').slice(1).join('\n')).savedStickers.length,0);
 }finally{globalThis.fetch=old;}
});
