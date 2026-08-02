import { normalizeSettings } from "./ffmpeg-commands.mjs";
import {
  estimateOutputSize,
  OUTPUT_SIZE_ESTIMATOR_LIMITS,
} from "./output-size-estimator.mjs";

export const ADAPTIVE_PRESET_POLICY_VERSION = "ffimg-adaptive-v1";

export const ADAPTIVE_PRESET_IDS = Object.freeze([
  "auto",
  "light",
  "balanced",
  "crisp",
]);

const MEBIBYTE = 1024 ** 2;
const WIDTH_CANDIDATES = Object.freeze([
  160,
  240,
  320,
  360,
  480,
  540,
  640,
  720,
  960,
  1080,
  1280,
]);
const FPS_CANDIDATES = Object.freeze([6, 8, 10, 12, 15, 18, 20, 24]);

const INTENT_POLICY = Object.freeze({
  light: Object.freeze({
    maxWidth: 480,
    maxFps: 12,
    likelyBudget: Object.freeze({ gif: 8 * MEBIBYTE, apng: 12 * MEBIBYTE }),
    workUnitBudget: Object.freeze({ gif: 40_000_000, apng: 18_000_000 }),
    gifColors: 96,
    gifStats: "diff",
    gifDither: "sierra2_4a",
    apngCompression: 8,
  }),
  balanced: Object.freeze({
    maxWidth: 720,
    maxFps: 18,
    likelyBudget: Object.freeze({ gif: 24 * MEBIBYTE, apng: 36 * MEBIBYTE }),
    workUnitBudget: Object.freeze({ gif: 120_000_000, apng: 55_000_000 }),
    gifColors: 160,
    gifStats: "diff",
    gifDither: "sierra2_4a",
    apngCompression: 8,
  }),
  crisp: Object.freeze({
    maxWidth: 1280,
    maxFps: 24,
    likelyBudget: Object.freeze({ gif: 64 * MEBIBYTE, apng: 96 * MEBIBYTE }),
    workUnitBudget: Object.freeze({ gif: 280_000_000, apng: 120_000_000 }),
    gifColors: 224,
    gifStats: "full",
    gifDither: "floyd_steinberg",
    apngCompression: 7,
  }),
});

const FALLBACK_SETTINGS = Object.freeze({
  light: Object.freeze({ fps: 8, width: 360 }),
  balanced: Object.freeze({ fps: 12, width: 480 }),
  crisp: Object.freeze({ fps: 15, width: 720 }),
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizedMedia(media) {
  if (
    !media ||
    !finitePositive(media.durationSeconds) ||
    !finitePositive(media.width) ||
    !finitePositive(media.height) ||
    media.durationSeconds < 0.1 ||
    media.width > OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumSourceDimension ||
    media.height > OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumSourceDimension
  ) {
    return null;
  }

  return {
    durationSeconds: media.durationSeconds,
    width: Math.max(1, Math.round(media.width)),
    height: Math.max(1, Math.round(media.height)),
    sizeBytes: finitePositive(media.sizeBytes) ? media.sizeBytes : null,
  };
}

function sourceComplexityHint(media) {
  if (!media || media.sizeBytes == null) return 0.55;
  const density =
    media.sizeBytes /
    (media.width * media.height * media.durationSeconds);
  return clamp((Math.log10(density) + 2) / 2.7, 0, 1);
}

function normalizedTrim(trim, sourceDuration) {
  const requestedStart = Number.isFinite(trim?.start) ? trim.start : 0;
  const maximumStart = Math.max(0, sourceDuration - 0.1);
  const start = clamp(requestedStart, 0, maximumStart);
  const requestedDuration = Number.isFinite(trim?.duration) ? trim.duration : 6;
  const duration = clamp(requestedDuration, 0.1, sourceDuration - start);
  return { start, duration };
}

function interpolate(left, right, amount) {
  return left + (right - left) * amount;
}

function automaticQualityLevel(media, trim, complexity) {
  const shorterEdge = Math.min(media.width, media.height);
  const durationLevel = 1 + (8 - trim.duration) / 7;
  const resolutionAdjustment =
    shorterEdge >= 720 ? 0.3 : shorterEdge >= 480 ? 0.12 : -0.2;
  const complexityAdjustment = (0.55 - complexity) * 0.35;
  return clamp(
    durationLevel + resolutionAdjustment + complexityAdjustment,
    0,
    2,
  );
}

function interpolatePolicy(level) {
  const names = ["light", "balanced", "crisp"];
  const lowerIndex = Math.floor(level);
  const upperIndex = Math.ceil(level);
  const amount = level - lowerIndex;
  const lower = INTENT_POLICY[names[lowerIndex]];
  const upper = INTENT_POLICY[names[upperIndex]];
  const interpolateFormatValues = (key) => ({
    gif: interpolate(lower[key].gif, upper[key].gif, amount),
    apng: interpolate(lower[key].apng, upper[key].apng, amount),
  });

  return {
    intent: names[Math.round(level)],
    policy: {
      maxWidth: Math.round(interpolate(lower.maxWidth, upper.maxWidth, amount)),
      maxFps: interpolate(lower.maxFps, upper.maxFps, amount),
      likelyBudget: interpolateFormatValues("likelyBudget"),
      workUnitBudget: interpolateFormatValues("workUnitBudget"),
      gifColors: Math.round(
        interpolate(lower.gifColors, upper.gifColors, amount),
      ),
      gifStats: level >= 1.65 ? "full" : "diff",
      gifDither: level >= 1.65 ? "floyd_steinberg" : "sierra2_4a",
      apngCompression: Math.round(
        interpolate(
          lower.apngCompression,
          upper.apngCompression,
          amount,
        ),
      ),
    },
  };
}

function outputGeometry(width, media) {
  const outputWidth = Math.min(width, media.width);
  const scaledHeight = (outputWidth / media.width) * media.height;
  return {
    width: outputWidth,
    height: Math.max(2, Math.round(scaledHeight / 2) * 2),
  };
}

function qualityScore(candidate) {
  const pixels = candidate.output.width * candidate.output.height;
  return Math.log2(pixels + 1) * 0.72 + Math.log2(candidate.settings.fps + 1) * 0.28;
}

function rationaleFor({ metadataAvailable, trim, complexity, output, media }) {
  if (!metadataAvailable) return "metadata-unavailable";
  if (trim.duration >= 20) return "long-duration";
  if (complexity >= 0.76) return "dense-source";
  if (trim.duration <= 5 && output.width >= 720) return "short-source";
  if (complexity <= 0.32 && output.width >= 640) return "light-source";
  if (output.width >= media.width) return "source-size";
  return "balanced";
}

function workloadFor(format, output, frameCount, estimate) {
  const pixelFrames = output.width * output.height * frameCount;
  const workUnits = pixelFrames * (format === "gif" ? 2 : 1);
  const frameBuffers =
    output.width * output.height * 4 * (format === "gif" ? 12 : 8);
  const outputCopies =
    (estimate?.rangeBytes?.upper ?? 0) * (format === "gif" ? 3 : 2);

  return {
    pixelFrames,
    workUnits,
    estimatedWorkingSetBytes: frameBuffers + outputCopies,
  };
}

function riskFor(candidate, policy, format, fellBack) {
  const upper = candidate.estimate?.rangeBytes?.upper ?? 0;
  const likely = candidate.estimate?.rangeBytes?.likely ?? 0;
  const workUnits = candidate.workload.workUnits;
  const workUnitBudget = policy.workUnitBudget[format];
  const likelyBudget = policy.likelyBudget[format];
  const workingSet = candidate.workload.estimatedWorkingSetBytes;

  let reason = "within-budget";
  if (fellBack) reason = "workload";
  else if (candidate.estimate?.capped || upper >= 128 * MEBIBYTE) {
    reason = "output-size";
  } else if (workUnits > workUnitBudget * 1.2) reason = "workload";
  else if (workingSet >= 384 * MEBIBYTE) reason = "memory";

  if (
    fellBack ||
    candidate.estimate?.capped ||
    upper >= 128 * MEBIBYTE ||
    workUnits > workUnitBudget * 1.2 ||
    workingSet >= 384 * MEBIBYTE
  ) {
    return { level: "high", reason };
  }
  if (
    upper >= 50 * MEBIBYTE ||
    likely > likelyBudget * 0.85 ||
    workUnits > workUnitBudget * 0.85 ||
    workingSet >= 192 * MEBIBYTE
  ) {
    return {
      level: "medium",
      reason:
        workingSet >= 192 * MEBIBYTE
          ? "memory"
          : workUnits > workUnitBudget * 0.85
            ? "workload"
            : "output-size",
    };
  }
  return { level: "low", reason: "within-budget" };
}

function makeSettings({ format, preset, trim, fps, width, policy }) {
  return normalizeSettings(
    {
      format,
      mode: "Advanced",
      preset,
      start: trim.start,
      duration: trim.duration,
      fps,
      width,
      plays: 0,
      gifColors: policy.gifColors,
      gifStats: policy.gifStats,
      gifDither: policy.gifDither,
      apngCompression: policy.apngCompression,
    },
    trim.start + trim.duration,
  );
}

function fallbackResult({ format, mode, requestedPreset, trim }) {
  const intent = requestedPreset === "auto" ? "balanced" : requestedPreset;
  const policy = INTENT_POLICY[intent];
  const fallback = FALLBACK_SETTINGS[intent];
  const safeTrim = {
    start: Number.isFinite(trim?.start) ? Math.max(0, trim.start) : 0,
    duration: Number.isFinite(trim?.duration)
      ? Math.max(0.1, trim.duration)
      : 6,
  };
  const settings = makeSettings({
    format,
    mode,
    preset: requestedPreset,
    trim: safeTrim,
    fps: fallback.fps,
    width: fallback.width,
    policy,
  });

  return {
    policyVersion: ADAPTIVE_PRESET_POLICY_VERSION,
    requestedPreset,
    intent,
    metadataAvailable: false,
    settings: { ...settings, mode, preset: requestedPreset },
    output: { width: fallback.width, height: null, frameCount: null },
    estimate: null,
    risk: {
      level: "unknown",
      reason: "metadata-unavailable",
      pixelFrames: null,
      workUnits: null,
      estimatedWorkingSetBytes: null,
    },
    rationale: "metadata-unavailable",
  };
}

export function recommendBeginnerDuration(mediaInput) {
  const media = normalizedMedia(mediaInput);
  if (!media) return 6;

  const complexity = sourceComplexityHint(media);
  if (media.durationSeconds <= 12) return media.durationSeconds;
  const longSourceTarget =
    media.durationSeconds <= 30
      ? 12
      : clamp(12 - (media.durationSeconds - 30) / 15, 8, 12);
  const complexityPenalty =
    clamp((complexity - 0.65) / 0.2, 0, 1) *
    4 *
    clamp((media.durationSeconds - 12) / 8, 0, 1);
  return Math.min(
    media.durationSeconds,
    Math.max(6, Math.round((longSourceTarget - complexityPenalty) * 10) / 10),
  );
}

/**
 * @param {{
 *   format?: string,
 *   mode?: string,
 *   preset?: string,
 *   media?: {
 *     durationSeconds?: number | null,
 *     width?: number | null,
 *     height?: number | null,
 *     sizeBytes?: number | null,
 *   } | null,
 *   trim?: { start?: number, duration?: number },
 * }} [options]
 */
export function resolveAdaptivePreset({
  format = "gif",
  mode = "Beginner",
  preset = "auto",
  media: mediaInput,
  trim,
} = {}) {
  const safeFormat = format === "apng" ? "apng" : "gif";
  const requestedPreset = ADAPTIVE_PRESET_IDS.includes(preset)
    ? preset
    : "auto";
  const media = normalizedMedia(mediaInput);
  if (!media) {
    return fallbackResult({
      format: safeFormat,
      mode,
      requestedPreset,
      trim,
    });
  }

  const safeTrim = normalizedTrim(trim, media.durationSeconds);
  const complexity = sourceComplexityHint(media);
  const automaticPolicy =
    requestedPreset === "auto"
      ? interpolatePolicy(automaticQualityLevel(media, safeTrim, complexity))
      : null;
  const intent = automaticPolicy?.intent ?? requestedPreset;
  const policy = automaticPolicy?.policy ?? INTENT_POLICY[intent];
  const budgetFactor = clamp(1.08 - (complexity - 0.55) * 0.28, 0.92, 1.12);
  const likelyBudget = policy.likelyBudget[safeFormat] * budgetFactor;
  const workUnitBudget = policy.workUnitBudget[safeFormat] * budgetFactor;
  const candidates = [];
  const seen = new Set();

  for (const requestedWidth of WIDTH_CANDIDATES) {
    if (requestedWidth > policy.maxWidth) continue;
    const width = clamp(Math.min(requestedWidth, media.width), 160, 1280);
    const output = outputGeometry(width, media);
    for (const fps of FPS_CANDIDATES) {
      if (fps > policy.maxFps) continue;
      const key = `${output.width}:${output.height}:${fps}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const settings = makeSettings({
        format: safeFormat,
        mode,
        preset: requestedPreset,
        trim: safeTrim,
        fps,
        width,
        policy,
      });
      const estimate = estimateOutputSize({ settings, media });
      const frameCount = Math.max(
        1,
        Math.ceil(settings.fps * settings.duration),
      );
      const candidate = {
        settings,
        output: { ...output, frameCount },
        estimate: estimate.status === "available" ? estimate : null,
        workload: workloadFor(
          safeFormat,
          output,
          frameCount,
          estimate.status === "available" ? estimate : null,
        ),
      };
      candidate.score = qualityScore(candidate);
      candidates.push(candidate);
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  const selected =
    candidates.find(
      (candidate) =>
        candidate.estimate &&
        !candidate.estimate.capped &&
        candidate.estimate.rangeBytes.likely <= likelyBudget &&
        candidate.workload.workUnits <= workUnitBudget &&
        (requestedPreset !== "auto" ||
          candidate.estimate.rangeBytes.upper < 128 * MEBIBYTE),
    ) ?? candidates.at(-1);
  const fellBack = !selected ||
    selected.workload.workUnits > workUnitBudget ||
    (selected.estimate?.rangeBytes.likely ?? Number.POSITIVE_INFINITY) >
      likelyBudget;
  const finalCandidate = selected ?? candidates[0];

  if (!finalCandidate) {
    return fallbackResult({
      format: safeFormat,
      mode,
      requestedPreset,
      trim: safeTrim,
    });
  }

  return {
    policyVersion: ADAPTIVE_PRESET_POLICY_VERSION,
    requestedPreset,
    intent,
    metadataAvailable: true,
    settings: {
      ...finalCandidate.settings,
      mode,
      preset: requestedPreset,
    },
    output: finalCandidate.output,
    estimate: finalCandidate.estimate,
    risk: {
      ...riskFor(finalCandidate, policy, safeFormat, fellBack),
      ...finalCandidate.workload,
    },
    rationale: rationaleFor({
      metadataAvailable: true,
      trim: safeTrim,
      complexity,
      output: finalCandidate.output,
      media,
    }),
  };
}
