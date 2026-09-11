import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, mkdir, copyFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export function version(value) {
  assert(typeof value === 'string' && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value), 'Use a SemVer version, e.g. v1.2.3');
  return value.replace(/^v/, '');
}
export function inside(root, value) {
  assert(typeof value === 'string' && value.length && !value.includes('\\') && !path.isAbsolute(value), `Expected a relative POSIX path: ${value}`);
  const target = path.resolve(root, value);
  assert(target.startsWith(path.resolve(root) + path.sep), `Path escapes root: ${value}`);
  return target;
}
export async function regular(root, value) {
  const target = inside(root, value);
  assert((await lstat(target)).isFile(), `Expected a regular file: ${value}`);
  assert((await realpath(target)).startsWith((await realpath(root)) + path.sep), `Symlink escapes root: ${value}`);
  return target;
}
export function validateConfig(config) {
  assert(config.schemaVersion === 1, 'Unsupported release config schema');
  assert(/^[A-Za-z0-9][A-Za-z0-9-]+$/.test(config.name), 'Invalid artifact prefix');
  assert(/^\d+\.\d+\.\d+$/.test(config.node), 'Pin the full Node version');
  assert(['yarn', 'pnpm', 'npm'].includes(config.packageManager), 'Unknown package manager');
  assert(Array.isArray(config.versionFiles) && config.versionFiles.length > 0, 'versionFiles is required');
  assert(new Set(config.versionFiles).size === config.versionFiles.length, 'Duplicate version file');
  for (const file of [...config.versionFiles, config.adapter]) inside(process.cwd(), file);
  assert(Array.isArray(config.targets) && config.targets.length > 0, 'No targets');
  assert(new Set(config.targets).size === config.targets.length, 'Duplicate targets');
  for (const t of config.targets) assert(['windows-x64', 'linux-x64', 'macos-universal'].includes(t), `Unknown target ${t}`);
  assert(config.signing === 'testing', 'This release-kit version implements testing signing only; formal signing needs a validated adapter');
  return config;
}
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function preparedFiles(root, entries, versionFiles) {
  assert(Array.isArray(entries), 'Prepared metadata must be an array');
  const seen = new Set(versionFiles.map(file => file.toLowerCase()));
  for (const { path: file, content } of entries) {
    inside(root, file);
    assert(file.split('/').every(part => part && part !== '.' && part !== '..'), 'Metadata path must be canonical');
    assert(!seen.has(file.toLowerCase()), 'Duplicate metadata or version file');
    seen.add(file.toLowerCase());
    assert(typeof content === 'string' && content.length < 1000000, 'Invalid prepared metadata');
  }
  return entries;
}
export async function digest(file) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
export async function stageFiles(root, output, files, metadata) {
  assert(files.length > 0, 'No distributable assets');
  await mkdir(output, { recursive: true });
  const names = new Set();
  const assets = [];
  for (const entry of files) {
    const source = await regular(root, entry.path);
    const name = entry.name ?? path.basename(source);
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(name), `Unsafe asset name: ${name}`);
    assert(!names.has(name.toLowerCase()), `Duplicate asset: ${name}`);
    names.add(name.toLowerCase());
    assert(name.includes(metadata.version) || (entry.kind === 'update-feed' && ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'].includes(name)), `Asset must include version: ${name}`);
    const stat = await lstat(source);
    assert(stat.size > 0, `Empty asset: ${name}`);
    const hash = await digest(source);
    await copyFile(source, path.join(output, name));
    assets.push({ name, size: stat.size, sha256: hash });
  }
  const manifest = { schemaVersion: 1, ...metadata, assets };
  await writeFile(path.join(output, `${metadata.target}.json`), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export async function collectRelease(root, expected) {
  const dirs = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory());
  const manifests = [];
  for (const dir of dirs) {
    for (const file of await readdir(path.join(root, dir.name))) {
      if (/^(windows-x64|linux-x64|macos-universal)\.json$/.test(file)) {
        const manifest = JSON.parse(await readFile(path.join(root, dir.name, file), 'utf8'));
        manifests.push({ ...manifest, dir: path.join(root, dir.name) });
      }
    }
  }
  assert.deepEqual(manifests.map(m => m.target).sort(), [...expected.targets].sort(), 'Missing or duplicate platform manifests');
  const names = new Set();
  const assets = [];
  for (const manifest of manifests) {
    for (const key of ['sourceSha', 'version', 'toolkitSha']) assert.equal(manifest[key], expected[key], `Mixed ${key}`);
    assert.equal(manifest.automatedVerification, 'passed', 'Platform verification did not pass');
    for (const a of manifest.assets) {
      assert(!names.has(a.name.toLowerCase()), `Duplicate release asset: ${a.name}`);
      names.add(a.name.toLowerCase());
      const file = await regular(manifest.dir, a.name);
      assert.equal((await lstat(file)).size, a.size, `Size mismatch: ${a.name}`);
      assert.equal(await digest(file), a.sha256, `Checksum mismatch: ${a.name}`);
      assets.push({ ...a, file });
    }
  }
  return { manifests, assets };
}
