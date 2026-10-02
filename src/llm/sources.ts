export type Source = 'claudeCode' | 'vsCode';

export type SourceSetting = 'claudeCodeThenVsCode' | 'vsCodeThenClaudeCode' | 'claudeCode' | 'vsCode';

export const SOURCE_SETTINGS: readonly SourceSetting[] = ['claudeCodeThenVsCode', 'vsCodeThenClaudeCode', 'claudeCode', 'vsCode'];

/** Sources to try, in order. Later sources are used only when earlier ones are unavailable. */
export function sourceOrder(setting: SourceSetting): readonly Source[] {
  switch (setting) {
    case 'claudeCodeThenVsCode':
      return ['claudeCode', 'vsCode'];
    case 'vsCodeThenClaudeCode':
      return ['vsCode', 'claudeCode'];
    case 'claudeCode':
      return ['claudeCode'];
    case 'vsCode':
      return ['vsCode'];
  }
}

/**
 * Model aliases accepted by `claude --model`; each resolves to the latest model of
 * that family. Ordered from cheapest to most expensive.
 */
export const CLAUDE_CODE_MODELS = [
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'fable', label: 'Fable' },
] as const;

export type ClaudeCodeModel = (typeof CLAUDE_CODE_MODELS)[number]['id'];

export function claudeCodeModelLabel(id: string): string {
  return CLAUDE_CODE_MODELS.find((m) => m.id === id)?.label ?? id;
}
