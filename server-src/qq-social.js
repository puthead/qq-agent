/** 小范围QQ互动：模型只挑当前消息/引用消息，不接受任意群号、QQ或消息ID。 */
export const EMOJI = { '赞':'128077', '爱心':'10084', '笑哭':'128514', '惊讶':'128558', '疑问':'10067' };
export class QQSocial {
 constructor({enabled=true,reactionCooldownMs=20000,pokeCooldownMs=120000,now=Date.now}={}) {
  Object.assign(this,{enabled,reactionCooldownMs,pokeCooldownMs,now});this.last=new Map();this.inflight=new Set();this.queued=new WeakSet();
 }
 ready(key,type) { return !this.inflight.has(key) && this.now()-(this.last.get(key+':'+type) ?? -Infinity) >= (type==='poke'?this.pokeCooldownMs:this.reactionCooldownMs); }
 session({key,last={},actions,dryRun=false}={}) {
  if (!this.enabled || !/^group:\d+$/.test(key)) return null;
  const latest = /^-?\d+$/.test(String(last.messageId||'')) ? String(last.messageId) : '';
  const quoted = /^-?\d+$/.test(String(last.quoted?.id||'')) ? String(last.quoted.id) : '';
  const userId = /^\d+$/.test(String(last.userId||'')) ? String(last.userId) : '';
  const defs=[];
  if (latest || quoted) defs.push({type:'function',function:{name:'react_message',description:'给当前群的一条消息贴表情回应（不是发表情包图片）。最新消息用 latest，引用原话用 quoted。轻松赞同、接梗时可只贴表情；一轮最多一个QQ互动。不要用文字声称动作完成。',parameters:{type:'object',properties:{target:{type:'string',enum:[...(latest?['latest']:[]),...(quoted?['quoted']:[])]},emoji:{type:'string',enum:Object.keys(EMOJI)}},required:['target','emoji'],additionalProperties:false}}});
  if(userId) defs.push({type:'function',function:{name:'poke_member',description:'轻轻戳一下当前与你聊天的这位群友。只在明确被要求戳、被戳想回一下或熟悉轻松的互动中使用，不催人、不反复戳。每群两分钟最多一次；不能指定别的群或陌生人。一轮最多一个QQ互动。',parameters:{type:'object',properties:{},additionalProperties:false}}});
  return {defs,queue:(name,args={})=>{
   const type=name==='react_message'?'reaction':name==='poke_member'?'poke':'';
   if(!type) return '没有这个QQ互动';
   if(actions.some(a=>a.type==='qq_social')) return '本轮已经安排过一个互动，不再叠加';
   if(!this.ready(key,type)) return '互动还在冷却，这轮用文字或保持安静';
   if(type==='reaction' && (!EMOJI[args.emoji] || !({latest,quoted})[args.target])) return '这条消息或表情不在本轮可用范围';
   if(type==='poke' && (!userId || Object.keys(args).length)) return '只能戳当前说话的群友，不接受其他目标';
   const action={type:'qq_social',kind:type,key,messageId:type==='reaction'?({latest,quoted})[args.target]:'',emojiId:EMOJI[args.emoji],userId};
   this.queued.add(action);actions.push(action);
   return dryRun?'干跑：只记录动作，不会执行':'已安排在本轮发送时执行，尚未完成。不要描述动作或声称已成功；可以让正文留空，由这个互动回应。';
  }};
 }
 async send(actions,{key,bot,dryRun=false,limit=Infinity,onSent}={}) {
  if(!this.enabled || dryRun || limit<=0) return 0;
  const action=actions.find(a=>a.type==='qq_social' && this.queued.has(a) && a.key===key);
  if(!action || !this.ready(key,action.kind)) return 0;
  this.queued.delete(action);this.inflight.add(key);
  try {
   const r=await bot.sendSocial(key,action);
   if(!r?.ok) {console.log('[QQ互动] 未成功：'+(r?.error||'接口失败'));return 0;}
   this.last.set(key+':'+action.kind,this.now());
   while(this.last.size>400)this.last.delete(this.last.keys().next().value);
   try { onSent?.(action); } catch { /* 已发送成功，日志失败不能把结果改成失败 */ }
   return 1;
  } catch(e) {console.log('[QQ互动] 失败：'+e.message);return 0;}
  finally {this.inflight.delete(key);}
 }
}
