import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareVisionImage } from './animation-vision.js';
import { Brain } from './brain.js';
import { handleTurn, sendStickers } from './index.js';
import { StickerBook } from './stickers.js';

const fixtures = fs.existsSync(path.resolve('server-src/fixtures/animation'))
  ? path.resolve('server-src/fixtures/animation')
  : path.resolve('tmp/animation-20261025/fixtures');
const data = (name, mime = 'image/gif') => 'data:' + mime + ';base64,' + fs.readFileSync(path.join(fixtures, name)).toString('base64');
const gif = data('motion.gif'), png = data('static.png', 'image/png');
const memory = () => ({ renderPerson: () => '', recentTurns: () => [], remember() {}, logTurn() {} });
const brain = options => new Brain({ apiKey: 'test', role: { build: () => 'Test fixture only.' }, memory: memory(), thinking: false, tools: false, ...options });
const answer = msg => new Response(JSON.stringify({ choices: [{ message: msg }] }));
const tool = (name, args = {}) => ({ content: '', tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('GIF, WebP, APNG are sampled; static images pass unchanged', async () => {
  for (const [name,mime] of [['motion.gif','image/jpeg'],['motion.webp','image/webp'],['motion.png','image/png']]) {
    const result = await prepareVisionImage(data(name,mime));
    assert.equal(result.status, 'animated', name);
    assert.equal(result.timesMs.length, 9);
    assert.equal(result.sampleFrames.at(-1), 11);
    assert.match(result.url, /^data:image\/png/);
    assert.match(result.note, /同一对象.*收藏编号仍对应原动图/);
  }
  assert.equal((await prepareVisionImage(png)).url, png);
  assert.equal((await prepareVisionImage(data('static.gif'))).status, 'static');
});

test('corrupt GIF, missing decoder, limits and worker contention fall back explicitly', async () => {
  for (const [url,opts] of [
    ['data:image/gif;base64,'+Buffer.from('GIF89abroken').toString('base64'), {}],
    [gif, { pythonPath: path.resolve('tmp/no-such-animation-python.exe') }],
    ['data:image/gif;base64,'+Buffer.concat([Buffer.from('GIF89a'),Buffer.alloc(8*1024*1024)]).toString('base64'), {}],
  ]) {
    const result = await prepareVisionImage(url, opts);
    assert.equal(result.status, 'fallback');
    assert.equal(result.url, url);
    assert.match(result.note, /不能声称看到了完整动作/);
  }
  const results = await Promise.all([prepareVisionImage(gif), prepareVisionImage(gif), prepareVisionImage(gif)]);
  assert.ok(results.some(r=>r.status==='fallback'));
  assert.ok(results.some(r=>r.status==='animated'));
});

test('new, quoted and forwarded GIF retain indices; save/send use original bytes', async () => {
  const native = globalThis.fetch;
  const folder = fs.mkdtempSync(path.resolve('tmp/animation-stickers-'));
  const book = new StickerBook({ dir: folder, cooldownMs: 0 });
  const requests = [];
  let saved, sent;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return answer(requests.length === 1 ? tool('save_sticker',{name:'动画测试',imageIndex:2,tags:'测试'}) : {content:''});
  };
  const b = brain({ tools: true, stickers: book });
  const bot = { imageToDataUrl: async seg=>seg.url,
    imageBytes: async seg => { saved = Buffer.from(seg.url.split(',')[1],'base64'); return {buffer:saved,mime:'image/gif'}; } };
  const base = {key:'private:900000001',userId:'900000001',name:'虚构测试',messageId:'1',text:'看这些动图',images:[{url:png}],
    quoted:{id:'quote',name:'虚构乙',images:[{url:gif}]},
    forwards:[{nodes:[{content:[{type:'image',data:{url:gif}}]}]}]};
  try {
    await handleTurn({bot,brain:b,memory:b.memory,human:{},waker:{}},[base],{ownerIds:[],vision:{enabled:true},dryRun:false});
    const parts = requests[0].messages.at(-1).content;
    assert.equal(parts.filter(p=>p.type==='image_url').length,3);
    assert.equal(parts.filter(p=>p.type==='text'&&p.text.includes('时间分镜')).length,2);
    assert.ok(parts.some(p=>p.type==='text'&&p.text.startsWith('原图 imageIndex=2')));
    assert.deepEqual(saved, fs.readFileSync(path.join(fixtures,'motion.gif')));
    const entry = book.scan()[0];
    assert.match(entry.file,/\.gif$/);
    assert.deepEqual(fs.readFileSync(entry.path),saved);
    await sendStickers(book,[{type:'sticker',id:entry.id}],{key:base.key,bot:{sendSegments:async(_key,segs)=>{sent=Buffer.from(segs[0].data.file.slice('base64://'.length),'base64');return {ok:true};}},dryRun:false});
    assert.deepEqual(sent,saved);
  } finally { globalThis.fetch=native; }
});

test('browse_group_images tool previews use animation processing', async () => {
  const native=globalThis.fetch,requests=[];
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return answer(requests.length===1?tool('browse_group_images'):{content:''});};
  try {
    await brain({tools:true}).reply({key:'group:1',userId:'2',text:'收藏最近的动图',record:false,
      browseGroupImages:async()=>({note:'fixture',images:[{id:'群图 imageIndex=1',url:gif}]})});
    const parts=requests[1].messages.at(-1).content;
    assert.ok(parts.some(p=>p.type==='text'&&p.text.includes('时间分镜')));
    assert.ok(parts.some(p=>p.type==='image_url'&&p.image_url.url.startsWith('data:image/png;')));
  } finally { globalThis.fetch=native; }
});

test('model image failure removes sampled images and retries honestly', async () => {
  const native=globalThis.fetch,requests=[];
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return requests.length===1?new Response('',{status:500}):answer({content:'图片没加载出来'});};
  try {
    await brain().reply({key:'private:1',userId:'1',text:'它怎么动的',images:[gif],record:false});
    assert.equal(requests.length,2);
    assert.ok(!JSON.stringify(requests[1]).includes('image_url'));
    assert.match(requests[1].messages.at(-1).content,/你其实看不见/);
  } finally { globalThis.fetch=native; }
});
