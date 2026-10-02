import * as assert from 'node:assert/strict';
import { buildInstructions, buildPromptInput, MAX_LISTED_FILES, resolveStyle, type PromptParams } from '../../src/prompt/buildPrompt';

const BASE: PromptParams = {
  style: 'traditional',
  language: 'auto',
  recentSubjects: ['Fix typo', 'Add parser'],
  mode: 'staged',
  files: [
    { path: 'src/a.ts', status: 'modified' },
    { path: 'src/new.ts', status: 'untracked' },
    { path: 'src/b.ts', status: 'renamed', originalPath: 'src/old.ts' },
    { path: 'package-lock.json', status: 'modified' },
  ],
  omitted: [
    { path: 'package-lock.json', reason: 'excluded' },
    { path: 'src/new.ts', reason: 'too large' },
  ],
  customInstructions: '',
};

suite('resolveStyle', () => {
  test('explicit styles pass through', () => {
    assert.equal(resolveStyle('gitmoji', []), 'gitmoji');
  });
  test('auto detects conventional commits', () => {
    assert.equal(resolveStyle('auto', ['feat: a', 'fix(x): b', 'chore!: c', 'Update readme']), 'conventional');
  });
  test('auto detects gitmoji', () => {
    assert.equal(resolveStyle('auto', ['✨ Add a', '🐛 Fix b', 'Update c']), 'gitmoji');
  });
  test('auto detects traditional', () => {
    assert.equal(resolveStyle('auto', ['Fix a', 'Add b', 'feat: c']), 'traditional');
  });
  test('auto falls back to conventional without a clear majority or history', () => {
    assert.equal(resolveStyle('auto', ['feat: a', 'Fix b']), 'conventional');
    assert.equal(resolveStyle('auto', ['✨ Add a', 'Fix b']), 'conventional');
    assert.equal(resolveStyle('auto', []), 'conventional');
    assert.equal(resolveStyle('auto', ['Merge branch x']), 'conventional');
  });
  test('auto ignores merge commits', () => {
    assert.equal(resolveStyle('auto', ['Merge branch x', 'Merge pull request #1', 'feat: a']), 'conventional');
  });
});

suite('buildPrompt', () => {
  test('instructions contain the rules, examples, history and output instruction', () => {
    const text = buildInstructions(BASE);
    assert.match(text, /imperative mood/);
    assert.match(text, /must never exceed 72/);
    assert.match(text, /Fix null check in config loader/);
    assert.match(text, /- Add parser/);
    assert.match(text, /English, unless/);
    assert.match(text, /Output only the commit message/);
    assert.doesNotMatch(text, /Additional instructions/);
  });

  test('conventional style uses its own rules and examples', () => {
    const text = buildInstructions({ ...BASE, style: 'conventional', language: 'German' });
    assert.match(text, /Conventional Commits 1\.0/);
    assert.match(text, /fix\(config\): handle missing settings file/);
    assert.match(text, /Write the message in German\. Keep the Conventional Commits type keywords in English\./);
  });

  test('custom instructions are appended', () => {
    assert.match(buildInstructions({ ...BASE, customInstructions: 'Mention JIRA-1' }), /Additional instructions from the user:\nMention JIRA-1/);
  });

  test('omits the history section without commits', () => {
    assert.doesNotMatch(buildInstructions({ ...BASE, recentSubjects: [] }), /Recent commit subjects/);
  });

  test('changes message lists each file once, marks omitted diffs and adds the diff', () => {
    const { changes } = buildPromptInput(BASE, 'diff --git a/src/a.ts b/src/a.ts');
    assert.match(changes, /^These are the staged changes/);
    assert.match(changes, /^M src\/a\.ts$/m);
    assert.match(changes, /^A src\/new\.ts \(new file; diff not shown: too large\)$/m);
    assert.match(changes, /^R src\/old\.ts -> src\/b\.ts$/m);
    assert.match(changes, /^M package-lock\.json \(diff not shown: excluded\)$/m);
    assert.equal(changes.match(/package-lock\.json/g)?.length, 2, 'listed once, plus the example in the legend');
    assert.match(changes, /Diff:\ndiff --git/);
  });

  test('omitted files without a status entry are still listed', () => {
    const { changes } = buildPromptInput({ ...BASE, omitted: [{ path: '"odd\\303\\251.txt"', reason: 'binary' }] }, '');
    assert.match(changes, /^\? "odd\\303\\251\.txt" \(diff not shown: binary\)$/m);
  });

  test('caps the file list', () => {
    const files = Array.from({ length: MAX_LISTED_FILES + 50 }, (_, i) => ({ path: `f${i}.ts`, status: 'modified' as const }));
    const { changes } = buildPromptInput({ ...BASE, files, omitted: [] }, '');
    assert.match(changes, new RegExp(`^M f${MAX_LISTED_FILES - 1}\\.ts$`, 'm'));
    assert.doesNotMatch(changes, new RegExp(`^M f${MAX_LISTED_FILES}\\.ts$`, 'm'));
    assert.match(changes, /^\.\.\. and 50 more files$/m);
  });

  test('all-changes mode and merge conflicts are explained', () => {
    const files = [...BASE.files, { path: 'x.ts', status: 'conflicted' as const }];
    const { changes } = buildPromptInput({ ...BASE, mode: 'all', files }, '');
    assert.match(changes, /Nothing is staged/);
    assert.match(changes, /concludes a merge/);
    assert.match(changes, /^U x\.ts$/m);
    assert.doesNotMatch(changes, /Diff:/);
  });
});
