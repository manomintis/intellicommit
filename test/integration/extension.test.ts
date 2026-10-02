import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { IntelliCommitApi } from '../../src/extension';
import type { CommitMessageProvider, PromptInput } from '../../src/llm/provider';
import { MAX_MESSAGE_CHARS } from '../../src/prompt/budget';
import type { API, GitExtension, Repository } from '../../src/typings/git';

const EXTENSION_ID = 'rykantas.intellicommit';

/** A provider that streams fixed fragments; never calls a real model. */
class MockProvider implements CommitMessageProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock';
  prompts: PromptInput[] = [];

  constructor(
    private readonly fragments: readonly string[],
    private readonly waitForCancellation = false,
  ) {}

  async *generate(prompt: PromptInput, token: vscode.CancellationToken): AsyncIterable<string> {
    this.prompts.push(prompt);
    for (const fragment of this.fragments) {
      await new Promise((r) => setTimeout(r, 5));
      yield fragment;
    }
    if (this.waitForCancellation) {
      await new Promise<void>((resolve) => token.onCancellationRequested(() => { resolve(); }));
    }
  }

  maxInputTokens(): Promise<number | undefined> {
    return Promise.resolve(100_000);
  }

  countTokens(text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / 4));
  }
}

async function until(condition: () => boolean, message: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`Timed out waiting for: ${message}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('IntelliCommit', () => {
  let api: IntelliCommitApi;
  let git: API;
  let repo: Repository;
  const repoPath = process.env.INTELLICOMMIT_TEST_REPO ?? '';
  const tempDirs: string[] = [];

  suiteTeardown(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  suiteSetup(async () => {
    assert.ok(repoPath, 'INTELLICOMMIT_TEST_REPO must be set by .vscode-test.mjs');
    const extension = vscode.extensions.getExtension<IntelliCommitApi | undefined>(EXTENSION_ID);
    assert.ok(extension, 'extension is installed');
    const exported = await extension.activate();
    assert.ok(exported, 'the test API is available in test mode');
    api = exported;

    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    assert.ok(gitExtension);
    git = (gitExtension.isActive ? gitExtension.exports : await gitExtension.activate()).getAPI(1);
    await until(() => git.repositories.length > 0, 'the test repository to open');
    repo = git.repositories[0]!;
  });

  teardown(async () => {
    api.setProviderOverride(undefined);
    await vscode.workspace.getConfiguration('intellicommit').update('onExistingText', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('intellicommit').update('source', undefined, vscode.ConfigurationTarget.Global);
    repo.inputBox.value = '';
  });

  test('activates and registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('intellicommit.generate'));
    assert.ok(commands.includes('intellicommit.selectSource'));
  });

  test('describes unstaged and untracked changes when nothing is staged, without staging', async () => {
    writeFileSync(join(repoPath, 'README.md'), '# Fixture\n\nMore docs.\n');
    writeFileSync(join(repoPath, 'notes.txt'), 'brand new file\n');
    await repo.status();
    await until(() => repo.state.workingTreeChanges.length + repo.state.untrackedChanges.length >= 2, 'git status to refresh');

    const provider = new MockProvider(['```\n', 'Added notes', ' and docs.', '\n```']);
    api.setProviderOverride(provider);
    await vscode.commands.executeCommand('intellicommit.generate', repo);

    assert.equal(repo.inputBox.value, 'Add notes and docs');
    assert.equal(repo.state.indexChanges.length, 0, 'nothing was staged');
    const changes = provider.prompts[0]?.changes ?? '';
    assert.match(changes, /Nothing is staged/);
    assert.match(changes, /\+More docs\./);
    assert.match(changes, /\+\+\+ b\/notes\.txt\n@@ -0,0 \+1,1 @@\n\+brand new file/);
  });

  test('describes only staged changes when something is staged', async () => {
    writeFileSync(join(repoPath, 'staged.txt'), 'staged content\n');
    writeFileSync(join(repoPath, 'unstaged.txt'), 'unstaged content\n');
    await repo.add([join(repoPath, 'staged.txt')]);
    await until(() => repo.state.indexChanges.length === 1, 'the index to refresh');

    const provider = new MockProvider(['Add staged file']);
    api.setProviderOverride(provider);
    await vscode.commands.executeCommand('intellicommit.generate', repo);

    assert.equal(repo.inputBox.value, 'Add staged file');
    const changes = provider.prompts[0]?.changes ?? '';
    assert.match(changes, /^These are the staged changes/);
    assert.match(changes, /\+staged content/);
    assert.doesNotMatch(changes, /unstaged|notes\.txt|More docs/);
    await repo.revert([join(repoPath, 'staged.txt')]);
  });

  test('a second run cancels the first and restores the previous text', async () => {
    await vscode.workspace.getConfiguration('intellicommit').update('onExistingText', 'append', vscode.ConfigurationTarget.Global);
    repo.inputBox.value = 'Draft';

    api.setProviderOverride(new MockProvider(['Partial subject'], true));
    const first = vscode.commands.executeCommand('intellicommit.generate', repo);
    await until(() => repo.inputBox.value.includes('Partial subject'), 'the first run to stream');

    api.setProviderOverride(new MockProvider(['Fix the thing']));
    await vscode.commands.executeCommand('intellicommit.generate', repo);
    await first;

    assert.equal(repo.inputBox.value, 'Draft\n\nFix the thing');
  });

  test('the stop command cancels the run and restores the previous text', async () => {
    repo.inputBox.value = 'Draft';
    api.setProviderOverride(new MockProvider(['Partial subject'], true));
    const run = vscode.commands.executeCommand('intellicommit.generate', repo);
    await until(() => repo.inputBox.value.includes('Partial subject'), 'the run to stream');

    await vscode.commands.executeCommand('intellicommit.stop', repo);
    await run;

    assert.equal(repo.inputBox.value, 'Draft');
  });

  test('without any language model, explains and sends nothing', async function () {
    if ((await vscode.lm.selectChatModels()).length > 0) {
      this.skip();
    }
    // Only VS Code LLMs: the Claude Code CLI fallback could reach a real model on a dev machine.
    await vscode.workspace.getConfiguration('intellicommit').update('source', 'vsCode', vscode.ConfigurationTarget.Global);
    repo.inputBox.value = 'Untouched';
    await vscode.commands.executeCommand('intellicommit.generate', repo);
    assert.equal(repo.inputBox.value, 'Untouched');
  });

  test('restores the previous text when generation fails', async () => {
    repo.inputBox.value = 'Keep me';
    const failing: CommitMessageProvider = {
      id: 'failing',
      displayName: 'Failing',
      maxInputTokens: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(1),
      async *generate() {
        await Promise.resolve();
        throw new Error('network down');
      },
    };
    api.setProviderOverride(failing);
    await vscode.commands.executeCommand('intellicommit.generate', repo);
    assert.equal(repo.inputBox.value, 'Keep me');
  });

  test('never sends the content of secret files or of what untracked symlinks point to', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const outsideDir = mkdtempSync(join(tmpdir(), 'intellicommit-outside-'));
    tempDirs.push(outsideDir);
    const outside = join(outsideDir, 'credentials');
    writeFileSync(outside, 'LINKED_SECRET\n');
    symlinkSync(outside, join(repoPath, 'linked-credentials'));
    writeFileSync(join(repoPath, '.env'), 'API_TOKEN=DOTENV_SECRET\n');
    await repo.status();
    await until(
      () => [...repo.state.workingTreeChanges, ...repo.state.untrackedChanges].some((c) => c.uri.path.endsWith('/.env')),
      'git status to refresh',
    );

    const provider = new MockProvider(['Add local configuration']);
    api.setProviderOverride(provider);
    await vscode.commands.executeCommand('intellicommit.generate', repo);

    const changes = provider.prompts[0]?.changes ?? '';
    assert.match(changes, /^A \.env \(new file; diff not shown: excluded\)$/m);
    assert.match(changes, /^A linked-credentials \(new file; diff not shown: symbolic link\)$/m);
    assert.doesNotMatch(changes, /DOTENV_SECRET|LINKED_SECRET/);
  });

  test('stops reading untracked files once the diff size limit is reached', async () => {
    const config = vscode.workspace.getConfiguration('intellicommit');
    await config.update('maxDiffChars', 1000, vscode.ConfigurationTarget.Global);
    try {
      const dir = join(repoPath, 'many');
      mkdirSync(dir);
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(dir, `file${String(i).padStart(2, '0')}.txt`), `${'content '.repeat(40)}\n`);
      }
      await repo.status();
      await until(
        () => [...repo.state.workingTreeChanges, ...repo.state.untrackedChanges].some((c) => c.uri.path.endsWith('/many/file19.txt')),
        'git status to refresh',
      );

      const provider = new MockProvider(['Add many files']);
      api.setProviderOverride(provider);
      await vscode.commands.executeCommand('intellicommit.generate', repo);

      const changes = provider.prompts[0]?.changes ?? '';
      assert.match(changes, /^A many\/file19\.txt \(new file[;)]/m, 'every file is still listed');
      assert.match(changes, /^A many\/file\d+\.txt \(new file; diff not shown: diff size limit\)$/m);
    } finally {
      await config.update('maxDiffChars', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('stops a runaway response at the length limit and keeps the message', async () => {
    let requestCancelled = false;
    const endless: CommitMessageProvider = {
      id: 'endless',
      displayName: 'Endless',
      maxInputTokens: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(1),
      async *generate(_prompt, token) {
        token.onCancellationRequested(() => {
          requestCancelled = true;
        });
        yield 'Add a long message\n\n';
        while (!token.isCancellationRequested) {
          await new Promise((r) => setTimeout(r, 1));
          yield 'word '.repeat(50);
        }
      },
    };
    api.setProviderOverride(endless);
    await vscode.commands.executeCommand('intellicommit.generate', repo);
    assert.ok(requestCancelled, 'the request was cancelled');
    assert.match(repo.inputBox.value, /^Add a long message\n\nword word/);
    assert.ok(repo.inputBox.value.length <= MAX_MESSAGE_CHARS);
  });
});
