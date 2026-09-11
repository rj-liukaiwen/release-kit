import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('promotion refuses failed or foreign runs and mixed source manifests before publication',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'release-kit-promote-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'.release-out/source-manifest'),{recursive:true});
  const run={status:'completed',conclusion:'success',event:'workflow_dispatch',path:'.github/workflows/release.yml',repository:{full_name:'test/project'},html_url:'https://github.com/test/project/actions/runs/123'};
  const check=(response,phase)=>{
    const stub='globalThis.fetch=async()=>new Response('+JSON.stringify(JSON.stringify(response))+');';
    return spawnSync(process.execPath,[
      '--import','data:text/javascript,'+encodeURIComponent(stub),
      fileURLToPath(new URL('../bin/inspect-run.mjs',import.meta.url)),...(phase?[phase]:[]),
    ],{cwd:dir,encoding:'utf8',env:{...process.env,GH_TOKEN:'test-token-no-network',GITHUB_REPOSITORY:'test/project',BUILD_RUN:'123',RELEASE_MODE:'draft',GITHUB_OUTPUT:path.join(dir,'output')}});
  };
  assert.equal(check(run).status,0);
  assert.notEqual(check({...run,conclusion:'failure'}).status,0);
  assert.notEqual(check({...run,repository:{full_name:'other/project'}}).status,0);
  assert.notEqual(check({...run,event:'pull_request'}).status,0);
  const m={run:'123',sourceSha:'a'.repeat(40),toolkitSha:'b'.repeat(40),version:'1.2.3',platforms:[{target:'windows-x64',automatedVerification:'passed',sourceSha:'c'.repeat(40),toolkitSha:'b'.repeat(40),version:'1.2.3'}]};
  await writeFile(path.join(dir,'.release-out/source-manifest/BUILD-MANIFEST.json'),JSON.stringify(m));
  assert.notEqual(check(run,'manifest').status,0);
  m.platforms[0].sourceSha=m.sourceSha;
  await writeFile(path.join(dir,'.release-out/source-manifest/BUILD-MANIFEST.json'),JSON.stringify(m));
  assert.equal(check(run,'manifest').status,0);
});
