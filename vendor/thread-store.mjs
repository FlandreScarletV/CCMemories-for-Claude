import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const clamp = (n, fallback, max) => Number.isInteger(n) ? Math.max(1, Math.min(n, max)) : fallback;
const parse = line => { try { return JSON.parse(line); } catch { return null; } };
const fault = (message, code = -32602) => Object.assign(new Error(message), { code });

function indexRoot(root) {
  const sessions = join(root, 'sessions');
  const archived = join(root, 'archived_sessions');
  if (!existsSync(sessions) || !existsSync(archived)) return root;
  const sessionRoot = dirname(realpathSync(sessions));
  const archivedRoot = dirname(realpathSync(archived));
  return sessionRoot.toLowerCase() === archivedRoot.toLowerCase() ? sessionRoot : root;
}

function titleIndex(root) {
  const path = join(indexRoot(root), 'session_index.jsonl');
  const result = new Map();
  if (!existsSync(path)) return result;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const item = parse(line);
    if (uuid.test(item?.id) && typeof item.thread_name === 'string')
      result.set(item.id.toLowerCase(), { title: item.thread_name.slice(0, 180), updatedAt: item.updated_at || null });
  }
  return result;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path);
    }
  }
  return result;
}

async function firstLine(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) return parse(line);
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function catalog(root) {
  const names = titleIndex(root);
  const result = new Map();
  for (const [dir, archived] of [['sessions', false], ['archived_sessions', true]]) {
    for (const path of walk(join(root, dir))) {
      const first = await firstLine(path);
      const id = first?.payload?.id;
      if (!uuid.test(id)) continue;
      if (!['user', 'chatgpt_handoff', 'voice_chat'].includes(first?.payload?.thread_source)) continue;
      const key = id.toLowerCase();
      const stat = statSync(path);
      const info = names.get(key);
      const row = result.get(key) || { threadId: id, title: info?.title || '(未命名任务)',
        updatedAt: null, archived: true, files: [], mtime: 0 };
      row.files.push({ path, startedAt: first.timestamp || '', mtime: stat.mtimeMs });
      row.archived = row.archived && archived;
      row.mtime = Math.max(row.mtime, stat.mtimeMs);
      result.set(key, row);
    }
  }
  for (const row of result.values()) {
    row.files.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.path.localeCompare(b.path));
    row.updatedAt = new Date(row.mtime).toISOString();
  }
  return [...result.values()].sort((a, b) => b.mtime - a.mtime);
}

const publicRow = ({ threadId, title, updatedAt, archived }) => ({ threadId, title, updatedAt, archived });

function titleQuery(value) {
  return value.toLocaleLowerCase()
    .replace(/(?:请|帮我|一下|继续|读取|查找|查一下|搜索|工作会话|工作任务|会话|任务|work|codex)/gu, ' ')
    .trim();
}

function titleMatches(rows, rawQuery) {
  const query = titleQuery(rawQuery);
  if (!query) return [];
  const terms = query.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) || [];
  const compact = query.replace(/[^a-z0-9\p{Script=Han}]/gu, '');
  return rows.map(row => {
    const title = row.title.toLocaleLowerCase();
    const flatTitle = title.replace(/[^a-z0-9\p{Script=Han}]/gu, '');
    const hits = terms.filter(term => title.includes(term));
    const exact = title.includes(rawQuery.trim().toLocaleLowerCase());
    const phrase = compact.length >= 2 && flatTitle.includes(compact);
    const score = exact ? 3 : phrase ? 2 : hits.length === terms.length ? 1 : 0;
    return { row, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.row.mtime - a.row.mtime);
}

async function messages(files, maxMessageChars = 2000) {
  const found = [];
  for (const { path } of files) {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const row = parse(line);
      const item = row?.type === 'response_item' ? row.payload : null;
      if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role)) continue;
      if (item.role === 'assistant' && item.phase && !['final_answer', 'commentary'].includes(item.phase)) continue;
      const text = (Array.isArray(item.content) ? item.content : [])
        .filter(part => ['input_text', 'output_text', 'text'].includes(part?.type))
        .map(part => part.text || '').join('\n').trim();
      if (text) found.push({ role: item.role, phase: item.role === 'assistant' ? item.phase || null : null,
        text: maxMessageChars === null ? text : text.slice(0, maxMessageChars), timestamp: row.timestamp || null });
    }
  }
  return found;
}

async function lastMessageMatch(files, query) {
  let hit = null;
  for (const { path } of files) {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.toLocaleLowerCase().includes(query)) continue;
      const row = parse(line);
      const item = row?.type === 'response_item' ? row.payload : null;
      if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role)) continue;
      if (item.role === 'assistant' && item.phase && !['final_answer', 'commentary'].includes(item.phase)) continue;
      const text = (Array.isArray(item.content) ? item.content : [])
        .filter(part => ['input_text', 'output_text', 'text'].includes(part?.type))
        .map(part => part.text || '').join('\n');
      const at = text.toLocaleLowerCase().indexOf(query);
      if (at >= 0) hit = { role: item.role, timestamp: row.timestamp || null,
        snippet: text.slice(Math.max(0, at - 100), at + query.length + 200) };
    }
  }
  return hit;
}

function messageFingerprint(all, count) {
  const hash = createHash('sha256');
  for (let index = 0; index < count; index++) hash.update(JSON.stringify(all[index]) + '\n');
  return hash.digest('base64url').slice(0, 22);
}

// Opt-in, complete-text pagination. Existing hosts keep their original API.
function completeMessagePage(thread, all, args) {
  const limit = clamp(args.messageLimit, 10, 20);
  let budget = Number.isInteger(args.characterLimit) ? args.characterLimit : 12000;
  if (budget < 512 || budget > 24000) throw fault('characterLimit must be between 512 and 24000');
  let position = { v: 1, t: thread.threadId.toLowerCase(), n: all.length,
    i: all.length - 1, e: all.at(-1)?.text.length || 0 };
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length > 1024 || !/^[\w-]+$/.test(args.cursor))
      throw fault('Invalid cursor');
    try { position = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); }
    catch { throw fault('Invalid cursor'); }
    if (position?.v !== 1 || position.t !== thread.threadId.toLowerCase() ||
        !Number.isInteger(position.n) || position.n < 1 || position.n > all.length ||
        !Number.isInteger(position.i) || position.i < 0 || position.i >= position.n ||
        !Number.isInteger(position.e) || position.e < 1 || position.e > all[position.i].text.length)
      throw fault('Cursor does not match this conversation snapshot');
    if (position.h !== messageFingerprint(all, position.n))
      throw fault('Conversation history changed. Read the latest page without a cursor.', -32006);
  }
  const snapshotHash = position.h || messageFingerprint(all, position.n);
  const page = [];
  let index = position.i;
  let end = position.e;
  while (index >= 0 && page.length < limit && budget > 0) {
    const message = all[index];
    let start = Math.max(0, end - budget);
    // Keep UTF-16 surrogate pairs together at a page boundary.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(message.text[start]) &&
        /[\uD800-\uDBFF]/.test(message.text[start - 1])) start++;
    if (start === end) break;
    const text = message.text.slice(start, end);
    page.unshift({ ...message, text, messageIndex: index, charStart: start, charEnd: end,
      totalChars: message.text.length, partial: start > 0 || end < message.text.length });
    budget -= text.length;
    if (start > 0) end = start;
    else { index--; end = all[index]?.text.length || 0; }
  }
  const nextCursor = index >= 0 ? Buffer.from(JSON.stringify({ ...position, i: index,
    e: end, h: snapshotHash })).toString('base64url') : null;
  return { thread, messages: page, nextCursor, totalMessages: all.length,
    snapshotMessages: position.n, newerMessages: all.length - position.n,
    paginationDirection: 'older', characterOffsets: 'UTF-16' };
}

// Called with an operator-configured root, never with a model-provided path.
// chunkedRead is a host option, not a permission selected by a tool caller.
export async function handleThreadTool(configuredRoot, name, args = {}, options = {}) {
  const root = resolve(configuredRoot);
  if (!existsSync(root) || !statSync(root).isDirectory() ||
      !['sessions', 'archived_sessions'].some(dir => existsSync(join(root, dir))))
    throw fault('Codex source directory is unavailable or has no session directories', -32005);
  const result = value => value;
  if (name === 'list_work_threads' || name === 'search_work_threads') {
    if (name === 'search_work_threads' && (typeof args.query !== 'string' || !args.query.trim()))
      throw fault('query is required');
    const rows = await catalog(root);
    if (name === 'list_work_threads')
      return result({ items: rows.slice(0, clamp(args.limit, 10, 50)).map(publicRow) });
    const matches = titleMatches(rows, args.query);
    const items = matches.slice(0, clamp(args.limit, 10, 50))
      .map(({ row, score }) => ({ ...publicRow(row), matchLevel: score === 3 ? 'exact' : score === 2 ? 'phrase' : 'keywords' }));
    return result({ items, needsSelection: matches.length > 1 });
  }
  if (name === 'search_work_messages') {
    if (typeof args.query !== 'string' || args.query.trim().length < 2) throw fault('query must contain at least 2 characters');
    const query = args.query.trim().toLocaleLowerCase();
    const limit = clamp(args.limit, 10, 20);
    const items = [];
    for (const row of await catalog(root)) {
      const match = await lastMessageMatch(row.files, query);
      if (match) items.push({ thread: publicRow(row), ...match });
      if (items.length >= limit) break;
    }
    return result({ items });
  }
  if (name === 'read_work_thread') {
    if (typeof args.threadId !== 'string' || !uuid.test(args.threadId)) throw fault('Invalid threadId');
    const offset = Number.isInteger(args.cursor) && args.cursor >= 0 ? args.cursor : 0;
    const limit = clamp(args.messageLimit, 10, 20);
    const row = (await catalog(root)).find(item => item.threadId.toLowerCase() === args.threadId.toLowerCase());
    if (!row) throw fault('Task not found', -32004);
    const all = await messages(row.files, options.chunkedRead ? null : 2000);
    if (options.chunkedRead) return completeMessagePage(publicRow(row), all, args);
    const end = Math.max(0, all.length - offset);
    const start = Math.max(0, end - limit);
    return result({ thread: publicRow(row), messages: all.slice(start, end),
      nextCursor: start > 0 ? offset + end - start : null, totalMessages: all.length });
  }
  throw fault('Unknown thread tool', -32601);
}
