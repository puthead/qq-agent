import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Brain,stripStickerReceipt} from './brain.js';
import {ConversationMemory} from './conversation-memory.js';
import {Role} from './role.js';
import {StickerBook} from './stickers.js';
const actions=[{type:'sticker'}];
test('回执过滤保留正常文字、失败和无动作的引用',()=>{
 const receipt='已安排发送：笑到眯眼。实际发出由发送通道确认，本轮不再重复。';
 assert.equal(stripStickerReceipt(receipt,actions),'');
 assert.equal(stripStickerReceipt('哈哈。'+receipt+'真好玩。',actions),'哈哈。真好玩。');
 assert.equal(stripStickerReceipt('发送失败，请稍后再试。',[]),'发送失败，请稍后再试。');
 assert.equal(stripStickerReceipt(receipt,[]),receipt);
 assert.equal(stripStickerReceipt('{"tool":"send_sticker","status":"queued","userVisible":false}',actions),'');
});
test('群聊两轮均为deepseek-flash；表情回执不进正文，动作保留且不再开放重复发送',async()=>{
 const root=path.resolve('tmp/sticker-receipt');fs.mkdirSync(root,{recursive:true});
 const dir=fs.mkdtempSync(path.join(root,'case-')),book=new StickerBook({dir:path.join(dir,'stickers')});
 book.save({name:'笑到眯眼',buffer:Buffer.from('fake'),mime:'image/png'});
 const b=new Brain({apiKey:'test',model:'deepseek-flash',memory:new ConversationMemory({dir}),role:new Role({}),stickers:book,dialogue:{sceneEnabled:true,harness:{enabled:false},replyHarness:{enabled:false}}});
 b.replyHarness.judge=async()=>{throw Error('external writer must not run');};
 const requests=[],original=globalThis.fetch;
 globalThis.fetch=async(_u,i)=>{
  const body=JSON.parse(i.body);requests.push(body);let message;
  if(body.response_format)message={content:JSON.stringify({mode:'reaction',addressedTo:'self',confidence:.95})};
  else if(!body.messages.some(m=>m.role==='tool'))message={content:'',tool_calls:[{id:'call1',type:'function',function:{name:'send_sticker',arguments:JSON.stringify({id:'笑到眯眼'})}}]};
  else {assert.ok(!body.tools.some(t=>t.function.name==='send_sticker'));message={content:'已安排发送：笑到眯眼。实际发出由发送通道确认，本轮不再重复。'};}
  return new Response(JSON.stringify({choices:[{message}]}));
 };
 try{
  const r=await b.reply({key:'group:synthetic',userId:'1',text:'哈哈',record:false,dryRun:true});
  assert.equal(r.text,'');assert.equal(r.actions.length,1);assert.equal(r.actions[0].type,'sticker');
  assert.equal(requests.length,3);assert.ok(requests.every(r=>r.model==='deepseek-flash'));
 }finally{globalThis.fetch=original;}
});
