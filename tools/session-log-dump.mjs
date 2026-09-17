#!/usr/bin/env node
// dsh session 日志解析器（C1 spike 沉淀，见 docs/spikes/C1-dsh-headless-spike.md F6）
//
// dsh 将 session 事件以 JSONL 追加写入 session.v3.jsonl.zstd，每次 append 一个
// 独立 zstd 帧；单次 zstdDecompressSync 只能解出首帧。本工具按 zstd magic
// （28 B5 2F FD）切帧后逐帧解压，输出人类可读的事件摘要。
//
// 用法：node tools/session-log-dump.mjs <path/to/session.v3.jsonl.zstd> [--json]
//   --json  原样输出解压后的完整 JSONL（不截断、不加列）
//
// 依赖：Node ≥ 24（node:zlib 原生 zstd），零第三方依赖。
import fs from 'node:fs';
import zlib from 'node:zlib';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/session-log-dump.mjs <session.v3.jsonl.zstd> [--json]');
  process.exit(2);
}
const rawJson = flags.includes('--json');

const buf = fs.readFileSync(file);
const offsets = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i);
}
if (offsets.length === 0) {
  console.error('no zstd frames found (magic 28 B5 2F FD)');
  process.exit(1);
}

const chunks = [];
let failed = 0;
for (let i = 0; i < offsets.length; i++) {
  // 帧长度未随 magic 存储：依次尝试到下一个帧边界（含文件尾），首次解压成功即为本帧终点。
  const ends = [...offsets.slice(i + 1), buf.length];
  let decoded = false;
  for (const end of ends) {
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(offsets[i], end)));
      decoded = true;
      break;
    } catch {
      /* 帧跨越了下一个 magic 候选位（压缩数据内偶现同字节序），延长候选终点重试 */
    }
  }
  if (!decoded) failed++;
}
const text = Buffer.concat(chunks).toString('utf-8');
const lines = text.split('\n').filter((l) => l.trim() !== '');

if (rawJson) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
} else {
  console.log(`frames: ${offsets.length} (${failed} undecodable)  events: ${lines.length}`);
  for (const line of lines) {
    const e = JSON.parse(line);
    let extra = '';
    if (e.type === 'assistant/message') {
      extra = (e.data?.message?.content ?? []).map((b) => b.type).join(',');
    } else if (e.type === 'tool/call') {
      extra = `${e.data?.name} ${String(e.data?.arguments ?? '').slice(0, 100)}`;
    } else {
      extra = JSON.stringify(e.data ?? {}).slice(0, 120);
    }
    console.log(`${String(e.seq ?? '-').padStart(4)}  ${e.type.padEnd(26)} ${extra}`);
  }
}
