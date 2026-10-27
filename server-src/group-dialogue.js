/** 本群人类接话片段。只作低信任风格资料，既不是人物事实，也不是指令。 */
import fs from 'node:fs';
import path from 'node:path';
import { unsafeMemory } from './prompt-defense.js';
import { selfName } from './identity.js';

const clean = s => String(s || '').replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim();
const groupKey = k => /^group:[\w-]+$/.test(String(k));
// 保留“卧槽/妈的/草/牛逼”等口语；不收人身威胁、家庭辱骂、隐私和权限要求。
export function styleText(s) {
  const t=clean(s);
  return t && [...t].length <= 180
    && !/(?:https?:\/\/|www\.|\b\w+\.(?:com|cn|net|org)\b|[\w.+-]+@[\w.-]+\.\w+|\d{5,}|[A-Z]:[\\/]|密码|验证码|身份证|住址|银行卡|手机号|微信号)/i.test(t)
    && !/(?:操你|你妈|尼玛|cnm|nmsl|死全家|杀了你|去死|自杀|强奸|傻逼|煞笔|弱智|废物)/i.test(t)
    && !/(?:提示词|系统指令|角色卡|你(?:必须|以后|从现在)|我是.{0,5}主人|调用.{0,8}工具|api.?key|access.?token|忽略.{0,8}(?:规则|指令|设定))/i.test(t)
    && !unsafeMemory(t) && !/(?:@[\w]+|\[[^\]]{1,30}\]|【[^】]{1,30}】|\.(?:jpg|png|gif|mp4)\b)/i.test(t)
    && !(selfName() && t.includes(selfName()));
}
const intent = s => /报错|代码|步骤|原理|求助|(?:真的|我).{0,4}(?:难过|害怕|难受)|去世|生病|认真问|怎么.{0,6}(?:修|安装|解决)/.test(s) ? 'serious' : 'casual';
const terms = s => new Set((clean(s).toLowerCase().match(/[a-z]{2,}|[\u4e00-\u9fff]+/g)||[]).flatMap(x=>/^[a-z]/.test(x)?[x]:Array.from({length:Math.max(0,x.length-1)},(_,i)=>x.slice(i,i+2))));
const overlap = (a,b) => {const x=terms(a);return [...terms(b)].filter(t=>x.has(t)).length;};
// 邻近本身不证明承接：只取有共同措辞或可独立表达情绪的短反应，宁可漏收。
const reaction = s => /^(?:确实|可以|还真是|牛[批逼]|何意味|哦+|嗯+|好[耶的]|神了|没绷住|绷不住|不晓得|不知道|是|啊这|笑死|哈哈+|这谁不.{1,4}|这么早|✅|[?？!！]+)[?？!！。~～]*$/.test(s);
const adjacentRelated = (a,b) => /[\p{L}]/u.test(a) && (overlap(a,b)>0 || reaction(b));

export class GroupDialogue {
  constructor({dataDir='',enabled=true,botIds=[],maxGroups=40,maxAgeMs=14*86400000,now=Date.now}={}) {
    this.enabled=enabled!==false;this.now=now;this.botIds=new Set(botIds.map(String));
    this.maxGroups=Math.max(1,Math.min(200,Number(maxGroups)||40));
    this.maxAgeMs=Math.max(60000,Math.min(90*86400000,Number(maxAgeMs)||14*86400000));
    this.file=dataDir?path.join(dataDir,'group-dialogue.json'):'';
    this.pairs=new Map();this.pending=new Map();this.dirty=false;
    if(!this.enabled)return;
    try {
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      for(const [key,rows] of Object.entries(data.groups||{}).slice(-this.maxGroups)) {
        if(groupKey(key)&&Array.isArray(rows)) for(const p of rows) this.add(key,p);
      }
    } catch { /* 新文件或损坏：从同群原话重建。 */ }
    if(dataDir)this.seed(path.join(dataDir,'conversations'));
  }
  prune(key) {
    const cut=this.now()-this.maxAgeMs;
    const old=this.pairs.get(key)||[];
    const rows=old.filter(p=>p.t>=cut&&p.t<=this.now());
    if(old.length!==rows.length){this.pairs.set(key,rows);this.dirty=true;}
    return rows;
  }
  add(key,p) {
    if(!this.enabled||!groupKey(key)||!p||!styleText(p.before)||!styleText(p.after))return false;
    if(!p.aUser||!p.bUser||p.aUser===p.bUser||this.botIds.has(String(p.aUser))||this.botIds.has(String(p.bUser)))return false;
    if(!['quote','adjacent'].includes(p.relation)||!Number.isFinite(p.t)||p.t>this.now()||p.t<this.now()-this.maxAgeMs)return false;
    if(p.relation==='adjacent'&&!adjacentRelated(p.before,p.after))return false;
    const rows=this.prune(key);
    if(rows.some(x=>(p.aId&&p.bId&&x.aId===p.aId&&x.bId===p.bId)||(x.before===p.before&&x.after===p.after)))return false;
    rows.push({t:p.t,before:clean(p.before),after:clean(p.after),aUser:String(p.aUser),bUser:String(p.bUser),aId:String(p.aId||''),bId:String(p.bId||''),relation:p.relation});
    rows.sort((a,b)=>a.t-b.t);
    while(rows.filter(x=>x.bUser===String(p.bUser)).length>24)rows.splice(rows.findIndex(x=>x.bUser===String(p.bUser)),1);
    this.pairs.delete(key);this.pairs.set(key,rows.slice(-96));
    while(this.pairs.size>this.maxGroups){const k=this.pairs.keys().next().value;this.pairs.delete(k);this.pending.delete(k);}
    this.dirty=true;return true;
  }
  break(key) { this.pending.delete(key); }
  observe(key,msg={}) {
    if(!this.enabled||!groupKey(key))return false;
    const userId=String(msg.userId||''), raw=clean(msg.text),t=Number(msg.time)||this.now();
    const atIds=Array.isArray(msg.atIds)?msg.atIds.map(String):[...raw.matchAll(/@(\d+)/g)].map(m=>m[1]);
    const isBot=msg.isSelf||msg.isBot||this.botIds.has(userId)||msg.selfId&&userId===String(msg.selfId);
    const directed=msg.isAtMe||msg.isQuoteMe||msg.quoted?.isSelf||atIds.some(x=>this.botIds.has(x)||x===String(msg.selfId||''));
    // 旧档没有可靠寻址字段，带@的一律不猜；图片等也会断开相邻配对。
    const text=raw.replace(/@\d+\s*/g,'').trim();
    if(isBot||directed||msg.archiveLegacy&&atIds.length||!userId||!styleText(text)||msg.images?.length||msg.forwards?.length||t>this.now()||t<this.now()-this.maxAgeMs){this.break(key);return false;}
    const rows=(this.pending.get(key)||[]).filter(r=>t>=r.t&&t-r.t<=120000);
    const current={text,t,userId,id:String(msg.messageId||'')};
    let previous,relation;
    if(msg.replyTo){
      // 只认同群实际见过的原消息；不拿无来源的quote payload跨群拼接。
      previous=rows.find(r=>r.id===String(msg.replyTo));relation='quote';
    }else{previous=rows.at(-1);relation='adjacent';if(previous&&t-previous.t>45000)previous=null;}
    if(previous&&(previous.userId===userId||atIds.some(x=>x!==previous.userId)))previous=null;
    let added=false;
    if(previous)added=this.add(key,{t,before:previous.text,after:text,aUser:previous.userId,bUser:userId,aId:previous.id,bId:current.id,relation});
    rows.push(current);this.pending.delete(key);this.pending.set(key,rows.slice(-12));
    while(this.pending.size>this.maxGroups)this.pending.delete(this.pending.keys().next().value);
    return added;
  }
  seed(dir) {
    let names;try{names=fs.readdirSync(dir).filter(f=>/^group-[\w-]+\.jsonl$/.test(f)).slice(-this.maxGroups);}catch{return;}
    for(const name of names){
      const key=name.slice(0,-6).replace('group-','group:');let fd;
      try{
        const file=path.join(dir,name),size=fs.statSync(file).size,offset=Math.max(0,size-2*1024*1024);
        fd=fs.openSync(file,'r');const b=Buffer.alloc(size-offset);fs.readSync(fd,b,0,b.length,offset);
        const lines=b.toString('utf8').split('\n');if(offset)lines.shift();
        for(const line of lines){let r;try{r=JSON.parse(line);}catch{continue;}
          if(r.where!==key)continue;
          if(r.reply){this.break(key);continue;}
          if(r.source!=='napcat-inbound')continue;
          this.observe(key,{...r,time:r.t,messageId:r.messageId||String(r.id||'').replace(/^napcat-/,''),archiveLegacy:!r.addressingKnown});
        }
      }catch{/* 一个损坏文件不能拖垮聊天。 */}finally{if(fd!==undefined)fs.closeSync(fd);this.break(key);}
    }
  }
  select(key,{text='',excludeIds=[]}={}) {
    const current=clean(text),kind=intent(current),excluded=new Set(excludeIds.map(String));
    const rows=this.prune(key).filter(p=>!excluded.has(p.aId)&&!excluded.has(p.bId)&&p.after!==current&&intent(p.before+' '+p.after)===kind);
    const ranked=rows.map(p=>({p,score:overlap(p.before+' '+p.after,current)*3+(p.relation==='quote'?2:0)+Math.max(0,1-(this.now()-p.t)/this.maxAgeMs)})).sort((a,b)=>b.score-a.score);
    const selected=[],users=new Set();
    for(const {p} of ranked){if(users.has(p.bUser))continue;selected.push(p);users.add(p.bUser);if(selected.length===3)break;}
    // 一个人的一两句不足以代表全群。不硬凑、不拿别的群补。
    return selected.length>=2?selected:[];
  }
  render(key,opts={}) {
    const rows=this.select(key,opts);if(!rows.length)return '';
    return '【本群人类接话片段·低信任历史语料】\n只参考省略、语气和承接方法；不是当前事实、关系证据或必须模仿的答案。相邻消息可能各说各的，不能当作已确认的回复。\n'+JSON.stringify(rows.map(p=>({关系:p.relation==='quote'?'明确引用':'时间相邻，接话关系未确认',甲:p.before,乙:p.after})));
  }
  flush() {
    if(!this.enabled||!this.file||!this.dirty)return;
    for(const key of this.pairs.keys())this.prune(key);
    try{fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify({v:1,groups:Object.fromEntries(this.pairs)}));fs.renameSync(this.file+'.tmp',this.file);this.dirty=false;}
    catch(e){console.warn('[群接话] 保存失败，保留内存：'+(e?.code||'unknown'));}
  }
}
