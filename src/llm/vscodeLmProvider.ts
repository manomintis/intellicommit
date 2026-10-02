import * as vscode from 'vscode';
import { cancelledError, toIntelliCommitError } from '../errors';
import type { CommitMessageProvider, PromptInput } from './provider';

/** CommitMessageProvider on top of VS Code's Language Model API (`vscode.lm`). */
export class VsCodeLmProvider implements CommitMessageProvider {
  constructor(private readonly model: vscode.LanguageModelChat) {}

  get id(): string {
    return this.model.id;
  }

  get displayName(): string {
    return this.model.name;
  }

  async *generate(prompt: PromptInput, token: vscode.CancellationToken): AsyncIterable<string> {
    // The Language Model API has no system role, so the instructions are the first user message.
    const messages = [
      vscode.LanguageModelChatMessage.User(prompt.instructions),
      vscode.LanguageModelChatMessage.User(prompt.changes),
    ];
    try {
      const response = await this.model.sendRequest(
        messages,
        { justification: vscode.l10n.t('IntelliCommit uses the model to write a commit message for your changes.') },
        token,
      );
      for await (const fragment of response.text) {
        if (token.isCancellationRequested) {
          break;
        }
        yield fragment;
      }
    } catch (error) {
      throw toIntelliCommitError(error, token);
    }
    if (token.isCancellationRequested) {
      throw cancelledError();
    }
  }

  maxInputTokens(): Promise<number | undefined> {
    return Promise.resolve(this.model.maxInputTokens > 0 ? this.model.maxInputTokens : undefined);
  }

  async countTokens(text: string, token: vscode.CancellationToken): Promise<number> {
    try {
      return await this.model.countTokens(text, token);
    } catch (error) {
      throw toIntelliCommitError(error, token);
    }
  }
}
