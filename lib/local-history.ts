export const HISTORY_DATABASE_NAME = "ffimg-result-history";
export const HISTORY_SCHEMA_VERSION = 1;

const ENTRY_STORE = "entries";
const FILE_STORE = "files";

export type HistoryFormat = "gif" | "apng";

export type HistorySettings = {
  start: number;
  duration: number;
  fps: number;
  width: number;
  plays: number;
  gifColors: number;
  gifStats: string;
  gifDither: string;
  apngCompression: number;
  preset: string;
  presetPolicyVersion: string;
};

export type HistoryEntry = {
  id: string;
  schemaVersion: 1;
  createdAt: number;
  source: {
    name: string;
    sizeBytes: number;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
  };
  output: {
    name: string;
    format: HistoryFormat;
    mimeType: "image/gif" | "image/png";
    sizeBytes: number;
  };
  settings: HistorySettings;
  batch: null | {
    id: string;
    label: string;
    index: number;
    total: number;
  };
};

export type HistoryPersistence = "saved" | "session-only" | "quota-full";

export class LocalHistoryError extends Error {
  readonly kind: Exclude<HistoryPersistence, "saved"> | "blocked";

  constructor(
    kind: Exclude<HistoryPersistence, "saved"> | "blocked",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalHistoryError";
    this.kind = kind;
  }
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function getFactory(factory?: IDBFactory) {
  if (factory) return factory;
  if (typeof indexedDB === "undefined") {
    throw new LocalHistoryError(
      "session-only",
      "IndexedDB is not available in this browser",
    );
  }
  return indexedDB;
}

function openDatabase(factory?: IDBFactory) {
  const resolvedFactory = getFactory(factory);

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = resolvedFactory.open(
      HISTORY_DATABASE_NAME,
      HISTORY_SCHEMA_VERSION,
    );
    let settled = false;
    const blockedTimer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new LocalHistoryError(
          "blocked",
          "Another tab is blocking the history database upgrade",
        ),
      );
    }, 4000);

    request.onupgradeneeded = () => {
      const database = request.result;
      const entryStore = database.objectStoreNames.contains(ENTRY_STORE)
        ? request.transaction!.objectStore(ENTRY_STORE)
        : database.createObjectStore(ENTRY_STORE, { keyPath: "id" });
      if (!entryStore.indexNames.contains("createdAt")) {
        entryStore.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(FILE_STORE)) {
        database.createObjectStore(FILE_STORE, { keyPath: "id" });
      }
    };
    request.onblocked = () => {
      // The timer turns a potentially endless wait into a recoverable state.
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(blockedTimer);
      reject(request.error ?? new Error("Could not open history database"));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      globalThis.clearTimeout(blockedTimer);
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function classifyError(error: unknown) {
  if (error instanceof LocalHistoryError) return error;
  if (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  ) {
    return new LocalHistoryError(
      "quota-full",
      "Browser storage quota was exceeded",
      { cause: error },
    );
  }
  return new LocalHistoryError(
    "session-only",
    "Browser history storage is unavailable",
    { cause: error },
  );
}

let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite<T>(operation: () => Promise<T>) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function listHistoryEntries(factory?: IDBFactory) {
  try {
    await writeQueue;
    const database = await openDatabase(factory);
    try {
      const transaction = database.transaction(ENTRY_STORE, "readonly");
      const entries = await requestResult<HistoryEntry[]>(
        transaction.objectStore(ENTRY_STORE).getAll(),
      );
      await transactionComplete(transaction);
      return entries
        .filter(
          (entry) =>
            entry?.schemaVersion === 1 &&
            typeof entry.id === "string" &&
            Number.isFinite(entry.createdAt) &&
            Number.isFinite(entry.output?.sizeBytes),
        )
        .sort((left, right) => right.createdAt - left.createdAt);
    } finally {
      database.close();
    }
  } catch (error) {
    throw classifyError(error);
  }
}

export function saveHistoryResult(
  entry: HistoryEntry,
  blob: Blob,
  factory?: IDBFactory,
) {
  return enqueueWrite(async () => {
    try {
      const database = await openDatabase(factory);
      try {
        const transaction = database.transaction(
          [ENTRY_STORE, FILE_STORE],
          "readwrite",
        );
        transaction.objectStore(ENTRY_STORE).put(entry);
        transaction.objectStore(FILE_STORE).put({ id: entry.id, blob });
        await transactionComplete(transaction);
      } finally {
        database.close();
      }
    } catch (error) {
      throw classifyError(error);
    }
  });
}

export async function getHistoryBlob(id: string, factory?: IDBFactory) {
  try {
    await writeQueue;
    const database = await openDatabase(factory);
    try {
      const transaction = database.transaction(FILE_STORE, "readonly");
      const record = await requestResult<{ id: string; blob: Blob } | undefined>(
        transaction.objectStore(FILE_STORE).get(id),
      );
      await transactionComplete(transaction);
      return record?.blob ?? null;
    } finally {
      database.close();
    }
  } catch (error) {
    throw classifyError(error);
  }
}

export function deleteHistoryResult(id: string, factory?: IDBFactory) {
  return enqueueWrite(async () => {
    try {
      const database = await openDatabase(factory);
      try {
        const transaction = database.transaction(
          [ENTRY_STORE, FILE_STORE],
          "readwrite",
        );
        transaction.objectStore(ENTRY_STORE).delete(id);
        transaction.objectStore(FILE_STORE).delete(id);
        await transactionComplete(transaction);
      } finally {
        database.close();
      }
    } catch (error) {
      throw classifyError(error);
    }
  });
}

export function clearHistoryResults(factory?: IDBFactory) {
  return enqueueWrite(async () => {
    try {
      const database = await openDatabase(factory);
      try {
        const transaction = database.transaction(
          [ENTRY_STORE, FILE_STORE],
          "readwrite",
        );
        transaction.objectStore(ENTRY_STORE).clear();
        transaction.objectStore(FILE_STORE).clear();
        await transactionComplete(transaction);
      } finally {
        database.close();
      }
    } catch (error) {
      throw classifyError(error);
    }
  });
}

export function sumHistoryBytes(entries: HistoryEntry[]) {
  return entries.reduce(
    (total, entry) => total + Math.max(0, entry.output.sizeBytes || 0),
    0,
  );
}

export function historyErrorKind(error: unknown) {
  return classifyError(error).kind;
}
