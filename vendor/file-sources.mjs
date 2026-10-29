import { readFileSync } from 'node:fs';
import { configuration, fileTools, handleFileTool } from './local-files.mjs';
import { configuredSources } from './thread-sources.mjs';
import { runSshScript } from './ssh-source.mjs';

const fail = message => Object.assign(new Error(message), { code: -32602 });
const protectedNames = ['.codex', '.cache', '.config', '.local', '.npmrc', '.pypirc', '.netrc',
  '.huggingface', '__pycache__', 'id_rsa', 'id_ed25519', 'authorized_keys', 'token', 'token.json', 'tokens.json'];
const sourceProperty = { type: 'string', description: 'One configured source id; omit for local. Discover remote ids from list_work_threads, then list_local_files without path to see that source\'s allowed roots. Preserve source, path and cursor for continuation.' };

export const sourceFileTools = fileTools.map(tool => ({ ...tool,
  description: tool.description + ' Supports configured SSH sources via source; operations remain read only.',
  inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
    source: sourceProperty,
    path: { ...tool.inputSchema.properties.path, description: 'Absolute path on the selected source inside its configured allowed roots.' }
  } }
}));

function tagResponse(value, source, sources) {
  const data = { ...value.structuredContent, source: source.id, sourceLabel: source.label, sources };
  return { ...value, structuredContent: data,
    content: value.content.map((item, index) => index === 0 && item.type === 'text' ? { ...item, text: JSON.stringify(data) } : item) };
}

export function createFileRouter(localRoot, options = {}) {
  return async (name, args) => {
    if (!fileTools.some(tool => tool.name === name)) throw fail('Unknown file tool');
    const sources = configuredSources(localRoot);
    const source = sources.find(item => item.id === (args.source ?? 'local'));
    if (!source) throw fail('Choose one configured source for file operations: ' + sources.map(s => s.id).join(', '));
    const metadata = sources.map(({ id, label, type, file_roots }) => ({ id, label, type, filesEnabled: id === 'local' || !!file_roots?.length }));
    const { source: _source, ...parameters } = args;
    let value;
    if (source.id === 'local') {
      const cfg = options.immutableSqlite ? { ...await configuration(), immutableSqlite: true } : undefined;
      value = await handleFileTool(name, parameters, cfg);
    }
    else {
      if (!source.file_roots?.length) throw fail('File access is disabled for this source. Configure file_roots first.');
      const cfg = { allowedRoots: source.file_roots, pythonExecutable: source.python ?? (source.type === 'ssh' ? 'python3' : 'python'), protectedNames, immutableSqlite: true };
      if (source.type === 'local') value = await handleFileTool(name, parameters, cfg);
      else {
        cfg.parserSource = readFileSync(new URL('./file-parser.py', import.meta.url), 'utf8');
        const code = readFileSync(new URL('./local-files.mjs', import.meta.url), 'utf8');
        const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
        const request = JSON.stringify({ name, args: parameters, cfg });
        const script = `try {\nconst {handleFileTool} = await import(${JSON.stringify(moduleUrl)});\n` +
          `const req = ${request};\nconst value = await handleFileTool(req.name, req.args, req.cfg);\n` +
          `process.stdout.write(JSON.stringify({ok:true,value}));\n` +
          `} catch(error) {process.stdout.write(JSON.stringify({ok:false,error:{code:error.code||-32603,message:error.message}}));}\n`;
        value = await runSshScript(source, script);
      }
    }
    return tagResponse(value, source, metadata);
  };
}
