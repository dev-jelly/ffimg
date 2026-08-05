import {
  buildApngCommandFromResolved,
  buildGifCommandsFromResolved,
  outputFileFor,
  VIRTUAL_FILES,
} from "@/lib/ffmpeg-commands.mjs";
import {
  loadBrowserFfmpeg,
  mountLocalFile,
  setFfmpegProgressListener,
  type BrowserFfmpeg,
  unmountLocalFile,
} from "@/lib/ffmpeg-runtime";

export type ResolvedConversionSettings = {
  format: "gif" | "apng";
  mode: string;
  preset: string;
  start: number;
  duration: number;
  fps: number;
  width: number;
  plays: number;
  gifColors: number;
  gifStats: "diff" | "full";
  gifDither: "sierra2_4a" | "floyd_steinberg" | "bayer" | "none";
  apngCompression: number;
};

export type ConversionStage =
  | "loading"
  | "preparing"
  | "palette"
  | "encoding"
  | "finalizing";

export type ConversionUpdate = {
  stage: ConversionStage;
  progress: number;
  message: string;
  isIndeterminate?: boolean;
};

export async function convertLocalVideo({
  file,
  settings,
  signal,
  onUpdate,
  onEngineReady,
  onEngineDisposed,
}: {
  file: File;
  settings: ResolvedConversionSettings;
  signal: AbortSignal;
  onUpdate?: (update: ConversionUpdate) => void;
  onEngineReady?: (engine: BrowserFfmpeg) => void;
  onEngineDisposed?: (engine: BrowserFfmpeg) => void;
}) {
  let engine: BrowserFfmpeg | null = null;
  let removeProgressListener: (() => void) | null = null;

  const ensureActive = () => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const report = (update: ConversionUpdate) => {
    if (!signal.aborted) onUpdate?.(update);
  };

  try {
    report({
      stage: "loading",
      progress: 1,
      message: "변환 엔진을 준비하고 있어요.",
    });
    engine = await loadBrowserFfmpeg({
      signal,
      onProgress: ({ ratio, label }) => {
        report({
          stage: "loading",
          progress: Math.round(1 + ratio * 14),
          message: `${label}. 처음 한 번만 오래 걸릴 수 있어요.`,
        });
      },
    });
    ensureActive();
    onEngineReady?.(engine);

    report({
      stage: "preparing",
      progress: 15,
      message: "동영상 파일을 안전하게 연결하는 중이에요.",
    });
    await mountLocalFile(engine.ffmpeg, file, VIRTUAL_FILES.input, signal);
    ensureActive();

    if (settings.format === "gif") {
      const commands = buildGifCommandsFromResolved(settings);
      report({
        stage: "palette",
        progress: 20,
        message: "GIF 색상표를 만들고 있어요.",
        isIndeterminate: true,
      });
      removeProgressListener = setFfmpegProgressListener(
        engine.ffmpeg,
        ({ progress: ratio }) => {
          report({
            stage: "palette",
            progress: Math.round(20 + Math.min(1, Math.max(0, ratio)) * 25),
            message: "GIF 색상표를 만들고 있어요.",
            isIndeterminate: true,
          });
        },
      );
      const paletteExit = await engine.ffmpeg.exec(commands.palette, -1, {
        signal,
      });
      if (paletteExit !== 0) throw new Error("GIF palette command failed");
      ensureActive();
      removeProgressListener();
      removeProgressListener = null;

      report({
        stage: "encoding",
        progress: 45,
        message: "GIF 프레임을 조합하고 있어요.",
      });
      removeProgressListener = setFfmpegProgressListener(
        engine.ffmpeg,
        ({ progress: fallbackRatio, time }) => {
          const ratio = settings.duration
            ? time / (settings.duration * 1_000_000)
            : fallbackRatio;
          report({
            stage: "encoding",
            progress: Math.round(45 + Math.min(1, Math.max(0, ratio)) * 50),
            message: "GIF 프레임을 조합하고 있어요.",
          });
        },
      );
      const encodeExit = await engine.ffmpeg.exec(commands.encode, -1, {
        signal,
      });
      if (encodeExit !== 0) throw new Error("GIF encode command failed");
    } else {
      report({
        stage: "encoding",
        progress: 20,
        message: "APNG 프레임을 인코딩하고 있어요.",
      });
      removeProgressListener = setFfmpegProgressListener(
        engine.ffmpeg,
        ({ progress: fallbackRatio, time }) => {
          const ratio = settings.duration
            ? time / (settings.duration * 1_000_000)
            : fallbackRatio;
          report({
            stage: "encoding",
            progress: Math.round(20 + Math.min(1, Math.max(0, ratio)) * 75),
            message: "APNG 프레임을 인코딩하고 있어요.",
          });
        },
      );
      const exitCode = await engine.ffmpeg.exec(
        buildApngCommandFromResolved(settings),
        -1,
        { signal },
      );
      if (exitCode !== 0) throw new Error("APNG encode command failed");
    }

    ensureActive();
    removeProgressListener?.();
    removeProgressListener = null;
    report({
      stage: "finalizing",
      progress: 95,
      message: "결과 파일을 마무리하고 있어요.",
    });

    const output = outputFileFor(settings.format);
    const data = await engine.ffmpeg.readFile(output.virtualName, "binary", {
      signal,
    });
    ensureActive();
    if (typeof data === "string") throw new Error("Unexpected text output");

    const sourceBuffer = data.buffer;
    let exactBuffer: ArrayBuffer;
    if (sourceBuffer instanceof ArrayBuffer) {
      exactBuffer =
        data.byteOffset === 0 && data.byteLength === sourceBuffer.byteLength
          ? sourceBuffer
          : sourceBuffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            );
    } else {
      const outputBytes = new Uint8Array(data.byteLength);
      outputBytes.set(data);
      exactBuffer = outputBytes.buffer;
    }
    const blob = new Blob([exactBuffer], { type: output.mimeType });

    report({
      stage: "finalizing",
      progress: 100,
      message: "결과가 준비됐어요.",
    });
    return { blob, output };
  } finally {
    removeProgressListener?.();
    if (engine) {
      if (!signal.aborted) {
        await unmountLocalFile(engine.ffmpeg, VIRTUAL_FILES.input);
        if (settings.format === "gif") {
          try {
            await engine.ffmpeg.deleteFile(VIRTUAL_FILES.palette);
          } catch {}
        }
      }
      onEngineDisposed?.(engine);
      engine.dispose();
    }
  }
}
