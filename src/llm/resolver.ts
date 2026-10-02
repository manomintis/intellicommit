import * as vscode from 'vscode';
import { aiFeaturesDisabled, getModelConfig, MODEL_SETTINGS } from '../config';
import { clearClaudeCliCache, findClaudeCli } from './claudeCode/cli';
import { ClaudeCodeProvider } from './claudeCode/claudeCodeProvider';
import { log } from '../log';
import { resolveModel, sortByPrice } from './modelSelection';
import type { CommitMessageProvider } from './provider';
import { sourceOrder, type Source } from './sources';
import { VsCodeLmProvider } from './vscodeLmProvider';

export interface Resolved {
  readonly ok: true;
  readonly provider: CommitMessageProvider;
  readonly source: Source;
  /** Short label, e.g. "Claude Code · Haiku". */
  readonly label: string;
  /** Earlier sources that were unavailable, with the reason. */
  readonly skipped: readonly SourceProblem[];
  /** Set when a VS Code LLM is used because `intellicommit.model` names one that is not available. */
  readonly staleModelId: string | undefined;
}

export interface Unresolved {
  readonly ok: false;
  readonly problems: readonly SourceProblem[];
}

export interface SourceProblem {
  readonly source: Source;
  readonly reason: string;
}

/**
 * Picks the provider for the next generation: the configured sources in order,
 * falling back only when a source is unavailable.
 */
export class ProviderResolver implements vscode.Disposable {
  private readonly configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (MODEL_SETTINGS.some((s) => e.affectsConfiguration(s))) {
      clearClaudeCliCache();
    }
  });
  private lastLoggedModels = '';

  async resolve(): Promise<Resolved | Unresolved> {
    const config = getModelConfig();
    const problems: SourceProblem[] = [];

    for (const source of sourceOrder(config.source)) {
      if (source === 'claudeCode') {
        const cli = await findClaudeCli(config.claudeCodePath);
        if (cli) {
          const provider = new ClaudeCodeProvider(cli, config.claudeCodeModel);
          return { ok: true, provider, source, label: provider.displayName, skipped: problems, staleModelId: undefined };
        }
        problems.push({ source, reason: vscode.l10n.t('the Claude Code CLI was not found') });
      } else {
        const models = await vscode.lm.selectChatModels();
        this.logVsCodeModels(models);
        const resolution = resolveModel(models, config.model, config.preferredModels);
        if (resolution.model) {
          return {
            ok: true,
            provider: new VsCodeLmProvider(resolution.model),
            source,
            label: resolution.model.name,
            skipped: problems,
            staleModelId: resolution.staleExplicitId,
          };
        }
        problems.push({ source, reason: noVsCodeLlmReason() });
      }
    }

    return { ok: false, problems };
  }

  /** Lists available VS Code LLM ids in the log, so users can copy one into `intellicommit.model`. */
  private logVsCodeModels(models: readonly vscode.LanguageModelChat[]): void {
    const text = sortByPrice(models).map((m) => `${m.id} (${m.name}, ${m.vendor})`).join(', ');
    if (text !== this.lastLoggedModels) {
      this.lastLoggedModels = text;
      log().info(`VS Code LLMs available: ${text === '' ? 'none' : text}`);
    }
  }

  dispose(): void {
    this.configListener.dispose();
  }
}

export function sourceName(source: Source): string {
  return source === 'claudeCode' ? vscode.l10n.t('Claude Code CLI') : vscode.l10n.t('VS Code LLMs');
}

function noVsCodeLlmReason(): string {
  return aiFeaturesDisabled()
    ? vscode.l10n.t('AI features are turned off in VS Code (setting "chat.disableAIFeatures")')
    : vscode.l10n.t('no extension provides VS Code LLMs');
}
