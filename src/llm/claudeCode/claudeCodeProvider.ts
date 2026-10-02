import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import { AUTH_PATTERN } from '../../errorKind';
import { cancelledError, IntelliCommitError } from '../../errors';
import { log } from '../../log';
import type { CommitMessageProvider, PromptInput } from '../provider';
import { claudeCodeModelLabel } from '../sources';
import { claudeCommand, isWindows, type ClaudeCli } from './cli';
import { buildClaudeArgs, CLAUDE_ENV, classifyClaudeError, parseClaudeLine, type ClaudeUsage } from './protocol';

/** Input limit assumed for Claude models; the CLI does not report one. */
const CLAUDE_MAX_INPUT_TOKENS = 200_000;
/** Conservative estimate; the CLI has no token counting. */
const CHARS_PER_TOKEN = 3;
/** Only the end of stderr is kept: it holds the error message, and its size is not bounded. */
const MAX_STDERR_CHARS = 8000;

/** CommitMessageProvider that runs the Claude Code CLI, using the user's own Claude sign-in. */
export class ClaudeCodeProvider implements CommitMessageProvider {
  readonly id: string;
  readonly displayName: string;

  constructor(
    private readonly cli: ClaudeCli,
    private readonly model: string,
  ) {
    this.id = `claude-code:${model}`;
    this.displayName = `Claude Code · ${claudeCodeModelLabel(model)}`;
  }

  async *generate(prompt: PromptInput, token: vscode.CancellationToken): AsyncIterable<string> {
    const command = claudeCommand(this.cli.path, buildClaudeArgs(this.model));
    // A new, empty working directory keeps project files (e.g. CLAUDE.md) out of the
    // request. Unlike the shared /tmp on Linux, other users cannot add files to it.
    const cwd = await mkdtemp(join(tmpdir(), 'intellicommit-'));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.file, command.args, {
        cwd,
        env: { ...process.env, ...CLAUDE_ENV },
        shell: command.shell,
        windowsHide: true,
        stdio: 'pipe',
      });
    } catch (error) {
      await rm(cwd, { recursive: true, force: true });
      throw error;
    }
    const cancellation = token.onCancellationRequested(() => {
      terminate(child);
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    const exited = new Promise<{ code: number | null } | { error: Error }>((resolve) => {
      child.once('error', (error) => {
        resolve({ error });
      });
      child.once('close', (code) => {
        resolve({ code });
      });
    });
    // A CLI that exits before reading its input closes stdin; the exit code reports the failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${prompt.instructions}\n\n${prompt.changes}`);

    let failure: IntelliCommitError | undefined;
    let streamedText = false;
    let resultText = '';
    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const event = parseClaudeLine(line);
        if (event.kind === 'init') {
          logBillingSource(event.apiKeySource);
        } else if (event.kind === 'text') {
          streamedText = true;
          yield event.text;
        } else if (event.kind === 'result') {
          logUsage(event.usage);
          if (event.isError) {
            failure = new IntelliCommitError(classifyClaudeError(event.status, event.text), claudeErrorMessage(event.text));
          } else {
            resultText = event.text;
          }
        }
      }

      const exit = await exited;
      if (token.isCancellationRequested) {
        throw cancelledError();
      }
      if ('error' in exit) {
        throw new IntelliCommitError('unknown', vscode.l10n.t('Could not run Claude Code: {0}', exit.error.message), { cause: exit.error });
      }
      if (!failure && exit.code !== 0) {
        const detail = stderr.trim().split('\n').pop() ?? '';
        failure = new IntelliCommitError(
          classifyClaudeError(undefined, detail),
          vscode.l10n.t('Claude Code exited with code {0}. {1}', exit.code ?? -1, detail),
        );
      }
      if (failure) {
        log().error(`Claude Code failed: ${failure.message}`, stderr.trim());
        throw failure;
      }
      if (!streamedText && resultText !== '') {
        yield resultText;
      }
    } finally {
      cancellation.dispose();
      terminate(child);
      // Windows cannot remove the directory while the process still uses it.
      void exited.then(() => rm(cwd, { recursive: true, force: true })).catch(() => undefined);
    }
  }

  maxInputTokens(): Promise<number | undefined> {
    return Promise.resolve(CLAUDE_MAX_INPUT_TOKENS);
  }

  countTokens(text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / CHARS_PER_TOKEN));
  }
}

/**
 * Stops the CLI and anything it started. On Windows an npm install runs under cmd.exe,
 * and killing only the shell would leave the CLI running, so the whole tree is terminated.
 */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (!isWindows || child.pid === undefined) {
    child.kill();
    return;
  }
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  execFile(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
    if (error) {
      child.kill();
    }
  });
}

function logBillingSource(apiKeySource: string | undefined): void {
  if (apiKeySource === undefined) {
    return;
  }
  log().info(
    apiKeySource === 'none'
      ? 'Claude Code is not using an API key.'
      : `Claude Code is using an API key from ${apiKeySource}; requests are billed per token to that API account.`,
  );
}

function logUsage(usage: ClaudeUsage | undefined): void {
  if (!usage) {
    return;
  }
  const cost = usage.costUsd === undefined ? '' : `, $${usage.costUsd.toFixed(4)} at API prices`;
  log().info(
    `Claude Code usage: ${usage.inputTokens} input tokens (+${usage.cacheReadTokens} cache read, +${usage.cacheWriteTokens} cache write), ` +
      `${usage.outputTokens} output tokens${cost}.`,
  );
}

function claudeErrorMessage(text: string): string {
  const detail = text.trim() !== '' ? text.trim() : vscode.l10n.t('Unknown error.');
  return AUTH_PATTERN.test(detail)
    ? vscode.l10n.t('Claude Code is not signed in. Run "claude" in a terminal and sign in, then try again. ({0})', detail)
    : vscode.l10n.t('Claude Code: {0}', detail);
}
