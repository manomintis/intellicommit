/** Replaces likely secrets in diff text before it is sent. */

export const REDACTED = '[REDACTED]';

/**
 * Tokens with a distinctive format, so false positives are rare. Generic names such as
 * `password = "..."` are not matched: they appear in ordinary code far more often than secrets.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // AWS access key ids
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  // GitLab personal access tokens
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  // Slack tokens and webhook paths
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?<=hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/g,
  // Anthropic, OpenAI and similar `sk-` API keys; a digit keeps kebab-case names out
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
  // Stripe secret and restricted keys
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // npm tokens
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // JSON Web Tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** The password in `scheme://user:password@host`. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@'"`]+:)[^\s/?#@'"`]+@/gi;

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

export interface RedactionResult {
  readonly text: string;
  /** Number of redacted tokens, passwords and private key lines. */
  readonly count: number;
}

/**
 * Redacts likely secrets in `git diff`-style text: well-known token formats, passwords
 * in URLs, and the body of private keys. The diff marker at the start of a line is kept.
 */
export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  const lines = text.split('\n');
  let inKey = false;
  // First line of the current hunk or file section; a key may begin before the hunk starts.
  let segmentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ')) {
      inKey = false;
      segmentStart = i + 1;
      continue;
    }
    if (line.startsWith('@@')) {
      segmentStart = i + 1;
      continue;
    }
    if (PRIVATE_KEY_END.test(line)) {
      if (!inKey) {
        // The key began above the visible part of the hunk.
        for (let j = segmentStart; j < i; j++) {
          lines[j] = redactLine(lines[j] ?? '');
          count++;
        }
      }
      inKey = false;
      continue;
    }
    if (inKey) {
      lines[i] = redactLine(line);
      count++;
      continue;
    }
    if (PRIVATE_KEY_BEGIN.test(line)) {
      inKey = true;
      continue;
    }
    let redacted = line;
    for (const pattern of TOKEN_PATTERNS) {
      redacted = redacted.replace(pattern, () => {
        count++;
        return REDACTED;
      });
    }
    lines[i] = redacted.replace(URL_PASSWORD, (_match, start: string) => {
      count++;
      return `${start}${REDACTED}@`;
    });
  }
  return { text: lines.join('\n'), count };
}

function redactLine(line: string): string {
  const marker = /^[-+ ]/.test(line) ? line.charAt(0) : '';
  return `${marker}${REDACTED}`;
}
