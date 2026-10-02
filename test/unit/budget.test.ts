import * as assert from 'node:assert/strict';
import { diffTokenBudget, fitDiff, truncateFile, DEFAULT_MAX_INPUT_TOKENS, OUTPUT_RESERVE_TOKENS } from '../../src/prompt/budget';
import { untrackedToPseudoDiff, type FileDiff } from '../../src/git/diffUtils';

/** Roughly 4 characters per token, like many tokenizers. */
const count = (text: string): Promise<number> => Promise.resolve(Math.ceil(text.length / 4));

function bigFile(path: string, lines: number): FileDiff {
  return untrackedToPseudoDiff(path, Array.from({ length: lines }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n');
}

suite('diffTokenBudget', () => {
  test('keeps a 20% margin and reserves room for instructions and output', () => {
    assert.equal(diffTokenBudget(100_000, 2_000), 80_000 - 2_000 - OUTPUT_RESERVE_TOKENS);
  });
  test('uses a default when the limit is unknown', () => {
    assert.equal(diffTokenBudget(undefined, 0), Math.floor(DEFAULT_MAX_INPUT_TOKENS * 0.8) - OUTPUT_RESERVE_TOKENS);
  });
  test('reports when the fixed part of the prompt does not fit', () => {
    assert.equal(diffTokenBudget(1000, 5000), undefined);
  });
});

suite('fitDiff', () => {
  test('sends a small diff unchanged', async () => {
    const files = [bigFile('a.ts', 3)];
    const result = await fitDiff(files, 10_000, 100_000, count);
    assert.equal(result.level, 'full');
    assert.match(result.text, /\+const line2 = 2;/);
  });

  test('truncates an oversized diff per file, keeping every header', async () => {
    const files = [bigFile('a.ts', 2000), bigFile('b.ts', 2000), bigFile('c.ts', 10)];
    const result = await fitDiff(files, 2_000, 100_000, count);
    assert.equal(result.level, 'truncated');
    assert.ok((await count(result.text)) <= 2_000);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      assert.match(result.text, new RegExp(`\\+\\+\\+ b/${name}`));
    }
    assert.match(result.text, /more lines of this hunk truncated/);
    assert.match(result.text, /\+const line9 = 9;/);
  });

  test('respects the character cap even when tokens would fit', async () => {
    const result = await fitDiff([bigFile('a.ts', 2000)], 1_000_000, 5_000, count);
    assert.ok(result.text.length <= 5_000);
    assert.equal(result.level, 'truncated');
  });

  test('falls back to a file list with stats', async () => {
    const files = Array.from({ length: 200 }, (_, i) => bigFile(`f${i}.ts`, 50));
    const result = await fitDiff(files, 3_000, 1_000_000, count);
    assert.equal(result.level, 'summary');
    assert.match(result.text, /^f0\.ts \| \+50 -0$/m);
    assert.ok((await count(result.text)) <= 3_000);
  });

  test('drops summary lines when even the list is too long', async () => {
    const files = Array.from({ length: 2000 }, (_, i) => bigFile(`file-${i}.ts`, 50));
    const result = await fitDiff(files, 1_000, 1_000_000, count);
    assert.equal(result.level, 'summary');
    assert.match(result.text, /more files$/);
    assert.ok((await count(result.text)) <= 1_000);
  });

  test('returns nothing when nothing fits', async () => {
    const result = await fitDiff([bigFile('a.ts', 10)], 0, 1_000_000, count);
    assert.equal(result.text, '');
  });
});

suite('truncateFile', () => {
  test('keeps whole hunks that fit and counts the rest', () => {
    const file: FileDiff = {
      path: 'x.ts',
      header: 'diff --git a/x.ts b/x.ts',
      hunks: ['@@ -1 +1 @@\n-a\n+b', '@@ -9 +9 @@\n-c\n+d'],
      binary: false,
      additions: 2,
      deletions: 2,
    };
    assert.equal(truncateFile(file, 45), 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\n[... 1 more hunk(s) in x.ts truncated]');
  });
});
