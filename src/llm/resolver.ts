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
 * falling back only when a source is unavailable. Nothing is checked until the
 * first explicit `resolve`; after that, model and setting changes refresh the result.
 */
export class ProviderResolver implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
  private last: Resolved | Unresolved | undefined;
  private lastLoggedModels = '';

  /** Fires after the resolved provider may have changed. */
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.disposables.push(
      vscode.lm.onDidChangeChatModels(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (MODEL_SETTINGS.some((s) => e.affectsConfiguration(s))) {
          clearClaudeCliCache();
          void this.refresh();
        }
      }),
    );
  }

  /** The most recent resolution, if any has happened yet. */
  get current(): Resolved | Unresolved | undefined {
    return this.last;
  }

  async resolve(): Promise<Resolved | Unresolved> {
    const config = getModelConfig();
    const problems: SourceProblem[] = [];
    let result: Resolved | Unresolved | undefined;

    for (const source of sourceOrder(config.source)) {
      if (source === 'claudeCode') {
        const cli = await findClaudeCli(config.claudeCodePath);
        if (cli) {
          const provider = new ClaudeCodeProvider(cli, config.claudeCodeModel);
          result = { ok: true, provider, source, label: provider.displayName, skipped: problems, staleModelId: undefined };
          break;
        }
        problems.push({ source, reason: vscode.l10n.t('the Claude Code CLI was not found') });
      } else {
        const models = await vscode.lm.selectChatModels();
        this.logVsCodeModels(models);
        const resolution = resolveModel(models, config.model, config.preferredModels);
        if (resolution.model) {
          result = {
            ok: true,
            provider: new VsCodeLmProvider(resolution.model),
            source,
            label: resolution.model.name,
            skipped: problems,
            staleModelId: resolution.staleExplicitId,
          };
          break;
        }
        problems.push({ source, reason: noVsCodeLlmReason() });
      }
    }

    this.last = result ?? { ok: false, problems };
    this.changeEmitter.fire();
    return this.last;
  }

  private async refresh(): Promise<void> {
    if (!this.last) {
      return;
    }
    try {
      await this.resolve();
    } catch {
      // Listing models can fail transiently while providers register; the next event retries.
    }
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
    vscode.Disposable.from(...this.disposables).dispose();
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
