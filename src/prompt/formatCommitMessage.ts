export type ResolvedStyle = 'traditional' | 'conventional' | 'gitmoji';

export const SUBJECT_TARGET = 50;
export const SUBJECT_MAX = 72;

export interface FormatResult {
  readonly message: string;
  readonly warnings: readonly string[];
}

export const CONVENTIONAL_RE = /^(\w+)(\([^)]*\))?(!)?:\s*(.*)$/;
const PREAMBLE_RE =
  /^(?:(?:sure|certainly|okay)[,!.].*|here(?:'s| is| are)\b.*|(?:suggested |proposed |generated )?commit message\s*:?\s*)$/i;
const SUBJECT_LABEL_RE = /^(?:subject|title|summary)\s*:\s*/i;
const TRAILER_RE = /^(?:[A-Za-z]+(?:-[A-Za-z]+)+|Refs?|Fixes|Closes|Resolves|BREAKING CHANGE): \S/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+/;
// Emoji (with variation selectors and ZWJ sequences) or a `:shortcode:` at the start of a gitmoji subject.
export const LEADING_GITMOJI_RE = /^((?::[a-z0-9_+-]+:|\p{Extended_Pictographic}(?:\u{FE0F}|\u200D\p{Extended_Pictographic})*)\s*)/u;

/**
 * Cleans up raw model output and enforces the commit conventions.
 * Safe to call on partial (streaming) output.
 */
export function formatCommitMessage(raw: string, style: ResolvedStyle): FormatResult {
  const warnings: string[] = [];
  let lines = stripWrapping(raw.replace(/\r\n?/g, '\n')).split('\n').map((l) => l.trimEnd());

  lines = dropLeadingNoise(lines);
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return { message: '', warnings };
  }

  const subject = formatSubject(lines[0] ?? '', style);
  const bodyLines = lines.slice(1);
  while (bodyLines.length > 0 && bodyLines[0]?.trim() === '') {
    bodyLines.shift();
  }

  const body = formatBody(bodyLines);
  const subjectLength = displayLength(subject);
  if (subjectLength > SUBJECT_MAX) {
    warnings.push(`Subject line is ${subjectLength} characters (maximum ${SUBJECT_MAX}).`);
  }
  return { message: body ? `${subject}\n\n${body}` : subject, warnings };
}

/** Removes code fences and quotes that wrap the whole message. */
function stripWrapping(text: string): string {
  let result = text.trim();
  // A fenced block anywhere: keep only its content (handles preamble + fence).
  const fenced = /```[^\n`]*\n([\s\S]*?)(?:\n```|$)/.exec(result);
  if (fenced) {
    result = (fenced[1] ?? '').trim();
  }
  result = result.replace(/^```[^\n]*$/gm, '').trim();

  for (const quote of ['"""', "'''", '"', "'", '`', '“']) {
    const close = quote === '“' ? '”' : quote;
    if (result.length > quote.length + close.length && result.startsWith(quote) && result.endsWith(close)) {
      const inner = result.slice(quote.length, result.length - close.length);
      if (!inner.includes(quote === '“' ? '“' : quote)) {
        result = inner.trim();
        break;
      }
    }
  }
  return result;
}

/** Drops chatty preambles ("Here is a commit message:") and empty lines before the subject. */
function dropLeadingNoise(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length) {
    const line = (lines[start] ?? '').trim();
    if (line === '' || (PREAMBLE_RE.test(line) && (line.endsWith(':') || start + 1 < lines.length))) {
      start++;
      continue;
    }
    break;
  }
  return lines.slice(start);
}

function formatSubject(line: string, style: ResolvedStyle): string {
  let subject = line
    .trim()
    .replace(SUBJECT_LABEL_RE, '')
    .replace(/^#+\s*/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^["'`](.*)["'`]$/, '$1')
    .trim();
  subject = subject.replace(/\s*\.+$/, (m) => (m.trim() === '...' ? m : ''));

  const conventional = CONVENTIONAL_RE.exec(subject);
  if (style === 'conventional' && conventional) {
    const [, type = '', scope = '', bang = '', description = ''] = conventional;
    return `${type.toLowerCase()}${scope}${bang}: ${lowerFirst(toImperative(description))}`;
  }

  if (style === 'gitmoji') {
    const emoji = LEADING_GITMOJI_RE.exec(subject);
    if (emoji) {
      const rest = subject.slice(emoji[0].length);
      return `${emoji[1]?.trim() ?? ''} ${upperFirst(toImperative(rest))}`;
    }
  }

  return upperFirst(toImperative(subject));
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Lowercases the first letter unless the first word has more capitals, like "API" or "TypeScript". */
function lowerFirst(text: string): string {
  const firstWord = /^\S+/.exec(text)?.[0] ?? '';
  if (/\p{Lu}/u.test(firstWord.slice(1))) {
    return text;
  }
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const BASE_VERBS = [
  'add', 'adjust', 'allow', 'apply', 'avoid', 'bump', 'change', 'clean', 'clarify', 'configure',
  'convert', 'correct', 'create', 'deprecate', 'delete', 'disable', 'document', 'drop', 'enable',
  'ensure', 'expose', 'extract', 'fix', 'handle', 'implement', 'improve', 'include', 'initialize',
  'introduce', 'merge', 'migrate', 'move', 'optimize', 'prevent', 'refactor', 'reformat', 'remove',
  'rename', 'reorganize', 'replace', 'restore', 'revert', 'rework', 'simplify', 'support', 'switch',
  'tweak', 'update', 'upgrade', 'use', 'validate',
] as const;

const IRREGULAR: Readonly<Record<string, string>> = {
  made: 'make', makes: 'make', making: 'make',
  sets: 'set', setting: 'set',
  wrote: 'write', written: 'write', writes: 'write', writing: 'write',
  rewrote: 'rewrite', rewritten: 'rewrite', rewrites: 'rewrite', rewriting: 'rewrite',
  splits: 'split', splitting: 'split',
  built: 'build', builds: 'build', building: 'build',
  dropped: 'drop', dropping: 'drop',
};

function inflections(base: string): string[] {
  const forms: string[] = [];
  const endsWithE = base.endsWith('e');
  const consonantY = /[^aeiou]y$/.test(base);
  // third person
  forms.push(/(?:s|x|z|ch|sh)$/.test(base) ? `${base}es` : consonantY ? `${base.slice(0, -1)}ies` : `${base}s`);
  // past
  forms.push(endsWithE ? `${base}d` : consonantY ? `${base.slice(0, -1)}ied` : `${base}ed`);
  // gerund
  forms.push(endsWithE ? `${base.slice(0, -1)}ing` : `${base}ing`);
  return forms;
}

const TO_BASE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>(Object.entries(IRREGULAR));
  for (const base of BASE_VERBS) {
    for (const form of inflections(base)) {
      map.set(form, base);
    }
  }
  return map;
})();

/** Rewrites a leading past-tense / third-person / gerund verb into the imperative. */
export function toImperative(text: string): string {
  const match = /^([A-Za-z]+)(.*)$/s.exec(text);
  if (!match) {
    return text;
  }
  const [, word = '', rest = ''] = match;
  const base = TO_BASE.get(word.toLowerCase());
  if (!base) {
    return text;
  }
  const isCapitalized = /^[A-Z]/.test(word);
  return (isCapitalized ? upperFirst(base) : base) + rest;
}

function formatBody(lines: readonly string[]): string {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
    } else {
      current.push(stripMarkdown(line));
    }
  }
  if (current.length > 0) {
    paragraphs.push(current);
  }
  return paragraphs.map(formatParagraph).join('\n\n');
}

function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^(\s*)[*+]\s+/, '$1- ');
}

function formatParagraph(lines: readonly string[]): string {
  // Trailers (Signed-off-by:, Refs:, BREAKING CHANGE:) and code blocks stay intact.
  if (lines.every((l) => TRAILER_RE.test(l) && !LIST_ITEM_RE.test(l)) && !lines.every((l) => l.startsWith('BREAKING CHANGE: '))) {
    return lines.join('\n');
  }
  if (lines.every((l) => /^( {4}|\t)/.test(l))) {
    return lines.join('\n');
  }

  // Group into list items (with continuation lines) and plain text runs, unwrapping hard breaks.
  const blocks: { indent: string; marker: string; words: string[] }[] = [];
  for (const line of lines) {
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      blocks.push({ indent: item[1] ?? '', marker: `${item[2] ?? '-'} `, words: words(line.slice(item[0].length)) });
    } else {
      const last = blocks[blocks.length - 1];
      if (last && (last.marker !== '' || !/^\s/.test(line))) {
        last.words.push(...words(line));
      } else {
        blocks.push({ indent: '', marker: '', words: words(line) });
      }
    }
  }
  // One line per paragraph or list item; the commit box and Git tools soft-wrap it to fit.
  return blocks.map((b) => b.indent + b.marker + b.words.join(' ')).join('\n');
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter((w) => w.length > 0);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Length in user-perceived characters (an emoji counts as one). */
export function displayLength(text: string): number {
  return Array.from(graphemes.segment(text)).length;
}
