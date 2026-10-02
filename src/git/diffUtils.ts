/** Which set of changes a generation describes. */
export type ChangeMode = 'staged' | 'all' | 'none';

export interface ChangeCounts {
  readonly staged: number;
  readonly workingTree: number;
  readonly untracked: number;
  readonly merge: number;
}

/**
 * Staged changes win. Otherwise everything (tracked, untracked and conflicted)
 * is described as if it were staged. With nothing at all, there is nothing to do.
 */
export function decideMode(counts: ChangeCounts): ChangeMode {
  if (counts.staged > 0) {
    return 'staged';
  }
  if (counts.workingTree > 0 || counts.untracked > 0 || counts.merge > 0) {
    return 'all';
  }
  return 'none';
}

export type FileStatusLabel =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'type changed';

export interface FileEntry {
  /** Repo-relative path with forward slashes. */
  readonly path: string;
  readonly status: FileStatusLabel;
  /** Previous path for renames. */
  readonly originalPath?: string;
}

/** One file section of a unified diff. */
export interface FileDiff {
  readonly path: string;
  /** `diff --git` line plus metadata up to (excluding) the first hunk. */
  readonly header: string;
  readonly hunks: readonly string[];
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
}

export type OmitReason = 'excluded' | 'binary' | 'too large' | 'symbolic link' | 'directory' | 'unreadable' | 'diff size limit';

export interface OmittedFile {
  readonly path: string;
  readonly reason: OmitReason;
}

export interface FilteredDiff {
  readonly included: readonly FileDiff[];
  /** Files kept out of the diff text; the model is only told their names. */
  readonly omitted: readonly OmittedFile[];
}

const SECTION_START = 'diff --git ';
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Splits `git diff` output into per-file sections, leaving out excluded and binary
 * files. Omitted files are identified from their header alone, so a large lockfile
 * diff is never split into lines.
 *
 * `knownPaths` are the repo-relative paths Git reports as changed. They identify a
 * section's file whatever prefixes the user's Git config puts in the diff
 * (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`/`dstPrefix`).
 */
export function parseDiff(
  diff: string,
  isExcluded: (path: string) => boolean,
  knownPaths: ReadonlySet<string> = new Set(),
): FilteredDiff {
  const included: FileDiff[] = [];
  const omitted: OmittedFile[] = [];
  for (const section of splitSections(diff)) {
    const hunkStart = section.indexOf('\n@@');
    const headerLines = toLines(hunkStart === -1 ? section : section.slice(0, hunkStart));
    const { path, alsoCheck, binary } = parseHeader(headerLines, knownPaths);
    if (isExcluded(path) || alsoCheck.some(isExcluded)) {
      omitted.push({ path, reason: 'excluded' });
    } else if (binary) {
      omitted.push({ path, reason: 'binary' });
    } else {
      included.push(parseFile(path, headerLines, hunkStart === -1 ? '' : section.slice(hunkStart + 1)));
    }
  }
  return { included, omitted };
}

function splitSections(diff: string): string[] {
  const starts = diff.startsWith(SECTION_START) ? [0] : [];
  for (let i = diff.indexOf(`\n${SECTION_START}`); i !== -1; i = diff.indexOf(`\n${SECTION_START}`, i + 1)) {
    starts.push(i + 1);
  }
  return starts.map((start, index) => diff.slice(start, starts[index + 1] ?? diff.length));
}

function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

interface Header {
  /** The file's (new) path. */
  readonly path: string;
  /**
   * Other paths the exclude patterns must not match: the old path of a rename or copy,
   * and, when the path could not be confirmed, every way of reading the header.
   */
  readonly alsoCheck: readonly string[];
  readonly binary: boolean;
}

function parseHeader(lines: readonly string[], knownPaths: ReadonlySet<string>): Header {
  const diffGitLine = lines[0] ?? '';
  let binary = false;
  let renamedTo: string | undefined;
  let renamedFrom: string | undefined;
  let plusPath: string | undefined;
  let minusPath: string | undefined;
  for (const line of lines) {
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true;
    } else if (line.startsWith('+++ ')) {
      plusPath = headerPath(line.slice('+++ '.length));
    } else if (line.startsWith('--- ')) {
      minusPath = headerPath(line.slice('--- '.length));
    } else if (/^(?:rename|copy) to /.test(line)) {
      renamedTo = unquoteGitPath(line.replace(/^\w+ to /, ''));
    } else if (/^(?:rename|copy) from /.test(line)) {
      renamedFrom = unquoteGitPath(line.replace(/^\w+ from /, ''));
    }
  }

  const oldPath = renamedFrom ?? (minusPath?.startsWith('a/') ? minusPath.slice('a/'.length) : undefined);
  const alsoCheck = oldPath === undefined ? [] : [oldPath];
  const newSide = newSideOfDiffGitLine(diffGitLine);
  const confirmed =
    renamedTo ??
    defaultPrefixPath(diffGitLine) ??
    knownPath(newSide, knownPaths) ??
    (plusPath?.startsWith('b/') ? plusPath.slice('b/'.length) : undefined) ??
    (plusPath === '/dev/null' && minusPath?.startsWith('a/') ? minusPath.slice('a/'.length) : undefined);
  if (confirmed !== undefined) {
    return { path: confirmed, alsoCheck, binary };
  }
  // Unknown prefixes: the path is a guess, so the excludes are checked against every reading of it.
  return { path: stripPrefix(newSide), alsoCheck: [...alsoCheck, ...pathSuffixes(newSide)], binary };
}

/** A path from a `---`/`+++` line; git appends a tab to it when the path contains a space. */
function headerPath(text: string): string {
  return unquoteGitPath(text.replace(/\t$/, ''));
}

/**
 * The new side of a `diff --git <old> <new>` line, decoded. When neither path is
 * quoted, the two cannot be told apart reliably, so both are returned.
 */
function newSideOfDiffGitLine(line: string): string {
  const paths = line.slice(SECTION_START.length);
  if (paths.startsWith('"')) {
    return unquoteGitPath(paths.slice(quotedLength(paths) + 1));
  }
  if (paths.endsWith('"')) {
    // An unquoted path never contains a quote, so the first one opens the new path.
    return unquoteGitPath(paths.slice(paths.indexOf('"')));
  }
  return paths;
}

/** The path from `diff --git a/<path> b/<path>`, the default format for a file that kept its name. */
function defaultPrefixPath(line: string): string | undefined {
  const paths = line.slice(SECTION_START.length);
  const path = paths.slice('a/'.length, 'a/'.length + (paths.length - 'a/ b/'.length) / 2);
  return path !== '' && paths === `a/${path} b/${path}` ? path : undefined;
}

/** Best guess when the path is not confirmed: the new side without the default `a/`/`b/` prefixes. */
function stripPrefix(newSide: string): string {
  const match = DIFF_GIT_RE.exec(`${SECTION_START}${newSide}`);
  return match?.[2] ?? (newSide.startsWith('b/') ? newSide.slice('b/'.length) : newSide);
}

/** `text` and every suffix of it that starts after a space or a slash, longest first. */
function pathSuffixes(text: string): string[] {
  const suffixes = [text];
  for (let i = 1; i < text.length; i++) {
    const before = text.charAt(i - 1);
    if (before === ' ' || before === '/') {
      suffixes.push(text.slice(i));
    }
  }
  return suffixes;
}

/**
 * The longest known path the new side ends with, preceded by at most one prefix
 * segment such as `i/`. Requiring that keeps `x` from being taken for `dir/x` when
 * Git's status lists only `x`.
 */
function knownPath(newSide: string, knownPaths: ReadonlySet<string>): string | undefined {
  if (knownPaths.size === 0) {
    return undefined;
  }
  return pathSuffixes(newSide).find((suffix) => {
    if (!knownPaths.has(suffix)) {
      return false;
    }
    const before = newSide.slice(0, newSide.length - suffix.length);
    return /^[^/]*\/?$/.test(before.slice(before.lastIndexOf(' ') + 1));
  });
}

/** Length of the quoted string at the start of `text`, including both quotes. */
function quotedLength(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '"') {
      return i + 1;
    }
  }
  return text.length;
}

const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * Decodes a path that git wrote as a C-style quoted string, which it does for names
 * with non-ASCII bytes (`core.quotePath`), quotes, backslashes or control characters.
 * Other paths are returned unchanged.
 */
export function unquoteGitPath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) {
    return text;
  }
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const [, octal, escaped, literal] of text.slice(1, -1).matchAll(/\\([0-7]{3})|\\(.)|([^\\]+)/gsu)) {
    if (octal !== undefined) {
      bytes.push(parseInt(octal, 8));
    } else if (escaped !== undefined) {
      bytes.push(C_ESCAPES[escaped] ?? escaped.charCodeAt(0));
    } else if (literal !== undefined) {
      bytes.push(...encoder.encode(literal));
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function parseFile(path: string, headerLines: string[], body: string): FileDiff {
  const hunks: string[][] = [];
  let current: string[] | undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of body === '' ? [] : toLines(body)) {
    if (line.startsWith('@@')) {
      current = [line];
      hunks.push(current);
      continue;
    }
    current?.push(line);
    if (line.startsWith('+')) {
      additions++;
    } else if (line.startsWith('-')) {
      deletions++;
    }
  }
  return {
    path,
    header: joinWithoutTrailingBlankLines(headerLines),
    hunks: hunks.map(joinWithoutTrailingBlankLines),
    binary: false,
    additions,
    deletions,
  };
}

function joinWithoutTrailingBlankLines(lines: string[]): string {
  let end = lines.length;
  while (end > 1 && lines[end - 1] === '') {
    end--;
  }
  return lines.slice(0, end).join('\n');
}

export function renderFileDiff(file: FileDiff): string {
  return [file.header, ...file.hunks].join('\n');
}

/** Builds a `git diff`-style section for an untracked file's text content. */
export function untrackedToPseudoDiff(path: string, content: string): FileDiff {
  const normalized = content.replace(/\r\n?/g, '\n');
  const hasTrailingNewline = normalized.endsWith('\n');
  const lines = normalized === '' ? [] : (hasTrailingNewline ? normalized.slice(0, -1) : normalized).split('\n');
  const header = [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`].join('\n');
  const hunks: string[] = [];
  if (lines.length > 0) {
    const body = lines.map((l) => `+${l}`);
    if (!hasTrailingNewline) {
      body.push('\\ No newline at end of file');
    }
    hunks.push([`@@ -0,0 +1,${lines.length} @@`, ...body].join('\n'));
  }
  return { path, header, hunks, binary: false, additions: lines.length, deletions: 0 };
}

/** Heuristic used by git itself: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}
