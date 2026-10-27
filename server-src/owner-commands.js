/**
 * 主人指令 · 只认主人、只在私聊
 * ─────────────────────────────────────────────────────────────
 * /帮助 /状态 /学习 /学习状态 /总结 /习惯
 *
 * 群里发同样的字按普通聊天处理——指令会带出服务状态和会话信息，
 * 当着群友的面回这些等于把后台摊开；主人要看状态就私聊发。
 * 认不出的 / 开头消息不劫持，照常当聊天。
 * 停服、重启仍然走 tools\xiaod-control.ps1：从这里杀掉进程，回复通道也就没了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readLearnedSection } from './learning-cycle.js';
import { selfName } from './identity.js';

const ALIAS = {
  '帮助': 'help', 'help': 'help',
  '状态': 'status',
  '学习': 'learn',
  '学习状态': 'learnstatus',
  '总结': 'digests',
  '习惯': 'habits',
};

/** 解析 / 开头的主人指令；认不出返回 null（按普通聊天走） */
export function parseOwnerCommand(text) {
  const s = String(text || '').trim();
  const m = /^[/／]([A-Za-z\u4e00-\u9fa5]+)(?:\s+([\s\S]*))?$/.exec(s);
  if (!m) return null;
  const name = ALIAS[m[1].toLowerCase()];
  return name ? { name, args: (m[2] || '').trim() } : null;
}

const fmt = (t) => t ? new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '';
const keyLabel = (key) => String(key).startsWith('group:') ? '群 ' + String(key).slice(6) : '私聊 ' + String(key).slice(8);

export class OwnerCommands {
  /**
   * @param {object} opts
   * @param {string[]} opts.ownerIds
   * @param {object}  opts.memory    ConversationMemory（logTurn 记账）
   * @param {object}  [opts.learning] LearningCycle（学习类指令用）
   * @param {object}  [opts.bot]     OneBot，创建后回填
   */
  constructor({ ownerIds = [], memory, learning = null, bot = null, dataDir = '', dryRun = false, log = console.log } = {}) {
    this.ownerSet = new Set(ownerIds.map(String));
    this.memory = memory;
    this.learning = learning;
    this.bot = bot;
    this.dataDir = dataDir;
    this.dryRun = dryRun;
    this.log = log;
  }

  /** 是主人私聊里认得出的指令就接管这一条，返回 true；其余一律 false（lastDispatch 供测试等待） */
  handle(msg) {
    const cmd = parseOwnerCommand(msg?.text);
    if (!cmd) return false;
    if (msg.isGroup || !this.ownerSet.has(String(msg.userId))) return false;
    this.log('[指令] ' + msg.name + '：' + String(msg.text || '').slice(0, 40));
    this.lastDispatch = this.#dispatch(cmd, msg).catch((e) => this.log('[指令] ' + (e?.message || e)));
    return true;
  }

  async #reply(msg, text) {
    const body = String(text || '').trim();
    if (!body) return;
    if (this.dryRun) { this.log('   [指令·干跑] 会回：' + body.slice(0, 80)); return; }
    const r = await this.bot.send(msg.key, body);
    if (r?.ok === false) this.log('[指令] 回复发送失败：' + (r.error || ''));
    this.memory.logTurn({ where: msg.key, who: selfName(), text: '', reply: body.slice(0, 300) });
  }

  async #dispatch(cmd, msg) {
    // 指令本体也照常入账：历史里看得到主人下过什么令
    this.memory.logTurn({ where: msg.key, who: msg.name, userId: msg.userId, text: msg.text, reply: '' });

    if (cmd.name === 'help') {
      await this.#reply(msg, [
        '在的，这些我能直接办（只认你、只在私聊）：',
        '/状态 —— 服务跑得怎么样',
        '/学习 —— 现在就跑一轮两小时学习',
        '/学习状态 —— 上次学到哪、下次什么时候',
        '/总结 —— 最近各会话的记忆要点',
        '/习惯 —— 角色卡里学到的说话习惯',
        '停服重启还是走 tools\\xiaod-control.ps1，这里不给。',
      ].join('\n'));
      return;
    }

    if (cmd.name === 'status') {
      let snap = {};
      try { snap = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'service-status.json'), 'utf8')); } catch { /* 没有就用实时值 */ }
      const connected = snap.napcatConnected !== undefined ? !!snap.napcatConnected : !!this.bot?.connected;
      const hours = snap.uptimeSeconds ? Math.floor(snap.uptimeSeconds / 3600) : null;
      const minutes = snap.uptimeSeconds ? Math.floor((snap.uptimeSeconds % 3600) / 60) : null;
      await this.#reply(msg, '跑了 ' + (hours !== null ? hours + ' 小时 ' + minutes + ' 分钟' : '一会儿') + '（PID ' + (snap.pid || '?') + '），NapCat ' + (connected ? '连着' : '断了') + '。'
        + '会话 ' + (snap.conversations ?? '?') + ' 个。'
        + (this.learning ? '学习循环' + (this.learning.enabled ? '开着，每 ' + this.learning.intervalHours + ' 小时一轮' : '没开') + '。' : ''));
      return;
    }

    if (cmd.name === 'learn') {
      if (!this.learning || !this.learning.enabled) { await this.#reply(msg, '学习循环没开，config 里 learning.enabled 打开才有。'); return; }
      if (this.learning.busy) { await this.#reply(msg, '上一轮学习还在跑，先等等。'); return; }
      await this.#reply(msg, '好，现在就开始收集这两小时的新东西，跑完跟你说结果。');
      const r = await this.learning.run({ trigger: 'manual' }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
      await this.#reply(msg, r.ok
        ? '这轮学完了：看了 ' + r.groups + ' 个群 ' + r.rows + ' 条新消息（' + r.chars + ' 字），'
          + '说话习惯 ' + r.habits + ' 条' + (r.cardUpdated ? '已写进角色卡' : '没变化') + '，'
          + '给 ' + r.digestSessions + ' 个会话存了 ' + r.memories + ' 条记忆要点。'
        : r.reason === 'busy' ? '刚才那轮还没跑完，没开成新的。' : '没跑成：' + (r.error || r.reason || '原因不明') + '。原话和旧习惯都没动。');
      return;
    }

    if (cmd.name === 'learnstatus') {
      if (!this.learning) { await this.#reply(msg, '学习循环没接上。'); return; }
      const s = this.learning.status();
      await this.#reply(msg, (s.enabled ? '学习循环开着，每 ' + s.intervalHours + ' 小时一轮' : '学习循环没开') + (s.busy ? '，这轮正在跑。' : '。')
        + '上次：' + (fmt(s.lastRunAt) || '还没跑过') + (s.lastRunAt ? (s.lastOkAt >= s.lastRunAt ? '（成功）' : '（失败：' + (s.lastError || '原因不明') + '）') : '')
        + '，累计 ' + s.runCount + ' 次、失败 ' + s.failCount + ' 次。'
        + (s.runCount ? '下次：约 ' + fmt(s.nextDueAt) + '。' : '')
        + '角色卡里现在有 ' + s.habits + ' 条学到的习惯，记了 ' + s.digestSessions + ' 个会话的要点。');
      return;
    }

    if (cmd.name === 'digests') {
      const digests = this.learning?.digests?.() || {};
      const keys = Object.keys(digests).sort((a, b) => (digests[b].at(-1)?.t || 0) - (digests[a].at(-1)?.t || 0));
      if (!keys.length) { await this.#reply(msg, '还没有存下的记忆要点，等第一轮学习跑完。'); return; }
      const lines = keys.slice(0, 4).map((k) => {
        const last = digests[k].at(-1);
        return '【' + keyLabel(k) + '·' + fmt(last.t) + '】\n' + String(last.text || '').slice(0, 400);
      });
      await this.#reply(msg, lines.join('\n\n'));
      return;
    }

    if (cmd.name === 'habits') {
      let card = '';
      const cardPath = this.learning?.cardPath;
      try { card = fs.readFileSync(cardPath, 'utf8'); } catch { /* 读不到就照实说 */ }
      const section = readLearnedSection(card);
      await this.#reply(msg, section ? '角色卡学习区现在是这样：\n\n' + section : '学习区还是空的，等第一轮学习跑完就有内容了。');
      return;
    }
  }
}

export default OwnerCommands;
