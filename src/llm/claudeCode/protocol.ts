/** Arguments and output parsing for the Claude Code CLI in print mode with streaming JSON output. */
import { AUTH_PATTERN, NETWORK_PATTERN, QUOTA_PATTERN, type ErrorKind } from '../../errorKind';

/** Replaces Claude Code's default coding-agent system prompt. Must not contain `"`, `%` or line breaks, which `quoteForCmd` refuses. */
export const CLAUDE_SYSTEM_PROMPT =
  'You write Git commit messages. Follow the instructions in the user message and output only the commit message.';

/**
 * Arguments for a single, tool-less, stateless request. The prompt itself is sent
 * on standard input. Settings files, MCP servers and skills are skipped so the
 * user's Claude Code configuration cannot change or slow down the request.
 */
export function buildClaudeArgs(model: string): string[] {
  return [
    '--print',
    '--model', model,
    '--effort', 'low',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', CLAUDE_SYSTEM_PROMPT,
  ];
}

/**
 * Environment overrides for the CLI. Extended thinking is turned off: commit messages
 * don't need it, and its hidden tokens would otherwise make up most of the output.
 * The output limit also bounds the response on the server side. Non-essential
 * traffic (update checks, telemetry, error reporting) is turned off.
 */
export const CLAUDE_ENV: Readonly<Record<string, string>> = {
  MAX_THINKING_TOKENS: '0',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

export interface ClaudeUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Cost at API list prices in US dollars; reported for subscription plans too. */
  readonly costUsd: number | undefined;
}

export type ClaudeEvent =
  | {
      readonly kind: 'init';
      /** Where the API key comes from, e.g. `ANTHROPIC_API_KEY`; `none` when no API key is used. */
      readonly apiKeySource: string | undefined;
    }
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'result';
      readonly isError: boolean;
      readonly text: string;
      readonly status: number | undefined;
      readonly usage: ClaudeUsage | undefined;
    }
  | { readonly kind: 'other' };

/** Parses one line of `--output-format stream-json`. Unknown or malformed lines are ignored. */
export function parseClaudeLine(line: string): ClaudeEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'other' };
  }
  if (!isRecord(value)) {
    return { kind: 'other' };
  }
  if (value.type === 'system' && value.subtype === 'init') {
    return { kind: 'init', apiKeySource: typeof value.apiKeySource === 'string' ? value.apiKeySource : undefined };
  }
  if (value.type === 'stream_event' && isRecord(value.event) && value.event.type === 'content_block_delta') {
    const delta = value.event.delta;
    if (isRecord(delta) && delta.type === 'text_delta' && typeof delta.text === 'string') {
      return { kind: 'text', text: delta.text };
    }
  }
  if (value.type === 'result') {
    return {
      kind: 'result',
      isError: value.is_error === true || (typeof value.subtype === 'string' && value.subtype !== 'success'),
      text: typeof value.result === 'string' ? value.result : '',
      status: typeof value.api_error_status === 'number' ? value.api_error_status : undefined,
      usage: parseUsage(value),
    };
  }
  return { kind: 'other' };
}

function parseUsage(result: Record<string, unknown>): ClaudeUsage | undefined {
  const usage = result.usage;
  if (!isRecord(usage)) {
    return undefined;
  }
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return {
    inputTokens: count(usage.input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    outputTokens: count(usage.output_tokens),
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
  };
}

/** Maps a failed result to an error kind. */
export function classifyClaudeError(status: number | undefined, message: string): ErrorKind {
  if (status === 401 || status === 403 || AUTH_PATTERN.test(message)) {
    return 'accessDenied';
  }
  if (status === 429 || QUOTA_PATTERN.test(message)) {
    return 'quota';
  }
  if (status === 404 || /issue with the selected model|model .* not (?:found|exist)/i.test(message)) {
    return 'noModels';
  }
  if (status === 529 || NETWORK_PATTERN.test(message)) {
    return 'network';
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
