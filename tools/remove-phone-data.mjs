import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const removedMemories=new Map([
 ['5d37504f-22e9-4b90-ab21-e9b24cd29ed1','小助手表示自己没有实体手机，但可以替用户操作手机应用并看到屏幕内容，无法感知设备温度。'],
 ['f8a0db59-5264-4cfa-88dc-b7b1d143083a','小助手在2026-10-23向Forgotten说明自己没有实体手机，但能代为操作应用并看到屏幕，感觉不到温度。'],
]);
const mixedId='mmmvky9vv8440';
const mixedBefore='只在本机部署，杭州那台容器不动也不用；手机控制走本机 127.0.0.1:8899 的桥，聊天在线不等于手机桥在线。';
const mixedAfter='只在本机部署，杭州那台容器不动也不用。';
const oldReplies=new Map([
 ['legacy-turn:384','我手上没手机，但能替这台机子点几下、开个应用什么的，屏幕上发生什么也看得见。就是摸不出烫不烫，得靠你告诉我'],
 ['365b9689-4a47-41b8-9cbd-5cdd6409f71e','手机那边连不上，我这边没法把头像替你换上。'],
 ['39ac0c67-72b1-4103-b9ce-613e23770e51','功能其实有，断掉的是我和那台手机之间的连接。'],
]);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const parse=text=>JSON.parse(text.replace(/^\uFEFF/,''));

// Fixed, reviewed records only. Ordinary phone discussions and other facts stay.
export function cleanPhoneState(value){
 const s=structuredClone(value);let removed=0,edited=0,recent=0;
 s.memories=(s.memories||[]).filter(m=>{
  if(!removedMemories.has(m.id))return true;
  assert.equal(m.text,removedMemories.get(m.id),'Memory changed since review');removed++;return false;
 }).map(m=>{
  if(m.id===mixedId&&m.text!==mixedAfter){assert.equal(m.text,mixedBefore,'Mixed memory changed since review');m.text=mixedAfter;edited++;}
  return m;
 });
 s.recent=(s.recent||[]).flatMap(r=>{const clean=cleanPhoneRecord(r);if(clean===r)return [r];recent++;return clean?[clean]:[];});
 return {value:s,removed,edited,recent};
}
export function cleanPhoneRecord(row,compatibility=false){
 const expected=compatibility?[...oldReplies.values()].find(t=>t===row.reply):oldReplies.get(row.id);
 if(!expected)return row;
 // A cleared imported reply retains the person's original question.
 if(!row.reply)return row;
 assert.equal(row.reply,expected,'Chat record changed since review');
 return row.text?{...row,reply:''}:null;
}
export function planPhoneCleanup(dataDir){
 const changes=[],counts={memoriesRemoved:0,memoryClausesRemoved:0,recentRepliesRemoved:0,archiveRepliesRemoved:0,compatibilityRepliesRemoved:0,topicsRemoved:0};
 const add=(rel,before,after)=>{if(before!==after)changes.push({rel,beforeHash:hash(before),afterHash:hash(after),after});};
 for(const name of fs.readdirSync(path.join(dataDir,'conversations'))){
  if(!/^(private|group)-[\w-]+\.jsonl?$/.test(name))continue;
  const rel='conversations/'+name,before=fs.readFileSync(path.join(dataDir,rel),'utf8');
  if(name.endsWith('.json')){
   const c=cleanPhoneState(parse(before));counts.memoriesRemoved+=c.removed;counts.memoryClausesRemoved+=c.edited;counts.recentRepliesRemoved+=c.recent;
   if(c.removed+c.edited+c.recent)add(rel,before,JSON.stringify(c.value,null,2));
  }else{
   let changed=0;
   const after=before.split('\n').flatMap(line=>{
    if(!line.trim())return [line];const row=parse(line),clean=cleanPhoneRecord(row);
    if(clean===row)return [line];changed++;return clean?[JSON.stringify(clean)]:[];
   }).join('\n');
   counts.archiveRepliesRemoved+=changed;if(changed)add(rel,before,after);
  }
 }
 const turns=path.join(dataDir,'turns.jsonl');
 if(fs.existsSync(turns)){
  const before=fs.readFileSync(turns,'utf8');let changed=0;
  const after=before.split('\n').flatMap(line=>{
   if(!line.trim())return [line];const row=parse(line),clean=cleanPhoneRecord(row,true);
   if(clean===row)return [line];changed++;return clean?[JSON.stringify(clean)]:[];
  }).join('\n');
  counts.compatibilityRepliesRemoved=changed;if(changed)add('turns.jsonl',before,after);
 }
 const people=path.join(dataDir,'people.json');
 if(fs.existsSync(people)){
  const before=fs.readFileSync(people,'utf8'),j=parse(before),p=j['1138876912'];
  if(p?.topics){const old=p.topics.length;p.topics=p.topics.filter(t=>t!=='你用过手机吗');counts.topicsRemoved=old-p.topics.length;}
  if(counts.topicsRemoved)add('people.json',before,JSON.stringify(j,null,2));
 }
 return {changes,counts};
}
export function applyPhoneCleanup(dataDir,plan){
 // Validate every target before any write, then use atomic per-file replacement.
 for(const c of plan.changes)assert.equal(hash(fs.readFileSync(path.join(dataDir,c.rel),'utf8')),c.beforeHash,'Concurrent data change: '+c.rel);
 for(const c of plan.changes){const target=path.join(dataDir,c.rel),tmp=target+'.phone-removal.tmp';fs.writeFileSync(tmp,c.after,'utf8');fs.renameSync(tmp,target);}
 return {counts:plan.counts,files:plan.changes.map(({rel,beforeHash,afterHash})=>({rel,beforeHash,afterHash}))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,dataDir,configFile]=process.argv.slice(2);
 assert.ok(mode==='--plan'||mode==='--apply');assert.ok(dataDir);
 if(path.resolve(dataDir).toLowerCase()==='d:\\agent\\data'&&mode==='--apply')assert.ok(fs.existsSync(path.join(dataDir,'service-paused')),'Pause companion before modifying production memory');
 const plan=planPhoneCleanup(dataDir);
 if(mode==='--plan')console.log(JSON.stringify({counts:plan.counts,files:plan.changes.map(c=>c.rel)}));
 else{
  let cfg;
  if(configFile){cfg=parse(fs.readFileSync(configFile,'utf8'));delete cfg.phone;}
  const result=applyPhoneCleanup(dataDir,plan);
  if(configFile){const tmp=configFile+'.phone-removal.tmp';fs.writeFileSync(tmp,JSON.stringify(cfg,null,2),'utf8');fs.renameSync(tmp,configFile);}
  fs.writeFileSync('tmp/phone-removal-20261025/cleanup-result.json',JSON.stringify({at:new Date().toISOString(),...result,configPhoneRemoved:!!configFile},null,2));
  console.log(JSON.stringify({counts:result.counts,files:result.files.map(c=>c.rel),configPhoneRemoved:!!configFile}));
 }
}
