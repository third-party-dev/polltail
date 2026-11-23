import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Poller, dropPartialStart, readWindow, sigChanged } from '../core';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'polltail-'));
}

function newPoller(): { poller: Poller; changes: string[] } {
  const changes: string[] = [];
  const poller = new Poller(() => 100, (p) => changes.push(p));
  return { poller, changes };
}

test('sigChanged detects size, mtime, inode and appearance', () => {
  const a = { mtimeMs: 1, size: 1, ino: 1 };
  assert.equal(sigChanged(a, { ...a }), false);
  assert.equal(sigChanged(a, { ...a, size: 2 }), true);
  assert.equal(sigChanged(a, { ...a, mtimeMs: 2 }), true);
  assert.equal(sigChanged(a, { ...a, ino: 2 }), true);
  assert.equal(sigChanged(undefined, a), true);
  assert.equal(sigChanged(undefined, undefined), false);
});

test('readWindow returns whole file when under the limit', async () => {
  const d = tmp();
  const f = join(d, 'a.log');
  writeFileSync(f, 'one\ntwo\nthree\n');
  const r = await readWindow(f, 1000);
  assert.equal(r.truncated, false);
  assert.equal(r.data.toString(), 'one\ntwo\nthree\n');
  const r0 = await readWindow(f, 0);
  assert.equal(r0.truncated, false);
  rmSync(d, { recursive: true });
});

test('readWindow returns only the tail, starting at a line boundary, when over the limit', async () => {
  const d = tmp();
  const f = join(d, 'a.log');
  writeFileSync(f, 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n'); // 33 bytes
  const r = await readWindow(f, 15); // window starts mid-line of "bbbb..." or earlier
  assert.equal(r.truncated, true);
  assert.equal(r.totalSize, 33);
  assert.equal(r.data.toString(), 'cccccccccc\n');
  rmSync(d, { recursive: true });
});

test('dropPartialStart skips split UTF-8 continuation bytes when there is no newline', () => {
  const euro = Buffer.from('€€€', 'utf8'); // e2 82 ac e2 82 ac e2 82 ac
  const cut = euro.subarray(1); // starts with continuation bytes 82 ac
  assert.equal(dropPartialStart(cut).toString(), '€€');
});

test('Poller detects appended content', async () => {
  const d = tmp();
  const f = join(d, 'a.log');
  writeFileSync(f, 'x\n');
  const { poller, changes } = newPoller();
  poller.add(f);
  await poller.tickOnce();
  assert.deepEqual(changes, [], 'no change yet');
  appendFileSync(f, 'y\n');
  await poller.tickOnce();
  assert.deepEqual(changes, [f]);
  await poller.tickOnce();
  assert.deepEqual(changes, [f], 'no duplicate event when nothing changed');
  rmSync(d, { recursive: true });
});

test('Poller detects rotation (rename and recreate with identical size)', async () => {
  const d = tmp();
  const f = join(d, 'a.log');
  writeFileSync(f, 'same\n');
  const { poller, changes } = newPoller();
  poller.add(f);
  renameSync(f, join(d, 'a.log.1'));
  writeFileSync(f, 'same\n'); // new inode, same size and (likely) same mtime
  await poller.tickOnce();
  assert.deepEqual(changes, [f]);
  rmSync(d, { recursive: true });
});

test('Poller tolerates a missing file and reports it when it reappears', async () => {
  const d = tmp();
  const f = join(d, 'a.log');
  writeFileSync(f, 'x\n');
  const { poller, changes } = newPoller();
  poller.add(f);
  rmSync(f);
  await poller.tickOnce();
  assert.deepEqual(changes, [], 'missing file is not reported as a change');
  writeFileSync(f, 'new content\n');
  await poller.tickOnce();
  assert.deepEqual(changes, [f]);
  rmSync(d, { recursive: true });
});

test('Poller picks up a file that did not exist when it was added', async () => {
  const d = tmp();
  const f = join(d, 'later.log');
  const { poller, changes } = newPoller();
  poller.add(f);
  writeFileSync(f, 'hello\n');
  await poller.tickOnce();
  assert.deepEqual(changes, [f]);
  rmSync(d, { recursive: true });
});

test('markSeen suppresses the echo of our own write', async () => {
  const d = tmp();
  const f = join(d, 'a.log');
  writeFileSync(f, 'x\n');
  const { poller, changes } = newPoller();
  poller.add(f);
  appendFileSync(f, 'own write\n');
  poller.markSeen(f);
  await poller.tickOnce();
  assert.deepEqual(changes, []);
  rmSync(d, { recursive: true });
});

test('start/stop run the timer loop and remove() stops reporting a file', async () => {
  const d = tmp();
  const f = join(d, 'a.log');
  writeFileSync(f, 'x\n');
  const { poller, changes } = newPoller();
  poller.add(f);
  poller.start();
  appendFileSync(f, 'y\n');
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(changes.length >= 1, 'timer loop reported the change');
  const n = changes.length;
  poller.remove(f);
  appendFileSync(f, 'z\n');
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(changes.length, n, 'removed file no longer reported');
  poller.stop();
  rmSync(d, { recursive: true });
});
