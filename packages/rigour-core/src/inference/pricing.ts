/**
 * List prices for pricing a run's tokens when the provider does not report
 * cost itself (OpenRouter does; see cloud-provider.ts). USD per million tokens.
 *
 * Only models whose price we have checked are listed. An unlisted model gets
 * no cost at all rather than a guess: a wrong number in Studio is worse than
 * a missing one.
 */
interface Price {
    input: number;
    output: number;
}

const PRICES: Array<[RegExp, Price]> = [
    [/claude-opus-5[.-]5/, { input: 4, output: 20 }],
    [/claude-sonnet-5[.-]5/, { input: 2, output: 10 }],
    [/claude-haiku-4[.-]5/, { input: 1, output: 5 }],
];

export function listPrice(model: string): Price | undefined {
    const name = model.toLowerCase();
    return PRICES.find(([pattern]) => pattern.test(name))?.[1];
}

export function priceTokens(model: string, inputTokens: number, outputTokens: number): number | undefined {
    const price = listPrice(model);
    return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : undefined;
}
