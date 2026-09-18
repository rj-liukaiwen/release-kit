import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orphanedTag } from '../lib/github.mjs';

const source = 'a'.repeat(40);
const route = '/repos/test/project/git/ref/tags/v1.2.3';

async function withFetch(t, response, action) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => response;
  await action();
}

test('reuses only an orphaned direct tag that matches the candidate source', async t => {
  await withFetch(t, new Response(JSON.stringify({ object: { type: 'commit', sha: source } }), { status: 200 }), async () => {
    assert.equal(await orphanedTag(route, source), true);
  });
});

test('does not require a tag before first publication', async t => {
  await withFetch(t, new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }), async () => {
    assert.equal(await orphanedTag(route, source), false);
  });
});

test('refuses a tag that points at another source', async t => {
  await withFetch(t, new Response(JSON.stringify({ object: { type: 'commit', sha: 'b'.repeat(40) } }), { status: 200 }), async () => {
    await assert.rejects(orphanedTag(route, source), /does not match this source commit/);
  });
});
