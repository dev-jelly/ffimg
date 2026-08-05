import type {
  FFmpeg,
  FFFSType,
  LogEventCallback,
  ProgressEventCallback,
} from "@ffmpeg/ffmpeg";

const CORE_VERSION = "0.12.10";
const WRAPPER_VERSION = "0.12.15";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CORE_JS_URL = `${CORE_BASE}/ffmpeg-core.js`;
const CORE_WASM_URL = `${CORE_BASE}/ffmpeg-core.wasm`;
const CORE_HASHES = {
  [CORE_JS_URL]:
    "67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3",
  [CORE_WASM_URL]:
    "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
} as const;

export type EngineLoadProgress = {
  ratio: number;
  label: string;
};

export type BrowserFfmpeg = {
  ffmpeg: FFmpeg;
  dispose: () => void;
};

type VerifiedCoreAssets = {
  core: Blob;
  wasm: Blob;
};

const coreAssetProgress = { core: 0, wasm: 0 };
const coreAssetSubscribers = new Set<(ratio: number) => void>();
let verifiedCoreAssetsPromise: Promise<VerifiedCoreAssets> | null = null;
let verifiedCoreAssetsController: AbortController | null = null;

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function getClassWorkerUrl() {
  const basePath = document.documentElement.dataset.basePath ?? "";
  return new URL(`${basePath}/ffmpeg/worker.js`, window.location.origin).href;
}

async function fetchVerifiedBlob(
  url: string,
  mimeType: string,
  signal: AbortSignal,
  onProgress: (ratio: number) => void,
) {
  const response = await fetch(url, {
    signal,
    cache: "force-cache",
  });

  if (!response.ok) {
    throw new Error(`Engine download failed (${response.status})`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();

  if (!reader) {
    const body = await response.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", body);
    if (toHex(digest) !== CORE_HASHES[url as keyof typeof CORE_HASHES]) {
      throw new Error("Engine integrity check failed");
    }
    onProgress(1);
    return new Blob([body], { type: mimeType });
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(total ? Math.min(received / total, 0.99) : 0.5);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", body);
  if (toHex(digest) !== CORE_HASHES[url as keyof typeof CORE_HASHES]) {
    throw new Error("Engine integrity check failed");
  }

  onProgress(1);
  return new Blob([body.buffer], { type: mimeType });
}

function reportCoreAssetProgress() {
  const ratio = coreAssetProgress.core * 0.08 + coreAssetProgress.wasm * 0.82;
  for (const subscriber of coreAssetSubscribers) subscriber(ratio);
}

function getVerifiedCoreAssets() {
  if (verifiedCoreAssetsPromise) return verifiedCoreAssetsPromise;

  const controller = new AbortController();
  verifiedCoreAssetsController = controller;
  const failTogether = <T,>(promise: Promise<T>) =>
    promise.catch((error) => {
      controller.abort();
      throw error;
    });

  coreAssetProgress.core = 0;
  coreAssetProgress.wasm = 0;
  const request: Promise<VerifiedCoreAssets> = Promise.all([
    failTogether(
      fetchVerifiedBlob(
        CORE_JS_URL,
        "text/javascript",
        controller.signal,
        (ratio) => {
          coreAssetProgress.core = ratio;
          reportCoreAssetProgress();
        },
      ),
    ),
    failTogether(
      fetchVerifiedBlob(
        CORE_WASM_URL,
        "application/wasm",
        controller.signal,
        (ratio) => {
          coreAssetProgress.wasm = ratio;
          reportCoreAssetProgress();
        },
      ),
    ),
  ])
    .then(([core, wasm]) => {
      if (verifiedCoreAssetsPromise === request) {
        verifiedCoreAssetsController = null;
      }
      return { core, wasm };
    })
    .catch((error) => {
      if (verifiedCoreAssetsPromise === request) {
        verifiedCoreAssetsPromise = null;
        verifiedCoreAssetsController = null;
        coreAssetProgress.core = 0;
        coreAssetProgress.wasm = 0;
      }
      throw error;
    });
  verifiedCoreAssetsPromise = request;

  return verifiedCoreAssetsPromise;
}

function abortUnusedCoreAssetDownload() {
  if (coreAssetSubscribers.size > 0 || !verifiedCoreAssetsController) return;
  const abandonedRequest = verifiedCoreAssetsPromise;
  verifiedCoreAssetsController.abort();
  if (verifiedCoreAssetsPromise === abandonedRequest) {
    verifiedCoreAssetsPromise = null;
    verifiedCoreAssetsController = null;
    coreAssetProgress.core = 0;
    coreAssetProgress.wasm = 0;
  }
}

function waitForVerifiedCoreAssets(
  signal: AbortSignal,
  onProgress: (ratio: number) => void,
) {
  return new Promise<VerifiedCoreAssets>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const subscriber = (ratio: number) => onProgress(ratio);
    const abort = () => {
      cleanup();
      abortUnusedCoreAssetDownload();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      coreAssetSubscribers.delete(subscriber);
      signal.removeEventListener("abort", abort);
    };

    coreAssetSubscribers.add(subscriber);
    onProgress(
      coreAssetProgress.core * 0.08 + coreAssetProgress.wasm * 0.82,
    );
    signal.addEventListener("abort", abort, { once: true });
    getVerifiedCoreAssets().then(
      (assets) => {
        cleanup();
        resolve(assets);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function loadBrowserFfmpeg({
  signal,
  onProgress,
  onLog,
}: {
  signal: AbortSignal;
  onProgress: (progress: EngineLoadProgress) => void;
  onLog?: LogEventCallback;
}): Promise<BrowserFfmpeg> {
  let coreUrl: string | null = null;
  let wasmUrl: string | null = null;
  let ffmpeg: FFmpeg | null = null;

  const dispose = () => {
    ffmpeg?.terminate();
    ffmpeg = null;
    if (coreUrl) URL.revokeObjectURL(coreUrl);
    if (wasmUrl) URL.revokeObjectURL(wasmUrl);
    coreUrl = null;
    wasmUrl = null;
  };

  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const [{ FFmpeg }, blobs] = await Promise.all([
      import("@ffmpeg/ffmpeg"),
      waitForVerifiedCoreAssets(signal, (ratio) => {
        onProgress({ ratio, label: "변환 엔진을 내려받는 중" });
      }),
    ]);

    coreUrl = URL.createObjectURL(blobs.core);
    wasmUrl = URL.createObjectURL(blobs.wasm);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    ffmpeg = new FFmpeg();
    if (onLog) ffmpeg.on("log", onLog);
    onProgress({ ratio: 0.92, label: "변환 엔진을 준비하는 중" });
    await ffmpeg.load(
      {
        classWorkerURL: getClassWorkerUrl(),
        coreURL: coreUrl,
        wasmURL: wasmUrl,
      },
      { signal },
    );
    onProgress({ ratio: 1, label: "변환 엔진 준비 완료" });

    return { ffmpeg, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

function mountedPathParts(virtualPath: string) {
  const separator = virtualPath.lastIndexOf("/");
  if (separator <= 0 || separator === virtualPath.length - 1) {
    throw new Error("Invalid mounted input path");
  }
  return {
    directory: virtualPath.slice(0, separator),
    name: virtualPath.slice(separator + 1),
  };
}

export async function mountLocalFile(
  ffmpeg: FFmpeg,
  file: File,
  virtualPath: string,
  signal: AbortSignal,
) {
  const { directory, name } = mountedPathParts(virtualPath);
  await ffmpeg.createDir(directory, { signal });
  await ffmpeg.mount(
    "WORKERFS" as FFFSType,
    { blobs: [{ name, data: file }] },
    directory,
  );
}

export async function unmountLocalFile(
  ffmpeg: FFmpeg,
  virtualPath: string,
) {
  const { directory } = mountedPathParts(virtualPath);
  try {
    await ffmpeg.unmount(directory);
  } catch {}
  try {
    await ffmpeg.deleteDir(directory);
  } catch {}
}

export function setFfmpegProgressListener(
  ffmpeg: FFmpeg,
  callback: ProgressEventCallback,
) {
  ffmpeg.on("progress", callback);
  return () => ffmpeg.off("progress", callback);
}

export const FFMPEG_CORE_NOTICE = {
  coreVersion: CORE_VERSION,
  wrapperVersion: WRAPPER_VERSION,
  projectUrl: "https://ffmpegwasm.netlify.app/",
  wrapperLicenseUrl:
    "https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/LICENSE",
  coreLicenseUrl: `https://www.npmjs.com/package/@ffmpeg/core/v/${CORE_VERSION}`,
  faqUrl: "https://ffmpegwasm.netlify.app/docs/faq/",
};
