// API prices in USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, 2026-10).
// A subscription (Pro, Max) is not billed per token; these prices say what the same work would cost
// on the API, which is how the value of the subscription is measured.

const PRICES = [
  // [pattern, input, 5m cache write, 1h cache write, cache read, output]
  [/fable-5-1|mythos-5-1/, 10, 12.5, 20, 0.25, 50],
  [/fable-5|mythos-5/, 10, 12.5, 20, 1, 50],
  [/opus-5-5/, 4, 5, 8, 0.2, 20],
  [/opus-5(?!-\d)/, 5, 6.25, 10, 0.5, 25],
  [/opus-4-(5|6|7|8)/, 5, 6.25, 10, 0.5, 25],
  [/opus-4/, 15, 18.75, 30, 1.5, 75],
  [/sonnet-5-5/, 2, 2.5, 4, 0.1, 10],
  [/sonnet-5(?!-\d)/, 2, 2.5, 4, 0.2, 10],
  [/sonnet-4|sonnet-3|3-[57]-sonnet/, 3, 3.75, 6, 0.3, 15],
  [/haiku-5-5/, 0.1, 0.125, 0.2, 0.01, 0.5],
  [/haiku-4/, 1, 1.25, 2, 0.1, 5],
  [/haiku-3-5|3-5-haiku/, 0.8, 1, 1.6, 0.08, 4],
  [/haiku/, 0.25, 0.3, 0.5, 0.03, 1.25],
];

// Haiku 5.5 costs five times more once a prompt is over 100,000 tokens.
const HAIKU_55_LONG = 100_000;

/** The price row of a model id such as "claude-opus-5-5" or "claude-sonnet-4-5-20250929"; null when unknown. */
export function priceOf(model) {
  const id = String(model ?? '').toLowerCase();
  for (const [pattern, input, write5m, write1h, read, output] of PRICES) {
    if (pattern.test(id)) {
      return { input, write5m, write1h, read, output };
    }
  }

  return null;
}

/**
 * What a request would cost on the API. Fast mode doubles Opus 5.5's price (and the caching prices with it).
 * Cache writes are 5-minute ones unless the 1-hour part is given.
 */
export function costOf({ model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0, speed }) {
  const price = priceOf(model);
  if (!price) {
    return 0;
  }

  let factor = speed === 'fast' ? 2 : 1;
  if (/haiku-5-5/.test(String(model)) && input + cacheRead + cacheWrite > HAIKU_55_LONG) {
    factor *= 5;
  }

  const write5m = Math.max(0, cacheWrite - cacheWrite1h);
  const dollars =
    input * price.input +
    output * price.output +
    cacheRead * price.read +
    write5m * price.write5m +
    cacheWrite1h * price.write1h;
  return (dollars * factor) / 1_000_000;
}

/** A short name for a model id: "claude-opus-5-5" → "Opus 5.5". */
export function modelLabel(model) {
  const match = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(String(model ?? '').toLowerCase());
  if (!match) {
    return model || 'noma\'lum';
  }

  const family = match[1][0].toUpperCase() + match[1].slice(1);
  const minor = match[3] && match[3].length <= 2 ? `.${match[3]}` : '';
  return `${family} ${match[2]}${minor}`;
}
