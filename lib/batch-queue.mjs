const MEBIBYTE = 1024 * 1024;

/**
 * Apply the same hard browser-safety envelope to custom batch jobs that the
 * adaptive preset engine applies to its most demanding source-first preset.
 *
 * @param {{
 *   settings: {format: "gif" | "apng"; width: number; fps: number};
 *   estimate: {
 *     status: "available" | "unavailable";
 *     capped: boolean;
 *     rangeBytes: null | {upper: number};
 *     output: {width: number | null; height: number | null; frameCount: number | null};
 *   };
 *   metadataAvailable: boolean;
 *   presetSafetyError?: string | null;
 * }} options
 */
export function getBatchSettingsSafetyError({
  settings,
  estimate,
  metadataAvailable,
  presetSafetyError = null,
}) {
  if (presetSafetyError) return presetSafetyError;

  if (!metadataAvailable) {
    return settings.width > 480 || settings.fps > 12
      ? "영상 정보를 확인할 수 없을 때는 480px · 12 FPS 이하로 설정해 주세요."
      : null;
  }

  if (
    estimate.status !== "available" ||
    !estimate.rangeBytes ||
    !Number.isFinite(estimate.output.width) ||
    !Number.isFinite(estimate.output.height) ||
    !Number.isFinite(estimate.output.frameCount)
  ) {
    return "이 설정의 변환 부담을 계산하지 못했어요. 너비나 FPS를 낮춰 주세요.";
  }

  const hardOutputLimit =
    settings.format === "gif" ? 160 * MEBIBYTE : 192 * MEBIBYTE;
  if (estimate.capped || estimate.rangeBytes.upper >= hardOutputLimit) {
    return "예상 결과가 너무 커요. 길이, 너비 또는 FPS를 낮춰 주세요.";
  }

  const pixelFrames =
    estimate.output.width *
    estimate.output.height *
    estimate.output.frameCount;
  const workUnits = pixelFrames * (settings.format === "gif" ? 2 : 1);
  const workLimit = settings.format === "gif" ? 320_000_000 : 140_000_000;
  if (workUnits > workLimit) {
    return "처리할 프레임이 너무 많아요. 길이, 너비 또는 FPS를 낮춰 주세요.";
  }

  const estimatedWorkingSet =
    estimate.output.width *
      estimate.output.height *
      4 *
      (settings.format === "gif" ? 12 : 8) +
    estimate.rangeBytes.upper * (settings.format === "gif" ? 3 : 2);
  if (estimatedWorkingSet >= 384 * MEBIBYTE) {
    return "브라우저 메모리를 너무 많이 사용할 수 있어요. 설정을 한 단계 낮춰 주세요.";
  }

  return null;
}

/**
 * Pick a deliberately conservative worker count. Each worker owns a complete
 * single-thread ffmpeg.wasm instance, so two workers can use substantially
 * more memory than one.
 *
 * @param {{
 *   hardwareConcurrency?: number | null;
 *   deviceMemory?: number | null;
 *   fileSizeBytes?: number | null;
 *   jobCount?: number;
 *   hasRiskyJobs?: boolean;
 *   estimatedWorkingSetBytes?: number;
 * }} [options]
 */
export function getBatchExecutionPlan({
  hardwareConcurrency,
  deviceMemory,
  fileSizeBytes,
  jobCount,
  hasRiskyJobs = false,
  estimatedWorkingSetBytes = 0,
} = {}) {
  if (jobCount < 2) {
    return { concurrency: 1, reason: "single-job" };
  }
  if (!Number.isFinite(deviceMemory) || deviceMemory < 8) {
    return { concurrency: 1, reason: "memory-unknown-or-low" };
  }
  if (!Number.isFinite(hardwareConcurrency) || hardwareConcurrency < 8) {
    return { concurrency: 1, reason: "cpu-low" };
  }
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes >= 256 * MEBIBYTE) {
    return { concurrency: 1, reason: "large-source" };
  }
  if (hasRiskyJobs) {
    return { concurrency: 1, reason: "heavy-settings" };
  }
  if (
    !Number.isFinite(estimatedWorkingSetBytes) ||
    estimatedWorkingSetBytes > 256 * MEBIBYTE
  ) {
    return { concurrency: 1, reason: "working-set" };
  }

  return { concurrency: 2, reason: "parallel-safe" };
}

/**
 * Run independent jobs with bounded concurrency. A failure is isolated to its
 * item and does not prevent later work from starting.
 *
 * @template T, R
 * @param {T[]} items
 * @param {{
 *   concurrency?: number;
 *   signal?: AbortSignal;
 *   worker: (item: T, index: number, slotIndex: number) => Promise<R>;
 *   onItemStart?: (item: T, index: number, slotIndex: number) => void;
 *   onItemSettled?: (
 *     item: T,
 *     outcome: {status: "fulfilled"; value: R} | {status: "rejected" | "cancelled"; error?: unknown},
 *     index: number,
 *     slotIndex: number,
 *   ) => void;
 * }} options
 */
export async function runBatchQueue(
  items,
  { concurrency = 1, signal, worker, onItemStart, onItemSettled } = {},
) {
  const safeConcurrency = Math.max(
    1,
    Math.min(2, Math.floor(Number(concurrency) || 1), items.length || 1),
  );
  const outcomes = new Array(items.length);
  let nextIndex = 0;

  async function runSlot(slotIndex) {
    while (!signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      const item = items[index];
      onItemStart?.(item, index, slotIndex);

      try {
        const value = await worker(item, index, slotIndex);
        outcomes[index] = { status: "fulfilled", value };
      } catch (error) {
        outcomes[index] = {
          status: signal?.aborted ? "cancelled" : "rejected",
          error,
        };
      }

      onItemSettled?.(item, outcomes[index], index, slotIndex);
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, (_, slotIndex) =>
      runSlot(slotIndex),
    ),
  );

  for (let index = 0; index < items.length; index += 1) {
    if (!outcomes[index]) outcomes[index] = { status: "cancelled" };
  }

  return outcomes;
}
