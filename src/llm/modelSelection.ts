/** The subset of `vscode.LanguageModelChat` needed for ranking. */
export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly family: string;
}

/** Default of `intellicommit.preferredModels`: cheap, fast models, in order of preference. */
export const DEFAULT_PREFERRED_MODELS: readonly string[] = ['gpt-5-mini', 'gpt-5.4-mini', 'flash', 'gpt-5.4-nano', 'gpt-4o-mini', 'haiku'];

export type ResolutionReason = 'explicit' | 'preference' | 'fallback';

export interface ModelResolution<T extends ModelInfo> {
  readonly model: T | undefined;
  readonly reason: ResolutionReason | undefined;
  /** Set when `intellicommit.model` names a model that is not available. */
  readonly staleExplicitId: string | undefined;
}

/**
 * 1. The explicitly configured model id, if available.
 * 2. The first preference fragment that matches any model (substring of id,
 *    family or name, case-insensitive); ties go to the earlier model.
 * 3. The cheapest model by naming convention (see `priceTier`).
 */
export function resolveModel<T extends ModelInfo>(
  models: readonly T[],
  explicitId: string,
  preferredFragments: readonly string[],
): ModelResolution<T> {
  const wanted = explicitId.trim();
  let staleExplicitId: string | undefined;
  if (wanted !== '') {
    const explicit = models.find((m) => m.id === wanted);
    if (explicit) {
      return { model: explicit, reason: 'explicit', staleExplicitId: undefined };
    }
    staleExplicitId = wanted;
  }

  for (const fragment of preferredFragments) {
    const needle = fragment.trim().toLowerCase();
    if (needle === '') {
      continue;
    }
    const match = models.find((m) => matchesFragment(m, needle));
    if (match) {
      return { model: match, reason: 'preference', staleExplicitId };
    }
  }

  const cheapest = sortByPrice(models)[0];
  return { model: cheapest, reason: cheapest ? 'fallback' : undefined, staleExplicitId };
}

function matchesFragment(model: ModelInfo, needle: string): boolean {
  return [model.id, model.family, model.name].some((field) => field.toLowerCase().includes(needle));
}

/**
 * Rough price tier from well-known model naming conventions (lower is cheaper).
 * Only used to order lists; it is not a price lookup.
 */
const PRICE_TIERS: readonly (readonly [RegExp, number])[] = [
  [/(?:^|[^a-z])(?:nano|lite)(?:$|[^a-z])/, 0],
  [/(?:^|[^a-z])(?:mini|haiku|flash|small)(?:$|[^a-z])/, 1],
  [/(?:^|[^a-z])(?:sonnet|pro|large)(?:$|[^a-z])/, 3],
  [/(?:^|[^a-z])opus(?:$|[^a-z])/, 4],
  [/(?:^|[^a-z])fable(?:$|[^a-z])/, 5],
];
const DEFAULT_TIER = 2;

export function priceTier(model: ModelInfo): number {
  const text = `${model.family} ${model.id} ${model.name}`.toLowerCase();
  return PRICE_TIERS.find(([pattern]) => pattern.test(text))?.[1] ?? DEFAULT_TIER;
}

/** Sorts from cheapest to most expensive by naming convention; ties keep their order. */
export function sortByPrice<T extends ModelInfo>(models: readonly T[]): T[] {
  return models
    .map((model, index) => ({ model, index, tier: priceTier(model) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.model);
}
