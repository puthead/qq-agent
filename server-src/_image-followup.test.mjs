import test from 'node:test';
import assert from 'node:assert/strict';
import { RecentMedia } from './recent-media.js';
import { handleTurn } from './index.js';
const now=Date.now(),key='group:42';
const request=(text,extra={})=>({key,userId:'1',name:'甲',isGroup:true,messageId:'q',text,time:now,atIds:['1290313893'],...extra});
function cache(){const r=new RecentMedia({now:()=>now});r.observe(request('[图片]',{messageId:'pic',time:now-6000,images:[{file:'synthetic'}]}));return r;}
test('分条追问、复用和短收藏请求均关联刚才图片；闲聊不挂图',()=>{
 const r=cache();
 for(const text of ['@1290313893 这是你吗','以后发这个','记得收藏','收藏这张','这图现在能看懂了吗'])assert.equal(r.forFollowup([request(text)])[0]?.messageId,'pic',text);
 for(const text of ['你好','你今天吃什么','收藏网页','这是什么天气']){
   assert.equal(r.forFollowup([request(text)]).length,0,text);
 }
});
test('群、人、显式引用、新图、转发、第三人寻址和混合批次隔离',()=>{
 const r=cache();
 for(const extra of [{key:'group:2'},{userId:'2'},{replyTo:'quoted'},{quoted:{id:'quoted'}},{images:[{}]},{forwards:['f']},{atIds:['2']}])assert.deepEqual(r.forFollowup([request('这是你吗',extra)]),[]);
 assert.deepEqual(r.forFollowup([request('这是你吗'),request('嗯',{userId:'2'})]),[]);
 r.observe(request('[图片]',{userId:'2',messageId:'newer',time:now-2000,images:[{}]}));
 assert.deepEqual(r.forFollowup([request('这是你吗')]),[]);
});
test('追问45秒、明确收藏120秒时效；未来图片不可用',()=>{
 const r=cache();
 r.rows.get(key)[0].t=now-46000;
 assert.deepEqual(r.forFollowup([request('这是你吗')]),[]);
 assert.equal(r.forFollowup([request('收藏这张')]).length,1);
 r.rows.get(key)[0].t=now-120001;
 assert.deepEqual(r.forFollowup([request('收藏这张')]),[]);
 r.rows.get(key)[0].t=now+1;
 assert.deepEqual(r.forFollowup([request('这是你吗')]),[]);
});
test('未处理的入站图片缓存后，真实handleTurn把图传入brain；下载失败不借旧图',async()=>{
 for(const ok of [true,false]){
  let input;const requested=[];
  await handleTurn({recentMedia:cache(),bot:{imageToDataUrl:async seg=>{requested.push(seg.file);return ok?'data:image/png;base64,eA==':null;}},brain:{reply:async i=>{input=i;return {text:'',actions:[]};}},memory:{recentTurns:()=>[],logTurn(){}},human:{},waker:{}},[request('这是你吗')],{vision:{enabled:true},dryRun:true});
  assert.deepEqual(requested,['synthetic']);assert.equal(input.images.length,ok?1:0);
  assert.match(input.situation,ok?/不是新发图/:/一张都没取到/);
 }
});
