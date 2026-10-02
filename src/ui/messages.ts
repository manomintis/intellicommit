import * as vscode from 'vscode';
import { aiFeaturesDisabled } from '../config';
import type { IntelliCommitError } from '../errors';
import { sourceName, type SourceProblem } from '../llm/resolver';
import { log } from '../log';

export const CLAUDE_CODE_DOCS_URL = 'https://code.claude.com/docs/en/setup';

/** Explains why no source is usable; no request is attempted. */
export async function showNoProviderMessage(problems: readonly SourceProblem[]): Promise<void> {
  const reasons = problems.map((p) => `${sourceName(p.source)}: ${p.reason}`).join('; ');
  const selectSource = vscode.l10n.t('Select Source');
  const installClaude = vscode.l10n.t('Install Claude Code');
  const openSettings = vscode.l10n.t('Open AI Setting');
  const actions = [selectSource, installClaude, ...(aiFeaturesDisabled() && problems.some((p) => p.source === 'vsCode') ? [openSettings] : [])];

  const choice = await vscode.window.showWarningMessage(vscode.l10n.t('No LLM is available. {0}.', reasons), ...actions);
  if (choice === selectSource) {
    await vscode.commands.executeCommand('intellicommit.selectSource');
  } else if (choice === installClaude) {
    await vscode.env.openExternal(vscode.Uri.parse(CLAUDE_CODE_DOCS_URL));
  } else if (choice === openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'chat.disableAIFeatures');
  }
}

/** Offers to pick a model when the configured VS Code LLM is gone. */
export async function showStaleModelWarning(id: string): Promise<void> {
  const openSettings = vscode.l10n.t('Open Settings');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('The configured VS Code LLM "{0}" is not available. Using an automatic choice instead.', id),
    openSettings,
  );
  if (choice === openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'intellicommit.model');
  }
}

/** Reports a failed generation; offers a different source when the model itself is the problem. */
export async function showGenerationError(error: IntelliCommitError): Promise<void> {
  const selectSource = vscode.l10n.t('Select Source');
  const showLog = vscode.l10n.t('Show Log');
  const modelProblem = ['noModels', 'accessDenied', 'quota', 'blocked'].includes(error.kind);
  const choice = await vscode.window.showErrorMessage(error.message, ...(modelProblem ? [selectSource, showLog] : [showLog]));
  if (choice === selectSource) {
    await vscode.commands.executeCommand('intellicommit.selectSource');
  } else if (choice === showLog) {
    log().show(true);
  }
}
