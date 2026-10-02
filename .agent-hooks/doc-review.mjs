#!/usr/bin/env node
/**
 * Documentation-review reminder, not a security or semantic quality gate.
 * Node.js >= 20; git on PATH. No dependencies, network, commits, or doc writes.
 * Events: UserPromptSubmit (baseline), Stop (at most one continuation).
 * Local state: <worktree-git-dir>/agent-doc-review/<host>-<session-hash>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PREFIX = '[doc-review:v1]';
const MISSING = 'missing';
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_PATHS = 300;
const MAX_INPUT = 1024 * 1024;
const DOC_PATH = /(?:^|\/)(?:docs?|documentation|notes)(?:\/|$)|\.(?:md|mdx|rst|adoc)$/i;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code) => { throw new Error(code); };
const splitZero = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);

export function hasDocStatus(message) {
  if (typeof message !== 'string') return false;
  // A declaration is evidence of reporting, NOT proof of correct documentation.
  return /\u6587\u6863\s*[:\uff1a]\s*(?:\u5df2\u66f4\u65b0|\u65e0\u9700\u66f4\u65b0|\u5f85\u66f4\u65b0)\s*[\uff08(][^\n\uff09)]{2,300}[\uff09)]/u.test(message)
    || /Docs:\s*(?:updated|not needed|pending)\s*\([^\n)]{2,300}\)/i.test(message);
}

export function parseStatus(buffer) {
  const fields = splitZero(buffer);
  const names = new Set();
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record.length < 4 || record[2] !== ' ') fail('invalid-git-status');
    const status = record.slice(0, 2);
    if (status.includes('U') || status === 'AA' || status === 'DD') fail('unmerged-files');
    names.add(record.slice(3));
    if (/[RC]/.test(status)) {
      if (!fields[i + 1]) fail('invalid-rename-record');
      names.add(fields[++i]);
    }
  }
  return [...names].sort();
}

function context(cwd) {
  const deadline = Date.now() + 6000;
  let bytesRead = 0;
  const check = () => { if (Date.now() > deadline) fail('time-budget'); };
  const git = (args, allowFailure = false) => {
    check();
    const result = spawnSync('git', args, {
      cwd, shell: false, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
      maxBuffer: MAX_TOTAL,
      timeout: Math.max(1, Math.min(2000, deadline - Date.now())),
    });
    if (result.error) fail(result.error.code === 'ETIMEDOUT' ? 'git-timeout' : 'git-unavailable');
    if (result.status !== 0 && !allowFailure) fail('git-check-failed');
    return { ok: result.status === 0, out: result.stdout ?? Buffer.alloc(0) };
  };
  const rootResult = git(['rev-parse', '--show-toplevel'], true);
  if (!rootResult.ok) return null;
  const root = fs.realpathSync(rootResult.out.toString('utf8').trim());
  cwd = root; // All path comparisons are repository-root relative.
  const gitDir = git(['rev-parse', '--absolute-git-dir']).out.toString('utf8').trim();
  const digest = (buffer, mode) => {
    check();
    bytesRead += buffer.length;
    if (buffer.length > MAX_FILE || bytesRead > MAX_TOTAL) fail('size-budget');
    return mode + ':' + sha(buffer);
  };
  const workingFile = (name) => {
    check();
    const full = path.resolve(root, name);
    if (!full.startsWith(root + path.sep)) fail('unsafe-path');
    let stat;
    try { stat = fs.lstatSync(full); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return MISSING;
      throw error;
    }
    // Never follow a directory symlink outside this repository.
    const parent = fs.realpathSync(path.dirname(full));
    if (parent !== root && !parent.startsWith(root + path.sep)) fail('external-symlink-parent');
    if (stat.isSymbolicLink()) return digest(Buffer.from(fs.readlinkSync(full)), 'link');
    if (!stat.isFile()) fail('unsupported-non-file');
    if (stat.size > MAX_FILE) fail('size-budget');
    return digest(fs.readFileSync(full), stat.mode & 0o111 ? 'executable' : 'file');
  };
  const head = () => {
    const result = git(['rev-parse', '--verify', '--quiet', 'HEAD'], true);
    return result.ok ? result.out.toString('ascii').trim() : null;
  };
  const snapshot = () => {
    const paths = parseStatus(git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']).out);
    if (paths.length > MAX_PATHS) fail('path-budget');
    return { head: head(), dirty: Object.fromEntries(paths.map((name) => [name, workingFile(name)])) };
  };
  const historicalFile = (commit, name) => {
    if (!commit) return MISSING;
    const entries = splitZero(git(['ls-tree', '-z', commit, '--', name]).out);
    // Directory replacements and gitlinks need a project-specific policy.
    const entry = entries.find((value) => value.slice(value.indexOf('\t') + 1) === name);
    if (!entry) return MISSING;
    const [mode, type, object] = entry.slice(0, entry.indexOf('\t')).split(' ');
    if (type !== 'blob') fail('unsupported-tree-entry');
    const size = Number(git(['cat-file', '-s', object]).out.toString('ascii'));
    if (!Number.isFinite(size) || size > MAX_FILE) fail('size-budget');
    const data = git(['cat-file', 'blob', object]).out;
    return digest(data, mode === '120000' ? 'link' : mode === '100755' ? 'executable' : 'file');
  };
  const changes = (baseline, current) => {
    let committed = [];
    if (baseline.head !== current.head) {
      if (baseline.head && current.head) {
        committed = splitZero(git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseline.head, current.head, '--']).out);
      } else if (current.head) {
        committed = splitZero(git(['ls-tree', '-r', '--name-only', '-z', current.head]).out);
      } else {
        fail('head-removed');
      }
    }
    const candidates = [...new Set([...Object.keys(baseline.dirty), ...Object.keys(current.dirty), ...committed])];
    if (candidates.length > MAX_PATHS) fail('path-budget');
    return candidates.filter((name) => {
      const before = Object.hasOwn(baseline.dirty, name) ? baseline.dirty[name] : historicalFile(baseline.head, name);
      const after = Object.hasOwn(current.dirty, name) ? current.dirty[name] : workingFile(name);
      return before !== after;
    }).sort();
  };
  return { root, gitDir, snapshot, changes };
}

function save(file, data) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function handle(input, host) {
  if (!['claude', 'codex'].includes(host)) fail('invalid-host');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-input');
  if (!['UserPromptSubmit', 'Stop'].includes(input.hook_event_name)) return {};
  if (input.hook_event_name === 'Stop' && input.stop_hook_active === true) return {};
  // Codex Stop feedback creates a new prompt. Do not reset the original baseline.
  if (input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string' && input.prompt.startsWith(PREFIX)) return {};
  if (typeof input.cwd !== 'string' || typeof input.session_id !== 'string' || !input.session_id) fail('missing-session-context');
  const ctx = context(input.cwd);
  if (!ctx) return {};
  const stateDir = path.join(ctx.gitDir, 'agent-doc-review');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, `${host}-${sha(input.session_id)}.json`);
  if (input.hook_event_name === 'UserPromptSubmit') {
    // Remove an old baseline first: failure must not reuse stale evidence.
    if (fs.existsSync(file)) fs.unlinkSync(file);
    save(file, { version: 1, baseline: ctx.snapshot(), reminded: false });
    return {};
  }
  if (!fs.existsSync(file)) fail('missing-baseline-restart-session');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.version !== 1 || !state.baseline?.dirty) fail('invalid-state');
  if (state.reminded || hasDocStatus(input.last_assistant_message)) return {};
  const changed = ctx.changes(state.baseline, ctx.snapshot());
  const implementationChanges = changed.filter((name) => !DOC_PATH.test(name));
  if (implementationChanges.length === 0) return {};
  state.reminded = true;
  save(file, state); // Record BEFORE requesting another model turn.
  const feedback = `${PREFIX} Repository changes were detected during this user turn (${implementationChanges.length} non-document paths). `
    + 'Before finishing, assess documentation impact using the actual diff and existing project rules. '
    + 'Changes may include concurrent work; do not claim ownership or overwrite others\' work. '
    + 'Update only documentation made inaccurate by your authorized task. Do not edit Markdown merely to pass this reminder. '
    + 'Then include one line: Docs: updated (files and reason), Docs: not needed (specific reason), or Docs: pending (blocker). '
    + 'You may write the equivalent in Simplified Chinese. If waiting for a user decision, report pending; do not expand scope. '
    + 'This is a one-time review reminder, not proof that documentation is correct. Do not change or disable the hook to silence it.';
  if (host === 'claude') return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: feedback } };
  return { decision: 'block', reason: feedback };
}

async function main() {
  const host = process.argv[2];
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) fail('input-budget');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return handle(input, host);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((output) => process.stdout.write(JSON.stringify(output) + '\n')).catch(() => {
    // Fail visibly, but do not block work or print file contents/credentials.
    process.stdout.write(JSON.stringify({ systemMessage: '[doc-review] Documentation review was skipped because its input, Git state, or resource budget could not be checked. No documentation conclusion was verified; inspect the hook and review manually.' }) + '\n');
  });
}
