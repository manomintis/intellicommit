import * as assert from 'node:assert/strict';
import { formatCommitMessage, toImperative, type ResolvedStyle } from '../../src/prompt/formatCommitMessage';

interface Case {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
  readonly style?: ResolvedStyle;
}

suite('formatCommitMessage', () => {
  const cases: readonly Case[] = [
    { name: 'passes a clean subject through', input: 'Fix null check in config loader', expected: 'Fix null check in config loader' },
    { name: 'strips code fences', input: '```\nAdd login form\n```', expected: 'Add login form' },
    { name: 'strips fences with a language tag and preamble', input: 'Here is a commit message:\n\n```text\nAdd login form\n```\nLet me know!', expected: 'Add login form' },
    { name: 'strips an unclosed fence (streaming)', input: '```\nAdd login', expected: 'Add login' },
    { name: 'strips wrapping quotes', input: '"Add login form"', expected: 'Add login form' },
    { name: 'strips a "Commit message:" preamble', input: 'Commit message:\nAdd login form', expected: 'Add login form' },
    { name: 'strips a "Sure," preamble line', input: 'Sure, here you go.\nAdd login form', expected: 'Add login form' },
    { name: 'strips a Subject: label', input: 'Subject: Add login form', expected: 'Add login form' },
    { name: 'removes the trailing period', input: 'Add login form.', expected: 'Add login form' },
    { name: 'capitalizes the subject', input: 'add login form', expected: 'Add login form' },
    { name: 'converts past tense to imperative', input: 'Added login form.', expected: 'Add login form' },
    { name: 'converts third person to imperative', input: 'Fixes crash on startup', expected: 'Fix crash on startup' },
    { name: 'converts gerund to imperative', input: 'Updating dependencies', expected: 'Update dependencies' },
    { name: 'keeps unknown verbs', input: 'Bootstrap the CLI', expected: 'Bootstrap the CLI' },
    { name: 'inserts the blank line after the subject', input: 'Add login form\nIt validates input.', expected: 'Add login form\n\nIt validates input.' },
    { name: 'collapses extra blank lines after the subject', input: 'Add login form\n\n\n\nIt validates input.', expected: 'Add login form\n\nIt validates input.' },
    { name: 'trims trailing whitespace and CRLF', input: 'Add login form   \r\n\r\nBody text.  \r\n', expected: 'Add login form\n\nBody text.' },
    {
      name: 'keeps long body paragraphs on one line',
      input:
        'Add retry to uploads\n\nUploads failed permanently on the first network hiccup which was very annoying for users on flaky connections, so retry them.',
      expected:
        'Add retry to uploads\n\nUploads failed permanently on the first network hiccup which was very annoying for users on flaky connections, so retry them.',
    },
    {
      name: 'joins short unwrapped lines of one paragraph',
      input: 'Add retry\n\nUploads failed\npermanently.',
      expected: 'Add retry\n\nUploads failed permanently.',
    },
    {
      name: 'keeps list items separate and unwraps their continuation lines',
      input:
        'Remove flags\n\n* Drop the legacy search flag which has been enabled everywhere since\n  release 2.3 anyway\n- Drop the beta banner',
      expected:
        'Remove flags\n\n- Drop the legacy search flag which has been enabled everywhere since release 2.3 anyway\n- Drop the beta banner',
    },
    {
      name: 'never breaks URLs',
      input: 'Document API\n\nSee https://example.com/a/very/long/url/that/goes/on/and/on/and/on/forever/and/ever/index.html for details.',
      expected: 'Document API\n\nSee https://example.com/a/very/long/url/that/goes/on/and/on/and/on/forever/and/ever/index.html for details.',
    },
    { name: 'removes Markdown bold and headings in the body', input: 'Add form\n\n## Details\n**Validates** input.', expected: 'Add form\n\nDetails Validates input.' },
    { name: 'keeps trailers intact', input: 'Add form\n\nRefs: #123\nCo-authored-by: A <a@example.com>', expected: 'Add form\n\nRefs: #123\nCo-authored-by: A <a@example.com>' },
    { name: 'conventional: lowercases the description', input: 'feat(ui): Added login form.', style: 'conventional', expected: 'feat(ui): add login form' },
    { name: 'conventional: keeps acronyms', input: 'fix: API returns 500', style: 'conventional', expected: 'fix: API returns 500' },
    { name: 'conventional: keeps camel-case names', input: 'feat: TypeScript 6 support', style: 'conventional', expected: 'feat: TypeScript 6 support' },
    { name: 'conventional: keeps the breaking marker', input: 'Feat!: drop node 18', style: 'conventional', expected: 'feat!: drop node 18' },
    { name: 'gitmoji: capitalizes after the emoji', input: '🐛 fixed crash.', style: 'gitmoji', expected: '🐛 Fix crash' },
    { name: 'empty output stays empty', input: '  \n ```\n```', expected: '' },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(formatCommitMessage(c.input, c.style ?? 'traditional').message, c.expected);
    });
  }

  test('warns about subjects longer than 72 characters without truncating', () => {
    const subject = 'Add ' + 'very '.repeat(16) + 'long subject';
    const result = formatCommitMessage(subject, 'traditional');
    assert.equal(result.message, subject);
    assert.equal(result.warnings.length, 1);
  });

  test('toImperative handles irregular and -e verbs', () => {
    assert.equal(toImperative('Made it faster'), 'Make it faster');
    assert.equal(toImperative('removed x'), 'remove x');
    assert.equal(toImperative('Simplifies y'), 'Simplify y');
    assert.equal(toImperative('Using z'), 'Use z');
    assert.equal(toImperative('Dropped w'), 'Drop w');
    assert.equal(toImperative('dropping v'), 'drop v');
  });
});
