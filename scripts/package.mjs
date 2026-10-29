import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packExtension } from '@anthropic-ai/mcpb/cli';
import { unzipSync, zipSync } from 'fflate';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(project, 'build');
const output = join(project, 'release');
const metadata = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(project, 'manifest.json'), 'utf8'));
if (manifest.name !== metadata.name || manifest.version !== metadata.version)
  throw new Error('package.json and manifest.json must have matching names and versions.');
if (!/^[a-z0-9][a-z0-9-]*$/.test(metadata.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version))
  throw new Error('The release name or version is invalid.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${metadata.version}`)
  throw new Error('The release tag must match the package version.');

mkdirSync(build, { recursive: true });
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(build, 'package-'));
const temp = join(build, 'tmp');
const cache = resolve(process.env.XDG_CACHE_HOME || join(build, 'cache'));
mkdirSync(temp, { recursive: true });
mkdirSync(cache, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('Run this build through npm run release.');

const hash = data => createHash('sha256').update(data).digest('hex');
const slash = path => path.replaceAll('\\', '/');
function filesIn(directory) {
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to package a symbolic link: ${name}`);
    if (stat.isDirectory()) result.push(...filesIn(file));
    else if (stat.isFile()) result.push(file);
  }
  return result;
}
function safeArchiveNames(names) {
  for (const name of names) {
    if (name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..'))
      throw new Error(`Unsafe archive entry: ${name}`);
  }
}
function removeStaging() {
  const actual = realpathSync(staging);
  const inside = relative(realpathSync(build), actual);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !basename(actual).startsWith('package-'))
    throw new Error('Refusing to remove a directory outside the build staging area.');
  rmSync(actual, { recursive: true, force: true });
}

const runtime = ['manifest.json', 'package.json', 'package-lock.json', '.mcpbignore', 'thread-sources.example.json', 'server', 'vendor'];
const documents = readdirSync(project).filter(name => /^(README|LICENSE|COPYING|CHANGELOG)(?:\..+)?$/i.test(name));
for (const name of [...runtime, ...documents]) cpSync(join(project, name), join(staging, name), { recursive: true });
const installation = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts',
  '--no-audit', '--no-fund', '--bin-links=false'], {
  cwd: staging,
  env: { ...process.env, TEMP: temp, TMP: temp, XDG_CACHE_HOME: cache,
    npm_config_cache: process.env.npm_config_cache || join(cache, 'npm') },
  encoding: 'utf8', windowsHide: true,
});
if (installation.error || installation.status !== 0)
  throw new Error(installation.error?.message || installation.stderr || 'Production dependency installation failed.');

const stem = `${metadata.name}-${metadata.version}`;
const temporaryBundle = join(build, `${basename(staging)}.mcpb`);
await packExtension({ extensionPath: staging, outputPath: temporaryBundle, silent: true });
if (!existsSync(temporaryBundle)) throw new Error('MCPB packaging did not produce an artifact.');
const bundleBytes = readFileSync(temporaryBundle);
const bundleEntries = unzipSync(bundleBytes);
safeArchiveNames(Object.keys(bundleEntries));
const executables = filesIn(join(staging, 'node_modules')).filter(file =>
  /\.(?:mjs|cjs|js|json|node|wasm)$/.test(file) && basename(file) !== '.package-lock.json');
const ownRuntime = ['server', 'vendor'].flatMap(folder => filesIn(join(staging, folder)));
for (const file of [...ownRuntime, ...executables]) {
  const name = slash(relative(staging, file));
  if (!bundleEntries[name] || hash(bundleEntries[name]) !== hash(readFileSync(file)))
    throw new Error(`The bundle omitted or changed a runtime file: ${name}`);
}

const sourceNames = ['package.json', 'package-lock.json', 'manifest.json', '.gitignore', '.gitattributes', '.mcpbignore', 'thread-sources.example.json', ...documents];
for (const folder of ['server', 'vendor', 'scripts', '.github', 'docs']) {
  if (existsSync(join(project, folder)))
    sourceNames.push(...filesIn(join(project, folder)).map(file => slash(relative(project, file))));
}
const sourceEntries = {};
for (const name of [...new Set(sourceNames)].sort())
  sourceEntries[`${metadata.name}/${name}`] = readFileSync(join(project, name));
safeArchiveNames(Object.keys(sourceEntries));
const sourceBytes = zipSync(sourceEntries, { level: 9 });
const bundleName = `${stem}.mcpb`;
const sourceName = `${stem}-source.zip`;
writeFileSync(join(output, bundleName), bundleBytes);
writeFileSync(join(output, sourceName), sourceBytes);
writeFileSync(join(output, 'SHA256SUMS'),
  `${hash(bundleBytes)}  ${bundleName}\n${hash(sourceBytes)}  ${sourceName}\n`);
writeFileSync(join(build, 'release-audit.json'), JSON.stringify({ version: metadata.version,
  bundleEntries: Object.keys(bundleEntries).length, runtimeFilesChecked: executables.length + ownRuntime.length,
  sourceEntries: Object.keys(sourceEntries).length, productionDependenciesOnly: true,
  parserSha256: hash(readFileSync(join(project, 'vendor/thread-store.mjs'))),
  artifacts: [bundleName, sourceName, 'SHA256SUMS'] }, null, 2) + '\n');
removeStaging();
unlinkSync(temporaryBundle);
console.log(JSON.stringify({ version: metadata.version, output, artifacts: [bundleName, sourceName, 'SHA256SUMS'] }));
