import type { ChangeMode, FileEntry, FilteredDiff, OmitReason } from '../git/diffUtils';
import type { PromptInput } from '../llm/provider';
import { CONVENTIONAL_RE, LEADING_GITMOJI_RE, SUBJECT_MAX, SUBJECT_TARGET, type ResolvedStyle } from './formatCommitMessage';

export type StyleSetting = ResolvedStyle | 'auto';

/** Longest custom instructions sent; matches the `maxLength` of the setting's schema. */
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 2000;

/**
 * `auto` follows the style that more than half of the recent subjects use.
 * Without a clear majority (or without history) it uses `conventional`.
 */
export function resolveStyle(setting: StyleSetting, recentSubjects: readonly string[]): ResolvedStyle {
  if (setting !== 'auto') {
    return setting;
  }
  const subjects = recentSubjects.map((s) => s.trim()).filter((s) => s !== '' && !s.startsWith('Merge '));
  const half = subjects.length / 2;
  const count = (predicate: (s: string) => boolean): number => subjects.filter(predicate).length;
  if (count((s) => LEADING_GITMOJI_RE.test(s)) > half) {
    return 'gitmoji';
  }
  if (count((s) => !CONVENTIONAL_RE.test(s) && !LEADING_GITMOJI_RE.test(s)) > half) {
    return 'traditional';
  }
  return 'conventional';
}

export interface PromptParams {
  readonly style: ResolvedStyle;
  /** `auto` or a language name. */
  readonly language: string;
  readonly recentSubjects: readonly string[];
  readonly mode: Exclude<ChangeMode, 'none'>;
  readonly files: readonly FileEntry[];
  readonly omitted: FilteredDiff['omitted'];
  readonly customInstructions: string;
}

const COMMON_RULES = [
  'Use the imperative mood: the subject must complete the sentence "If applied, this commit will ...". Write "Add", "Fix", "Remove", never "Added", "Fixes" or "Adding".',
  `Keep the subject line at ${SUBJECT_TARGET} characters or fewer if possible; it must never exceed ${SUBJECT_MAX} characters.`,
  'Do not end the subject line with a period.',
  'Be specific and describe the change as a whole (e.g. "Fix null check in config loader", not "Update files" or "Fix bug").',
  'Be brief: say what was added, changed, fixed or removed, not how. Leave out implementation details such as function names, variables, algorithms and code structure; the diff shows them.',
  'Prefer a subject line only. Add a body only when the commit has several distinct changes that the subject cannot cover.',
  'A body is one blank line after the subject, then a short "- " bullet list with one change per bullet, each a few words long. At most 5 bullets. No paragraphs of explanation. Do not hard-wrap: each bullet is a single line.',
  'Plain text only: no Markdown headings, bold text or code fences.',
  'Do not start with "This commit". Do not add sign-offs, trailers or co-author lines.',
];

const STYLE_RULES: Readonly<Record<ResolvedStyle, readonly string[]>> = {
  traditional: ['Capitalize the first word of the subject line.', 'Do not use emoji or a "type:" prefix.'],
  conventional: [
    'Follow Conventional Commits 1.0: the subject is "type(scope): description", the scope is optional.',
    'Use one of these types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
    'The description after the colon starts with a lowercase letter and uses the imperative mood. The whole subject line counts toward the length limit.',
    'For breaking changes add "!" after the type/scope and a "BREAKING CHANGE: <explanation>" footer after a blank line.',
    'Do not use emoji.',
  ],
  gitmoji: [
    'Start the subject with exactly one gitmoji as a Unicode emoji (not a :shortcode:), followed by a space and a capitalized, imperative description.',
    'Common gitmojis: ✨ new feature, 🐛 bug fix, 📝 documentation, ♻️ refactor, ✅ tests, 🔧 configuration, ⬆️ dependency upgrade, 🔥 remove code or files, 🎨 structure or format, ⚡️ performance, 🔒️ security, 🚑️ critical hotfix.',
    'Use no other emoji anywhere in the message.',
  ],
};

const EXAMPLES: Readonly<Record<ResolvedStyle, readonly string[]>> = {
  traditional: [
    'Fix null check in config loader',
    'Retry failed uploads',
    'Remove unused feature flags\n\n- Drop the legacy search flag\n- Drop the beta banner flag and its setting',
  ],
  conventional: [
    'fix(config): handle missing settings file',
    'feat(upload): retry failed uploads',
    'refactor(settings): simplify settings page\n\n- Merge the general and advanced tabs\n- Remove the unused theme option',
    'refactor!: drop support for the v1 plugin API\n\nBREAKING CHANGE: plugins must implement the v2 interface.',
  ],
  gitmoji: [
    '🐛 Fix null check in config loader',
    '✨ Retry failed uploads',
    '🔥 Remove unused feature flags\n\n- Drop the legacy search flag\n- Drop the beta banner flag and its setting',
  ],
};

export function buildInstructions(params: PromptParams): string {
  const parts: string[] = [
    'You are an expert software engineer writing a Git commit message. Write one commit message for the changes in the next message, following traditional Git commit conventions.',
    'Rules:',
    [...STYLE_RULES[params.style], ...COMMON_RULES].map((r) => `- ${r}`).join('\n'),
    `Examples of good commit messages:\n${EXAMPLES[params.style].map((e) => `---\n${e}`).join('\n')}\n---`,
    languageInstruction(params.language, params.style),
  ];

  if (params.recentSubjects.length > 0) {
    parts.push(
      'Recent commit subjects in this repository, as a style reference only. Follow the rules above even where these subjects do not:\n' +
        params.recentSubjects.map((s) => `- ${s}`).join('\n'),
    );
  }

  const custom = params.customInstructions.trim();
  if (custom !== '') {
    parts.push(`Additional instructions from the user:\n${custom}`);
  }

  parts.push('Output only the commit message itself: no code fences, no quotes, no preamble, no explanation.');
  return parts.join('\n\n');
}

function languageInstruction(language: string, style: ResolvedStyle): string {
  const keepTypes = style === 'conventional' ? ' Keep the Conventional Commits type keywords in English.' : '';
  const value = language.trim();
  if (value === '' || value.toLowerCase() === 'auto') {
    return `Write the message in English, unless the recent commit subjects below are clearly written in another language; then use that language.${keepTypes}`;
  }
  return `Write the message in ${value}.${keepTypes}`;
}

const STATUS_CODE: Readonly<Record<FileEntry['status'], string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'A',
  conflicted: 'U',
  'type changed': 'T',
};

/** Longest file list sent; the rest is summarized as a count so huge change sets stay cheap. */
export const MAX_LISTED_FILES = 200;

/** Everything in the second message except the diff body; its size is bounded by `MAX_LISTED_FILES`. */
export function buildChangesHeader(params: PromptParams): string {
  const lines: string[] = [];
  lines.push(
    params.mode === 'staged'
      ? 'These are the staged changes, exactly what will be committed.'
      : 'Nothing is staged, so these are all uncommitted changes in the working tree, including new untracked files. Describe them as a single commit.',
  );
  if (params.files.some((f) => f.status === 'conflicted')) {
    lines.push('This commit concludes a merge; files marked U had merge conflicts. Mention that the commit resolves a merge.');
  }

  const omitted = new Map(params.omitted.map((o) => [o.path, o.reason]));
  const entries = params.files.map((file) => {
    const from = file.originalPath ? `${file.originalPath} -> ` : '';
    const notes = [file.status === 'untracked' ? 'new file' : '', notShown(omitted.get(file.path))].filter((n) => n !== '');
    omitted.delete(file.path);
    return `${STATUS_CODE[file.status]} ${from}${file.path}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
  });
  // Omitted diff files without a matching status entry are still named.
  for (const [path, reason] of omitted) {
    entries.push(`? ${path} (${notShown(reason)})`);
  }

  lines.push(
    '',
    'Changed files (A added, M modified, D deleted, R renamed, C copied, T type changed, U conflicted). ' +
      'The diff of files marked "diff not shown" is left out; mention them briefly only if relevant, e.g. "update package-lock.json":',
    ...entries.slice(0, MAX_LISTED_FILES),
  );
  if (entries.length > MAX_LISTED_FILES) {
    lines.push(`... and ${entries.length - MAX_LISTED_FILES} more files`);
  }
  return lines.join('\n');
}

function notShown(reason: OmitReason | undefined): string {
  return reason === undefined ? '' : `diff not shown: ${reason}`;
}

export function buildPromptInput(params: PromptParams, diffText: string): PromptInput {
  const header = buildChangesHeader(params);
  const diff = diffText.trim() === '' ? '' : `\n\nDiff:\n${diffText}`;
  return { instructions: buildInstructions(params), changes: header + diff };
}
