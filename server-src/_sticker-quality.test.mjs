import assert from 'node:assert/strict';
import {searchStickers,stickerQueries,stickerScore} from './web-stickers.js';
import {Brain} from './brain.js';
import {GroupContext} from './group-context.js';
import {handleTurn} from './index.js';
const gc=new GroupContext({});gc.add('group:1',{messageId:'old',text:'[图片]',images:['old']});
let downloads=0;
for(const text of ['睡了吗','来点片','这是漫画']){
 await handleTurn({groupCtx:gc,bot:{imageToDataUrl:async()=>{downloads++;return 'data:image/png;base64,AA==';}},brain:{stickers:{},reply:async a=>{assert.equal(a.images.length,0);assert.ok(!a.situation.includes('附了'));return {text:'',actions:[]};}},memory:{recentTurns:()=>[],logTurn(){}},human:{},waker:{}},[{key:'group:1',isGroup:true,text,userId:'1',name:'甲'}],{vision:{enabled:true}});
}
assert.equal(downloads,0,'普通聊天不能下载或注入旧图');
assert.equal(stickerScore({title:'大熊猫摄影图',page:''}),-1);
assert.equal(stickerScore({title:'孙字笔顺',page:''}),-1);
assert.equal(stickerQueries('熊猫头 表情包 无语 嘲讽')[0],'熊猫头 无语 表情包');
assert.equal(stickerQueries('抗压背锅吧 常用表情')[0],'抗压背锅 表情包');
const html=t=>Buffer.from('<a m="'+JSON.stringify({murl:'https://example.com/'+t+'.png',purl:'https://example.com/',t}).replaceAll('"','&quot;')+'">');
let searches=0;let images=0;
const ctx={stickers:{maxBytes:1024}};
await searchStickers('孙笑川吧 表情包',ctx,async url=>{
 if(url.includes('/images/search?'))return {buffer:html(++searches===1?'孙字笔顺':'熊猫头 表情包')};
 images++;return {buffer:Buffer.from([137,80,78,71,13,10,26,10])};
});
assert.ok(searches>=2);assert.equal(images,1,'不相关结果不能下载进预览');
let round=0,saved=0;
globalThis.fetch=async(url,init)=>{
 const body=JSON.parse(init.body);round++;
 let message;
 if(round===1){assert.ok(body.tools.some(t=>t.function.name==='browse_group_images'));message={tool_calls:[{id:'1',function:{name:'browse_group_images',arguments:'{}'}}]};}
 if(round===2){assert.ok(body.messages.at(-1).content.some(x=>x.type==='image_url'));message={tool_calls:[{id:'2',function:{name:'save_sticker',arguments:'{"name":"旧图","imageIndex":1}'}}]};}
 if(round===3)message={content:'好'};
 return new Response(JSON.stringify({choices:[{message}]}));
};
const brain=new Brain({apiKey:'fake',stickers:{size:0},role:{build:()=>''},memory:{renderPerson:()=>'',renderRecent:()=>''}});
await brain.reply({key:'group:1',userId:'1',text:'收表情',record:false,browseGroupImages:async()=>({note:'旧图仅供收藏',images:[{id:'群图 imageIndex=1',url:'data:image/png;base64,AA=='}]}),saveImage:async()=>{saved++;return '存好了';}});
assert.equal(saved,1);
console.log('PASS 连续纯文字不带旧图、搜偏过滤与回退、主动浏览→预览→收藏工具链');
