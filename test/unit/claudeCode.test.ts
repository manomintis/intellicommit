import * as assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { claudeCommand, clearClaudeCliCache, findOnPath, probeAll, quoteForCmd } from '../../src/llm/claudeCode/cli';
import { buildClaudeArgs, classifyClaudeError, parseClaudeLine } from '../../src/llm/claudeCode/protocol';
import { claudeCodeModelLabel, sourceOrder } from '../../src/llm/sources';

suite('sourceOrder', () => {
  test('maps each setting to the sources to try', () => {
    assert.deepEqual(sourceOrder('claudeCodeThenVsCode'), ['claudeCode', 'vsCode']);
    assert.deepEqual(sourceOrder('vsCodeThenClaudeCode'), ['vsCode', 'claudeCode']);
    assert.deepEqual(sourceOrder('claudeCode'), ['claudeCode']);
    assert.deepEqual(sourceOrder('vsCode'), ['vsCode']);
  });

  test('labels Claude models', () => {
    assert.equal(claudeCodeModelLabel('haiku'), 'Haiku');
    assert.equal(claudeCodeModelLabel('custom'), 'custom');
  });
});

suite('buildClaudeArgs', () => {
  const args = buildClaudeArgs('haiku');
  const valueOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

  test('runs one stateless, tool-less request with streaming output', () => {
    assert.equal(args[0], '--print');
    assert.equal(valueOf('--model'), 'haiku');
    assert.equal(valueOf('--output-format'), 'stream-json');
    assert.equal(valueOf('--tools'), '');
    assert.equal(valueOf('--setting-sources'), '');
    for (const flag of ['--include-partial-messages', '--verbose', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) {
      assert.ok(args.includes(flag), flag);
    }
  });

  test('passes a system prompt without quotes or newlines (safe for every shell)', () => {
    assert.doesNotMatch(valueOf('--system-prompt') ?? '', /["'\n]/);
  });
});

suite('parseClaudeLine', () => {
  test('text deltas', () => {
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Add' } } });
    assert.deepEqual(parseClaudeLine(line), { kind: 'text', text: 'Add' });
  });

  test('thinking deltas and other events are ignored', () => {
    const thinking = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } });
    assert.deepEqual(parseClaudeLine(thinking), { kind: 'other' });
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'status' })), { kind: 'other' });
    assert.deepEqual(parseClaudeLine('not json'), { kind: 'other' });
  });

  test('init event reports the API key source', () => {
    const line = (extra: object): string => JSON.stringify({ type: 'system', subtype: 'init', ...extra });
    assert.deepEqual(parseClaudeLine(line({ apiKeySource: 'ANTHROPIC_API_KEY' })), { kind: 'init', apiKeySource: 'ANTHROPIC_API_KEY' });
    assert.deepEqual(parseClaudeLine(line({})), { kind: 'init', apiKeySource: undefined });
  });

  test('successful result', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Add retries',
      api_error_status: null,
      total_cost_usd: 0.0005,
      usage: { input_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 10, output_tokens: 12 },
    });
    assert.deepEqual(parseClaudeLine(line), {
      kind: 'result',
      isError: false,
      text: 'Add retries',
      status: undefined,
      usage: { inputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 10, outputTokens: 12, costUsd: 0.0005 },
    });
  });

  test('error result (reported with subtype "success" and is_error true)', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Bad model', api_error_status: 404 });
    assert.deepEqual(parseClaudeLine(line), { kind: 'result', isError: true, text: 'Bad model', status: 404, usage: undefined });
  });
});

suite('classifyClaudeError', () => {
  const cases = [
    [401, 'Invalid API key · Please run /login', 'accessDenied'],
    [undefined, 'Not logged in · Please run /login', 'accessDenied'],
    [429, 'Too many requests', 'quota'],
    [undefined, 'Claude usage limit reached', 'quota'],
    [404, "There's an issue with the selected model (x).", 'noModels'],
    [529, 'Overloaded', 'network'],
    [500, 'Internal error', 'unknown'],
  ] as const;
  for (const [status, message, kind] of cases) {
    test(`${String(status)} ${message} → ${kind}`, () => {
      assert.equal(classifyClaudeError(status, message), kind);
    });
  }
});

suite('quoteForCmd', () => {
  test('leaves plain arguments alone and quotes the rest', () => {
    assert.equal(quoteForCmd('--model'), '--model');
    assert.equal(quoteForCmd('C:\\Users\\me\\claude.cmd'), 'C:\\Users\\me\\claude.cmd');
    assert.equal(quoteForCmd('C:\\Program Files\\claude.cmd'), '"C:\\Program Files\\claude.cmd"');
    assert.equal(quoteForCmd(''), '""');
    assert.equal(quoteForCmd('a & b'), '"a & b"');
  });

  test('refuses characters cmd.exe interprets inside quotes', () => {
    for (const arg of ['%PATH%', 'a"b', 'a\nb']) {
      assert.throws(() => quoteForCmd(arg), arg);
    }
  });
});

suite('claudeCommand', () => {
  test('runs executables directly, without a shell', function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    assert.deepEqual(claudeCommand('/usr/local/bin/claude', ['--version']), { file: '/usr/local/bin/claude', args: ['--version'], shell: false });
  });
});

suite('findOnPath', () => {
  const originalPath = process.env.PATH;
  teardown(() => {
    process.env.PATH = originalPath;
  });

  test('returns the absolute path from the first absolute PATH entry that has it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intellicommit-path-'));
    const file = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    writeFileSync(file, '');
    process.env.PATH = ['relative', join(dir, 'missing'), dir].join(delimiter);
    try {
      assert.equal(await findOnPath('claude'), file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores relative PATH entries', async () => {
    process.env.PATH = ['.', 'node_modules'].join(delimiter);
    assert.equal(await findOnPath('package.json'), undefined);
  });
});

suite('probeAll', () => {
  teardown(() => {
    clearClaudeCliCache();
  });

  test('skips an executable that failed until it changes or settings change', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const dir = mkdtempSync(join(tmpdir(), 'intellicommit-probe-'));
    const runs = join(dir, 'runs');
    const cli = join(dir, 'claude');
    // Records each run and prints no version, so the check fails.
    writeFileSync(cli, `#!/bin/sh\necho run >> '${runs}'\nexit 1\n`);
    chmodSync(cli, 0o755);
    const runCount = (): number => readFileSync(runs, 'utf8').split('\n').filter((l) => l !== '').length;
    try {
      assert.equal(await probeAll([cli]), undefined);
      assert.equal(await probeAll([cli]), undefined);
      assert.equal(runCount(), 1, 'a failed executable is not run again');

      utimesSync(cli, new Date(), new Date(Date.now() + 60_000));
      assert.equal(await probeAll([cli]), undefined);
      assert.equal(runCount(), 2, 'a changed executable is run again');

      clearClaudeCliCache();
      assert.equal(await probeAll([cli]), undefined);
      assert.equal(runCount(), 3, 'a settings change retries');

      writeFileSync(cli, '#!/bin/sh\necho 2.1.0\n');
      utimesSync(cli, new Date(), new Date(Date.now() + 120_000));
      assert.deepEqual(await probeAll([cli]), { path: cli });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
