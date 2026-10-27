// 只保留短期收到的图片句柄；不持久化下载地址，不跨会话或发言者借图。
export class RecentMedia {
  constructor({ttlMs=120000,maxKeys=64,now=Date.now}={}){this.ttlMs=ttlMs;this.maxKeys=maxKeys;this.now=now;this.rows=new Map();}
  observe(msg={}){
    if(!/^(private|group):[\w-]+$/.test(msg.key||'')||!msg.userId||msg.isSelf||msg.isBot||!msg.images?.length)return;
    const t=Number(msg.time)||this.now();if(t>this.now()||this.now()-t>this.ttlMs)return;
    const row={t,userId:String(msg.userId),messageId:String(msg.messageId||''),images:msg.images.slice(0,4)};
    const rows=(this.rows.get(msg.key)||[]).filter(x=>this.now()-x.t<=this.ttlMs&&(!row.messageId||x.messageId!==row.messageId));
    rows.push(row);rows.sort((a,b)=>a.t-b.t);this.rows.delete(msg.key);this.rows.set(msg.key,rows.slice(-12));
    while(this.rows.size>this.maxKeys)this.rows.delete(this.rows.keys().next().value);
  }
  forSaveFollowup({key,userId,text,before=this.now(),excludeIds=[]}={}){
    if(!/^(private|group):[\w-]+$/.test(key||'')||!userId)return [];
    if(!/(?:存|收藏|保存|收下)/.test(text||'')||!/(?:这|那|刚才|上一张)/.test(text||''))return [];
    const skip=new Set(excludeIds.map(String));
    const rows=(this.rows.get(key)||[]).filter(x=>x.t<=this.now()&&this.now()-x.t<=this.ttlMs);
    if(!rows.length){this.rows.delete(key);return [];}
    this.rows.set(key,rows);
    const latest=rows.findLast(x=>x.t<=before&&!skip.has(x.messageId));
    const row=latest?.userId===String(userId)?latest:null;
    return row?row.images.map(seg=>({seg,messageId:row.messageId,at:row.t})):[];
  }
  forAvatar({key,userId,before=this.now(),replyTo=''}={}){
    if(key!=='private:'+String(userId)||!userId)return [];
    const rows=(this.rows.get(key)||[]).filter(x=>x.t<=this.now()&&this.now()-x.t<=this.ttlMs&&x.t<=before);
    const row=replyTo?rows.findLast(x=>x.messageId===String(replyTo)):rows.at(-1);
    return row?.userId===String(userId)?row.images.map(seg=>({seg,messageId:row.messageId,at:row.t})):[];
  }
  forFollowup(items=[]){
    // 新图、引用或多人混合批次不猜指代；逐条读正文，不能用昵称/别人的话触发。
    if(!items.length||items.some(m=>m.images?.length||m.replyTo||m.quoted||m.forwards?.length)
      ||new Set(items.map(m=>m.key+'|'+m.userId)).size!==1)return [];
    for(const m of items.slice().reverse()){
      if((m.atIds||[]).some(id=>String(id)!==String(m.selfId||'1290313893')))continue;
      const text=String(m.text||'').replace(/@\d+\b/g,'').trim();
      const save=/(?:存|收藏|保存|收下).{0,8}(?:这|那|刚才|上一张)|(?:这|那|刚才|上一张).{0,8}(?:存|收藏|保存|收下)/.test(text);
      const reuse=/(?:以后|下次).{0,8}(?:发|用).{0,6}(?:这|那)/.test(text);
      const look=/(?:这|那|刚才|上一张).{0,6}(?:图|表情|截图).{0,20}(?:看|懂|什么|啥|谁|吗|么|呢|意思)|^(?:这|那)(?:个)?是(?:你(?:吗|么)?|谁|什么|啥)[啊呀吗么呢？?！!。]*$|(?:看懂|看清|看得懂|看得清|看不到|看不懂).{0,6}(?:了|吗|没|图)/.test(text);
      const shortSave=/^(?:记得|帮我|给我|你)?(?:收藏|保存|存下|收下)(?:一下|起来|吧|哦|啊)?[！!。]*$/.test(text);
      if(!save&&!reuse&&!look&&!shortSave)continue;
      const before=Number(m.time)||this.now();
      const maxAge=shortSave||look||reuse?45000:this.ttlMs;
      const skip=new Set(items.map(x=>String(x.messageId||'')));
      const row=(this.rows.get(m.key)||[]).findLast(x=>x.t<=before&&!skip.has(x.messageId));
      if(!row||row.userId!==String(m.userId)||this.now()-row.t>this.ttlMs||before-row.t>maxAge)return [];
      return row.images.map(seg=>({seg,messageId:row.messageId,at:row.t}));
    }
    return [];
  }
}
