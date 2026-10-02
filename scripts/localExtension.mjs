// The local variant of the extension adds the button inside the commit message box.
// That location needs the proposed `scm/inputBox` menu (contribSourceControlInputBoxMenu,
// https://github.com/microsoft/vscode/issues/195474), which the Marketplace does not accept.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');

const PROPOSAL = 'contribSourceControlInputBoxMenu';
const ASSETS = ['package.nls.json', 'l10n', 'images'];

/**
 * Writes the patched manifest and the static assets, plus `extraFiles` from the
 * repository root, into the existing folder `target`. Returns the manifest.
 */
export function writeLocalExtension(target, extraFiles = []) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.enabledApiProposals = [...new Set([...(manifest.enabledApiProposals ?? []), PROPOSAL])];
  manifest.contributes.menus['scm/inputBox'] = [{ command: 'intellicommit.generate', when: 'scmProvider == git' }];
  delete manifest.scripts;
  delete manifest.devDependencies;
  writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  for (const name of [...ASSETS, ...extraFiles]) {
    cpSync(join(root, name), join(target, name), { recursive: true });
  }
  return manifest;
}
