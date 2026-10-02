# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

IntelliCommit is a VS Code extension (publisher `rykantas`, min VS Code 1.91) that generates Git commit messages from the current changes, using either the Claude Code CLI or a VS Code Language Model API model.

## Commands

```sh
npm run compile        # tsc --noEmit + eslint + esbuild bundle to dist/extension.js
npm run check-types    # type check only
npm run lint           # eslint (strictTypeChecked + stylisticTypeChecked)
npm run compile-tests  # tsc to out/ — required before running unit tests
npm run test:unit      # mocha (tdd UI) over out/test/unit/**/*.test.js; no VS Code needed
npm test               # pretest (compile-tests + compile), then unit + integration
npm run test:integration  # @vscode/test-cli; downloads VS Code on first run
npm run l10n           # regenerate l10n/bundle.l10n.json from vscode.l10n.t() calls
npm run package:vsix   # Marketplace .vsix
```

Run a single unit test file or test (compile first; tests run from `out/`, not `src/`):

```sh
npm run compile-tests && npx mocha --ui tdd out/test/unit/budget.test.js
npx mocha --ui tdd "out/test/unit/**/*.test.js" --grep "fitDiff"
```

Integration tests (`.vscode-test.mjs`) create a throwaway Git repo as the workspace (path in `INTELLICOMMIT_TEST_REPO`) and drive the extension through the test-only API returned by `activate` (`setProviderOverride` with a mock provider, `setResponseTimeout`). They never call a real model. They change settings at the Global target and reset them in `teardown`. The Claude Code CLI suite uses a fake `/bin/sh` `claude` script and is skipped on Windows. Tests that need "no LLM available" skip themselves when the test VS Code exposes any `vscode.lm` model.

## Architecture

Flow of one generation, orchestrated by `Generator` in `src/commands/generate.ts`:

1. **Repository & run tracking** — `git/gitApi.ts` `resolveRepository` picks the target repo: SCM menu arg (a `SourceControl` with `rootUri`) → the only repo → the repo selected in Source Control (keybinding arg `{ fromCommitBox: true }` only) → the active editor's repo → a quick pick. At most one run per repo root: running again for the same repo cancels the previous run and starts over; `stop` with no arg (Command Palette) cancels every run. The `intellicommit.generatingRepos` context key swaps the ✨ button for Stop in `package.json` menus.
2. **Provider resolution** — `llm/resolver.ts` (`ProviderResolver`) walks `sourceOrder(intellicommit.source)` (`llm/sources.ts`) and returns the first *available* source; fallback happens only when a source is unavailable, never when a request fails. Resolves afresh for every generation; `MODEL_SETTINGS` changes clear the cached CLI lookup. Both backends implement `CommitMessageProvider` (`llm/provider.ts`): streamed `generate`, `maxInputTokens`, `countTokens`.
   - `llm/claudeCode/` — spawns `claude --print ... --output-format stream-json` (`protocol.ts` builds args/env and parses lines) in a fresh empty temp dir so no project files or settings leak in. `cli.ts` locates the binary (setting → PATH → installer locations) and handles Windows `.cmd` shims via cmd.exe with strict quoting. Token counts are estimated (chars/3), input limit assumed 200k.
   - `llm/vscodeLmProvider.ts` + `llm/modelSelection.ts` — `vscode.lm` models, chosen by explicit `intellicommit.model`, then `preferredModels`, then cheapest.
3. **Change collection** — `git/changes.ts`: staged changes if any, otherwise all changes including untracked files read as pseudo-diffs (`git/diffUtils.ts`). Never stages anything. `git/globs.ts` applies `SECRET_GLOBS` + `excludeGlobs` (content omitted, name still listed). Binary, symlinks, and >200 KB untracked files are omitted. Paths are always repo-relative.
4. **Prompt & budget** — `prompt/buildPrompt.ts` builds instructions (style resolved from recent commit subjects for `auto`) and the changes header; `prompt/budget.ts` `fitDiff` degrades full diff → per-file truncation (binary search on per-file limit) → file-stat summary to fit both the token budget and `maxDiffChars`.
5. **Streaming into the commit box** — fragments are formatted with `prompt/formatCommitMessage.ts` (safe on partial output; strips preambles/fences, enforces subject/body rules, unwraps body paragraphs and list items to one line each) and written via `CommitBox`. If the user edits the box mid-stream, generation stops and their text is kept; on cancel/error the original text is restored. `IdleTimer` aborts after `RESPONSE_TIMEOUT_MS` without a fragment; output is capped at `MAX_MESSAGE_CHARS`.
6. **Errors** — everything is normalized to `IntelliCommitError` with an `ErrorKind` (`errors.ts`, `errorKind.ts`) and surfaced through `ui/messages.ts`.

`src/typings/git.d.ts` is the vendored Git extension API. Its `Status` is an ambient const enum with no runtime object, so `changes.ts` keeps its own numeric copy.

## Conventions and gotchas

- **Settings schema ↔ code:** the code validates settings itself (`config.ts`), and `test/unit/manifest.test.ts` asserts that defaults/enums/bounds in `package.json` match constants in the source (`DEFAULT_EXCLUDE_GLOBS`, `DEFAULT_PREFERRED_MODELS`, `CLAUDE_CODE_MODELS`, `SOURCE_SETTINGS`, diff-char bounds, `MAX_CUSTOM_INSTRUCTIONS_CHARS`). Change both together.
- **Two config readers:** `getConfig(repo.rootUri)` reads resource-scoped settings per repository; `getModelConfig()` reads only application/machine-scoped model settings. A new setting must go in the reader that matches its `scope` in `package.json`. A resource setting that changes what is sent to the model also belongs in `capabilities.untrustedWorkspaces.restrictedConfigurations`.
- **Error kinds drive the UI:** `ui/messages.ts` offers "Select Source" only for model-related kinds (`noModels`, `accessDenied`, `quota`, `blocked`, `timeout`). `cancelled` is never shown, only logged. Map new failures to the right `ErrorKind`, not `unknown`.
- **Localization:** manifest strings use `%key%` placeholders resolved from `package.nls.json`; runtime user-facing strings go through `vscode.l10n.t(...)`, and `npm run l10n` must be rerun after adding/changing them. Log messages (`log()`) are not localized.
- **No in-box button:** the `scm/inputBox` menu is a proposed API the Marketplace rejects; the ⌥↩ / Alt+Enter keybinding (`when: scmRepository`) covers the commit box instead.
- Behavior changes or new settings should be reflected in `README.md` and `CHANGELOG.md`. Commit messages follow the README's "Commit message format" section (imperative, ≤50/72-char subject, no trailing period).
- CI (`.github/workflows/ci.yml`) runs types, lint, and unit tests on Linux/Windows/macOS, plus integration tests on all three and `vsce package` on Linux; keep code cross-platform (notably Windows process spawning/termination).
