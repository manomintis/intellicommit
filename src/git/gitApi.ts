import * as vscode from 'vscode';
import type { API, GitExtension, Repository } from '../typings/git';

/**
 * Returns the vscode.git API v1 once it is initialized, or undefined when the
 * Git extension is disabled (e.g. `git.enabled: false` or Restricted Mode) or
 * does not finish initializing within `timeoutMs`.
 */
export async function getGitApi(timeoutMs?: number): Promise<API | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (!exports.enabled) {
    return undefined;
  }
  const api = exports.getAPI(1);
  if (api.state === 'initialized' || (await whenInitialized(api, timeoutMs))) {
    return api;
  }
  return undefined;
}

function whenInitialized(api: API, timeoutMs: number | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = api.onDidChangeState((state) => {
      if (state === 'initialized') {
        clearTimeout(timer);
        listener.dispose();
        resolve(true);
      }
    });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            listener.dispose();
            resolve(false);
          }, timeoutMs);
  });
}

/** The `SourceControl` VS Code passes when the command runs from an SCM menu. */
export function rootUriOf(arg: unknown): vscode.Uri | undefined {
  if (typeof arg === 'object' && arg !== null && 'rootUri' in arg) {
    const rootUri: unknown = arg.rootUri;
    return rootUri instanceof vscode.Uri ? rootUri : undefined;
  }
  return undefined;
}

/**
 * Finds the repository a command applies to:
 * the SCM menu argument, the only repository, the active editor's repository,
 * or the user's pick.
 */
export async function resolveRepository(api: API, arg: unknown): Promise<Repository | undefined> {
  const repositories = api.repositories;
  const rootUri = rootUriOf(arg);
  if (rootUri) {
    const match = repositories.find((r) => r.rootUri.toString() === rootUri.toString());
    if (match) {
      return match;
    }
  }
  if (repositories.length <= 1) {
    return repositories[0];
  }

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const repo = api.getRepository(active);
    if (repo) {
      return repo;
    }
  }

  const picked = await vscode.window.showQuickPick(
    repositories.map((repository) => ({
      label: repoName(repository),
      description: vscode.workspace.asRelativePath(repository.rootUri, true),
      repository,
    })),
    { placeHolder: vscode.l10n.t('Choose a repository to generate a commit message for') },
  );
  return picked?.repository;
}

export function repoName(repository: Repository): string {
  const segments = repository.rootUri.path.split('/');
  return segments[segments.length - 1] ?? repository.rootUri.path;
}
