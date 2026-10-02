import type * as vscode from 'vscode';

/** The prompt as plain text; providers map it to their own message format. */
export interface PromptInput {
  /** Instructions for the model: rules, style and examples. */
  readonly instructions: string;
  /** Description of the changes (file list, diff). */
  readonly changes: string;
}

/** A language model backend that streams commit messages. */
export interface CommitMessageProvider {
  readonly id: string;
  readonly displayName: string;
  /** Streams text fragments; must honor cancellation. */
  generate(prompt: PromptInput, token: vscode.CancellationToken): AsyncIterable<string>;
  /** Max input tokens if known, used for budgeting. */
  maxInputTokens(): Promise<number | undefined>;
  countTokens(text: string, token: vscode.CancellationToken): Promise<number>;
}
