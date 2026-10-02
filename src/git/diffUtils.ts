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
 */
export function parseDiff(diff: string, isExcluded: (path: string) => boolean): FilteredDiff {
  const included: FileDiff[] = [];
  const omitted: OmittedFile[] = [];
  for (const section of splitSections(diff)) {
    const hunkStart = section.indexOf('\n@@');
    const headerLines = toLines(hunkStart === -1 ? section : section.slice(0, hunkStart));
    const { path, binary } = parseHeader(headerLines);
    if (isExcluded(path)) {
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

function parseHeader(lines: readonly string[]): { path: string; binary: boolean } {
  let path = pathFromDiffGitLine(lines[0] ?? '');
  let binary = false;
  for (const line of lines) {
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true;
    } else if (line.startsWith('+++ ')) {
      // Git appends a tab to this line when the path contains a space.
      const target = unquoteGitPath(line.slice('+++ '.length).replace(/\t$/, ''));
      if (target.startsWith('b/')) {
        path = target.slice('b/'.length);
      }
    } else if (line.startsWith('rename to ')) {
      path = unquoteGitPath(line.slice('rename to '.length));
    }
  }
  return { path, binary };
}

/** The new path from a `diff --git a/<old> b/<new>` line, where either path may be quoted. */
function pathFromDiffGitLine(line: string): string {
  const paths = line.slice(SECTION_START.length);
  let target: string;
  if (paths.startsWith('"')) {
    target = paths.slice(quotedLength(paths) + 1);
  } else if (paths.endsWith('"')) {
    // An unquoted path never contains a quote, so the first one opens the new path.
    target = paths.slice(paths.indexOf('"'));
  } else {
    return DIFF_GIT_RE.exec(line)?.[2] ?? paths;
  }
  const decoded = unquoteGitPath(target);
  return decoded.startsWith('b/') ? decoded.slice('b/'.length) : decoded;
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
