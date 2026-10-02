import * as vscode from 'vscode';
import { MODEL_SETTINGS } from '../config';
import { configuredLabel, sourceName, type ProviderResolver } from '../llm/resolver';
import type { API } from '../typings/git';

/** Shows the LLM that will be used; clicking opens the picker. Visible only with a Git repository. */
export class ModelStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly git: API,
    private readonly resolver: ProviderResolver,
  ) {
    this.item = vscode.window.createStatusBarItem('intellicommit.model', vscode.StatusBarAlignment.Right, -100);
    this.item.name = vscode.l10n.t('IntelliCommit Model');
    this.item.command = 'intellicommit.selectSource';
    const update = (): void => {
      this.update();
    };
    this.disposables.push(
      this.item,
      resolver.onDidChange(update),
      git.onDidOpenRepository(update),
      git.onDidCloseRepository(update),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (MODEL_SETTINGS.some((s) => e.affectsConfiguration(s))) {
          this.update();
        }
      }),
    );
    this.update();
  }

  private update(): void {
    if (this.git.repositories.length === 0) {
      this.item.hide();
      return;
    }
    const resolution = this.resolver.current;
    let label: string;
    let tooltip: string;
    if (resolution?.ok) {
      label = resolution.label;
      tooltip = vscode.l10n.t('IntelliCommit writes commit messages with {0} ({1}). Click to change the source.', resolution.label, sourceName(resolution.source));
    } else if (resolution) {
      label = vscode.l10n.t('No LLM');
      tooltip = vscode.l10n.t('No LLM is available. Click to change the source.');
    } else {
      // Nothing is checked before the first use; show what is configured.
      label = configuredLabel();
      tooltip = vscode.l10n.t('IntelliCommit LLM. Click to change the source.');
    }
    this.item.text = `$(sparkle) ${label}`;
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
