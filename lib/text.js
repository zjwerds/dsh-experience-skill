/**
 * text.js — 归一化、截断、脱敏、摘要哈希。
 * 纯函数，零依赖；所有落盘/日志路径都必须先脱敏。
 */
import { createHash } from 'node:crypto';

/** 码点长度（中文按 1 个算）。 */
export function codePointLength(text) {
  if (typeof text !== 'string') return 0;
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** 按码点截断，超长加省略号。 */
export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/**
 * 归一化：NFKC、全角→半角、小写、折叠空白、去首尾。
 * 保留 . _ - : / 等错误码/路径字符。
 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  let value = text.normalize('NFKC');
  value = value.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  value = value.replace(/\u3000/g, ' ');
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 中文 bigram + 英文/数字词，用于相似度。 */
export function tokenSet(text) {
  const normalized = normalizeText(text);
  const out = new Set();
  const cjk = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    const chars = [...run];
    if (chars.length === 1) out.add(chars[0]);
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  const latin = normalized.match(/[a-z0-9_.:/-]{2,}/g) ?? [];
  for (const word of latin) out.add(word);
  return out;
}

/** Jaccard 相似度。 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** sha256 前 16 位（标题/正文摘要，用于去重/校验）。 */
export function shortHash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

const SECRET_PATTERNS = [
  /\b(sk|pk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pous]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/gi,
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]{6,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** 脱敏：命中替换为 <redacted:kind>，并截断。 */
export function redact(text, max = 300) {
  if (typeof text !== 'string') return '';
  let value = text;
  value = value.replace(SECRET_PATTERNS[0], '<redacted:key>');
  value = value.replace(SECRET_PATTERNS[1], '<redacted:token>');
  value = value.replace(SECRET_PATTERNS[2], '<redacted:aws>');
  value = value.replace(SECRET_PATTERNS[3], 'Bearer <redacted>');
  value = value.replace(SECRET_PATTERNS[4], (m) => `${m.split(/[:=]/)[0]}=<redacted>`);
  value = value.replace(SECRET_PATTERNS[5], '<redacted:private-key>');
  value = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return truncate(value, max);
}

/** 取消息 content 里的纯文本（跳过 reasoning/tool-call/image）。 */
export function messageText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}
