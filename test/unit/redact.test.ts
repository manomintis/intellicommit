import * as assert from 'node:assert/strict';
import { REDACTED, redactSecrets } from '../../src/prompt/redact';

// Fake tokens are assembled at runtime so secret scanners don't flag this file.
const fake = (prefix: string, length: number, alphabet = 'aB3'): string =>
  prefix + Array.from({ length }, (_, i) => alphabet.charAt(i % alphabet.length)).join('');

suite('redactSecrets', () => {
  const tokens: readonly (readonly [string, string])[] = [
    ['AWS access key id', fake('AKIA', 16, 'Q7X')],
    ['GitHub token', fake('ghp_', 36)],
    ['GitHub fine-grained token', fake('github_pat_', 40)],
    ['GitLab token', fake('glpat-', 20)],
    ['Slack token', fake('xoxb-', 24, '1a-')],
    ['Anthropic key', fake('sk-ant-api03-', 40)],
    ['OpenAI key', fake('sk-proj-', 40)],
    ['Stripe key', fake('sk_live_', 24)],
    ['Google API key', fake('AIza', 35)],
    ['npm token', fake('npm_', 36)],
    ['JWT', `${fake('eyJ', 20)}.${fake('eyJ', 20)}.${fake('', 20)}`],
  ];
  for (const [name, token] of tokens) {
    test(`redacts: ${name}`, () => {
      const result = redactSecrets(`+const key = "${token}";`);
      assert.equal(result.text, `+const key = "${REDACTED}";`);
      assert.equal(result.count, 1);
    });
  }

  test('redacts a Slack webhook path but keeps the host', () => {
    const result = redactSecrets(`+url: https://hooks.slack.com/services/${fake('T', 8)}/${fake('B', 8)}/${fake('', 24)}`);
    assert.equal(result.text, `+url: https://hooks.slack.com/services/${REDACTED}`);
  });

  test('redacts the password in a URL', () => {
    const result = redactSecrets('+DATABASE_URL=postgres://app:s3cr3t@db.internal:5432/app');
    assert.equal(result.text, `+DATABASE_URL=postgres://app:${REDACTED}@db.internal:5432/app`);
    assert.equal(result.count, 1);
  });

  test('redacts the body of a private key, keeping diff markers', () => {
    const text = [
      'diff --git a/k b/k',
      '@@ -0,0 +1,4 @@',
      '+-----BEGIN OPENSSH PRIVATE KEY-----',
      '+b3BlbnNzaC1rZXktdjEAAAAA',
      '+AAAAC3NzaC1lZDI1NTE5AAAA',
      '+-----END OPENSSH PRIVATE KEY-----',
      ' unchanged',
    ].join('\n');
    const result = redactSecrets(text);
    assert.deepEqual(result.text.split('\n').slice(2), [
      '+-----BEGIN OPENSSH PRIVATE KEY-----',
      `+${REDACTED}`,
      `+${REDACTED}`,
      '+-----END OPENSSH PRIVATE KEY-----',
      ' unchanged',
    ]);
    assert.equal(result.count, 2);
  });

  test('redacts a private key that begins above the hunk', () => {
    const text = ['diff --git a/k b/k', '@@ -5,3 +5,3 @@', ' MIIEvQIBADANBgkqhkiG', '-OLDLINE', '+NEWLINE', ' -----END PRIVATE KEY-----'].join('\n');
    assert.deepEqual(redactSecrets(text).text.split('\n').slice(2), [` ${REDACTED}`, `-${REDACTED}`, `+${REDACTED}`, ' -----END PRIVATE KEY-----']);
  });

  test('redacts to the end of the file when a key has no visible end', () => {
    const text = ['diff --git a/k b/k', '@@ -0,0 +1,2 @@', '+-----BEGIN RSA PRIVATE KEY-----', '+MIIEow', 'diff --git a/x b/x', '@@ -1 +1 @@', '+kept'].join('\n');
    assert.deepEqual(redactSecrets(text).text.split('\n').slice(3), [`+${REDACTED}`, 'diff --git a/x b/x', '@@ -1 +1 @@', '+kept']);
  });

  test('leaves ordinary code alone', () => {
    const text = [
      '+const password = getPassword();',
      '+const css = "sk-navigation-header-container";',
      '+const url = "https://example.com/path?q=1";',
      '+const email = "user@example.com";',
      '+// see AKIA prefix in the AWS docs',
    ].join('\n');
    assert.deepEqual(redactSecrets(text), { text, count: 0 });
  });
});
