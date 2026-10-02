import * as vscode from 'vscode';
import { getModelConfig, updateSource } from '../config';
import { SOURCE_SETTINGS, type SourceSetting } from '../llm/sources';

interface SourceItem extends vscode.QuickPickItem {
  readonly value: SourceSetting;
}

/** Chooses where the LLM comes from. Models for each source are set on the Settings page. */
export async function selectSource(): Promise<void> {
  const config = getModelConfig();
  const labels: Readonly<Record<SourceSetting, string>> = {
    claudeCodeThenVsCode: vscode.l10n.t('Claude Code CLI, fallback to VS Code LLMs'),
    vsCodeThenClaudeCode: vscode.l10n.t('VS Code LLMs, fallback to Claude Code CLI'),
    claudeCode: vscode.l10n.t('Claude Code CLI only'),
    vsCode: vscode.l10n.t('VS Code LLMs only'),
  };
  const items: SourceItem[] = SOURCE_SETTINGS.map((value) => ({
    value,
    label: labels[value],
    description: value === config.source ? vscode.l10n.t('current') : undefined,
  }));

  const quickPick = vscode.window.createQuickPick<SourceItem>();
  quickPick.title = vscode.l10n.t('IntelliCommit: Select LLM Source');
  quickPick.placeholder = vscode.l10n.t('Where should IntelliCommit get its LLM from?');
  quickPick.items = items;
  const active = items.find((i) => i.value === config.source);
  if (active) {
    quickPick.activeItems = [active];
  }
  const picked = await new Promise<SourceItem | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      resolve(quickPick.selectedItems[0]);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
    });
    quickPick.show();
  });
  quickPick.dispose();

  if (picked) {
    await updateSource(picked.value);
  }
}
