import * as assert from 'node:assert/strict';
import { decideMode, looksBinary, parseDiff, renderFileDiff, unquoteGitPath, untrackedToPseudoDiff } from '../../src/git/diffUtils';
import { createExcludeMatcher, DEFAULT_EXCLUDE_GLOBS, SECRET_GLOBS } from '../../src/git/globs';

const SAMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-const a = 1;',
  '+const a = 2;',
  ' export {};',
  '@@ -10,1 +10,2 @@',
  ' x',
  '+y',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1 +1 @@',
  '-1',
  '+2',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

suite('decideMode', () => {
  const cases = [
    { name: 'staged changes win', counts: { staged: 1, workingTree: 3, untracked: 2, merge: 0 }, expected: 'staged' },
    { name: 'nothing staged + modified + untracked', counts: { staged: 0, workingTree: 1, untracked: 1, merge: 0 }, expected: 'all' },
    { name: 'nothing staged + only untracked', counts: { staged: 0, workingTree: 0, untracked: 2, merge: 0 }, expected: 'all' },
    { name: 'nothing staged + merge conflicts', counts: { staged: 0, workingTree: 0, untracked: 0, merge: 1 }, expected: 'all' },
    { name: 'nothing staged + no changes', counts: { staged: 0, workingTree: 0, untracked: 0, merge: 0 }, expected: 'none' },
  ] as const;
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(decideMode(c.counts), c.expected);
    });
  }
});

suite('parseDiff', () => {
  const includeAll = (): boolean => false;
  const pathsOf = (diff: string, isExcluded: (path: string) => boolean = includeAll): string[] => {
    const result = parseDiff(diff, isExcluded);
    return [...result.included, ...result.omitted].map((f) => f.path);
  };

  test('splits files, hunks and stats', () => {
    const { included, omitted } = parseDiff(SAMPLE_DIFF, includeAll);
    assert.deepEqual(
      included.map((f) => [f.path, f.hunks.length, f.additions, f.deletions]),
      [
        ['src/a.ts', 2, 2, 1],
        ['package-lock.json', 1, 1, 1],
      ],
    );
    assert.deepEqual(omitted, [{ path: 'logo.png', reason: 'binary' }]);
    assert.equal(renderFileDiff(included[0]!), SAMPLE_DIFF.split('\n').slice(0, 11).join('\n'));
  });

  test('omits excluded and binary files by name', () => {
    const result = parseDiff(SAMPLE_DIFF, createExcludeMatcher(DEFAULT_EXCLUDE_GLOBS));
    assert.deepEqual(result.included.map((f) => f.path), ['src/a.ts']);
    assert.deepEqual(result.omitted, [
      { path: 'package-lock.json', reason: 'excluded' },
      { path: 'logo.png', reason: 'binary' },
    ]);
  });

  test('uses the new path for renames', () => {
    assert.deepEqual(pathsOf('diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n'), ['new.ts']);
  });

  test('decodes paths that git quotes', () => {
    const diff = [
      'diff --git "a/\\320\\272/.env" "b/\\320\\272/.env"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/\\320\\272/.env"',
      '@@ -0,0 +1 @@',
      '+SECRET=1',
      'diff --git "a/conf\\"x/.env" "b/conf\\"x/.env"',
      'deleted file mode 100644',
      'diff --git "a/\\320\\272/a.txt" "b/conf\\"x/b.txt"',
      'similarity index 100%',
      'rename from "\\320\\272/a.txt"',
      'rename to "conf\\"x/b.txt"',
      '',
    ].join('\n');
    assert.deepEqual(pathsOf(diff), ['к/.env', 'conf"x/.env', 'conf"x/b.txt']);
    assert.deepEqual(parseDiff(diff, createExcludeMatcher(SECRET_GLOBS)).included.map((f) => f.path), ['conf"x/b.txt']);
  });

  test('drops the tab git appends to paths with spaces', () => {
    const diff = 'diff --git a/my dir/.env b/my dir/.env\n--- a/my dir/.env\t\n+++ b/my dir/.env\t\n@@ -1 +1 @@\n-A=1\n+A=2\n';
    assert.deepEqual(pathsOf(diff), ['my dir/.env']);
    assert.deepEqual(parseDiff(diff, createExcludeMatcher(SECRET_GLOBS)).omitted, [{ path: 'my dir/.env', reason: 'excluded' }]);
  });

  test('does not mistake an added "++" line for a file header', () => {
    const diff = 'diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+++ b/other\n';
    assert.deepEqual(pathsOf(diff), ['x.md']);
  });

  test('parses a very large hunk in linear time', () => {
    const lines = 200_000;
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', `@@ -0,0 +1,${lines} @@`, ...Array.from({ length: lines }, (_, i) => `+line ${i}`), ''].join('\n');
    const start = Date.now();
    const file = parseDiff(diff, includeAll).included[0]!;
    assert.ok(Date.now() - start < 2_000, 'took too long');
    assert.equal(file.additions, lines);
    assert.ok(file.hunks[0]!.endsWith(`+line ${lines - 1}`));
  });

  test('normalizes CRLF line endings', () => {
    const file = parseDiff('diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n', includeAll).included[0]!;
    assert.equal(renderFileDiff(file), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b');
  });

  test('returns nothing for an empty diff', () => {
    assert.deepEqual(parseDiff('', includeAll), { included: [], omitted: [] });
  });
});

suite('unquoteGitPath', () => {
  test('decodes octal UTF-8 bytes and C escapes', () => {
    assert.equal(unquoteGitPath('"\\303\\244\\t\\"\\\\.txt"'), 'ä\t"\\.txt');
  });

  test('leaves unquoted paths alone', () => {
    assert.equal(unquoteGitPath('src/a.ts'), 'src/a.ts');
  });
});

suite('untrackedToPseudoDiff', () => {
  test('renders a new-file diff', () => {
    const file = untrackedToPseudoDiff('src/new.ts', 'line 1\nline 2\n');
    assert.equal(
      renderFileDiff(file),
      'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+line 1\n+line 2',
    );
    assert.equal(file.additions, 2);
  });

  test('marks a missing trailing newline and normalizes CRLF', () => {
    const file = untrackedToPseudoDiff('a.txt', 'x\r\ny');
    assert.equal(file.hunks[0], '@@ -0,0 +1,2 @@\n+x\n+y\n\\ No newline at end of file');
  });

  test('handles empty files', () => {
    const file = untrackedToPseudoDiff('empty.txt', '');
    assert.deepEqual(file.hunks, []);
  });
});

suite('looksBinary', () => {
  test('detects NUL bytes', () => {
    assert.equal(looksBinary(new Uint8Array([0x89, 0x50, 0x00, 0x47])), true);
    assert.equal(looksBinary(new TextEncoder().encode('hello')), false);
  });
});
