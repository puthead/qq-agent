// 跨会话只保留表达特征和审核过的语气词；不存/不输出原话、名字、话题或关系。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {styleText} from './group-dialogue.js';
const WORDS=['确实','可以','还真是','牛批','何意味','哦哦','啊这','笑死','好耶','没绷住','绷不住','无语','离谱','行','嗯','哦','哈'];
const tokenPattern=new RegExp('^(?:'+WORDS.join('|')+'|[？?！!。，,~～\\s])+$');
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,24);
const AGE=14*86400000;
export class SpeechHabits {
 constructor({dir='',now=Date.now}={}){
  this.now=now;this.file=dir?path.join(dir,'speech-habits.json'):'';this.rows=[];
  try{this.rows=JSON.parse(fs.readFileSync(this.file,'utf8')).rows||[];}catch{}
  this.prune();
 }
 prune(){this.rows=this.rows.filter(r=>r&&Number.isFinite(r.t)&&r.t<=this.now()&&r.t>=this.now()-AGE&&/^[a-f0-9]{24}$/.test(r.user)&&/^[a-f0-9]{24}$/.test(r.scope)&&[6,14,40,180].includes(r.length)&&['none','question','exclaim','other'].includes(r.ending)&&Array.isArray(r.words)&&r.words.every(w=>WORDS.includes(w))).slice(-480);}
 observe(msg,{persist=true}={}){
  const {key,userId}=msg,t=Number(msg.time)||this.now(),s=String(msg.text||'').trim();
  if(!/^(private|group):[\w-]+$/.test(key)||!userId||msg.isSelf||msg.isBot||msg.isPoke||String(userId)===String(msg.selfId||'')||msg.images?.length||msg.forwards?.length||!styleText(s)||t>this.now()||t<this.now()-AGE)return false;
  this.prune();const user=hash(userId),scope=hash(key),day=Math.floor(t/86400000),n=[...s].length;
  const length=n<=6?6:n<=14?14:n<=40?40:180,ending=/[?？]$/.test(s)?'question':/[!！]$/.test(s)?'exclaim':/[。！？!?…，,、；;：:~～]/.test(s)?'other':'none';
  const words=tokenPattern.test(s)?WORDS.filter(w=>s.includes(w)).slice(0,3):[];
  const signature=[length,ending,...words].join('|');
  const person=this.rows.filter(r=>r.user===user&&Math.floor(r.t/86400000)===day);
  if(person.length>=8||person.some(r=>r.scope===scope&&[r.length,r.ending,...r.words].join('|')===signature))return false;
  this.rows.push({t,user,scope,length,ending,words});this.prune();if(persist)this.flush();return true;
 }
 stats(){this.prune();const rows=this.rows,n=rows.length;return {n,speakers:new Set(rows.map(r=>r.user)).size,conversations:new Set(rows.map(r=>r.scope)).size,shortPct:n?Math.round(100*rows.filter(r=>r.length<=14).length/n):0,noPunctPct:n?Math.round(100*rows.filter(r=>r.ending==='none').length/n):0,questionPct:n?Math.round(100*rows.filter(r=>r.ending==='question').length/n):0};}
 render(){
  const s=this.stats();if(s.n<12||s.speakers<3||s.conversations<2)return '';
  const phrases=WORDS.filter(w=>{const rows=this.rows.filter(r=>r.words.includes(w));return new Set(rows.map(r=>r.user)).size>=3&&new Set(rows.map(r=>r.scope)).size>=2;}).slice(0,6);
  const lines=['跨聊天学到的表达习惯，只作参考；当前意图、明确教学和本会话边界优先，认真问题仍说完整。'];
  if(s.shortPct>=50)lines.push('平常闲聊常用短句，省略已经明白的铺垫，不为缩短而敷衍问题。');
  if(s.noPunctPct>=50)lines.push('轻松短句可以不带句号。');
  if(s.questionPct>=10)lines.push('短疑问也可以表示反应，不一定要追加追问。');
  if(phrases.length)lines.push('多个聊天中多人使用过的语气词：'+JSON.stringify(phrases)+'。按情绪选择，不强行使用、不刷同一句。');
  return lines.length>1?lines.join('\n'):'';
 }
 flush(){if(!this.file)return;fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify({v:1,rows:this.rows}));fs.renameSync(tmp,this.file);}
}
