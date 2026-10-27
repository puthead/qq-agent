import fs from 'node:fs';
import path from 'node:path';
import {avatarRequestKind} from './qq-avatar.js';

const ownText=m=>(m?.raw||[]).filter(s=>s?.type==='text').map(s=>String(s.data?.text||'')).join('').trim();
const action=t=>/(?:换|改|设|用|选|采用|试|做|当|拿)/.test(t);
const canceled=t=>/(?:别|不要|不用|不许|取消|撤回|先不|不换)/.test(t);
const valid=(q,key,userId)=>q?.messageType==='private'&&q.sourceKey===key&&String(q.senderId)===userId&&!q.isSelf;

function recentIncoming(memory,key,currentId,now){
 const file=memory?.files?.(key)?.archive;if(!file||!fs.existsSync(file))return [];
 const size=fs.statSync(file).size,offset=Math.max(0,size-512*1024),fd=fs.openSync(file,'r'),b=Buffer.alloc(size-offset);
 try{fs.readSync(fd,b,0,b.length,offset);}finally{fs.closeSync(fd);}
 let lines=b.toString('utf8').split('\n');if(offset)lines.shift();
 let rows=lines.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}})
  .filter(r=>r.source==='napcat-inbound'&&r.context===false&&r.where===key&&Number.isFinite(r.t));
 const i=rows.findIndex(r=>String(r.messageId)===currentId);
 if(i>=0)rows=rows.slice(0,i);
 else rows=rows.filter(r=>r.t<=now);
 return rows.filter(r=>now-r.t<=2*60*60000&&r.t<=now+2000).slice(-24);
}

/** Resolve only the verified owner's recent private avatar context. No writes,
 * model calls, other conversations, summaries or long-term memory are used. */
export async function prepareAvatarTurn({items=[],ownerIds=[],memory,bot,dataDir,now=Date.now}={}){
 const unchanged={items,context:null},last=items.at(-1),userId=String(last?.userId||''),key=String(last?.key||'');
 if(!ownerIds.map(String).includes(userId)||key!=='private:'+userId||items.some(m=>m.isGroup!==false||m.key!==key||String(m.userId)!==userId||m.isSelf||m.isBot||m.isPoke))return unchanged;
 const current=items.findLast(m=>ownText(m)),text=ownText(current),images=items.flatMap(m=>m.images||[]);
 if((text&&!action(text))||canceled(text)||(!text&&images.length!==1)||typeof bot?.messageReference!=='function')return unchanged;
 // An explicitly identified and available current/reference image needs no history lookup.
 if(text&&(/头像/.test(text)||/头像/.test(last.quoted?.ownText||''))&&(images.length||last.quoted?.images?.length))return unchanged;
 const instant=now(),history=recentIncoming(memory,key,String(items[0]?.messageId||''),instant).filter(r=>String(r.userId)===userId);
 if(!history.length)return unchanged;
 const cache=new Map();let reads=0;
 const lookup=async id=>{
  id=String(id||'');if(!/^-?\d+$/.test(id))return null;
  if(cache.has(id))return cache.get(id);if(reads>=6)return null;reads++;
  const q=await bot.messageReference(id).catch(()=>null),value=valid(q,key,userId)&&String(q.id)===id?q:null;
  cache.set(id,value);return value;
 };
 // A prior incoming QQ reference can establish the avatar topic after restart;
 // its author and raw text are checked again through get_msg.
 let anchor=null,anchorIndex=-1;
 for(let i=history.length-1;i>=0;i--){
  const row=history[i];let q=null;
  if(/头像/.test(row.text||''))q=await lookup(row.messageId);
  if(!/头像/.test(q?.ownText||'')&&row.replyTo)q=await lookup(row.replyTo);
  if(/头像/.test(q?.ownText||'')){anchor=q;anchorIndex=i;break;}
 }
 if(!anchor)return unchanged;
 const context={key,userId,anchor,reference:null};
 let effective=items;
 if(!text){
  // A photo can complete a still-fresh owner's request. Later cancellation,
  // an earlier completed attempt, or a different image source prevents reuse.
  let pending=null;
  for(let i=history.length-1;i>=anchorIndex;i--){
   const row=history[i];if(instant-row.t>120000||canceled(row.text||''))break;
   if(!action(row.text||''))continue;
   const q=await lookup(row.messageId);
   if(!q||q.images?.length||row.replyTo||!avatarRequestKind(q.ownText,null,true))break;
   pending={key,userId,isGroup:false,messageId:q.id,time:q.time,name:last.name,
    text:q.ownText,raw:[{type:'text',data:{text:q.ownText}}],images:[],replyTo:''};break;
  }
  if(!pending)return unchanged;
  if(dataDir){
   try{const entries=JSON.parse(fs.readFileSync(path.join(dataDir,'avatar-changes.json'),'utf8'));
    if(!Array.isArray(entries)||entries.some(r=>r.requestKey===key+':'+pending.messageId))return unchanged;
   }catch(e){if(e.code!=='ENOENT')return unchanged;}
  }
  effective=[pending,...items];
 }else if(!avatarRequestKind(text,null,true))return unchanged;

 // Never override a current explicit reference with a guessed old picture.
 if(!images.length&&!items.some(m=>m.replyTo)&&/(?:这|那|刚|上|图|再|重新)/.test(text)){
  for(let i=history.length-1;i>=anchorIndex;i--){
   const row=history[i];let q=null;
   if(/\[图片/.test(row.text||''))q=await lookup(row.messageId);
   if(!q?.images?.length&&row.replyTo)q=await lookup(row.replyTo);
   if(q?.images?.length){context.reference=q;break;}
  }
  if(!context.reference&&anchor.images?.length)context.reference=anchor;
 }
 console.log('[头像上下文] '+JSON.stringify({key,messageId:last.messageId,anchorMessageId:anchor.id,
  pendingMessageId:effective!==items?effective[0].messageId:null,imageMessageId:context.reference?.id||null,lookups:reads}));
 return {items:effective,context};
}
