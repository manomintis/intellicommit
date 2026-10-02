# Changelog

All notable changes to IntelliCommit are documented here.

## [Unreleased]

- Typing in the commit box while a message is being written stops the generation and keeps your text, instead of overwriting it.
- A request is cancelled with an error when the language model stops responding for 60 seconds; a hanging Claude Code CLI is stopped.
- Press ⌥↩ (Alt+Enter on Windows and Linux) in the commit box to generate a commit message. Until you first use it, a one-time notification mentions it after the first message.
- Removed the status bar item. Choose the LLM source from the **…** menu of the Source Control view or the Command Palette.
- Removed the locally built variant with a button inside the commit box; use the keyboard shortcut instead.

## [1.0.0] - 2026-10-02

- Initial release.
