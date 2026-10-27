// 本地教学存储；不调用模型或网络，只保存已明确授权的表达场景/方法/示例。
import fs from 'node:fs';
import path from 'node:path';
import {unsafeMemory} from './prompt-defense.js';
const clean=(x,n)=>typeof x==='string'?x.trim().slice(0,n):'';
export const privateOnly=text=>/仅.{0,6}私聊|只.{0,8}(?:跟我|和我|私聊|这个群)|不要.{0,8}(?:其他群|全局|别处)|别.{0,6}全局/.test(String(text));
export const looksLikeTeaching=text=>/教.{0,10}(?:说话|回复|聊天|串|阴阳|接梗)|(?:回复|说话|群聊|群u|群友)[\s\S]{0,160}(?:可以|不用|不要|别|少|习惯|句式|句号|逗号|疑惑)|(?:可以|不用|不要|别|少)[\s\S]{0,60}(?:回复|复读|句号|逗号|后半句|解释|说话)|复读.{0,30}(?:可以|就行)|(?:串|阴阳|接梗).{0,30}(?:核心|应该|要|是)|(?:词|说法).{0,10}绕着弯/i.test(String(text));

// 只供保存例句时核对，不额外注入模型。跨消息教学可以用主人刚给的场景+后给的示范。
export function teachingEvidence(memory, {key,userId,text='',isOwner=false,now=Date.now()}={}) {
 if(!isOwner||key!=='private:'+String(userId))return String(text);
 try {
  const file=memory.files?.(key)?.archive;if(!file)return String(text);
  const size=fs.statSync(file).size,offset=Math.max(0,size-256*1024),buffer=Buffer.alloc(size-offset),fd=fs.openSync(file,'r');
  try{fs.readSync(fd,buffer,0,buffer.length,offset);}finally{fs.closeSync(fd);}
  const lines=buffer.toString('utf8').split('\n');if(offset)lines.shift();
  const rows=lines.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(r=>r&&r.where===key&&r.source==='napcat-inbound'&&String(r.userId)===String(userId)&&r.t<=now&&r.t>=now-15*60000);
  return rows.slice(-32).map(r=>String(r.text||'').slice(0,800)).join('\n')+'\n'+String(text);
 }catch{return String(text);}
}
export function normalizeLesson(value){
 if(!value||typeof value!=='object')return null;
 const topic=clean(value.topic,48),when=clean(value.when,180),how=clean(value.how,400);
 const examples=(Array.isArray(value.examples)?value.examples:[]).slice(0,3).map(x=>({input:clean(x?.input,180),reply:clean(x?.reply,180)})).filter(x=>x.input&&x.reply);
 const lesson={topic,when,how,examples},all=JSON.stringify(lesson);
 if(!topic||!when||!how||unsafeMemory(all)||privateOnly(all)||/(?:https?:\/\/|[A-Z]:[\\/]|\d{5,}|[\w.+%-]+@[\w.-]+\.\w+|sk-[\w-]{12,}|Bearer\s+[\w.-]{12,})/i.test(all))return null;
 if(/住在|住址|手机号|身份证|银行卡|我的(?:姓名|学校)|[他她](?:叫|住在)/.test(all))return null;
 if(/(?:忽略|覆盖|修改|关闭|取消|绕过|泄露).{0,16}(?:系统|规则|限制|权限|安全|凭据|密钥)|(?:无条件|必须).{0,8}服从/.test(all))return null;
 return lesson;
}
export class StyleLessons {
 constructor({dir}){this.file=path.join(dir,'style-lessons.json');}
 read(){try{const data=JSON.parse(fs.readFileSync(this.file,'utf8'));return (Array.isArray(data.items)?data.items:[]).filter(x=>normalizeLesson(x)).slice(-24);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 save(value,{ownerId,key,enabled=true}={}){
  const lesson=normalizeLesson(value);if(!lesson)return false;
  const rows=this.read().filter(x=>x.topic!==lesson.topic);
  rows.push({...lesson,enabled:enabled!==false,ownerId:String(ownerId||''),sourceKey:String(key||''),updatedAt:Date.now()});
  const tmp=this.file+'.'+process.pid+'.tmp';fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(tmp,JSON.stringify({v:1,items:rows.slice(-24)},null,2));fs.renameSync(tmp,this.file);return true;
 }
 active(){return this.read().filter(x=>x.enabled===true).map(normalizeLesson);}
}
