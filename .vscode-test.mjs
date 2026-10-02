import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway Git repository that the integration tests open as their workspace.
const repo = mkdtempSync(join(tmpdir(), 'intellicommit-it-'));
process.on('exit', () => {
  rmSync(repo, { recursive: true, force: true });
});
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'IntelliCommit Test');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'README.md'), '# Fixture\n');
git('add', '.');
git('commit', '-q', '-m', 'Initial commit');

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: repo,
  mocha: {
    ui: 'tdd',
    timeout: 60000,
  },
  env: {
    INTELLICOMMIT_TEST_REPO: repo,
  },
});
