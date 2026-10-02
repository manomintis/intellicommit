import * as assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { IntelliCommitApi } from '../../src/extension';
import type { API, GitExtension, Repository } from '../../src/typings/git';

/**
 * A stand-in for the `claude` executable that answers in the CLI's stream-json
 * format. Tests never call a real model.
 */
const FAKE_CLAUDE = `#!/bin/sh
dir=$(dirname "$0")
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
input=$(cat)
printf '%s\\n' "$@" > "$dir/args.txt"
pwd > "$dir/cwd.txt"
echo "$MAX_THINKING_TOKENS $CLAUDE_CODE_MAX_OUTPUT_TOKENS" > "$dir/env.txt"
printf '%s' "$input" > "$dir/stdin.txt"
case "$input" in
  *HANG_PLEASE*)
    echo "$$" > "$dir/pid.txt"
    exec sleep 30;;
  *FAIL_PLEASE*)
    echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","api_error_status":401}'
    exit 1;;
esac
echo '{"type":"system","subtype":"init"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Added fake"}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" CLI support."}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added fake CLI support."}'
`;

suite('Claude Code CLI source', function () {
  if (process.platform === 'win32') {
    return;
  }
  let repo: Repository;
  let api: IntelliCommitApi;
  const dir = mkdtempSync(join(tmpdir(), 'intellicommit-fake-claude-'));
  const fake = join(dir, 'claude');
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('intellicommit');
  const set = (key: string, value: unknown): Thenable<void> => config().update(key, value, vscode.ConfigurationTarget.Global);

  suiteSetup(async () => {
    const exported = await vscode.extensions.getExtension<IntelliCommitApi | undefined>('rykantas.intellicommit')?.activate();
    assert.ok(exported, 'the test API is available in test mode');
    api = exported;
    writeFileSync(fake, FAKE_CLAUDE);
    chmodSync(fake, 0o755);
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    assert.ok(gitExtension);
    const git: API = (gitExtension.isActive ? gitExtension.exports : await gitExtension.activate()).getAPI(1);
    repo = git.repositories[0]!;
    writeFileSync(join(process.env.INTELLICOMMIT_TEST_REPO ?? '', 'claude-test.txt'), 'hello\n');
    await repo.status();
  });

  suiteTeardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  teardown(async () => {
    api.setResponseTimeout(undefined);
    for (const key of ['source', 'claudeCode.path', 'claudeCode.model', 'customInstructions']) {
      await set(key, undefined);
    }
    repo.inputBox.value = '';
  });

  test('streams a message from the CLI and runs it in a private empty folder, without thinking', async () => {
    await set('source', 'claudeCode');
    await set('claudeCode.path', fake);
    await set('claudeCode.model', 'sonnet');
    await vscode.commands.executeCommand('intellicommit.generate', repo);

    assert.equal(repo.inputBox.value, 'Add fake CLI support');
    const args = readFileSync(join(dir, 'args.txt'), 'utf8').split('\n');
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.ok(args.includes('--no-session-persistence'));
    const cwd = readFileSync(join(dir, 'cwd.txt'), 'utf8').trim();
    assert.equal(realpathSync(dirname(cwd)), realpathSync(tmpdir()));
    assert.match(basename(cwd), /^intellicommit-/);
    assert.equal(readFileSync(join(dir, 'env.txt'), 'utf8').trim(), '0 1024');
    const stdin = readFileSync(join(dir, 'stdin.txt'), 'utf8');
    assert.match(stdin, /imperative mood/);
    assert.match(stdin, /claude-test\.txt/);
  });

  test('falls back to the CLI when no VS Code LLMs exist', async function () {
    if ((await vscode.lm.selectChatModels()).length > 0) {
      this.skip();
    }
    await set('source', 'vsCodeThenClaudeCode');
    await set('claudeCode.path', fake);
    await vscode.commands.executeCommand('intellicommit.generate', repo);
    assert.equal(repo.inputBox.value, 'Add fake CLI support');
  });

  test('a CLI error restores the previous text', async () => {
    await set('source', 'claudeCode');
    await set('claudeCode.path', fake);
    await set('customInstructions', 'FAIL_PLEASE');
    repo.inputBox.value = 'Keep me';
    await vscode.commands.executeCommand('intellicommit.generate', repo);
    assert.equal(repo.inputBox.value, 'Keep me');
  });

  test('a CLI that hangs times out, is stopped, and the previous text is restored', async () => {
    await set('source', 'claudeCode');
    await set('claudeCode.path', fake);
    await set('customInstructions', 'HANG_PLEASE');
    api.setResponseTimeout(500);
    repo.inputBox.value = 'Keep me';
    await vscode.commands.executeCommand('intellicommit.generate', repo);
    assert.equal(repo.inputBox.value, 'Keep me');

    const pid = Number(readFileSync(join(dir, 'pid.txt'), 'utf8').trim());
    await until(() => !isRunning(pid), 'the CLI process to exit');
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`Timed out waiting for: ${message}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
