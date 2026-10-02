// Creates .local-ext/, the extension development folder with the in-box button.
// Files are copied, never linked: VS Code identifies an extension by the real path
// of its code. esbuild.js refreshes .local-ext/dist after every build.
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { root, writeLocalExtension } from './localExtension.mjs';

const target = join(root, '.local-ext');
rmSync(target, { recursive: true, force: true });
mkdirSync(target);
writeLocalExtension(target);
mkdirSync(join(target, 'dist'));
// Copy the current build now: if the watch task is already running from an
// earlier launch, it won't rebuild (and copy) until a source file changes.
const { copyToLocalExt } = createRequire(import.meta.url)('./copyToLocalExt.js');
if (!copyToLocalExt()) {
  console.log('No build yet; the watch task will copy it after the first build.');
}
console.log(`Prepared ${target}`);
