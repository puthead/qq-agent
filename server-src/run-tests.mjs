// 跨平台测试入口：跑 server-src 下的离线测试，跳过需要真实网络的 -live 用例。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs') && !name.includes('live'))
  .sort()
  .map((name) => path.join(here, name));

if (files.length === 0) {
  console.error('没有找到测试文件');
  process.exit(1);
}

// 并发压到 4：默认按 CPU 数并发时，Windows 上偶尔出现测试进程 IPC 反序列化偶发错误。
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
