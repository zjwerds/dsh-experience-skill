/**
 * trace-reader.js — 增量读取 trace JSONL（按 checkpoints 里的字节偏移）。
 * 只读文件；不调用模型；解析失败的行跳过，不阻塞后续行。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function findTraceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.trace.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * @param {import('./store.js').Store} store
 * @param {{offsets?: Record<string, number>, maxRecords?: number, maxBytesPerFile?: number}} [options]
 * @returns {{records: object[], offsets: Record<string, number>, files: number, bytes: number}}
 */
export function readTraceIncrement(store, options = {}) {
  const root = join(store.dataDir, 'traces');
  const offsets = options.offsets !== null && typeof options.offsets === 'object' ? { ...options.offsets } : {};
  const maxBytesPerFile = Number.isInteger(options.maxBytesPerFile) ? options.maxBytesPerFile : 2 * 1024 * 1024;
  const files = findTraceFiles(root);
  const records = [];
  let bytes = 0;

  for (const file of files) {
    const key = relative(store.dataDir, file).split('\\').join('/');
    let size = 0;
    try { size = statSync(file).size; } catch { continue; }
    let start = Number.isInteger(offsets[key]) ? offsets[key] : 0;
    if (start < 0 || start > size) start = 0;
    if (start === size) continue;

    let buffer;
    try { buffer = readFileSync(file); } catch { continue; }
    let chunk = buffer.subarray(start);
    if (chunk.length > maxBytesPerFile) chunk = chunk.subarray(0, maxBytesPerFile);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline === -1) continue;
    const text = chunk.subarray(0, lastNewline + 1).toString('utf8');
    bytes += lastNewline + 1;
    offsets[key] = start + lastNewline + 1;

    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record === null || typeof record !== 'object' || typeof record.sessionId !== 'string') continue;
      records.push(record);
    }
  }

  return { records, offsets, files: files.length, bytes };
}
