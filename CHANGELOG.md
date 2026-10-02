# Changelog

All notable changes to IntelliCommit are documented here.

## [1.1.0] - 2026-10-02

- Typing in the commit box while a message is being written stops the generation and keeps your text, instead of overwriting it.
- A request is cancelled with an error when the language model stops responding for 60 seconds; a hanging Claude Code CLI is stopped.
- Press ⌥↩ (Alt+Enter on Windows and Linux) in the commit box to generate a commit message. Until you first use it, a one-time notification mentions it after the first message.
- Removed the status bar item. Choose the LLM source from the **…** menu of the Source Control view or the Command Palette.
- While a message is being generated, the ✨ button turns into a neutral Stop button in the same place.
- The description is no longer hard-wrapped at 72 characters: each paragraph or list item is one line, so the commit box no longer shows stray line breaks.
- Commit messages are shorter: they say what changed rather than how, and use a summary line only unless there are several distinct changes, which are listed briefly.
- Removed the locally built variant with a button inside the commit box; use the keyboard shortcut instead.
- Files matching `intellicommit.excludeGlobs` are also left out when your Git config sets `diff.noprefix`, `diff.mnemonicPrefix` or `diff.srcPrefix`/`diff.dstPrefix`; previously their contents could be sent.
- A renamed or copied file is excluded when its old path is excluded, e.g. `.env` renamed to `notes.txt`.
- Likely secrets in other files are replaced with `[REDACTED]` before sending: private keys, passwords in URLs, and well-known token formats.
- The contents of more credential files are never sent: `.yarnrc.yml`, `.dev.vars`, `.vault-token`, `.s3cfg`, `.boto`, Cargo and RubyGems credentials, Terraform CLI credentials, and `*.pkcs12`.

## [1.0.0] - 2026-10-02

- Initial release.
