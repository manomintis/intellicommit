import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_EXCLUDE_GLOBS } from '../../src/git/globs';
import { DEFAULT_PREFERRED_MODELS } from '../../src/llm/modelSelection';
import { CLAUDE_CODE_MODELS, SOURCE_SETTINGS } from '../../src/llm/sources';
import { DEFAULT_DIFF_CHARS, MAX_DIFF_CHARS, MIN_DIFF_CHARS } from '../../src/prompt/budget';
import { MAX_CUSTOM_INSTRUCTIONS_CHARS } from '../../src/prompt/buildPrompt';

interface SettingSchema {
  readonly default?: unknown;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
}

interface Manifest {
  readonly contributes: { readonly configuration: readonly { readonly properties: Readonly<Record<string, SettingSchema>> }[] };
}

/** The code validates settings itself, so its fallbacks must match the schema in package.json. */
suite('package.json settings', () => {
  // Compiled tests run from out/test/unit.
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as Manifest;
  const settings = new Map(manifest.contributes.configuration.flatMap((c) => Object.entries(c.properties)));
  const setting = (key: string): SettingSchema => {
    const schema = settings.get(`intellicommit.${key}`);
    assert.ok(schema, key);
    return schema;
  };

  test('excludeGlobs default', () => {
    assert.deepEqual(setting('excludeGlobs').default, DEFAULT_EXCLUDE_GLOBS);
  });

  test('preferredModels default', () => {
    assert.deepEqual(setting('preferredModels').default, DEFAULT_PREFERRED_MODELS);
  });

  test('maxDiffChars bounds and default', () => {
    const { default: value, minimum, maximum } = setting('maxDiffChars');
    assert.deepEqual([value, minimum, maximum], [DEFAULT_DIFF_CHARS, MIN_DIFF_CHARS, MAX_DIFF_CHARS]);
  });

  test('customInstructions length limit', () => {
    assert.equal(setting('customInstructions').maxLength, MAX_CUSTOM_INSTRUCTIONS_CHARS);
  });

  test('source and Claude model choices', () => {
    assert.deepEqual(setting('source').enum, SOURCE_SETTINGS);
    assert.deepEqual(setting('claudeCode.model').enum, CLAUDE_CODE_MODELS.map((m) => m.id));
  });
});
