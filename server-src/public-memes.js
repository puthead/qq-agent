// Public, curated reference data. Never owner teaching, private memory or instructions.
import fs from 'node:fs';
import net from 'node:net';
import { unsafeMemory } from './prompt-defense.js';

export const MEME_LIMIT = 200;
export const MEME_TTL = 45 * 86400000;
export const MEME_MAX_BYTES = 1024 * 1024;
const emotions = new Set(['羡慕','无语','调侃','反串','自嘲','惊讶']);
const text = (v, max, required = true) => {
  if (typeof v !== 'string' || v.length > max) return null;
  const s = v.replace(/[\u0000-\u001f]/g, ' ').trim();
  if ((!s && required) || unsafeMemory(s) || /https?:|[A-Z]:[\\/]|\b(?:sk-[\w-]{16,}|Bearer\s)|\d{5,}|QQ号|群号|手机号|身份证/.test(s)) return null;
  return s;
};
export const memeKey = value => String(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const validTime = (value, now) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) >= Date.UTC(2000,0,1) && Date.parse(value) <= now;

function source(value, now) {
  const title = text(value?.title, 160), publisher = text(value?.publisher, 60);
  if (!title || !publisher || typeof value?.url !== 'string' || value.url.length > 350) return null;
  try {
    const u = new URL(value.url), host = u.hostname.toLowerCase();
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.port || !host.includes('.') || net.isIP(host) || host.includes(':') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return null;
    if (value.publishedAt != null && (!/^\d{4}-\d{2}-\d{2}$/.test(value.publishedAt) || !validTime(value.publishedAt, now) || new Date(value.publishedAt).toISOString().slice(0,10) !== value.publishedAt)) return null;
    u.hash = '';
    return {url:u.href, title, publisher, publishedAt:value.publishedAt || null};
  } catch { return null; }
}

export function normalizeMeme(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const fields = {term:48, meaning:160, when:180, how:260, avoid:180}, out = {};
  for (const [name,max] of Object.entries(fields)) {
    out[name] = text(value[name],max); if (!out[name]) return null;
  }
  if (!memeKey(out.term) || !emotions.has(value.emotion) || !Array.isArray(value.tags) || value.tags.length > 8) return null;
  out.emotion = value.emotion;
  out.tags = value.tags.map(t=>text(t,24)); if (out.tags.some(t=>!t)) return null;
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 3) return null;
  out.sources = value.sources.map(s=>source(s,now)); if (out.sources.some(s=>!s)) return null;
  out.sources = [...new Map(out.sources.map(s=>[s.url,s])).values()];
  const recent = out.sources.filter(s=>s.publishedAt && now-Date.parse(s.publishedAt)<=30*86400000);
  out.evidence = new Set(recent.map(s=>s.publisher)).size >= 2 ? 'multiple-recent-sources' : 'candidate';
  return out;
}

export function activeMemes(data, now = Date.now()) {
  if (data?.version !== 1 || !Array.isArray(data.items) || data.items.length > MEME_LIMIT) return [];
  const found = new Map();
  for (const item of data.items) {
    const clean = normalizeMeme(item,now);
    if (!clean || !validTime(item.firstSeen,now) || !validTime(item.lastSeen,now) || Date.parse(item.firstSeen)>Date.parse(item.lastSeen) || now-Date.parse(item.lastSeen)>MEME_TTL) continue;
    found.set(memeKey(clean.term),{...clean,firstSeen:item.firstSeen,lastSeen:item.lastSeen});
  }
  return [...found.values()];
}

export function mergeMemes(previous, batch, now = Date.now()) {
  if (!batch || !Array.isArray(batch.items) || batch.items.length > 10) throw Error('Batch must contain at most 10 public memes');
  const incoming = batch.items.map(v=>normalizeMeme(v,now));
  if (incoming.some(v=>!v)) throw Error('Invalid meme: check lengths, text, public sources and publication dates');
  if (new Set(incoming.map(v=>memeKey(v.term))).size !== incoming.length) throw Error('Duplicate terms in batch');
  const map = new Map(activeMemes(previous,now).map(v=>[memeKey(v.term),v]));
  const at = new Date(now).toISOString(); let added=0,updated=0;
  for (const item of incoming) {
    const key=memeKey(item.term),old=map.get(key);
    if(old)updated++;else added++;
    // A refreshed item replaces the reviewed sources; stale sources do not accumulate as votes.
    map.set(key,{...item,firstSeen:old?.firstSeen || at,lastSeen:at});
  }
  const items=[...map.values()].sort((a,b)=>Date.parse(b.lastSeen)-Date.parse(a.lastSeen)).slice(0,MEME_LIMIT);
  return {data:{version:1,updatedAt:at,items},receipt:{added,updated,total:items.length,removed:Math.max(0,(previous?.items?.length||0)+added-items.length)}};
}

export function readPublicMemes(file, now = Date.now()) {
  if (!file) return [];
  try {
    if (fs.statSync(file).size > MEME_MAX_BYTES) return [];
    return activeMemes(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),now);
  } catch { return []; }
}

export function memeReference(item) {
  return {topic:item.term,when:item.when,how:item.how,meaning:item.meaning,avoid:item.avoid,emotion:item.emotion,tags:item.tags,examples:[],source:'public-meme',evidence:item.evidence,sources:item.sources,firstSeen:item.firstSeen,lastSeen:item.lastSeen};
}
