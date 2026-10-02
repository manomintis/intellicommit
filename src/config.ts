import * as vscode from 'vscode';
import { DEFAULT_EXCLUDE_GLOBS } from './git/globs';
import { DEFAULT_PREFERRED_MODELS } from './llm/modelSelection';
import { CLAUDE_CODE_MODELS, SOURCE_SETTINGS, type ClaudeCodeModel, type SourceSetting } from './llm/sources';
import { DEFAULT_DIFF_CHARS, MAX_DIFF_CHARS, MIN_DIFF_CHARS } from './prompt/budget';
import { MAX_CUSTOM_INSTRUCTIONS_CHARS, type StyleSetting } from './prompt/buildPrompt';

export type OnExistingText = 'replace' | 'append' | 'ask';

export interface IntelliCommitConfig {
  readonly style: StyleSetting;
  readonly language: string;
  readonly customInstructions: string;
  readonly excludeGlobs: readonly string[];
  readonly maxDiffChars: number;
  readonly onExistingText: OnExistingText;
}

export const SECTION = 'intellicommit';
const STYLES: readonly StyleSetting[] = ['auto', 'conventional', 'traditional', 'gitmoji'];
const EXISTING: readonly OnExistingText[] = ['replace', 'append', 'ask'];
/**
 * Typed settings access; `scope` is the repository root for resource-scoped settings.
 * Values are validated here because VS Code does not enforce the schema on settings.json.
 */
export function getConfig(scope?: vscode.Uri): IntelliCommitConfig {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  return {
    style: oneOf(c.get<unknown>('style'), STYLES, 'auto'),
    language: stringOr(c.get<unknown>('language'), 'auto'),
    customInstructions: stringOr(c.get<unknown>('customInstructions'), '').slice(0, MAX_CUSTOM_INSTRUCTIONS_CHARS),
    excludeGlobs: stringArrayOr(c.get<unknown>('excludeGlobs'), DEFAULT_EXCLUDE_GLOBS),
    maxDiffChars: Math.min(MAX_DIFF_CHARS, Math.max(MIN_DIFF_CHARS, numberOr(c.get<unknown>('maxDiffChars'), DEFAULT_DIFF_CHARS))),
    onExistingText: oneOf(c.get<unknown>('onExistingText'), EXISTING, 'replace'),
  };
}

export interface ModelConfig {
  readonly source: SourceSetting;
  /** VS Code LLM id; empty means automatic. */
  readonly model: string;
  readonly preferredModels: readonly string[];
  readonly claudeCodeModel: ClaudeCodeModel;
  readonly claudeCodePath: string;
}

/** Only the application/machine-scoped model settings; safe to read without a resource. */
export function getModelConfig(): ModelConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    source: oneOf(c.get<unknown>('source'), SOURCE_SETTINGS, 'claudeCodeThenVsCode'),
    model: stringOr(c.get<unknown>('model'), ''),
    preferredModels: stringArrayOr(c.get<unknown>('preferredModels'), DEFAULT_PREFERRED_MODELS),
    claudeCodeModel: oneOf(c.get<unknown>('claudeCode.model'), CLAUDE_CODE_MODELS.map((m) => m.id), 'haiku'),
    claudeCodePath: stringOr(c.get<unknown>('claudeCode.path'), ''),
  };
}

export const MODEL_SETTINGS = ['source', 'model', 'preferredModels', 'claudeCode.model', 'claudeCode.path'].map((k) => `${SECTION}.${k}`);

/** Saves the LLM source in the user settings. */
export async function updateSource(source: SourceSetting): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('source', source, vscode.ConfigurationTarget.Global);
}

/** True when VS Code's AI features, and with them all VS Code LLMs, are turned off. */
export function aiFeaturesDisabled(): boolean {
  return vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures', false);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArrayOr(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((v): v is string => typeof v === 'string') ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}
