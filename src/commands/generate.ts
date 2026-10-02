import * as vscode from 'vscode';
import { getConfig, type IntelliCommitConfig } from '../config';
import { cancelledError, IntelliCommitError, timeoutError, toIntelliCommitError } from '../errors';
import { collectChanges, hasChanges, type CollectedChanges } from '../git/changes';
import { getGitApi, isFromCommitBox, resolveRepository, rootUriOf } from '../git/gitApi';
import { IdleTimer } from '../idleTimer';
import { sourceName, type ProviderResolver } from '../llm/resolver';
import type { CommitMessageProvider } from '../llm/provider';
import { log } from '../log';
import { diffTokenBudget, fitDiff, MAX_MESSAGE_CHARS } from '../prompt/budget';
import { buildChangesHeader, buildInstructions, buildPromptInput, resolveStyle, type PromptParams } from '../prompt/buildPrompt';
import { formatCommitMessage } from '../prompt/formatCommitMessage';
import type { Repository } from '../typings/git';
import { showGenerationError, showNoProviderMessage, showStaleModelWarning } from '../ui/messages';

const SMART_COMMIT_HINT_KEY = 'intellicommit.smartCommitHintDismissed';
const SHORTCUT_USED_KEY = 'intellicommit.shortcutUsed';
const SHORTCUT_HINT_KEY = 'intellicommit.shortcutHintShown';
/** Context key with the root URIs of repositories that are generating; swaps the ✨ button for Stop. */
const GENERATING_CONTEXT_KEY = 'intellicommit.generatingRepos';
/** Recent commit subjects used for `auto` style detection and as a style reference in the prompt. */
const RECENT_SUBJECT_COUNT = 10;
/** How long a generation waits for the Git extension to finish starting up. */
const GIT_INIT_TIMEOUT_MS = 30_000;
/** Minimum time between commit box updates while a message streams in; the final message is always shown. */
const PREVIEW_INTERVAL_MS = 80;
/** Longest wait for the first or the next part of the response before the request is abandoned. */
export const RESPONSE_TIMEOUT_MS = 60_000;

interface Run {
  readonly cts: vscode.CancellationTokenSource;
  readonly done: Promise<void>;
}

/** Orchestrates generations; at most one run per repository. */
export class Generator implements vscode.Disposable {
  private readonly runs = new Map<string, Run>();
  private smartCommitHintShown = false;
  private fallbackNoticeShown = false;
  /** Replaces the language model backend; set only through the integration-test API. */
  providerOverride: CommitMessageProvider | undefined;
  /** Changed only through the integration-test API. */
  responseTimeoutMs = RESPONSE_TIMEOUT_MS;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly resolver: ProviderResolver,
  ) {}

  async run(arg?: unknown): Promise<void> {
    const git = await getGitApi(GIT_INIT_TIMEOUT_MS);
    if (!git) {
      void vscode.window.showWarningMessage(vscode.l10n.t('The built-in Git extension is not available.'));
      return;
    }
    const repo = await resolveRepository(git, arg);
    if (!repo) {
      if (git.repositories.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No Git repository is open.'));
      }
      return;
    }

    // Running the command again for the same repository (e.g. from the Command Palette) starts over.
    const key = repo.rootUri.toString();
    const previous = this.runs.get(key);
    const cts = new vscode.CancellationTokenSource();
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.runs.set(key, { cts, done });
    this.updateContext();
    if (isFromCommitBox(arg)) {
      void this.globalState.update(SHORTCUT_USED_KEY, true);
    }
    if (previous) {
      previous.cts.cancel();
      await previous.done;
    }

    try {
      if (await this.generate(repo, cts.token)) {
        this.maybeShowShortcutHint(arg);
      }
    } finally {
      if (this.runs.get(key)?.cts === cts) {
        this.runs.delete(key);
        this.updateContext();
      }
      cts.dispose();
      finish();
    }
  }

  /** Stops the generation of the repository the SCM menu passes, or every generation. */
  stop(arg?: unknown): void {
    const rootUri = rootUriOf(arg)?.toString();
    for (const [key, run] of this.runs) {
      if (rootUri === undefined || key === rootUri) {
        run.cts.cancel();
      }
    }
  }

  /** After the first message generated without the shortcut, mentions the shortcut once. */
  private maybeShowShortcutHint(arg: unknown): void {
    if (
      isFromCommitBox(arg) ||
      this.globalState.get<boolean>(SHORTCUT_USED_KEY, false) ||
      this.globalState.get<boolean>(SHORTCUT_HINT_KEY, false)
    ) {
      return;
    }
    void this.globalState.update(SHORTCUT_HINT_KEY, true);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Tip: next time, press {0} in the commit box to generate a commit message.', shortcutLabel()),
    );
  }

  private updateContext(): void {
    const roots = [...this.runs.keys()];
    void vscode.commands.executeCommand('setContext', GENERATING_CONTEXT_KEY, roots.length > 0 ? roots : undefined);
  }

  /** Returns true when a message was written to the commit box. */
  private async generate(repo: Repository, token: vscode.CancellationToken): Promise<boolean> {
    if (!hasChanges(repo)) {
      showNoChanges();
      return false;
    }
    // Set once the commit box may change, so failures before that leave the user's typing alone.
    let box: CommitBox | undefined;
    try {
      const provider = await this.getProvider();
      if (!provider || isCancelled(token)) {
        return false;
      }

      const config = getConfig(repo.rootUri);
      const changes = await collectChanges(repo, config.excludeGlobs, config.maxDiffChars);
      if (!changes) {
        showNoChanges();
        return false;
      }
      if (isCancelled(token)) {
        return false;
      }

      if (changes.mode === 'all') {
        this.maybeShowSmartCommitHint(repo);
      }

      const existing = repo.inputBox.value;
      const prefix = await this.prefixFor(existing, config);
      if (prefix === undefined || isCancelled(token)) {
        return false;
      }

      const title =
        changes.mode === 'staged'
          ? vscode.l10n.t('IntelliCommit: describing staged changes…')
          : vscode.l10n.t('IntelliCommit: nothing staged, describing all changes…');
      const commitBox = new CommitBox(repo, existing);
      box = commitBox;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title, cancellable: true },
        async (_progress, progressToken) => {
          const linked = new vscode.CancellationTokenSource();
          const subscriptions = [
            progressToken.onCancellationRequested(() => {
              linked.cancel();
            }),
            token.onCancellationRequested(() => {
              linked.cancel();
            }),
          ];
          try {
            await this.stream(commitBox, provider, changes, config, prefix, linked.token);
          } finally {
            vscode.Disposable.from(...subscriptions, linked).dispose();
          }
        },
      );
      return true;
    } catch (error) {
      box?.restore();
      const typed = toIntelliCommitError(error);
      if (typed.kind === 'cancelled') {
        log().info(
          box?.userEdited
            ? 'The commit message was edited during generation; generation stopped and the edit was kept.'
            : 'Generation cancelled; restored the previous commit message.',
        );
        return false;
      }
      log().error(typed.message, typed.cause ?? '');
      void showGenerationError(typed);
      return false;
    }
  }

  private async stream(
    box: CommitBox,
    provider: CommitMessageProvider,
    changes: CollectedChanges,
    config: IntelliCommitConfig,
    prefix: string,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const recent = await recentSubjects(box.repo);
    const style = resolveStyle(config.style, recent);
    const params: PromptParams = {
      style,
      language: config.language,
      recentSubjects: recent,
      mode: changes.mode,
      files: changes.files,
      omitted: changes.diff.omitted,
      customInstructions: config.customInstructions,
    };

    const overhead = await provider.countTokens(`${buildInstructions(params)}\n${buildChangesHeader(params)}`, token);
    const budget = diffTokenBudget(await provider.maxInputTokens(), overhead);
    if (budget === undefined) {
      throw new IntelliCommitError(
        'tooLarge',
        vscode.l10n.t('Too many files changed to describe them within the model\'s input limit. Stage a smaller set of changes and try again.'),
      );
    }
    const fitted = await fitDiff(changes.diff.included, budget, config.maxDiffChars, (text) => provider.countTokens(text, token));
    log().info(
      `Describing ${changes.mode} changes (${changes.files.length} files) with ${provider.displayName} in ${style} style; ` +
        `diff level: ${fitted.level}, ${fitted.text.length} chars, budget ${budget} tokens.`,
    );
    throwIfCancelled(token);

    // Also cancelled when the response reaches MAX_MESSAGE_CHARS, which is not an error,
    // when the response stalls, and when the loop exits on an error or a user edit.
    const request = new vscode.CancellationTokenSource();
    const forwardCancel = token.onCancellationRequested(() => {
      request.cancel();
    });
    const idle = new IdleTimer(this.responseTimeoutMs, () => {
      log().warn(`No response for ${this.responseTimeoutMs} ms; the request was cancelled.`);
      request.cancel();
    });
    let raw = '';
    let lastPreviewAt = 0;
    try {
      for await (const fragment of provider.generate(buildPromptInput(params, fitted.text), request.token)) {
        throwIfCancelled(token);
        idle.restart();
        raw += fragment;
        if (raw.length >= MAX_MESSAGE_CHARS) {
          raw = raw.slice(0, MAX_MESSAGE_CHARS);
          log().warn(`The response reached ${MAX_MESSAGE_CHARS} characters; generation was stopped there.`);
          request.cancel();
          break;
        }
        const now = Date.now();
        if (now - lastPreviewAt < PREVIEW_INTERVAL_MS) {
          continue;
        }
        lastPreviewAt = now;
        box.write(prefix + formatCommitMessage(raw, style).message);
      }
    } catch (error) {
      request.cancel();
      throw idle.fired && !isCancelled(token) ? timeoutError(this.responseTimeoutMs) : error;
    } finally {
      idle.dispose();
      forwardCancel.dispose();
      request.dispose();
    }
    throwIfCancelled(token);
    if (idle.fired) {
      throw timeoutError(this.responseTimeoutMs);
    }

    const result = formatCommitMessage(raw, style);
    if (result.message === '') {
      throw new IntelliCommitError('unknown', vscode.l10n.t('The language model returned an empty message.'));
    }
    for (const warning of result.warnings) {
      log().warn(warning);
    }
    box.write(prefix + result.message);
  }

  private async getProvider(): Promise<CommitMessageProvider | undefined> {
    if (this.providerOverride) {
      return this.providerOverride;
    }
    const resolution = await this.resolver.resolve();
    if (!resolution.ok) {
      log().warn(`No LLM available: ${resolution.problems.map((p) => `${p.source}: ${p.reason}`).join('; ')}`);
      void showNoProviderMessage(resolution.problems);
      return undefined;
    }
    if (resolution.staleModelId !== undefined) {
      void showStaleModelWarning(resolution.staleModelId);
    }
    const skipped = resolution.skipped[0];
    if (skipped && !this.fallbackNoticeShown) {
      this.fallbackNoticeShown = true;
      void vscode.window.showInformationMessage(
        vscode.l10n.t('{0} unavailable ({1}). Using {2} instead.', sourceName(skipped.source), skipped.reason, resolution.label),
      );
    }
    log().info(`Using ${resolution.provider.id} from ${resolution.source}${skipped ? ' (fallback)' : ''}.`);
    return resolution.provider;
  }

  /** The text kept in front of the generated message, or undefined when the user cancels. */
  private async prefixFor(existing: string, config: IntelliCommitConfig): Promise<string | undefined> {
    if (existing.trim() === '') {
      return '';
    }
    let action = config.onExistingText;
    if (action === 'ask') {
      const replace = vscode.l10n.t('Replace');
      const append = vscode.l10n.t('Append');
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('The commit message box already contains text.'),
        { modal: true, detail: vscode.l10n.t('Replace it with the generated message, or append the message below it?') },
        replace,
        append,
      );
      if (choice === undefined) {
        return undefined;
      }
      action = choice === append ? 'append' : 'replace';
    }
    return action === 'append' ? `${existing.trimEnd()}\n\n` : '';
  }

  private maybeShowSmartCommitHint(repo: Repository): void {
    const smartCommit = vscode.workspace.getConfiguration('git', repo.rootUri).get<boolean>('enableSmartCommit', false);
    if (smartCommit || this.smartCommitHintShown || this.globalState.get<boolean>(SMART_COMMIT_HINT_KEY, false)) {
      return;
    }
    this.smartCommitHintShown = true;
    const dontShow = vscode.l10n.t("Don't Show Again");
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t(
          'Nothing was staged, so IntelliCommit described all changes. IntelliCommit never stages files; when you commit, VS Code asks whether to stage all changes.',
        ),
        dontShow,
      )
      .then((choice) => (choice === dontShow ? this.globalState.update(SMART_COMMIT_HINT_KEY, true) : undefined));
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      run.cts.cancel();
    }
    this.runs.clear();
    this.updateContext();
  }
}

/**
 * The commit box during one generation. IntelliCommit owns it only while it still holds
 * what IntelliCommit last wrote; once the user types into it, their text is never replaced.
 */
class CommitBox {
  private written: string;

  constructor(
    readonly repo: Repository,
    private readonly original: string,
  ) {
    this.written = original;
  }

  get userEdited(): boolean {
    return this.repo.inputBox.value !== this.written;
  }

  /** Throws a cancellation error when the user has edited the box, which stops the generation. */
  write(value: string): void {
    if (this.userEdited) {
      throw cancelledError();
    }
    if (value !== this.written) {
      this.repo.inputBox.value = value;
      this.written = value;
    }
  }

  /** Puts back the text from before the generation, unless the user has edited the box. */
  restore(): void {
    if (!this.userEdited) {
      this.write(this.original);
    }
  }
}

function showNoChanges(): void {
  void vscode.window.showInformationMessage(vscode.l10n.t('No changes to describe.'));
}

/** A function call, so TypeScript doesn't narrow the flag across awaits. */
function isCancelled(token: vscode.CancellationToken): boolean {
  return token.isCancellationRequested;
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (isCancelled(token)) {
    throw cancelledError();
  }
}

function shortcutLabel(): string {
  return process.platform === 'darwin' ? '⌥↩' : 'Alt+Enter';
}

async function recentSubjects(repo: Repository): Promise<string[]> {
  try {
    const commits = await repo.log({ maxEntries: RECENT_SUBJECT_COUNT });
    return commits.map((c) => c.message.split('\n')[0]?.trim() ?? '').filter((s) => s !== '');
  } catch {
    // A repository without commits has no log.
    return [];
  }
}
