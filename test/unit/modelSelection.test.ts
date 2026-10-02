import * as assert from 'node:assert/strict';
import { priceTier, resolveModel, sortByPrice, type ModelInfo } from '../../src/llm/modelSelection';

const model = (id: string, family: string, name: string, vendor = 'copilot'): ModelInfo => ({ id, family, name, vendor });

const SONNET = model('claude-sonnet-5', 'claude-sonnet-5', 'Claude Sonnet 5');
const HAIKU = model('claude-haiku-4.5', 'claude-haiku-4.5', 'Claude Haiku 4.5');
const GPT_MINI = model('gpt-5-mini', 'gpt-5-mini', 'GPT-5 mini');
const GEMINI_PRO = model('gemini-3-pro', 'gemini-3-pro', 'Gemini 3 Pro');
const FLASH_A = model('gemini-3.5-flash', 'gemini-3.5-flash', 'Gemini 3.5 Flash');
const FLASH_B = model('mai-code-1.1-flash', 'mai-code-1.1-flash', 'MAI-Code-1.1-Flash', 'other');

const PREFS = ['haiku', 'gpt-5-mini', 'flash'];

suite('resolveModel', () => {
  test('empty model list', () => {
    assert.deepEqual(resolveModel([], '', PREFS), { model: undefined, reason: undefined, staleExplicitId: undefined });
  });

  test('empty model list with an explicit id reports it as stale', () => {
    assert.equal(resolveModel([], 'x', PREFS).staleExplicitId, 'x');
  });

  test('explicit choice wins', () => {
    const r = resolveModel([SONNET, HAIKU], 'claude-sonnet-5', PREFS);
    assert.equal(r.model, SONNET);
    assert.equal(r.reason, 'explicit');
  });

  test('stale explicit id falls back to the preference list', () => {
    const r = resolveModel([SONNET, GPT_MINI], 'gone-model', PREFS);
    assert.equal(r.model, GPT_MINI);
    assert.equal(r.reason, 'preference');
    assert.equal(r.staleExplicitId, 'gone-model');
  });

  test('first matching fragment wins, not the first model', () => {
    const r = resolveModel([GPT_MINI, SONNET, HAIKU], '', PREFS);
    assert.equal(r.model, HAIKU);
  });

  test('several matches for one fragment: the earlier model wins', () => {
    assert.equal(resolveModel([SONNET, FLASH_B, FLASH_A], '', ['flash']).model, FLASH_B);
  });

  test('matching is case-insensitive and checks the name', () => {
    assert.equal(resolveModel([SONNET, GPT_MINI], '', ['GPT-5 MINI']).model, GPT_MINI);
  });

  test('blank fragments are ignored', () => {
    assert.equal(resolveModel([SONNET, HAIKU], '', ['  ', 'haiku']).model, HAIKU);
  });

  test('falls back to the cheapest model', () => {
    const opus = model('claude-opus-5.5', 'claude-opus-5.5', 'Claude Opus 5.5');
    const nano = model('gpt-5.4-nano', 'gpt-5.4-nano', 'GPT-5.4 nano');
    const r = resolveModel([opus, GEMINI_PRO, nano], '', PREFS);
    assert.equal(r.model, nano);
    assert.equal(r.reason, 'fallback');
  });

  test('cheapest fallback keeps the original order within a price tier', () => {
    assert.equal(resolveModel([GEMINI_PRO, SONNET], '', PREFS).model, GEMINI_PRO);
  });
});

suite('sortByPrice', () => {
  test('orders by naming convention, cheapest first', () => {
    const opus = model('claude-opus-5.5', 'claude-opus-5.5', 'Claude Opus 5.5');
    const fable = model('claude-fable-5.1', 'claude-fable-5.1', 'Claude Fable 5.1');
    const gpt5 = model('gpt-5.4', 'gpt-5.4', 'GPT-5.4');
    const nano = model('gpt-5.4-nano', 'gpt-5.4-nano', 'GPT-5.4 nano');
    const sorted = sortByPrice([fable, SONNET, GEMINI_PRO, gpt5, opus, HAIKU, nano, GPT_MINI, FLASH_A]);
    assert.deepEqual(sorted.map((m) => m.id), [
      'gpt-5.4-nano',
      'claude-haiku-4.5',
      'gpt-5-mini',
      'gemini-3.5-flash',
      'gpt-5.4',
      'claude-sonnet-5',
      'gemini-3-pro',
      'claude-opus-5.5',
      'claude-fable-5.1',
    ]);
  });

  test('"gemini" is not mistaken for "mini"', () => {
    assert.equal(priceTier(GEMINI_PRO), 3);
  });
});
