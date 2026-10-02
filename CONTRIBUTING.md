# Contributing to IntelliCommit

Thank you for your interest in improving IntelliCommit. This guide explains how to set up the project, check your changes, and submit them.

## Reporting problems and suggesting ideas

- Search the [existing issues](https://github.com/manomintis/intellicommit/issues) first.
- When reporting a bug, include your VS Code version, operating system, the LLM source and model you use, and any relevant lines from **Output › IntelliCommit**. Remove anything private, such as file contents or tokens, before posting.
- For larger changes, please open an issue to discuss the idea before starting work.

## Setting up the project

You need [Node.js](https://nodejs.org/) (current LTS version) and VS Code 1.91 or newer.

```sh
git clone https://github.com/manomintis/intellicommit.git
cd intellicommit
npm install
```

To try the extension, open the folder in VS Code and press <kbd>F5</kbd>.

## Useful commands

| Command | What it does |
|---|---|
| `npm run compile` | Checks types, runs the linter, and builds the extension. |
| `npm run test:unit` | Runs the unit tests. These are fast and don't need VS Code. |
| `npm test` | Runs the unit tests and the integration tests. The first run downloads a copy of VS Code. |
| `npm run package:vsix` | Builds the `.vsix` file published to the Marketplace. |
| `npm run l10n` | Updates `l10n/bundle.l10n.json` after you add or change user-facing text. |

## Before you open a pull request

1. Make sure everything passes:
   ```sh
   npm run compile
   npm test
   ```
2. Add or update tests for any change in behavior. Unit tests live in `test/unit/`, and integration tests in `test/integration/`.
3. If you changed user-facing text, run `npm run l10n` and include the updated file.
4. If you changed how the extension behaves or added a setting, update `README.md`, and add a line to `CHANGELOG.md`.
5. Keep each pull request focused on one change, and write commit messages in the style described in the README's [Commit message format](README.md#commit-message-format) section.

Every pull request is checked automatically on Linux, Windows, and macOS: types, lint, unit tests, and integration tests on all three, plus packaging on Linux. A pull request is ready to merge once these checks pass and it has been reviewed.

## Why VS Code 1.91 is the minimum version

The extension relies on two VS Code features: the Language Model API, which became stable in 1.90, and the Git extension's list of untracked changes (`RepositoryState.untrackedChanges`), added in 1.91. The second is needed to describe new files when nothing is staged.

## License

By contributing, you agree that your contributions are released under the project's [MIT License](LICENSE).
