import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupContext } from './group-context.js';
import { setSelfName } from './identity.js';
setSelfName('小助手'); // 本文件 fixture 用「小助手」标识机器人
import { expandAddressedBatch, isQuoteRelay } from './group-addressing.js';
import { Waker } from './wake.js';
import { handleTurn } from './index.js';
import { GroupStyle } from './group-style.js';

const key = 'group:42';
const self = '1290313893';
const at = Date.now();
const msg = (id, text, extra = {}) => ({ key, isGroup: true, userId: '111', name: '甲',
  messageId: id, text, time: at - 1000, images: [], atIds: [], ...extra });
const ping = extra => msg('ping', '@' + self, { isAtMe: true, atIds: [self], time: at, ...extra });
function context(...rows) {
  const g = new GroupContext();
  for (const m of rows) g.add(m.key, { ...m, selfId: self });
  return g;
}

test('日志复现：前文→小助手还在回复→补 @，前文被提升且不混入同名群友', () => {
  const q = msg('q', '因为我感觉你们有智慧，有思想，有感情。是我的误判吗？');
  const p = ping();
  const g = context(q, msg('other', '别人的问题', { userId: '222' }),
    msg('reply', '真到那份上，我大概会先问有没有米饭。', { isSelf: true }), p);
  const result = expandAddressedBatch([p], g);
  assert.deepEqual(result.items.map(m => m.messageId), ['q', 'ping']);
  assert.deepEqual(result.linkedIds, ['q']);
});

test('拆成数条的前文顺序正确，图片/转发段保留，最多三条', () => {
  const image = { file: 'a.png' };
  const p = ping();
  const g = context(msg('q0', '太早一条'), msg('q1', '看看这个'),
    msg('q2', '[图片]', { images: [image] }), msg('q3', '你觉得呢', { forwards: ['f'] }), p);
  const r = expandAddressedBatch([p], g);
  assert.deepEqual(r.items.map(m => m.messageId), ['q1', 'q2', 'q3', 'ping']);
  assert.deepEqual(r.items[1].images, [image]);
  assert.deepEqual(r.items[2].forwards, ['f']);
});

test('隔离：不带入别群、过期、晚于 @、或另一段较早话题', () => {
  const p = ping();
  const g = context(msg('otherGroup', '隔壁', { key: 'group:43' }),
    msg('old', '过期', { time: at - 121000 }), msg('separate', '上个话题', { time: at - 60000 }),
    msg('new', '这一个问题'), p, msg('later', '后面才说的话', { time: at }));
  assert.deepEqual(expandAddressedBatch([p], g).linkedIds, ['new']);
});

test('明确 @ 别人或引用别人，不猜成自己的问题；无前文就保留空唤醒', () => {
  for (const q of [msg('q', '@222 给你的', { atIds: ['222'] }), msg('q', '给你的', { replyTo: 'x' })]) {
    const p = ping();
    assert.equal(expandAddressedBatch([p], context(msg('earlier', '更早的事'), q, p)).linkedIds.length, 0);
  }
  const p = ping();
  assert.deepEqual(expandAddressedBatch([p], context(p)).items, [p]);
});

test('本轮已经带入、成功答过的原话不重复提升', () => {
  const q = msg('q', '原问题'); const p = ping(); const g = context(q, p);
  assert.deepEqual(expandAddressedBatch([q, p], g).items.map(m => m.messageId), ['q', 'ping']);
  g.markAnswered(key, ['q']);
  assert.deepEqual(expandAddressedBatch([p], g).linkedIds, []);
});

test('只提升最近一轮的问题，不越过此前小助手的回复捞已结束的话题', () => {
  const p=ping(); const g=context(msg('old','上个话题'),
    msg('old-answer','上个话题答完了',{isSelf:true}),msg('q','新的问题'),p);
  assert.deepEqual(expandAddressedBatch([p],g).linkedIds,['q']);
});

test('有正文、显式引用、戳一戳、@多人或私聊不强行拼前文', () => {
  for (const extra of [{text:'@' + self + ' 新问题'}, {replyTo:'x'}, {isPoke:true},
    {atIds:[self,'222'],text:'@' + self + ' @222'}, {isGroup:false}]) {
    const p = ping(extra);
    assert.equal(expandAddressedBatch([p], context(msg('q','旧话'), p)).linkedIds.length, 0);
  }
});

test('引用小助手只 @ 第三人不唤醒；确有新问题/图片仍响应', () => {
  const relay = ping({ replyTo:'x', quoted:{isSelf:true,senderId:self}, isQuoteMe:true,
    atIds:[self,'222'], text:'@' + self + ' @222' });
  const w = new Waker({probability:0});
  assert.equal(isQuoteRelay(relay), true);
  assert.equal(w.shouldWake(relay).wake, false);
  assert.equal(expandAddressedBatch([relay], context(relay)).items.length, 0);
  for (const m of [{...relay,text:relay.text + ' 你觉得呢'}, {...relay,images:[{file:'a'}]},
    {...relay,text:'@' + self,atIds:[self]}]) {
    assert.equal(isQuoteRelay(m), false);
    assert.equal(w.shouldWake(m).wake, true);
  }
});

test('六条以上合并不提前丢失，flush 只消费一次', () => {
  const w = new Waker();
  for (let i=0;i<8;i++) w.batch(msg(String(i),'第'+i+'条'));
  assert.equal(w.flush(key).length,8);
  assert.deepEqual(w.flush(key),[]);
});

async function run(p, g, { dryRun = true, fail = false } = {}) {
  const requests = [];
  const deps = { groupCtx:g, memory:{recentTurns:()=>[], logTurn(){}, touch(){}},
    brain:{reply:async x=>{requests.push(x); return {text:'回答原问题',actions:[]};}},
    human:{say:async (out, opts)=>{ await opts.send(out); return {sent:1,parts:[out]}; }},
    bot:{imageToDataUrl:async()=> 'data:image/png;base64,AAAA', setTyping(){},
      send:async()=> fail ? {ok:false,error:'offline'} : {ok:true}}, waker:{wake(){}} };
  await handleTurn(deps,[p],{vision:{enabled:true},ownerIds:[],dryRun});
  return requests;
}

test('集成：关联正文和图片真正进入模型请求，干跑不消耗前文', async () => {
  const p=ping(); const g=context(msg('q','图里这步为什么不对',{images:[{file:'a'}]}),p);
  const [r]=await run(p,g);
  assert.match(r.text,/图里这步为什么不对/);
  assert.match(r.situation,/补 @ 关联/);
  assert.equal(r.images.length,1);
  assert.equal(g.liveRows(key)[0].answered,undefined);
});

test('集成：实际发送成功才标记已答，失败仍可再次关联', async () => {
  const p=ping(); const g=context(msg('q','原问题'),p);
  await assert.rejects(run(p,g,{dryRun:false,fail:true}),/offline/);
  assert.deepEqual(expandAddressedBatch([p],g).linkedIds,['q']);
  await run(p,g,{dryRun:false});
  assert.deepEqual(expandAddressedBatch([p],g).linkedIds,[]);
});

test('语气：训人式收尾校正、八股反馈只在本群生效，认真解释不压字数', () => {
  const g=new GroupStyle();
  g.observeSelf(key,'道理是对的，宝宝那两个字别顺手就带上');
  g.observeSelf(key,'想说什么直接说，别拿at当敲门');
  assert.match(g.nudge(key),/训人或压人/);
  assert.ok(!g.nudge(key,{text:'解释为什么报错'}).includes('训人或压人'));
  g.observe(key,{userId:'111',text:'你这鱼八股太严重了',isAtMe:true});
  assert.match(g.nudge(key,{text:'解释为什么报错'}),/八股味/);
  assert.equal(g.nudge('group:43'),'');
  assert.equal(g.groups.get(key).length,0,'反馈不混成可模仿的聊天语料');
  g.close();
});
