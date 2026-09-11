import assert from 'node:assert/strict';
import {readFile,appendFile} from 'node:fs/promises';
import {api} from '../lib/github.mjs';
import {version} from '../lib/core.mjs';
const runId=process.env.BUILD_RUN;
assert(/^[1-9]\d*$/.test(runId),'Use a numeric build run ID');
assert(['draft','prerelease'].includes(process.env.RELEASE_MODE),'Select draft or prerelease');
const run=await api(`/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`);
assert.equal(run.status,'completed','Build has not completed');
assert.equal(run.conclusion,'success','Only a successful complete build can be promoted');
assert.equal(run.event,'workflow_dispatch');
assert.equal(run.path,'.github/workflows/release.yml','Expected the project release workflow');
assert.equal(run.repository.full_name,process.env.GITHUB_REPOSITORY);
if(process.argv[2]==='manifest') {
  const m=JSON.parse(await readFile('.release-out/source-manifest/BUILD-MANIFEST.json','utf8'));
  assert.equal(String(m.run),runId,'Manifest belongs to another run');
  const v=version(m.version);
  for(const value of [m.sourceSha,m.toolkitSha])assert(/^[a-f0-9]{40}$/.test(value),'Invalid pinned commit');
  assert(Array.isArray(m.platforms)&&m.platforms.length>0,'Missing platform reports');
  const targets=m.platforms.map(p=>p.target);
  assert.equal(new Set(targets).size,targets.length,'Duplicate platforms');
  for(const p of m.platforms){assert(['windows-x64','linux-x64','macos-universal'].includes(p.target));assert.equal(p.automatedVerification,'passed');assert.equal(p.sourceSha,m.sourceSha);assert.equal(p.version,v);assert.equal(p.toolkitSha,m.toolkitSha);}
  for(const [key,value] of Object.entries({sha:m.sourceSha,version:v,toolkit:m.toolkitSha,mac:targets.includes('macos-universal')?'true':'false'}))await appendFile(process.env.GITHUB_OUTPUT,`${key}=${value}\n`);
}
console.log(`Verified successful source build: ${run.html_url}`);
