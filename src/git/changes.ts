import { posix } from 'node:path';
import * as vscode from 'vscode';
import { log } from '../log';
import { MIN_CHARS_PER_FILE, truncateFile } from '../prompt/budget';
import type { Change, Repository } from '../typings/git';
import {
  decideMode,
  looksBinary,
  parseDiff,
  untrackedToPseudoDiff,
  type ChangeMode,
  type FileDiff,
  type FileEntry,
  type FileStatusLabel,
  type FilteredDiff,
  type OmitReason,
} from './diffUtils';
import { createExcludeMatcher, SECRET_GLOBS } from './globs';

/**
 * Numeric values of the git extension's `Status` const enum. It is declared in
 * an ambient .d.ts, so it cannot be inlined by esbuild and has no runtime object.
 */
const Status = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
} as const;

/** Untracked files larger than this are listed by name only. */
const MAX_UNTRACKED_BYTES = 200_000;

export interface CollectedChanges {
  readonly mode: Exclude<ChangeMode, 'none'>;
  readonly files: readonly FileEntry[];
  readonly diff: FilteredDiff;
}

/** Cheap check from the cached Git status; reads no files. */
export function hasChanges(repo: Repository): boolean {
  return classify(repo).mode !== 'none';
}

function classify(repo: Repository): { mode: ChangeMode; trackedWorkingTree: Change[]; untracked: Change[] } {
  const state = repo.state;
  const untrackedInWorkingTree = state.workingTreeChanges.filter((c) => statusLabel(c.status) === 'untracked');
  const trackedWorkingTree = state.workingTreeChanges.filter((c) => statusLabel(c.status) !== 'untracked');
  const untracked = [...state.untrackedChanges, ...untrackedInWorkingTree];
  const mode = decideMode({
    staged: state.indexChanges.length,
    workingTree: trackedWorkingTree.length,
    untracked: untracked.length,
    merge: state.mergeChanges.length,
  });
  return { mode, trackedWorkingTree, untracked };
}

/**
 * Staged changes only, if any; otherwise all changes including untracked
 * files, as if they were staged. Returns undefined when there is nothing to describe.
 * Read-only: never stages anything.
 *
 * Untracked files are read only while the diff can still show every included file at
 * its minimum truncated size within `maxDiffChars`; the rest are listed by name.
 */
export async function collectChanges(
  repo: Repository,
  excludeGlobs: readonly string[],
  maxDiffChars: number,
): Promise<CollectedChanges | undefined> {
  const state = repo.state;
  const { mode, trackedWorkingTree, untracked } = classify(repo);
  if (mode === 'none') {
    return undefined;
  }

  const root = repo.rootUri;
  const isExcluded = createExcludeMatcher([...SECRET_GLOBS, ...excludeGlobs], (glob) => {
    log().warn(`Ignoring invalid pattern in intellicommit.excludeGlobs: ${glob}`);
  });
  const conflicts = state.mergeChanges.map((c): FileEntry => ({ path: relativePath(root, c.uri), status: 'conflicted' }));

  if (mode === 'staged') {
    const diff = parseDiff(await repo.diff(true), isExcluded);
    return {
      mode,
      files: [...state.indexChanges.map((c) => toEntry(root, c)), ...conflicts],
      diff,
    };
  }

  const tracked = parseDiff(await repo.diff(false), isExcluded);
  const included: FileDiff[] = [...tracked.included];
  const omitted = [...tracked.omitted];
  let footprint = included.reduce((sum, file) => sum + minimumFootprint(file), 0);
  for (const change of untracked) {
    const path = relativePath(root, change.uri);
    if (isExcluded(path)) {
      omitted.push({ path, reason: 'excluded' });
      continue;
    }
    if (footprint >= maxDiffChars) {
      omitted.push({ path, reason: 'diff size limit' });
      continue;
    }
    const result = await readUntracked(change.uri);
    if (typeof result === 'string') {
      const file = untrackedToPseudoDiff(path, result);
      included.push(file);
      footprint += minimumFootprint(file);
    } else {
      omitted.push({ path, reason: result.reason });
    }
  }

  return {
    mode,
    files: [
      ...trackedWorkingTree.map((c) => toEntry(root, c)),
      ...untracked.map((c) => toEntry(root, c)),
      ...conflicts,
    ],
    diff: { included, omitted },
  };
}

async function readUntracked(uri: vscode.Uri): Promise<string | { reason: OmitReason }> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    // `stat` and `readFile` follow links; Git records only the link target, never the content behind it.
    if (stat.type & vscode.FileType.SymbolicLink) {
      return { reason: 'symbolic link' };
    }
    if (stat.type & vscode.FileType.Directory) {
      return { reason: 'directory' };
    }
    if (stat.size > MAX_UNTRACKED_BYTES) {
      return { reason: 'too large' };
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (looksBinary(bytes)) {
      return { reason: 'binary' };
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    // Deleted between status and read, or not readable by the user.
    return { reason: 'unreadable' };
  }
}

/** Characters a file takes in the diff when truncated as far as `fitDiff` goes. */
function minimumFootprint(file: FileDiff): number {
  return truncateFile(file, MIN_CHARS_PER_FILE).length + 1;
}

function toEntry(root: vscode.Uri, change: Change): FileEntry {
  const status = statusLabel(change.status);
  if (status === 'renamed' && change.renameUri) {
    return { path: relativePath(root, change.renameUri), status, originalPath: relativePath(root, change.originalUri) };
  }
  return { path: relativePath(root, change.uri), status };
}

function statusLabel(status: number): FileStatusLabel {
  switch (status) {
    case Status.INDEX_MODIFIED:
    case Status.MODIFIED:
      return 'modified';
    case Status.INDEX_ADDED:
    case Status.INTENT_TO_ADD:
      return 'added';
    case Status.INDEX_DELETED:
    case Status.DELETED:
      return 'deleted';
    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
      return 'renamed';
    case Status.INDEX_COPIED:
      return 'copied';
    case Status.UNTRACKED:
      return 'untracked';
    case Status.TYPE_CHANGED:
      return 'type changed';
    default:
      return 'conflicted';
  }
}

/** Repository-relative path; never absolute, so local folder names don't reach the model. */
function relativePath(root: vscode.Uri, uri: vscode.Uri): string {
  return posix.relative(root.path, uri.path);
}
