import * as vscode from 'vscode';
import { Generator, RESPONSE_TIMEOUT_MS } from './commands/generate';
import { selectSource } from './commands/selectSource';
import { getGitApi } from './git/gitApi';
import type { CommitMessageProvider } from './llm/provider';
import { ProviderResolver } from './llm/resolver';
import { disposeLog } from './log';
import { ModelStatusBar } from './ui/statusBar';

/** Returned from `activate` only when the extension runs under integration tests. */
export interface IntelliCommitApi {
  setProviderOverride(provider: CommitMessageProvider | undefined): void;
  /** Undefined restores the default. */
  setResponseTimeout(ms: number | undefined): void;
}

export function activate(context: vscode.ExtensionContext): IntelliCommitApi | undefined {
  const resolver = new ProviderResolver();
  const generator = new Generator(context.globalState, resolver);

  context.subscriptions.push(
    resolver,
    generator,
    { dispose: disposeLog },
    vscode.commands.registerCommand('intellicommit.generate', (arg?: unknown) => generator.run(arg)),
    vscode.commands.registerCommand('intellicommit.stop', (arg?: unknown) => {
      generator.stop(arg);
    }),
    vscode.commands.registerCommand('intellicommit.selectSource', selectSource),
  );

  // The status bar needs the Git API, which may still be initializing; don't block activation.
  void getGitApi().then((git) => {
    if (git) {
      context.subscriptions.push(new ModelStatusBar(git, resolver));
    }
  });

  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return undefined;
  }
  return {
    setProviderOverride(provider) {
      generator.providerOverride = provider;
    },
    setResponseTimeout(ms) {
      generator.responseTimeoutMs = ms ?? RESPONSE_TIMEOUT_MS;
    },
  };
}
