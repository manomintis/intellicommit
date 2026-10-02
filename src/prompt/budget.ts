import { renderFileDiff, type FileDiff } from '../git/diffUtils';

/** Used when the provider does not report an input limit. */
export const DEFAULT_MAX_INPUT_TOKENS = 8000;
/** Fraction of the model's input limit that may be used. */
export const SAFETY_FACTOR = 0.8;
/** Room left for the generated message. */
export const OUTPUT_RESERVE_TOKENS = 1000;
/** Longest response accepted from the model; generation stops there to bound output tokens. */
export const MAX_MESSAGE_CHARS = 4000;
/** Smallest per-file slice worth sending before falling back to a summary. */
export const MIN_CHARS_PER_FILE = 300;
/** Bounds and default of `intellicommit.maxDiffChars`; they match the setting's schema. */
export const MIN_DIFF_CHARS = 1000;
export const MAX_DIFF_CHARS = 100_000;
export const DEFAULT_DIFF_CHARS = 20_000;

export type TokenCounter = (text: string) => Promise<number>;

export type BudgetLevel = 'full' | 'truncated' | 'summary';

export interface BudgetResult {
  readonly text: string;
  readonly level: BudgetLevel;
}

/**
 * Tokens available for the diff once instructions and output are accounted for,
 * or undefined when the instructions and file list alone exceed the input limit.
 */
export function diffTokenBudget(maxInputTokens: number | undefined, overheadTokens: number): number | undefined {
  const limit = maxInputTokens !== undefined && maxInputTokens > 0 ? maxInputTokens : DEFAULT_MAX_INPUT_TOKENS;
  const budget = Math.floor(limit * SAFETY_FACTOR) - overheadTokens - OUTPUT_RESERVE_TOKENS;
  return budget >= 0 ? budget : undefined;
}

/**
 * Returns the largest diff representation that fits both limits:
 * the full diff, then per-file truncation (headers and first hunks kept),
 * then a file list with +/- stats. Never exceeds `maxTokens` or `maxChars`.
 */
export async function fitDiff(
  files: readonly FileDiff[],
  maxTokens: number,
  maxChars: number,
  countTokens: TokenCounter,
): Promise<BudgetResult> {
  const fits = async (text: string): Promise<boolean> =>
    text.length <= maxChars && (await countTokens(text)) <= maxTokens;

  if (files.length === 0) {
    return { text: '', level: 'full' };
  }

  const rendered = files.map(renderFileDiff);
  const full = rendered.join('\n');
  if (await fits(full)) {
    return { text: full, level: 'full' };
  }

  const truncatedAt = (limit: number): string => files.map((f) => truncateFile(f, limit)).join('\n');
  let low = MIN_CHARS_PER_FILE;
  let best = truncatedAt(low);
  if (await fits(best)) {
    // Binary search for the largest per-file limit that still fits, to within 5%.
    // A limit above `maxChars` can never fit, and every step may count tokens.
    let high = Math.min(maxChars, rendered.reduce((max, text) => Math.max(max, text.length), 0));
    while (high - low > Math.max(50, low * 0.05)) {
      const mid = Math.floor((low + high) / 2);
      const candidate = truncatedAt(mid);
      if (await fits(candidate)) {
        low = mid;
        best = candidate;
      } else {
        high = mid;
      }
    }
    return { text: best, level: 'truncated' };
  }

  return { text: await fitSummary(files, fits), level: 'summary' };
}

/** Keeps the header and as many leading hunks (or hunk lines) as fit in `limit` characters. */
export function truncateFile(file: FileDiff, limit: number): string {
  const out: string[] = [file.header];
  let used = file.header.length;
  let index = 0;
  for (; index < file.hunks.length; index++) {
    const hunk = file.hunks[index] ?? '';
    if (used + hunk.length + 1 <= limit) {
      out.push(hunk);
      used += hunk.length + 1;
      continue;
    }
    // Partially include the first hunk that does not fit, line by line.
    const lines = hunk.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      if (used + line.length + 1 > limit) {
        break;
      }
      kept.push(line);
      used += line.length + 1;
    }
    if (kept.length > 1) {
      out.push(`${kept.join('\n')}\n[... ${lines.length - kept.length} more lines of this hunk truncated]`);
      index++;
    }
    break;
  }
  const remaining = file.hunks.length - index;
  if (remaining > 0) {
    out.push(`[... ${remaining} more hunk(s) in ${file.path} truncated]`);
  }
  return out.join('\n');
}

async function fitSummary(files: readonly FileDiff[], fits: (text: string) => Promise<boolean>): Promise<string> {
  const lines = files.map((f) => `${f.path} | +${f.additions} -${f.deletions}`);
  const render = (count: number): string => {
    const shown = ['Diff too large to include. Per-file line changes:', ...lines.slice(0, count)];
    if (count < lines.length) {
      shown.push(`... and ${lines.length - count} more files`);
    }
    return shown.join('\n');
  };

  let count = lines.length;
  while (count > 0) {
    const text = render(count);
    if (await fits(text)) {
      return text;
    }
    count = Math.floor(count * 0.75);
  }
  return '';
}
