import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateConfig, version, regular, stageFiles, collectRelease, digest, preparedFiles } from '../lib/core.mjs';
import { api, absent, orphanedTag } from '../lib/github.mjs';

const root = process.cwd();
const phase = process.argv[2];
const configFile = process.env.RELEASE_CONFIG || '.release/config.json';
const config = validateConfig(JSON.parse(await readFile(await regular(root, configFile), 'utf8')));
const adapter = await import(pathToFileURL(await regular(root, config.adapter)));
const requested = version(process.env.RELEASE_VERSION);
const mode = process.env.RELEASE_MODE || 'artifacts';
assert(['check', 'artifacts', 'draft', 'prerelease'].includes(mode), 'Unknown release mode');
const out = path.join(root, '.release-out');
await mkdir(out, { recursive: true });
const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
const sourceSha = git(['rev-parse', 'HEAD']);
const toolkitSha = process.env.RELEASE_KIT_SHA;
assert(/^[a-f0-9]{40}$/.test(toolkitSha), 'Pin release-kit to a full commit SHA');
const target = process.env.RELEASE_TARGET;
const context = { root, out, config, version: requested, mode, target, sourceSha, toolkitSha };
const output = async (key, value) => { if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`); };
const report = async text => { console.log(text); if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text + '\n'); };
const repository = process.env.GITHUB_REPOSITORY;
const base = `/repos/${repository}`;

try {
  if (phase === 'prepare') {
    assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid repository');
    let preflight;
    try { preflight = await adapter.preflight(context); }
    catch (error) { preflight = { blockers: [error.message], notes: [] }; }
    const result = { ...preflight, sourceSha, version: requested, toolkitSha, mode, targets: config.targets };
    await writeFile(path.join(out, 'preflight.json'), JSON.stringify(result, null, 2) + '\n');
    await report(`## ${config.name} v${requested}\n\nSource: \`${sourceSha}\`\n\n${(preflight.notes || []).map(s => `- ${s}`).join('\n')}\n\n${(preflight.blockers || []).map(s => `- BLOCKED: ${s}`).join('\n')}`);
    assert(!preflight.blockers?.length, 'Preflight blocked; see the summary for required inputs.');
    if (mode === 'prerelease') assert(config.allowPrerelease === true, 'Project requires final acceptance before public prerelease. Build artifacts/draft first.');
    await absent(`${base}/releases/tags/v${requested}`);
    if (mode === 'check') { await output('build', 'false'); process.exit(0); }
    const treeEntries = [];
    for (const file of config.versionFiles) {
      const original = await readFile(await regular(root, file), 'utf8');
      const json = JSON.parse(original);
      assert(typeof json.version === 'string', `No version field in ${file}`);
      json.version = requested;
      const content = JSON.stringify(json, null, 2) + '\n';
      if (content === original) continue;
      const blob = await api(`${base}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf-8' } });
      treeEntries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
    }
    if (adapter.prepareFiles) {
      for (const { path: file, content } of preparedFiles(root, await adapter.prepareFiles(context), config.versionFiles)) {
        const blob = await api(`${base}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf-8' } });
        treeEntries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    let sha = sourceSha;
    if (treeEntries.length) {
      const parent = await api(`${base}/git/commits/${sourceSha}`);
      const tree = await api(`${base}/git/trees`, { method: 'POST', body: { base_tree: parent.tree.sha, tree: treeEntries } });
      const commit = await api(`${base}/git/commits`, { method: 'POST', body: { message: `chore(release): prepare v${requested}`, tree: tree.sha, parents: [sourceSha] } });
      sha = commit.sha;
      await api(`${base}/git/refs`, { method: 'POST', body: { ref: `refs/heads/release-candidates/v${requested}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`, sha } });
    }
    const reusedOrphanedTag = await orphanedTag(`${base}/git/ref/tags/v${requested}`, sha);
    if (reusedOrphanedTag) await report(Reusing the matching orphaned tag v${requested}; no Release or uploaded assets exist.);
    const runners = { 'windows-x64': 'windows-2025', 'linux-x64': 'ubuntu-24.04', 'macos-universal': 'macos-15' };
    await output('sha', sha); await output('version', requested); await output('node', config.node);
    await output('matrix', { include: config.targets.map(target => ({ target, os: runners[target] })) });
    await output('build', 'true');
    await report(`All platforms will build commit \`${sha}\`. Signing: Windows unsigned; macOS ad-hoc, not notarized. Human acceptance is recorded separately.`);
  } else if (phase === 'install' || phase === 'build' || phase === 'verify' || phase === 'verify-intel') {
    assert(config.targets.includes(target), 'Target not configured');
    const method = phase === 'verify-intel' ? 'verifyIntel' : phase;
    assert(typeof adapter[method] === 'function', `Adapter is missing ${method}`);
    await adapter[method](context);
    if (phase === 'build') {
      // Preserve original candidate bytes before post-install acceptance runs.
      await stageFiles(root, path.join(out, 'candidate'), await adapter.assets(context), { sourceSha, version: requested, toolkitSha, target, automatedVerification: 'pending' });
    }
    if (phase === 'verify') {
      await stageFiles(root, path.join(out, 'assets'), await adapter.assets(context), {
        sourceSha, version: requested, toolkitSha, target, automatedVerification: 'passed',
        signing: target === 'macos-universal' ? 'ad-hoc signed, not notarized' : 'unsigned',
        humanAcceptance: 'not performed by release-kit',
      });
    }
    if (phase === 'verify-intel') await writeFile(path.join(out, 'intel-verification.json'), JSON.stringify({ sourceSha, version: requested, toolkitSha, status: 'passed', architecture: process.arch }, null, 2));
  } else if (phase === 'publish') {
    const result = await collectRelease(path.join(out, 'downloaded'), { sourceSha, version: requested, toolkitSha, targets: config.targets });
    if (config.targets.includes('macos-universal')) {
      const intel = JSON.parse(await readFile(path.join(out, 'intel', 'intel-verification.json'), 'utf8'));
      assert(intel.status === 'passed' && intel.architecture === 'x64' && intel.sourceSha === sourceSha && intel.version === requested && intel.toolkitSha === toolkitSha, 'Intel verification missing/mismatched');
    }
    const releaseDir = path.join(out, 'release'); await mkdir(releaseDir, { recursive: true });
    const sums = result.assets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n';
    await writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), sums);
    await writeFile(path.join(releaseDir, 'BUILD-MANIFEST.json'), JSON.stringify({ sourceSha, version: requested, toolkitSha, run: process.env.GITHUB_RUN_ID, platforms: result.manifests.map(({dir,...m}) => m) }, null, 2) + '\n');
    if (mode === 'artifacts') { await report('All configured platforms verified. Artifacts are ready; no GitHub Release requested.'); process.exit(0); }
    assert(mode === 'draft' || config.allowPrerelease === true, 'Public prerelease is disabled for this project');
    await absent(`${base}/releases/tags/v${requested}`);
    const reusedOrphanedTag = await orphanedTag(`${base}/git/ref/tags/v${requested}`, sourceSha);
    if (reusedOrphanedTag) await report(`Reusing the matching orphaned tag v${requested}; no Release or uploaded assets exist.`);
    const body = `Testing candidate v${requested}\n\nSource: ${sourceSha}\nToolchain: rj-liukaiwen/release-kit@${toolkitSha}\nRun: https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}\n\nWindows: unsigned. macOS: ad-hoc signed, not notarized.\nAutomated checks: passed on the configured platforms, including native Intel verification of the same macOS Universal package.\nHuman login, TCC, and upgrade acceptance: not performed by release-kit. See the project delivery guides before promoting this candidate.\n\n${(config.releaseNotes || []).join('\n')}`;
    // Assemble invisibly, verify every upload, then expose only when explicitly allowed.
    const release = await api(`${base}/releases`, { method: 'POST', body: { tag_name: `v${requested}`, target_commitish: sourceSha, name: `${config.name} v${requested} (testing candidate)`, body, draft: true, prerelease: true } });
    const files = [...result.assets, ...await Promise.all((await readdir(releaseDir)).map(async name => ({ name, file: path.join(releaseDir, name), sha256: await digest(path.join(releaseDir, name)) })))];
    for (const asset of files) {
      const { createReadStream, statSync } = await import('node:fs');
      const url = new URL(release.upload_url.replace(/\{.*$/, '')); assert.equal(url.hostname, 'uploads.github.com'); url.searchParams.set('name', asset.name);
      const upload = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(statSync(asset.file).size) }, body: createReadStream(asset.file), duplex: 'half' });
      if (!upload.ok) throw new Error(`Upload failed ${asset.name}: HTTP ${upload.status}; incomplete draft retained for inspection`);
      const uploaded = await upload.json(); assert.equal(uploaded.size, statSync(asset.file).size, 'Uploaded size differs');
      assert.equal(uploaded.digest, `sha256:${asset.sha256}`, `Uploaded digest differs: ${asset.name}`);
    }
    if (mode === 'prerelease') await api(`${base}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, prerelease: true, make_latest: 'false' } });
    await report(`Release ${mode}: ${release.html_url}`);
  } else throw new Error(`Unknown phase ${phase}`);
} catch (error) {
  await report(`**Release stopped:** ${error.message}`);
  throw error;
}
