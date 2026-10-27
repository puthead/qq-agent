import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { atomicJSON } from './conversation-memory.js';
import { thinkingSchedule } from './thinking-schedule.js';

export function startHealth({ bot, memory, brain, activity, port = 17861 }) {
  const snapshot = () => ({ service: 'xiaod-napcat', pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), napcatConnected: bot.connected,
    selfId: bot.selfId, lastActivity: new Date(activity.at).toISOString(), at: new Date().toISOString(),
    context: { recentLimit: memory.maxRecent, summaryTrigger: memory.compactAt, summaryKeep: memory.keepRecent, summaryChars: 1800, requestTextChars: brain?.contextLimits?.requestChars, historyMessages: brain?.contextLimits?.historyMessages, historyChars: brain?.contextLimits?.historyChars },
    dialogue: { sceneEnabled: brain?.dialogue?.sceneEnabled, model: brain?.model,
      sceneProvider:brain?.sceneHarness?.enabled?'harness':'deepseek', sceneModels:brain?.sceneHarness?.enabled?brain.sceneHarness.models:[], sceneMaxCallsPerDay:brain?.sceneHarness?.enabled?brain.sceneHarness.maxCallsPerDay:0,
      replyProvider:brain?.replyHarness?.enabled?'harness':'deepseek',replyModels:brain?.replyHarness?.enabled?brain.replyHarness.models:[] },
    thinkingSchedule: {...thinkingSchedule(),reply:thinkingSchedule().workHours?'low':'dynamic-low-high'},
    conversations: fs.readdirSync(memory.contextDir).filter(f => f.endsWith('.json')).length,
    dshSessionRequired: false });
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404).end(); return; }
    res.writeHead(bot.connected ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot()));
  });
  server.on('error', e => console.error('[健康检查] ' + e.message));
  server.listen(port, '127.0.0.1', () => console.log('[健康检查] http://127.0.0.1:' + port + '/health'));
  const timer = setInterval(() => {
    try { atomicJSON(path.join(memory.dir, 'service-status.json'), snapshot()); } catch (e) { console.error('[状态保存] ' + e.message); }
  }, 15000);
  timer.unref();
  return server;
}
