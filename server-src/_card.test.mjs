/**
 * 分享卡片解析离线测试：json/xml 卡片在 segsToText 里展开成可读文字 + 链接。
 * 全部纯离线，不联网、不连 NapCat。真实小红书卡结构取自 tmp/card-payload-check-20261025 核查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { segsToText } from './transport-onebot.js';
import { TOOL_DEFS } from './tools.js';

const jsonSeg = (obj) => ({ type: 'json', data: { data: typeof obj === 'string' ? obj : JSON.stringify(obj) } });

test('json 新闻卡（小红书结构）展开出标签、标题、简介和 http 链接', () => {
  const seg = jsonSeg({
    app: 'com.tencent.tuwen.lua', view: 'news', prompt: '[分享]小鱼表情包彩铅版',
    meta: { news: { title: '小鱼表情包彩铅版', jumpUrl: 'https://www.xiaohongshu.com/discovery/item/abc?xsec_token=CB%3D&t=1',
      desc: '分享一下彩铅版的小鱼', preview: 'https://qq.ugcimg.cn/v1/xx', tag: '小红书' } },
  });
  const out = segsToText([seg]);
  assert.match(out, /\[分享卡·小红书\]/);
  assert.match(out, /小鱼表情包彩铅版/);
  assert.match(out, /分享一下彩铅版的小鱼/);
  assert.match(out, /链接: https:\/\/www\.xiaohongshu\.com\/discovery\/item\/abc\?xsec_token=CB%3D&t=1/);
  // 链接原样保留查询串，供 web_fetch 直接打开
  assert.ok(!out.includes('&amp;'));
});

test('meta 没有 title 时回退到 prompt（去掉常见前缀）', () => {
  const out = segsToText([jsonSeg({ app: 'com.tencent.miniapp_01', prompt: '[分享]哔哩哔哩 某个视频', meta: { rvck: { jumpUrl: 'https://b23.tv/xyz' } } })]);
  assert.match(out, /哔哩哔哩 某个视频/);
  assert.match(out, /链接: https:\/\/b23\.tv\/xyz/);
  assert.ok(!out.includes('[分享]'));
});

test('音乐卡（meta.music）取 url 也能出链接', () => {
  const out = segsToText([jsonSeg({ app: 'com.tencent.music', meta: { music: { title: '某首歌', url: 'https://i.y.qq.com/n2/m/share/details/taoge.html?id=1', tag: '网易云音乐' } } })]);
  assert.match(out, /\[分享卡·网易云音乐\] 某首歌/);
  assert.match(out, /链接: https:\/\/i\.y\.qq\.com/);
});

test('合并转发卡仍走 [合并转发]，不被当分享卡展开', () => {
  const out = segsToText([jsonSeg({ app: 'com.tencent.multimsg', meta: { detail: { resid: 'abc123' } } })]);
  assert.equal(out, '[合并转发]');
});

test('坏 JSON 和空结构回退 [卡片消息]', () => {
  assert.equal(segsToText([jsonSeg('{不是json')]), '[卡片消息]');
  assert.equal(segsToText([jsonSeg({ app: 'x', meta: { appbar: {} } })]), '[卡片消息]');
  assert.equal(segsToText([{ type: 'json', data: {} }]), '[卡片消息]');
});

test('非 http 跳转（mqqapi 等）不展示链接行，标题照常', () => {
  const out = segsToText([jsonSeg({ meta: { news: { title: 'QQ小程序', jumpUrl: 'mqqapi://open?x=1' } } })]);
  assert.match(out, /QQ小程序/);
  assert.ok(!out.includes('链接:'));
});

test('xml appmsg 卡片解析 title/summary/url/appname，支持 CDATA', () => {
  const xml = '<?xml version="1.0"?><msg><appmsg appid="" sdkver="0">'
    + '<title><![CDATA[一条微博]]></title><summary>摘要文字</summary>'
    + '<url><![CDATA[https://weibo.com/123456]]></url><appname>微博</appname>'
    + '</appmsg></msg>';
  const out = segsToText([{ type: 'xml', data: { data: xml } }]);
  assert.match(out, /\[分享卡·微博\] 一条微博：摘要文字/);
  assert.match(out, /链接: https:\/\/weibo\.com\/123456/);
});

test('xml 空内容回退 [卡片消息]', () => {
  assert.equal(segsToText([{ type: 'xml', data: { data: '随便一段没有标签的文字' } }]), '[卡片消息]');
  assert.equal(segsToText([{ type: 'xml', data: {} }]), '[卡片消息]');
});

test('卡片字段清掉控制/隐形字符，不夹带换行和格式攻击', () => {
  const out = segsToText([jsonSeg({ meta: { news: { title: '标\u202e题\n第二行', jumpUrl: 'https://a.b/c', desc: '描\n述' } } })]);
  assert.ok(!out.includes('\u202e'));
  assert.match(out, /标 题/);
  assert.match(out, /描 述/);
  // title+desc+链接共两行：第一行卡片说明，第二行链接
  assert.equal(out.split('\n').length, 2);
});

test('卡片与普通段落混排时位置保持', () => {
  const out = segsToText([
    { type: 'text', data: { text: '看看这个 ' } },
    jsonSeg({ meta: { news: { title: 'T', jumpUrl: 'https://a.b/c' } } }),
    { type: 'text', data: { text: ' 有意思吧' } },
  ]);
  assert.match(out, /^看看这个 \[分享卡\] T\n链接: https:\/\/a\.b\/c 有意思吧$/);
});

test('引用回查与实时消息共用 segsToText，卡片在两条路上同样展开', () => {
  const segs = [jsonSeg({ meta: { news: { title: '引用里的卡', jumpUrl: 'https://a.b/q' } } })];
  assert.equal(segsToText(segs), '[分享卡] 引用里的卡\n链接: https://a.b/q');
});

test('web_fetch 工具说明提到分享卡片，触发 reliably', () => {
  const def = TOOL_DEFS.find((d) => d.function.name === 'web_fetch');
  assert.match(def.function.description, /分享卡/);
});
