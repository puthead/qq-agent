import assert from 'node:assert/strict';
import {handleTurn} from './index.js';
const picked=[];let fail=true;
const book={maxBytes:8*1024*1024,save:({name,buffer})=>{picked.push(buffer.toString());return {ok:true,entry:{id:name,file:name}};}};
const bot={imageToDataUrl:async d=>d==='missing'?null:'data:image/png;base64,'+d,imageBytes:async(d,opts)=>{assert.equal(opts.maxBytes,book.maxBytes);if(d==='b'&&fail){fail=false;return null;}return {buffer:Buffer.from(d),mime:'image/png'};}};
const brain={stickers:book,reply:async a=>{
 assert.equal(a.images.length,4);
 assert.match(await a.saveImage({name:'x',imageIndex:9}),/无效/);
 assert.match(await a.saveImage({name:'b',imageIndex:2}),/拿不到/);
 assert.match(await a.saveImage({name:'b',imageIndex:2}),/存好了/);
 assert.match(await a.saveImage({name:'b',imageIndex:2}),/已经保存/);
 await a.saveImage({name:'a',imageIndex:1});
 await a.saveImage({name:'q',imageIndex:4});
 assert.match(await a.saveImage({name:'c',imageIndex:3}),/三张/);
 return {text:'',actions:[]};
}};
const base={key:'group:1',isGroup:true,name:'甲',userId:'1'};
await handleTurn({bot,brain,memory:{recentTurns:()=>[],logTurn(){}},human:{},waker:{}},[
 {...base,text:'存这些',images:['a','missing','b']},
 {...base,text:'还有这张',images:['c'],quoted:{id:'q',images:['q'],name:'乙',text:'图'}}
],{vision:{enabled:true,maxBytes:8*1024*1024},dryRun:false});
assert.deepEqual(picked,['b','a','q']);
console.log('PASS 合并消息/引用图片、编号映射、失败重试、三张上限、8MB下载限制');
