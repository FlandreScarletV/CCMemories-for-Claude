import { spawn } from 'node:child_process';

const fault = (message, code = -32001) => Object.assign(new Error(message), { code });
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";

// Execute trusted source supplied on stdin, without installing remote files.
// The caller encodes all model parameters as JSON data inside that source.
export function runSshScript(source, script) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
  if (source.ssh_config) args.push('-F', source.ssh_config);
  args.push(source.host, quote(source.node) + ' --input-type=module');
  return new Promise((done, fail) => {
    const child = spawn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); fail(error); } else done(value);
    };
    const timer = setTimeout(() => finish(fault(`SSH source ${source.id} timed out`)), source.timeout_ms ?? 30000);
    child.on('error', error => finish(fault(`SSH source ${source.id}: ${error.message}`)));
    child.stdin.on('error', error => finish(fault(`SSH source ${source.id}: ${error.message}`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 12 * 1024 * 1024) finish(fault('Remote result exceeded 12 MiB'));
      else stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1600); });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(fault(`SSH source ${source.id} exited ${code}: ${stderr.trim()}`));
      let response;
      try { response = JSON.parse(stdout); }
      catch { return finish(fault(`SSH source ${source.id} returned invalid JSON; check Node availability and shell output`)); }
      if (!response.ok) return finish(fault(response.error?.message || 'Remote operation failed', response.error?.code || -32603));
      finish(null, response.value);
    });
    child.stdin.end(script);
  });
}
