export type RulesMarkdownLoader = (
  rulesId: string
) => Promise<string | undefined>;

export type RulesMarkdownResolverOptions = {
  onError?: (rulesId: string, error: unknown) => void;
};

export function createRulesMarkdownResolver(
  loader: RulesMarkdownLoader,
  options?: RulesMarkdownResolverOptions
): (rulesId: string) => Promise<string | undefined> {
  const cache = new Map<string, string | null>();

  return async (rulesId: string) => {
    if (cache.has(rulesId)) {
      return cache.get(rulesId) ?? undefined;
    }
    try {
      const markdown = await loader(rulesId);
      cache.set(rulesId, markdown ?? null);
      return markdown ?? undefined;
    } catch (err) {
      options?.onError?.(rulesId, err);
      cache.set(rulesId, null);
      return undefined;
    }
  };
}
