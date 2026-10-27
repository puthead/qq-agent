import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { parseScene } from './dialogue-policy.js';

const exec=promisify(execFile);
const MODELS=new Set(['kimi-k3.1-pro','doubao-seed-2.1-pro']);
const bounded=(v,d,min,max)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):d;
const fail=code=>Object.assign(new Error(code),{code});

async function credential(file){
 const literal=String(file).replace(/'/g,"''");
 const script=`$ErrorActionPreference='Stop';$s=ConvertTo-SecureString ([IO.File]::ReadAllText('${literal}'));$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}`;
 try{
  const {stdout}=await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:8192,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')}});
  if(!/^ark-[A-Za-z0-9-]{20,200}$/.test(stdout.trim()))throw fail('credential');
  return stdout.trim();
 }catch{throw fail('credential');}
}

// Actual supported Harness client, not a substitute HTTP client. Prompt goes only
// through stdin; credentials only through child environment, never argv or logs.
export async function runHarness(config,{model,payload,timeoutMs}){
 const root=path.resolve(config.root),runs=path.join(root,'runs');
 fs.mkdirSync(runs,{recursive:true});
 const home=fs.mkdtempSync(path.join(runs,'scene-'));
 const cwd=path.join(home,'empty');fs.mkdirSync(cwd);
 let child, timer;
 try{
  const key=await credential(config.credentialFile);
  return await new Promise((resolve,reject)=>{
   let buffer='',bytes=0,final=null,usage=null,problem=null,settled=false;
   const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve({content:final,usage});};
   child=spawn(config.executable,['--expose-internals',config.cliFile,'headless','--patch',path.join(root,config.profileDir||'profiles',model+'.json'),'--json','-'],{
    cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',XIAOD_ARK_PLAN_KEY:key,DSH_HOME:home,DSH_PERMISSION_MODE:'read-only',NO_COLOR:'1'}
   });
   const terminate=code=>{
    if(problem)return;problem=code;
    if(child.pid)execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});
    else finish(fail(code));
   };
   timer=setTimeout(()=>terminate('timeout'),timeoutMs);
   child.stdout.setEncoding('utf8');
   child.stdout.on('data',chunk=>{
    bytes+=Buffer.byteLength(chunk);if(bytes>1024*1024){terminate('output-limit');return;}
    buffer+=chunk;let nl;
    while((nl=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,nl).trim();buffer=buffer.slice(nl+1);
     let e;try{e=JSON.parse(line);}catch{continue;}
     if(e.type==='final')final=typeof e.text==='string'?e.text:null;
     if(e.type==='status'&&e.usage)usage=e.usage;
     if(e.type==='error')terminate('provider-error');
    }
   });
   // Do not retain stderr: runtime diagnostics can contain provider data.
   child.stderr.resume();
   child.stdin.on('error',()=>{});
   child.on('error',()=>finish(fail('spawn')));
   child.on('close',code=>finish(problem||code!==0||!final?fail(problem||'no-result'):null));
   child.stdin.end(JSON.stringify(payload)+'\n','utf8');
  });
 }finally{
  clearTimeout(timer);
  // Only the freshly created per-request directory under the configured root.
  if(path.dirname(home)===runs&&path.basename(home).startsWith('scene-')){
   try{fs.rmSync(home,{recursive:true,force:true,maxRetries:2,retryDelay:100});}catch{}
  }
 }
}

export class SceneHarness {
 constructor(config={},deps={}){
  this.enabled=config.enabled===true;
  this.config=config;this.models=(config.models||[]).filter(m=>MODELS.has(m));
  this.timeoutMs=bounded(config.timeoutMs,20000,3000,config.purpose==='reply'?60000:25000);
  this.maxConcurrent=bounded(config.maxConcurrent,2,1,2);
  this.maxCallsPerDay=bounded(config.maxCallsPerDay,120,1,500);
  this.run=deps.run||runHarness;this.now=deps.now||Date.now;
  this.active=0;this.failures=new Map();this.cooldowns=new Map();
 }
 async judge(payload,{key='',messageId='',proactive=false,continuation=false,output=false}={}){
  const started=this.now();
  const model=this.models.length?this.models[createHash('sha256').update(key+'|'+String(messageId||payload.current)).digest().readUInt32BE(0)%this.models.length]:null;
  const result={scene:null,model,provider:'harness',status:'disabled',elapsedMs:0,usage:null};
  if(!this.enabled||!model)return result;
  if(this.active>=this.maxConcurrent)return {...result,status:'busy'};
  if((this.cooldowns.get(model)||0)>started)return {...result,status:'circuit-open'};
  // Synchronous reserve before awaiting: concurrent groups share one daily cap.
  try{
   const root=path.resolve(this.config.root);fs.mkdirSync(root,{recursive:true});
   const file=path.join(root,'daily-budget.json'),day=new Date(started+8*3600000).toISOString().slice(0,10);
   let budget={day,count:0};
   if(fs.existsSync(file)){const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.day===day){if(!Number.isInteger(old.count)||old.count<0)throw fail('budget');budget=old;}}
   if(budget.count>=this.maxCallsPerDay)return {...result,status:'daily-cap'};
   budget.count++;fs.writeFileSync(file,JSON.stringify(budget));
  }catch{return {...result,status:'budget-unavailable'};}
  this.active++;
  try{
   const r=await this.run(this.config,{model,payload,timeoutMs:this.timeoutMs});
   const scene=output?null:parseScene(r.content,{proactive,continuation});
   const reply=output?String(r.content||'').trim():null;
   if(output?(!reply||reply.length>6000):(!scene||!scene.addressedTo))throw fail('invalid-json');
   this.failures.set(model,0);
   return {...result,scene,...(output?{text:reply}:{}),status:'ok',elapsedMs:this.now()-started,usage:r.usage||null};
  }catch(e){
   const n=(this.failures.get(model)||0)+1;this.failures.set(model,n);
   if(n>=3){this.cooldowns.set(model,this.now()+5*60*1000);this.failures.set(model,0);}
   const status=['credential','spawn','timeout','provider-error','output-limit','no-result','invalid-json'].includes(e?.code)?e.code:'unavailable';
   return {...result,status,elapsedMs:this.now()-started};
  }finally{this.active--;}
 }
}
