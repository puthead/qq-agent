import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Brain} from './brain.js';import {StickerBook} from './stickers.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'web-stickers-live-'));const book=new StickerBook({dir});
let count=0,id;
globalThis.fetch=async (url,init)=>{
 const b=JSON.parse(init.body);count++;
 let message;
 if(count===1) message={content:'',tool_calls:[{id:'s',function:{name:'search_stickers',arguments:JSON.stringify({query:'熊猫头 无语 表情包'})}}]};
 if(count===2){
  const preview=b.messages.at(-1).content;
  assert.ok(Array.isArray(preview)&&preview.some(x=>x.type==='image_url'));
  id=preview.find(x=>x.type==='text'&&x.text.startsWith('候选 ')).text.slice(3);
  message={content:'',tool_calls:[{id:'save',function:{name:'save_web_sticker',arguments:JSON.stringify({candidateId:id,name:'联网测试',tags:'测试'})}}]};
 }
 if(count===3){assert.equal(book.size,1);message={content:'',tool_calls:[{id:'send',function:{name:'send_sticker',arguments:JSON.stringify({id:'联网测试'})}}]};}
 if(count===4)message={content:'好了'};
 return new Response(JSON.stringify({choices:[{message}]}));
};
try{
 const brain=new Brain({apiKey:'test',stickers:book,role:{build:()=>''},memory:{renderPerson:()=>'',renderRecent:()=>''}});
 const r=await brain.reply({key:'test',userId:'test',text:'搜索表情',record:false});
 assert.equal(count,4);assert.equal(r.actions[0].type,'sticker');
 assert.ok(book.segment('联网测试').data.file.startsWith('base64://'));
 console.log('PASS 真实联网搜索下载→模型请求附预览→临时图库保存→可发送图片段；未向QQ发送');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
