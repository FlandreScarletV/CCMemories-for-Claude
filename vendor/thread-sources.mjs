import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSshScript } from './ssh-source.mjs';
import { handleThreadTool } from './thread-store.mjs';

const fault = (message, code = -32602) => Object.assign(new Error(message), { code });
const moduleDir = dirname(fileURLToPath(import.meta.url));
const names = new Set(['list_work_threads', 'search_work_threads', 'search_work_messages', 'read_work_thread']);
const sourceId = /^[a-z][a-z0-9_-]{0,47}$/;
const hostName = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,254}$/;
const clamp = (n, fallback, max) => Number.isInteger(n) ? Math.max(1, Math.min(n, max)) : fallback;

export function configuredSources(localRoot) {
  const filename = process.env.CCMEMORIES_SOURCES_FILE || join(moduleDir, '.runtime', 'data', 'thread-sources.json');
  let config;
  try { config = JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT' && !process.env.CCMEMORIES_SOURCES_FILE) config = {};
    else throw fault('Cannot read thread sources configuration: ' + error.message);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fault('Thread sources config must be an object');
  if (config.sources !== undefined && (!Array.isArray(config.sources) || config.sources.length > 8))
    throw fault('Configure at most 8 additional sources');
  const sources = [{ id: 'local', type: 'local', root: localRoot, label: '本机' }];
  for (const item of config.sources || []) {
    if (typeof item?.id !== 'string' || !sourceId.test(item.id) || item.id === 'all' || sources.some(s => s.id === item.id))
      throw fault('Invalid or duplicate source id');
    const source = { ...item, label: typeof item.label === 'string' ? item.label.slice(0, 120) : item.id };
    if (item.type === 'local') {
      if (typeof item.codex_home !== 'string' || !isAbsolute(item.codex_home)) throw fault('Local codex_home must be absolute');
      source.root = resolve(item.codex_home);
    } else if (item.type === 'ssh') {
      if (typeof item.host !== 'string' || !hostName.test(item.host)) throw fault('Invalid configured SSH host');
      if (item.codex_home !== undefined && (typeof item.codex_home !== 'string' || !item.codex_home.startsWith('/')))
        throw fault('SSH codex_home must be an absolute POSIX path, or omitted for ~/.codex');
      source.node = item.node ?? 'node';
      if (typeof source.node !== 'string' || !source.node || /[\r\n\0]/.test(source.node)) throw fault('Invalid configured Node executable');
      if (item.ssh_config !== undefined && (typeof item.ssh_config !== 'string' || !isAbsolute(item.ssh_config)))
        throw fault('ssh_config must be an absolute local path');
      if (item.timeout_ms !== undefined && (!Number.isInteger(item.timeout_ms) || item.timeout_ms < 1000 || item.timeout_ms > 120000))
        throw fault('timeout_ms must be between 1000 and 120000');
    } else throw fault('Source type must be local or ssh');
    if (item.file_roots !== undefined && (!Array.isArray(item.file_roots) || item.file_roots.length > 16 ||
        item.file_roots.some(path => typeof path !== 'string' || path.includes('\0') ||
          (item.type === 'ssh' ? !path.startsWith('/') || path.startsWith('//') : !isAbsolute(path)))))
      throw fault('file_roots must contain at most 16 absolute paths on the configured source');
    if (item.python !== undefined && (typeof item.python !== 'string' || !item.python || /[\r\n\0]/.test(item.python)))
      throw fault('Invalid configured Python executable');
    sources.push(source);
  }
  return sources;
}

// The trusted local module executes from stdin. Nothing is installed, written or
// cached on the remote host, and only filtered public results cross SSH.
function remoteCall(source, name, args, options) {
  const module = readFileSync(new URL('./thread-store.mjs', import.meta.url), 'utf8');
  const request = JSON.stringify({ root: source.codex_home ?? null, name, args, options });
  const script = module + `\nconst req = ${request};\ntry {\n` +
    `const root = req.root || (await import('node:os')).homedir() + '/.codex';\n` +
    `const value = await handleThreadTool(root, req.name, req.args, req.options);\n` +
    `process.stdout.write(JSON.stringify({ok:true,value}));\n` +
    `} catch(error) {process.stdout.write(JSON.stringify({ok:false,error:{code:error.code||-32603,message:error.message}}));}\n`;
  return runSshScript(source, script);
}

export function createThreadRouter(localRoot, options = {}) {
  return async (name, args) => {
    if (!names.has(name)) throw fault('Unknown thread tool', -32601);
    const sources = configuredSources(localRoot);
    const requested = args.source ?? 'local';
    if (typeof requested !== 'string' || (requested !== 'all' && !sources.some(s => s.id === requested)))
      throw fault('Unknown source. Available: ' + sources.map(s => s.id).join(', ') + ', all');
    const selected = requested === 'all' ? sources : sources.filter(s => s.id === requested);
    const metadata = sources.map(({ id, label, type }) => ({ id, label, type }));
    const { source: _source, ...parameters } = args;
    const responses = await Promise.all(selected.map(async source => {
      try {
        const value = source.type === 'local' ? await handleThreadTool(source.root, name, parameters, options) : await remoteCall(source, name, parameters, options);
        const tag = row => ({ ...row, source: source.id, sourceLabel: source.label });
        if (value.thread) value.thread = tag(value.thread);
        if (value.items) value.items = value.items.map(row => row.thread ? { ...row, thread: tag(row.thread) } : tag(row));
        return { source: source.id, value };
      } catch (error) { return { source: source.id, error }; }
    }));
    if (selected.length === 1 && responses[0].error) throw responses[0].error;
    const failures = responses.filter(r => r.error);
    const successes = responses.filter(r => r.value);
    if (!successes.length) throw fault(failures.map(r => `${r.source}: ${r.error.message}`).join('; '), -32001);
    const warnings = failures.map(r => ({ source: r.source, message: r.error.message }));
    if (name === 'read_work_thread') {
      if (successes.length !== 1) throw fault('Thread exists in multiple sources. Specify source: ' + successes.map(r => r.source).join(', '));
      return { ...successes[0].value, source: successes[0].source, sources: metadata,
        ...(warnings.length ? { incomplete: failures.some(r => r.error.code !== -32004), warnings } : {}) };
    }
    let items = successes.flatMap(r => r.value.items);
    const updated = row => Date.parse((row.thread ?? row).updatedAt) || 0;
    if (name === 'search_work_threads') {
      const score = { exact: 3, phrase: 2, keywords: 1 };
      items.sort((a, b) => score[b.matchLevel] - score[a.matchLevel] || updated(b) - updated(a));
    } else items.sort((a, b) => updated(b) - updated(a));
    const needsSelection = name === 'search_work_threads' && (items.length > 1 || successes.some(r => r.value.needsSelection));
    items = items.slice(0, clamp(args.limit, 10, name === 'search_work_messages' ? 20 : 50));
    return { items, sources: metadata, source: requested,
      ...(name === 'search_work_threads' ? { needsSelection } : {}),
      ...(warnings.length ? { incomplete: true, warnings } : {}) };
  };
}
