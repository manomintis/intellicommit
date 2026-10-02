import * as vscode from 'vscode';
import { NETWORK_PATTERN, QUOTA_PATTERN, type ErrorKind } from './errorKind';

/** Typed error for everything that can go wrong while generating a message. */
export class IntelliCommitError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'IntelliCommitError';
  }
}

export function cancelledError(cause?: unknown): IntelliCommitError {
  return new IntelliCommitError('cancelled', vscode.l10n.t('Generation was cancelled.'), { cause });
}

export function timeoutError(ms: number): IntelliCommitError {
  return new IntelliCommitError(
    'timeout',
    vscode.l10n.t('The language model stopped responding for {0} seconds. Try again later or pick another model.', Math.ceil(ms / 1000)),
  );
}

/** Maps any failure, including VS Code Language Model API errors, to a typed error. */
export function toIntelliCommitError(error: unknown, token?: vscode.CancellationToken): IntelliCommitError {
  if (error instanceof IntelliCommitError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (token?.isCancellationRequested || error instanceof vscode.CancellationError) {
    return cancelledError(error);
  }
  if (error instanceof vscode.LanguageModelError) {
    switch (error.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return new IntelliCommitError(
          'accessDenied',
          vscode.l10n.t('IntelliCommit is not allowed to use this language model. Allow access when prompted, or pick another model.'),
          { cause: error },
        );
      case vscode.LanguageModelError.NotFound.name:
        return new IntelliCommitError('noModels', vscode.l10n.t('The selected language model is no longer available.'), { cause: error });
      case vscode.LanguageModelError.Blocked.name:
        return QUOTA_PATTERN.test(message)
          ? quotaError(error)
          : new IntelliCommitError('blocked', vscode.l10n.t('The language model request was blocked: {0}', message), { cause: error });
    }
  }
  if (QUOTA_PATTERN.test(message)) {
    return quotaError(error);
  }
  if (NETWORK_PATTERN.test(message)) {
    return new IntelliCommitError('network', vscode.l10n.t('Could not reach the language model. Check your connection.'), { cause: error });
  }
  return new IntelliCommitError('unknown', vscode.l10n.t('Generating the commit message failed: {0}', message), { cause: error });
}

function quotaError(cause: unknown): IntelliCommitError {
  return new IntelliCommitError('quota', vscode.l10n.t('The language model quota or rate limit was reached. Try again later or pick another model.'), { cause });
}
