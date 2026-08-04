export const COMMON_FRAME_RATES = Object.freeze([
  6,
  8,
  10,
  12,
  15,
  18,
  20,
  23.976,
  24,
  25,
  29.97,
  30,
  48,
  50,
  59.94,
  60,
]);

const MIN_FRAME_RATE = 1;
const MAX_FRAME_RATE = 60;

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundedFrameRate(value) {
  return Number(value.toFixed(3));
}

export function normalizeFrameRate(value, fallback = 12) {
  const fallbackNumber = finiteNumber(fallback) ?? 12;
  const number = finiteNumber(value) ?? fallbackNumber;
  return roundedFrameRate(
    Math.min(MAX_FRAME_RATE, Math.max(MIN_FRAME_RATE, number)),
  );
}

export function parseFrameRate(value) {
  if (typeof value === "string" && value.includes("/")) {
    const [numerator, denominator, ...rest] = value.split("/");
    const left = finiteNumber(numerator);
    const right = finiteNumber(denominator);
    if (rest.length > 0 || left == null || right == null || right === 0) {
      return null;
    }
    const result = left / right;
    return result > 0 ? roundedFrameRate(result) : null;
  }

  const result = finiteNumber(value);
  return result != null && result > 0 ? roundedFrameRate(result) : null;
}

export function formatFrameRate(fps) {
  return (parseFrameRate(fps) ?? normalizeFrameRate(fps)).toString();
}

/**
 * Builds practical encoder choices without ever recommending above a known
 * source rate. An explicit target acts as an additional ceiling.
 */
export function getSourceAwareFrameRateOptions(
  sourceFps,
  { maxFps = MAX_FRAME_RATE, fpsTarget } = {},
) {
  const source = parseFrameRate(sourceFps);
  const target = parseFrameRate(fpsTarget);
  const maximum = normalizeFrameRate(maxFps, MAX_FRAME_RATE);
  const ceiling = roundedFrameRate(
    Math.min(maximum, source ?? maximum, target ?? maximum),
  );
  const values = COMMON_FRAME_RATES.filter((fps) => fps <= ceiling);
  values.push(ceiling);
  return [...new Set(values.map(roundedFrameRate))].sort(
    (left, right) => left - right,
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function snapCommonRate(value) {
  const nearest = COMMON_FRAME_RATES.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
  );
  return Math.abs(nearest - value) / nearest <= 0.003
    ? nearest
    : roundedFrameRate(value);
}

/**
 * Pure requestVideoFrameCallback sample reducer. Missed callbacks are handled
 * through presentedFrames deltas instead of assuming one callback per frame.
 */
export function estimateFrameRateFromSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const rates = [];

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const currentTime = finiteNumber(current?.mediaTime);
    const previousTime = finiteNumber(previous?.mediaTime);
    const currentFrames = finiteNumber(current?.presentedFrames);
    const previousFrames = finiteNumber(previous?.presentedFrames);
    if (
      currentTime == null ||
      previousTime == null ||
      currentFrames == null ||
      previousFrames == null
    ) {
      continue;
    }
    const elapsed = currentTime - previousTime;
    const frames = currentFrames - previousFrames;
    if (
      !Number.isFinite(elapsed) ||
      !Number.isFinite(frames) ||
      elapsed <= 0 ||
      frames <= 0
    ) {
      continue;
    }
    const rate = frames / elapsed;
    if (rate >= MIN_FRAME_RATE && rate <= 240) rates.push(rate);
  }

  if (rates.length === 0) return null;
  const center = median(rates);
  const filtered = rates.filter(
    (rate) => Math.abs(rate - center) / center <= 0.12,
  );
  return snapCommonRate(median(filtered.length > 0 ? filtered : rates));
}
