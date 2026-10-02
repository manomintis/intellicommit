import * as assert from 'node:assert/strict';
import { createExcludeMatcher, DEFAULT_EXCLUDE_GLOBS, SECRET_GLOBS } from '../../src/git/globs';

suite('createExcludeMatcher', () => {
  const matches = createExcludeMatcher(DEFAULT_EXCLUDE_GLOBS);
  const cases: readonly (readonly [string, boolean])[] = [
    ['package-lock.json', true],
    ['packages/web/yarn.lock', true],
    ['assets/app.min.js', true],
    ['dist/extension.js', true],
    ['src/dist/x.ts', true],
    ['src/app.js', false],
    ['src/minimal.ts', false],
    ['docs/build.md', false],
  ];
  for (const [path, expected] of cases) {
    test(`${path} → ${String(expected)}`, () => {
      assert.equal(matches(path), expected);
    });
  }

  test('supports braces, ? and anchored paths', () => {
    const m = createExcludeMatcher(['src/*.{gen,auto}.ts', 'file?.txt']);
    assert.equal(m('src/a.gen.ts'), true);
    assert.equal(m('src/a.auto.ts'), true);
    assert.equal(m('lib/src/a.gen.ts'), false);
    assert.equal(m('deep/file1.txt'), true);
    assert.equal(m('file12.txt'), false);
  });

  test('skips and reports invalid globs instead of failing', () => {
    const invalid: string[] = [];
    const m = createExcludeMatcher(['{a,b', '[z-a].txt', '*.lock'], (glob) => invalid.push(glob));
    assert.deepEqual(invalid, ['{a,b', '[z-a].txt']);
    assert.equal(m('yarn.lock'), true);
  });
});

suite('SECRET_GLOBS', () => {
  const matches = createExcludeMatcher(SECRET_GLOBS);
  const cases: readonly (readonly [string, boolean])[] = [
    ['.env', true],
    ['apps/api/.env.local', true],
    ['certs/server.pem', true],
    ['config/tls.key', true],
    ['keys/id_ed25519', true],
    ['.npmrc', true],
    ['.git-credentials', true],
    ['infra/prod.tfvars', true],
    ['keys/service-account-prod.json', true],
    ['deploy/prod.env', true],
    ['.envrc', true],
    ['infra/terraform.tfstate', true],
    ['infra/terraform.tfstate.backup', true],
    ['home/.aws/credentials', true],
    ['keys/server.ppk', true],
    ['keys/AuthKey_ABC123.p8', true],
    ['krb/service.keytab', true],
    ['keys/private.asc', true],
    ['backup/secring.gpg', true],
    ['home/.docker/config.json', true],
    ['config/secrets.yml', true],
    ['.yarnrc.yml', true],
    ['workers/api/.dev.vars', true],
    ['.vault-token', true],
    ['home/.cargo/credentials.toml', true],
    ['home/.gem/credentials', true],
    ['home/.terraform.d/credentials.tfrc.json', true],
    ['certs/client.pkcs12', true],
    ['src/secrets.ts', false],
    ['src/env.ts', false],
    ['src/environment.ts', false],
    ['docs/keys.md', false],
  ];
  for (const [path, expected] of cases) {
    test(`${path} → ${String(expected)}`, () => {
      assert.equal(matches(path), expected);
    });
  }
});
