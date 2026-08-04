export const OUTPUT_SIZE_MODEL_VERSION = "ffimg-size-v2";

export const OUTPUT_SIZE_ESTIMATOR_LIMITS = Object.freeze({
  minimumBytes: 1024,
  maximumBytes: 4 * 1024 ** 3,
  largeThresholdBytes: 50 * 1024 ** 2,
  veryLargeThresholdBytes: 100 * 1024 ** 2,
  maximumSourceDimension: 100_000,
});

const FORMAT_OVERHEAD = Object.freeze({
  gif: Object.freeze({
    baseBytes: 512,
    bytesPerFrame: 12,
  }),
  apng: Object.freeze({
    baseBytes: 768,
    bytesPerFrame: 24,
  }),
});

const GIF_DITHER_FACTORS = Object.freeze({
  none: 0.77,
  bayer: 0.83,
  sierra2_4a: 1,
  floyd_steinberg: 0.95,
});

const APNG_COMPRESSION_FACTORS = Object.freeze([
  null,
  1.16,
  1.14,
  1.12,
  1.08,
  1.04,
  1,
  0.99,
  0.985,
  0.98,
]);

const GIF_STATS = new Set(["diff", "full"]);
const GIF_DITHERS = new Set(Object.keys(GIF_DITHER_FACTORS));

// The source container is only a hint: audio, codec efficiency, and bitrate can
// all distort it. The log scale keeps that hint bounded while still separating
// extremely flat sources from highly detailed ones in the calibration corpus.
const SOURCE_DENSITY_LOG_FLOOR = -2;
const SOURCE_DENSITY_LOG_SPAN = 2.7;

/**
 * @typedef {{
 *   format: "gif" | "apng";
 *   duration: number;
 *   fps: number;
 *   width: number;
 *   gifColors: number;
 *   gifStats: "diff" | "full";
 *   gifDither: "none" | "bayer" | "sierra2_4a" | "floyd_steinberg";
 *   apngCompression: number;
 * }} NormalizedPredictionSettings
 *
 * @typedef {{
 *   durationSeconds?: number | null;
 *   width?: number | null;
 *   height?: number | null;
 *   sizeBytes?: number | null;
 * }} PredictionMedia
 *
 * @typedef {{
 *   modelVersion: string;
 *   status: "available";
 *   reason: null;
 *   rangeBytes: { lower: number; likely: number; upper: number };
 *   output: { width: number; height: number; frameCount: number };
 *   confidence: "limited";
 *   primaryUncertainty: "visual-complexity";
 *   sizeClass: "normal" | "large" | "very-large";
 *   capped: boolean;
 * }} AvailableOutputSizeEstimate
 *
 * @typedef {{
 *   modelVersion: string;
 *   status: "unavailable";
 *   reason: "missing-metadata" | "invalid-input";
 *   rangeBytes: null;
 *   output: { width: null; height: null; frameCount: null };
 *   confidence: "unavailable";
 *   primaryUncertainty: null;
 *   sizeClass: "unavailable";
 *   capped: false;
 * }} UnavailableOutputSizeEstimate
 */

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isFiniteInRange(value, minimum, maximum) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isIntegerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function unavailable(reason) {
  return {
    modelVersion: OUTPUT_SIZE_MODEL_VERSION,
    status: /** @type {const} */ ("unavailable"),
    reason,
    rangeBytes: null,
    output: {
      width: null,
      height: null,
      frameCount: null,
    },
    confidence: /** @type {const} */ ("unavailable"),
    primaryUncertainty: null,
    sizeClass: /** @type {const} */ ("unavailable"),
    capped: false,
  };
}

function settingsAreNormalized(settings) {
  if (!settings || (settings.format !== "gif" && settings.format !== "apng")) {
    return false;
  }
  if (!isFiniteInRange(settings.duration, 0.1, Number.MAX_VALUE)) return false;
  if (!isFiniteInRange(settings.fps, 1, 60)) return false;
  if (!Number.isSafeInteger(Math.ceil(settings.duration * settings.fps))) {
    return false;
  }
  if (!isIntegerInRange(settings.width, 160, 1920)) return false;

  return settings.format === "gif"
    ? isIntegerInRange(settings.gifColors, 2, 256) &&
        GIF_STATS.has(settings.gifStats) &&
        GIF_DITHERS.has(settings.gifDither)
    : isIntegerInRange(settings.apngCompression, 0, 9);
}

function metadataState(media) {
  if (
    !media ||
    media.durationSeconds == null ||
    media.width == null ||
    media.height == null
  ) {
    return "missing-metadata";
  }

  if (
    !isFiniteInRange(media.durationSeconds, Number.MIN_VALUE, Number.MAX_VALUE) ||
    !isFiniteInRange(
      media.width,
      Number.MIN_VALUE,
      OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumSourceDimension,
    ) ||
    !isFiniteInRange(
      media.height,
      Number.MIN_VALUE,
      OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumSourceDimension,
    ) ||
    (media.sizeBytes != null &&
      !isFiniteInRange(media.sizeBytes, Number.MIN_VALUE, Number.MAX_VALUE))
  ) {
    return "invalid-input";
  }

  return "available";
}

function sourceComplexityHint(media) {
  if (media.sizeBytes == null) return 0.55;

  const density =
    media.sizeBytes /
    (media.width * media.height * media.durationSeconds);
  return clamp(
    (Math.log10(density) - SOURCE_DENSITY_LOG_FLOOR) /
      SOURCE_DENSITY_LOG_SPAN,
    0,
    1,
  );
}

function gifPaletteFactor(colors) {
  return clamp((colors / 128) ** 0.18, 0.45, 1.2);
}

function apngCompressionFactor(compression) {
  return APNG_COMPRESSION_FACTORS[compression];
}

function boundedByteCount(value) {
  return clamp(
    value,
    OUTPUT_SIZE_ESTIMATOR_LIMITS.minimumBytes,
    OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumBytes,
  );
}

function orderedRange(lowerValue, likelyValue, upperValue) {
  const lower = Math.floor(boundedByteCount(lowerValue));
  const upper = Math.ceil(
    Math.max(lower, boundedByteCount(upperValue)),
  );
  const likely = Math.round(
    clamp(boundedByteCount(likelyValue), lower, upper),
  );

  return {
    rangeBytes: { lower, likely, upper },
    capped:
      lowerValue > OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumBytes ||
      likelyValue > OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumBytes ||
      upperValue > OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumBytes,
  };
}

function gifRange(pixelFrames, frameCount, settings, complexity) {
  const complexityCube = complexity ** 3;
  const paletteFactor = gifPaletteFactor(settings.gifColors);
  const ditherFactor = GIF_DITHER_FACTORS[settings.gifDither];
  const statsFactor = settings.gifStats === "full" ? 1.06 : 1;
  const settingsFactor = paletteFactor * ditherFactor * statsFactor;
  const overhead =
    FORMAT_OVERHEAD.gif.baseBytes +
    FORMAT_OVERHEAD.gif.bytesPerFrame * frameCount;

  // These deliberately wide envelopes contain flat, motion-heavy, and highly
  // detailed 480x270 calibration fixtures. `likely` is useful for ranking
  // future optimizer candidates; the UI still exposes the safer full range.
  const lowerRate = 0.00018 + 0.006 * complexityCube;
  const likelyRate = 0.0008 + 0.5 * complexityCube;
  const upperRate = 0.08 + complexityCube;

  return orderedRange(
    pixelFrames * lowerRate * settingsFactor + overhead,
    pixelFrames * likelyRate * settingsFactor + overhead,
    pixelFrames * upperRate * settingsFactor + overhead * 1.5,
  );
}

function apngRange(
  pixelFrames,
  pixelsPerFrame,
  frameCount,
  settings,
  complexity,
) {
  const overhead =
    FORMAT_OVERHEAD.apng.baseBytes +
    FORMAT_OVERHEAD.apng.bytesPerFrame * frameCount;

  if (settings.apngCompression === 0) {
    // Deflate level 0 is a discontinuity, not a small step below level 1.
    // APNG frame differencing can make a static clip close to one raw frame,
    // while full-frame motion approaches four RGBA bytes per pixel-frame.
    const lower = pixelsPerFrame * 3.75 + overhead;
    const upper = pixelFrames * 4.15 + overhead * 1.5;
    const likely = lower + (upper - lower) * Math.sqrt(complexity);
    return orderedRange(lower, likely, upper);
  }

  const complexityPower = complexity ** 2.5;
  const compressionFactor = apngCompressionFactor(
    settings.apngCompression,
  );
  const lowerRate = 0.00025 + 0.01 * complexityPower;
  const likelyRate = 0.001 + 1.3 * complexityPower;
  const upperRate = 0.1 + 2.6 * complexityPower;

  return orderedRange(
    pixelFrames * lowerRate * compressionFactor + overhead,
    pixelFrames * likelyRate * compressionFactor + overhead,
    pixelFrames * upperRate * compressionFactor + overhead * 1.5,
  );
}

/**
 * Estimate an animated output range without reading or encoding video frames.
 *
 * `settings` must already be the result of `normalizeSettings`. The model only
 * uses metadata and settings available in the browser, and its broad range is
 * intentionally dominated by the unobserved visual complexity of the frames.
 *
 * @param {{
 *   settings: NormalizedPredictionSettings;
 *   media: PredictionMedia;
 * }} input
 * @returns {AvailableOutputSizeEstimate | UnavailableOutputSizeEstimate}
 */
export function estimateOutputSize(input) {
  if (!input || !settingsAreNormalized(input.settings)) {
    return unavailable("invalid-input");
  }

  const mediaState = metadataState(input.media);
  if (mediaState !== "available") {
    return unavailable(mediaState);
  }

  const { settings, media } = input;
  const sourceWidth = Math.max(1, Math.round(media.width));
  const sourceHeight = Math.max(1, Math.round(media.height));
  const outputWidth = Math.min(settings.width, sourceWidth);
  const scaledHeight = (outputWidth / sourceWidth) * sourceHeight;
  const outputHeight = Math.max(2, Math.round(scaledHeight / 2) * 2);
  const continuousFrameCount = settings.fps * settings.duration;
  const frameCount = Math.max(1, Math.ceil(continuousFrameCount));
  const pixelsPerFrame = outputWidth * outputHeight;
  const pixelFrames = pixelsPerFrame * frameCount;
  const complexity = sourceComplexityHint(media);
  const rangeResult =
    settings.format === "gif"
      ? gifRange(pixelFrames, frameCount, settings, complexity)
      : apngRange(
          pixelFrames,
          pixelsPerFrame,
          frameCount,
          settings,
          complexity,
        );
  const { rangeBytes, capped } = rangeResult;
  const sizeClass =
    rangeBytes.upper >=
    OUTPUT_SIZE_ESTIMATOR_LIMITS.veryLargeThresholdBytes
      ? "very-large"
      : rangeBytes.upper >= OUTPUT_SIZE_ESTIMATOR_LIMITS.largeThresholdBytes
        ? "large"
        : "normal";

  return {
    modelVersion: OUTPUT_SIZE_MODEL_VERSION,
    status: "available",
    reason: null,
    rangeBytes,
    output: {
      width: outputWidth,
      height: outputHeight,
      frameCount,
    },
    confidence: "limited",
    primaryUncertainty: "visual-complexity",
    sizeClass,
    capped,
  };
}
