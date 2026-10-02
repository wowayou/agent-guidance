import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasDocStatus, parseStatus } from './doc-review.mjs';

const script = fileURLToPath(new URL('./doc-review.mjs', import.meta.url));
function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function write(dir, name, text = 'changed\n') {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
}
function repo(t, commit = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-review-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  write(dir, 'src/main.js', 'original\n');
  write(dir, 'README.md', 'original docs\n');
  if (commit) { git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'initial'); }
  return dir;
}
function event(dir, kind, extra = {}, host = 'codex') {
  const input = { cwd: dir, session_id: 'session-a', hook_event_name: kind, ...extra };
  const r = spawnSync(process.execPath, [script, host], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const start = (dir, extra, host) => event(dir, 'UserPromptSubmit', { prompt: 'Do the authorized task', ...extra }, host);
const stop = (dir, extra, host) => event(dir, 'Stop', { stop_hook_active: false, last_assistant_message: 'Done.', ...extra }, host);
const continued = (output) => output.decision === 'block' || Boolean(output.hookSpecificOutput?.additionalContext);

test('status parser: rename, spaces, and non-ASCII paths', () => {
  const data = Buffer.from('R  src/new name.js\0src/old name.js\0?? src/\u4e2d\u6587.js\0');
  assert.deepEqual(parseStatus(data), ['src/new name.js', 'src/old name.js', 'src/\u4e2d\u6587.js'].sort());
});
test('report recognition requires a reason', () => {
  assert.ok(hasDocStatus('Docs: not needed (internal change only)'));
  assert.ok(hasDocStatus('\u6587\u6863\uff1a\u5df2\u66f4\u65b0\uff08README\uff09'));
  assert.equal(hasDocStatus('Docs: not needed'), false);
});
test('clean read-only turn is silent', (t) => {
  const dir = repo(t); assert.deepEqual(start(dir), {}); assert.deepEqual(stop(dir), {});
});
test('unchanged pre-existing dirty work is not attributed to this turn', (t) => {
  const dir = repo(t); write(dir, 'src/main.js'); start(dir); assert.deepEqual(stop(dir), {});
});
test('editing an already dirty file is detected', (t) => {
  const dir = repo(t); write(dir, 'src/main.js', 'old dirty'); start(dir); write(dir, 'src/main.js', 'new dirty'); assert.ok(continued(stop(dir)));
});
test('single-file modification requests a review', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js'); assert.ok(continued(stop(dir)));
});
test('editing Markdown alone does not trigger', (t) => {
  const dir = repo(t); start(dir); write(dir, 'README.md'); assert.deepEqual(stop(dir), {});
});
test('changed documentation does not itself prove review completion', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js'); write(dir, 'README.md'); assert.ok(continued(stop(dir)));
});
test('reported not-needed with a reason avoids another model turn', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js'); assert.deepEqual(stop(dir, { last_assistant_message: 'Docs: not needed (internal-only implementation)' }), {});
});
test('reported pending does not claim documentation was verified', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js'); assert.deepEqual(stop(dir, { last_assistant_message: 'Partial completion. Docs: pending (requires product decision)' }), {});
});
test('only one reminder per baseline even without host loop protection', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js'); assert.ok(continued(stop(dir))); assert.deepEqual(stop(dir), {});
});
test('stop_hook_active always avoids continuation', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js'); assert.deepEqual(stop(dir, { stop_hook_active: true }), {});
});
test('a real new user turn resets the reminder budget', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js', 'first'); assert.ok(continued(stop(dir)));
  start(dir); write(dir, 'src/main.js', 'second'); assert.ok(continued(stop(dir)));
});
test('Codex synthetic continuation does not reset baseline or budget', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js'); const out = stop(dir);
  assert.ok(continued(out)); start(dir, { prompt: out.reason }); assert.deepEqual(stop(dir), {});
});
test('already committed changes are still detected', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'change'); assert.ok(continued(stop(dir)));
});
test('committing pre-existing dirty content without changing it is silent', (t) => {
  const dir = repo(t); write(dir, 'src/main.js'); start(dir); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'existing'); assert.deepEqual(stop(dir), {});
});
test('new untracked source is detected', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/new.js'); assert.ok(continued(stop(dir)));
});
test('same-length edits to an untracked file are detected', (t) => {
  const dir = repo(t); write(dir, 'new.js', 'aaaa'); start(dir); write(dir, 'new.js', 'bbbb'); assert.ok(continued(stop(dir)));
});
test('deletions are detected', (t) => {
  const dir = repo(t); start(dir); fs.unlinkSync(path.join(dir, 'src/main.js')); assert.ok(continued(stop(dir)));
});
test('renames are detected', (t) => {
  const dir = repo(t); start(dir); git(dir, 'mv', 'src/main.js', 'src/new name.js'); assert.ok(continued(stop(dir)));
});
test('non-ASCII filenames are handled', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/\u6587\u4ef6.js'); assert.ok(continued(stop(dir)));
});
test('staging unchanged content does not create a false review', (t) => {
  const dir = repo(t); write(dir, 'src/main.js'); start(dir); git(dir, 'add', 'src/main.js'); assert.deepEqual(stop(dir), {});
});
test('working from a subdirectory still uses repository-root paths', (t) => {
  const dir = repo(t); const sub = path.join(dir, 'src'); start(sub); write(dir, 'src/main.js'); assert.ok(continued(stop(sub)));
});
test('initial commit after an unborn baseline is handled', (t) => {
  const dir = repo(t, false); start(dir); write(dir, 'src/main.js'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first'); assert.ok(continued(stop(dir)));
});
test('net-zero edits are silent', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js', 'intermediate'); write(dir, 'src/main.js', 'original\n'); assert.deepEqual(stop(dir), {});
});
test('separate sessions do not overwrite each other', (t) => {
  const dir = repo(t); start(dir); write(dir, 'src/main.js', 'one'); start(dir, { session_id: 'session-b' });
  assert.ok(continued(stop(dir))); assert.deepEqual(stop(dir, { session_id: 'session-b' }), {});
});
test('Claude uses non-error additionalContext; Codex uses block/reason', (t) => {
  const dir = repo(t); start(dir, {}, 'claude'); write(dir, 'src/main.js'); const out = stop(dir, {}, 'claude');
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop'); assert.ok(out.hookSpecificOutput.additionalContext); assert.equal(out.decision, undefined);
});
test('a missing baseline fails visibly without blocking', (t) => {
  const dir = repo(t); write(dir, 'src/main.js'); const out = stop(dir); assert.ok(out.systemMessage); assert.equal(continued(out), false);
});
test('invalid JSON fails visibly without claiming success', () => {
  const r = spawnSync(process.execPath, [script, 'codex'], { input: '{broken', encoding: 'utf8' });
  assert.equal(r.status, 0); assert.ok(JSON.parse(r.stdout).systemMessage);
});
test('oversize files fail visibly without reading unlimited content', (t) => {
  const dir = repo(t); start(dir); fs.writeFileSync(path.join(dir, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1)); const out = stop(dir); assert.ok(out.systemMessage); assert.equal(continued(out), false);
});
test('non-Git directory is silent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(start(dir), {}); assert.deepEqual(stop(dir), {});
});
test('worktree uses its own Git metadata directory', (t) => {
  const dir = repo(t); const sibling = dir + '-worktree';
  git(dir, 'worktree', 'add', '-qb', 'test-worktree', sibling);
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  start(sibling); write(sibling, 'src/main.js'); assert.ok(continued(stop(sibling)));
});
test('state does not store source contents', (t) => {
  const dir = repo(t); write(dir, 'src/main.js', 'SENTINEL_DO_NOT_STORE'); start(dir);
  const stateDir = path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'agent-doc-review');
  for (const name of fs.readdirSync(stateDir)) assert.equal(fs.readFileSync(path.join(stateDir, name), 'utf8').includes('SENTINEL_DO_NOT_STORE'), false);
});

for (const host of ['claude', 'codex']) {
  test(`${host} configuration command works from a subdirectory in a spaced path`, (t) => {
    const outer = repo(t);
    const dir = path.join(outer, 'repo with spaces');
    fs.mkdirSync(dir); git(dir, 'init', '-q');
    write(dir, 'src/main.js', 'original\n');
    fs.mkdirSync(path.join(dir, '.agent-hooks'));
    fs.copyFileSync(script, path.join(dir, '.agent-hooks/doc-review.mjs'));
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'initial');
    const name = host === 'claude' ? 'claude.settings.fragment.json' : 'codex.hooks.fragment.json';
    const config = JSON.parse(fs.readFileSync(new URL(`./config/${name}`, import.meta.url), 'utf8'));
    const run = (ev) => {
      const command = config.hooks[ev][0].hooks[0].command;
      const r = spawnSync('bash', ['-c', command], {
        cwd: path.join(dir, 'src'),
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        input: JSON.stringify({ cwd: path.join(dir, 'src'), session_id: 'configuration-test', hook_event_name: ev, last_assistant_message: 'Done.' }),
        encoding: 'utf8', timeout: 10000,
      });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    assert.deepEqual(run('UserPromptSubmit'), {});
    write(dir, 'src/main.js');
    assert.ok(continued(run('Stop')));
  });
}
