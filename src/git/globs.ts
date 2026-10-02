/**
 * Converts a glob to a RegExp. Supports `**`, `*`, `?`, `{a,b}` and `[...]`.
 * Patterns without a `/` match the file name at any depth (like .gitignore).
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/\\/g, '/');
  if (!pattern.includes('/')) {
    pattern = `**/${pattern}`;
  } else if (pattern.startsWith('/')) {
    pattern = pattern.slice(1);
  }

  let re = '';
  let inGroup = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === '*') {
      if (pattern.charAt(i + 1) === '*') {
        const atSegmentStart = i === 0 || pattern.charAt(i - 1) === '/';
        const followedBySlash = pattern.charAt(i + 2) === '/';
        i++;
        if (atSegmentStart && followedBySlash) {
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inGroup++;
      re += '(?:';
    } else if (c === '}' && inGroup > 0) {
      inGroup--;
      re += ')';
    } else if (c === ',' && inGroup > 0) {
      re += '|';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        re += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^$()|\\\]]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Builds a path matcher; globs that don't form a valid pattern are skipped and reported to `onInvalid`. */
export function createExcludeMatcher(globs: readonly string[], onInvalid?: (glob: string) => void): (path: string) => boolean {
  const regexes: RegExp[] = [];
  for (const glob of globs) {
    if (glob.trim() === '') {
      continue;
    }
    try {
      regexes.push(globToRegExp(glob));
    } catch {
      onInvalid?.(glob);
    }
  }
  return (path) => regexes.some((re) => re.test(path.replace(/\\/g, '/')));
}

/**
 * Files that commonly hold credentials. Their content is never sent, whatever
 * `intellicommit.excludeGlobs` says, because overriding that setting replaces its defaults.
 */
export const SECRET_GLOBS: readonly string[] = [
  '.env',
  '.env.*',
  '*.env',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pkcs12',
  '*.pfx',
  '*.p8',
  '*.jks',
  '*.keystore',
  '*.keytab',
  'id_rsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'id_dsa*',
  '*.ppk',
  '*.asc',
  '*.gpg',
  '*.kdbx',
  '*.ovpn',
  '*.tfvars',
  '*.tfstate',
  '*.tfstate.backup',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.yarnrc.yml',
  '.dev.vars',
  '.git-credentials',
  '.htpasswd',
  '.pgpass',
  '.vault-token',
  '.s3cfg',
  '.boto',
  'kubeconfig',
  '**/.aws/credentials',
  '**/.docker/config.json',
  '**/.cargo/credentials',
  '**/.cargo/credentials.toml',
  '**/.gem/credentials',
  'credentials.tfrc.json',
  'credentials.json',
  'secrets.{json,yml,yaml,toml}',
  'service-account*.json',
];

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'packages.lock.json',
  'flake.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/node_modules/**',
  '**/vendor/**',
  '*.generated.*',
  '*.pb.go',
  '*_pb2.py',
];
