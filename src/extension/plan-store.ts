import type { RenderPlan } from "../core/contracts/render-plan.js";
import { isRenderPlan } from "../core/contracts/render-plan.js";
import type { CaptureMode } from "./state-machine.js";

export const RENDER_PLAN_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_RENDER_PLAN_BYTES = 25 * 1024 * 1024;

const DATABASE_NAME = "web2ui-extension";
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = "current-render-plan";
const LEGACY_CURRENT_RECORD_ID = "current";
const RECORD_ID_PREFIX = "tab:";

export interface StoredRenderPlan {
  id: string;
  runId: string;
  tabId: number;
  documentId: string;
  mode: CaptureMode;
  createdAt: number;
  expiresAt: number;
  plan: RenderPlan;
}

export interface RenderPlanStoreOptions {
  indexedDB?: IDBFactory;
  dbName?: string;
  now?: () => number;
  maxBytes?: number;
}

export class RenderPlanTooLargeError extends Error {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super(`RenderPlan is ${actualBytes} bytes; the local limit is ${maxBytes} bytes`);
    this.name = "RenderPlanTooLargeError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export class RenderPlanStore {
  readonly #indexedDB: IDBFactory;
  readonly #dbName: string;
  readonly #now: () => number;
  readonly #maxBytes: number;
  #databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: RenderPlanStoreOptions = {}) {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB;
    if (!indexedDB) throw new Error("IndexedDB is unavailable");
    this.#indexedDB = indexedDB;
    this.#dbName = options.dbName ?? DATABASE_NAME;
    this.#now = options.now ?? Date.now;
    this.#maxBytes = options.maxBytes ?? MAX_RENDER_PLAN_BYTES;
  }

  async put(
    plan: RenderPlan,
    identity: { runId: string; tabId: number; documentId: string; mode: CaptureMode },
  ): Promise<StoredRenderPlan> {
    if (!isRenderPlan(plan)) throw new TypeError("Cannot persist an invalid RenderPlan");
    if (
      !identity.runId ||
      !identity.documentId ||
      (identity.mode !== "visible-area" && identity.mode !== "full-page") ||
      !Number.isInteger(identity.tabId) ||
      identity.tabId < 0
    ) {
      throw new TypeError("Cannot persist a RenderPlan without a valid run identity");
    }

    const actualBytes = new TextEncoder().encode(JSON.stringify(plan)).byteLength;
    if (actualBytes > this.#maxBytes) {
      throw new RenderPlanTooLargeError(actualBytes, this.#maxBytes);
    }

    const createdAt = this.#now();
    const record: StoredRenderPlan = {
      id: recordIdForTab(identity.tabId),
      runId: identity.runId,
      tabId: identity.tabId,
      documentId: identity.documentId,
      mode: identity.mode,
      createdAt,
      expiresAt: createdAt + RENDER_PLAN_TTL_MS,
      plan,
    };

    const database = await this.#database();
    const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
    transaction.objectStore(OBJECT_STORE_NAME).put(record);
    await transactionComplete(transaction);
    return record;
  }

  async get(tabId: number): Promise<StoredRenderPlan | null> {
    if (!Number.isInteger(tabId) || tabId < 0) return null;
    const database = await this.#database();
    const transaction = database.transaction(OBJECT_STORE_NAME, "readonly");
    const value = await requestResult(
      transaction.objectStore(OBJECT_STORE_NAME).get(recordIdForTab(tabId)),
    );
    await transactionComplete(transaction);

    if (!isStoredRenderPlan(value) || value.expiresAt <= this.#now()) {
      if (value !== undefined) await this.clear(tabId);
      return null;
    }
    return value;
  }

  /** Backward-compatible helper for callers that only need the newest result. */
  async getCurrent(): Promise<StoredRenderPlan | null> {
    const records = await this.getAll();
    return records.reduce<StoredRenderPlan | null>(
      (latest, record) => (!latest || record.createdAt > latest.createdAt ? record : latest),
      null,
    );
  }

  async getAll(): Promise<StoredRenderPlan[]> {
    const database = await this.#database();
    const transaction = database.transaction(OBJECT_STORE_NAME, "readonly");
    const values = await requestResult(transaction.objectStore(OBJECT_STORE_NAME).getAll());
    await transactionComplete(transaction);

    const live: StoredRenderPlan[] = [];
    const staleIds: string[] = [];
    let legacy: StoredRenderPlan | null = null;
    for (const value of values) {
      if (isStoredRenderPlan(value) && value.expiresAt > this.#now()) {
        live.push(value);
      } else if (isLegacyStoredRenderPlan(value) && value.expiresAt > this.#now()) {
        legacy = { ...value, id: recordIdForTab(value.tabId) };
        staleIds.push(LEGACY_CURRENT_RECORD_ID);
      } else if (hasStringId(value)) {
        staleIds.push(value.id);
      }
    }

    if (legacy && !live.some((record) => record.tabId === legacy.tabId)) {
      await this.#writeRecord(legacy);
      live.push(legacy);
    }
    if (staleIds.length > 0) await this.#deleteRecords(staleIds);
    return live.sort((left, right) => left.tabId - right.tabId);
  }

  async clear(tabId?: number): Promise<void> {
    if (tabId === undefined) {
      await this.clearAll();
      return;
    }
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const database = await this.#database();
    const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
    transaction.objectStore(OBJECT_STORE_NAME).delete(recordIdForTab(tabId));
    await transactionComplete(transaction);
  }

  async clearAll(): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
    transaction.objectStore(OBJECT_STORE_NAME).clear();
    await transactionComplete(transaction);
  }

  async cleanupExpired(): Promise<void> {
    await this.getAll();
  }

  async #writeRecord(record: StoredRenderPlan): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
    transaction.objectStore(OBJECT_STORE_NAME).put(record);
    await transactionComplete(transaction);
  }

  async #deleteRecords(ids: readonly string[]): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(OBJECT_STORE_NAME);
    for (const id of ids) store.delete(id);
    await transactionComplete(transaction);
  }

  async #database(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#indexedDB.open(this.#dbName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
          database.createObjectStore(OBJECT_STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade was blocked"));
    });
    return this.#databasePromise;
  }
}

function isStoredRenderPlan(value: unknown): value is StoredRenderPlan {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredRenderPlan>;
  return (
    candidate.id === recordIdForTab(candidate.tabId ?? -1) &&
    typeof candidate.runId === "string" &&
    candidate.runId.length > 0 &&
    Number.isInteger(candidate.tabId) &&
    (candidate.tabId ?? -1) >= 0 &&
    typeof candidate.documentId === "string" &&
    candidate.documentId.length > 0 &&
    (candidate.mode === "visible-area" || candidate.mode === "full-page") &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt === candidate.createdAt + RENDER_PLAN_TTL_MS &&
    isRenderPlan(candidate.plan)
  );
}

function isLegacyStoredRenderPlan(value: unknown): value is StoredRenderPlan {
  if (!hasStringId(value) || value.id !== LEGACY_CURRENT_RECORD_ID) return false;
  const candidate = value as Partial<StoredRenderPlan>;
  return (
    typeof candidate.runId === "string" &&
    candidate.runId.length > 0 &&
    Number.isInteger(candidate.tabId) &&
    (candidate.tabId ?? -1) >= 0 &&
    typeof candidate.documentId === "string" &&
    candidate.documentId.length > 0 &&
    (candidate.mode === "visible-area" || candidate.mode === "full-page") &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt === candidate.createdAt + RENDER_PLAN_TTL_MS &&
    isRenderPlan(candidate.plan)
  );
}

function recordIdForTab(tabId: number): string {
  return `${RECORD_ID_PREFIX}${tabId}`;
}

function hasStringId(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}
