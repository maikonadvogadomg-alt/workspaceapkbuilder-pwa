import type { AppConfig } from "./android";
import type { ArchiveFile } from "./archive";

const DB_NAME = "apk-builder";
const DB_VERSION = 1;
const STORE = "project";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key: string, value: unknown) {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function get<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 512;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    let s = "";
    for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j]);
    parts.push(s);
  }
  return btoa(parts.join(""));
}

function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ── Public API ─────────────────────────────────────────── */
export interface SavedSession {
  cfg: AppConfig;
  source: string;
  savedAt: number;
  fileCount: number;
}

export type SaveResult = "ok" | "meta-only" | "quota-exceeded";

export async function saveSession(cfg: AppConfig, source: string, files: ArchiveFile[]): Promise<SaveResult> {
  // Salva metadados sempre (leve, raramente falha)
  await put("cfg", cfg);
  await put("source", source);
  await put("fileCount", files.length);
  await put("savedAt", Date.now());
  // Limpa arquivos antigos antes de tentar salvar novos
  try { await put("files", null); } catch {}

  if (files.length > 5000) {
    return "meta-only";
  }

  try {
    await put("files", files.map(f => ({
      path: f.path,
      b64: toBase64(f.content),
    })));
    return "ok";
  } catch {
    // Quota excedida — retorna status para o chamador exibir aviso
    return "quota-exceeded";
  }
}

export async function loadSession(): Promise<{ cfg: AppConfig; source: string; files: ArchiveFile[] } | null> {
  const cfg = await get<AppConfig>("cfg");
  const source = await get<string>("source");
  const rawFiles = await get<{ path: string; b64?: string; content?: number[] }[]>("files");
  if (!cfg || !source || !rawFiles) return null;
  const files: ArchiveFile[] = rawFiles.map(f => ({
    path: f.path,
    // suporta formato antigo (content: number[]) e novo (b64: string)
    content: f.b64 ? fromBase64(f.b64) : new Uint8Array(f.content ?? []).buffer,
  }));
  return { cfg, source, files };
}

export async function getSavedMeta(): Promise<SavedSession | null> {
  const cfg = await get<AppConfig>("cfg");
  const source = await get<string>("source");
  const savedAt = await get<number>("savedAt");
  const fileCount = await get<number>("fileCount");
  if (!cfg || !source) return null;
  return { cfg, source, savedAt: savedAt ?? 0, fileCount: fileCount ?? 0 };
}

export async function clearSession() {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
