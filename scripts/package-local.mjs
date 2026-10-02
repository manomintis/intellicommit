// Builds <name>-<version>-local.vsix, the variant with the button inside the commit
// message box (see README "Optional: button inside the commit box"), from a staging copy of the extension.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, writeLocalExtension } from './localExtension.mjs';

execFileSync('npm', ['run', 'package'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

const stage = mkdtempSync(join(tmpdir(), 'intellicommit-local-'));
try {
  const manifest = writeLocalExtension(stage, ['README.md', 'CHANGELOG.md', 'LICENSE']);
  mkdirSync(join(stage, 'dist'));
  copyFileSync(join(root, 'dist', 'extension.js'), join(stage, 'dist', 'extension.js'));

  const out = join(root, `${manifest.name}-${manifest.version}-local.vsix`);
  const vsce = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
  execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--out', out], { cwd: stage, stdio: 'inherit' });
  console.log(`\nLocal build: ${out}`);
  console.log(`Enable with "enable-proposed-api": ["${manifest.publisher}.${manifest.name}"] in argv.json.`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
