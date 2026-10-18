// The agent against a real server, the way Claude Code runs its hooks: stopping a computer from the dashboard,
// and keeping it to some models and an effort cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effortAbove, familyOf, modelAllowed, parseModels } from '../src/policy.mjs';

const agentFile = fileURLToPath(new URL('../agent/agent.mjs', import.meta.url));

test('rules name model families and effort levels', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('claude-mythos-5'), 'fable');
  assert.deepEqual(parseModels('["haiku","sonnet","nonsense"]'), ['sonnet', 'haiku']);
  assert.equal(parseModels([]), null);
  const policy = { models: ['sonnet'], maxEffort: 'medium' };
  assert.equal(modelAllowed(policy, 'claude-sonnet-5-5'), true);
  assert.equal(modelAllowed(policy, 'claude-opus-5-5'), false);
  assert.equal(modelAllowed(policy, '<synthetic>'), true);
  assert.equal(effortAbove(policy, 'high'), true);
  assert.equal(effortAbove(policy, 'medium'), false);
  assert.equal(effortAbove({ maxEffort: null }, 'max'), false);
});

async function startServer() {
  const port = 43000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA: ':memory:', TRUST_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Setup code: ([0-9a-f]+)/.exec(out);
      if (match) resolve(match[1]);
    });
    child.on('exit', () => reject(new Error(out)));
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = null;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-monitor': '1', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return response.json();
  };
  await call('/api/setup', 'POST', { password: 'owner-password', code });
  return { child, base, call };
}

test('the agent stops a paused computer and keeps it to its models and effort', async (t) => {
  const { child, base, call } = await startServer();
  const home = mkdtempSync(join(tmpdir(), 'cm-agent-'));
  t.after(() => {
    child.kill();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const config = join(home, '.claude');
  // The computer's own sign-in is not used here: no percentages go to Anthropic from a test.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home, CLAUDE_MONITOR_LANG: 'en' };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const run = (command, input = {}) => {
    const result = spawnSync(process.execPath, [join(config, 'claude-monitor', 'agent.mjs'), command], { env, input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000 });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const settings = () => JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8'));

  const machine = await call('/api/machines', 'POST', { name: 'laptop' });
  const setup = spawnSync(process.execPath, [agentFile, 'setup', '--server', base, '--token', machine.token], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(setup.status, 0, setup.stderr);
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionStart', 'PreModelSwitch', 'PostModelSwitch']) assert.ok(settings().hooks[event], event);
  // Auto-update is asked for, not assumed.
  assert.equal(JSON.parse(readFileSync(join(config, 'claude-monitor', 'config.json'), 'utf8')).autoUpdate, false);

  // Working: nothing is stopped.
  assert.equal(run('gate', { session_id: 's1' }).code, 0);

  // "Stop Claude" on the dashboard: the next prompt and the next tool call are stopped.
  await call(`/api/machines/${machine.id}`, 'PATCH', { paused: true });
  const stopped = run('gate', { session_id: 's1' });
  assert.equal(stopped.code, 2);
  assert.match(stopped.err, /stopped from the dashboard/);
  const tool = JSON.parse(run('guard', { session_id: 's1' }).out);
  assert.equal(tool.continue, false);
  assert.equal(tool.hookSpecificOutput.permissionDecision, 'deny');
  await call(`/api/machines/${machine.id}`, 'PATCH', { paused: false });
  assert.equal(run('gate', { session_id: 's1' }).code, 0);

  // Only Sonnet and Haiku, effort up to medium: written into Claude Code's own settings.
  await call(`/api/machines/${machine.id}`, 'PATCH', { allowedModels: ['sonnet', 'haiku'], maxEffort: 'medium' });
  assert.equal(run('gate', { session_id: 's1' }).code, 0);
  assert.deepEqual(settings().availableModels, ['sonnet', 'haiku']);
  assert.equal(settings().enforceAvailableModels, true);
  assert.equal(settings().maxEffortLevel, 'medium');

  // A switch to Opus is refused, one to Sonnet goes through.
  const toOpus = run('model', { session_id: 's1', to_model: 'claude-opus-5-5' });
  assert.equal(toOpus.code, 2);
  assert.match(toOpus.err, /claude-opus-5-5 may not be used/);
  assert.equal(run('model', { session_id: 's1', to_model: 'claude-sonnet-5-5' }).code, 0);

  // A session that started on Opus anyway (ANTHROPIC_MODEL, say) is stopped at its prompt, until it switches.
  run('session', { session_id: 's2', model: 'claude-opus-5-5' });
  assert.equal(run('gate', { session_id: 's2' }).code, 2);
  run('switched', { session_id: 's2', to_model: 'claude-sonnet-5-5' });
  assert.equal(run('gate', { session_id: 's2' }).code, 0);

  // Effort over the cap stops the tool call; at the cap it goes on.
  const high = JSON.parse(run('guard', { session_id: 's1', effort: { level: 'high' } }).out);
  assert.equal(high.continue, false);
  assert.match(high.stopReason, /effort high is above/);
  assert.equal(run('guard', { session_id: 's1', effort: { level: 'medium' } }).out, '');

  // No rules on the dashboard: the agent takes its keys out again, but leaves a person's own setting.
  const own = settings();
  own.maxEffortLevel = 'high';
  writeFileSync(join(config, 'settings.json'), JSON.stringify(own));
  await call(`/api/machines/${machine.id}`, 'PATCH', { allowedModels: null, maxEffort: 'max' });
  assert.equal(run('gate', { session_id: 's1' }).code, 0);
  assert.equal(settings().availableModels, undefined);
  assert.equal(settings().enforceAvailableModels, undefined);
  assert.equal(settings().maxEffortLevel, 'high');

  // "remove" takes out every hook it set.
  run('remove');
  assert.equal(settings().hooks, undefined);
});

import { openDb } from '../src/db.mjs';
import { newToken } from '../src/auth.mjs';
import { checkPolicy } from '../src/alerts.mjs';

test('the owner is told when a request went past the rules; Claude Code’s own helpers do not count', () => {
  const db = openDb(':memory:');
  const { hash, hint } = newToken();
  db.prepare(`INSERT INTO machines (name, token_hash, token_hint, color, created_at, allowed_models, max_effort) VALUES ('pc', ?, ?, '#f00', ?, '["sonnet"]', 'medium')`).run(hash, hint, Date.now());
  const machine = db.prepare('SELECT * FROM machines').get();
  checkPolicy(db, machine, [
    { model: 'claude-haiku-5-5', source: 'generate_session_title', effort: 'medium' },
    { model: 'claude-sonnet-5-5', source: 'repl_main_thread', effort: 'medium' },
  ]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM alerts WHERE kind = 'policy'").get().n, 0);
  checkPolicy(db, machine, [{ model: 'claude-opus-5-5', source: 'repl_main_thread', effort: 'high' }]);
  checkPolicy(db, machine, [{ model: 'claude-opus-5-5', source: 'repl_main_thread', effort: 'high' }]);
  // One for the model, one for the effort, each once a day.
  assert.equal(db.prepare("SELECT count(*) AS n FROM alerts WHERE kind = 'policy'").get().n, 2);
});
