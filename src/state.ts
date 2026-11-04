import { chmod, mkdir, readFile, rename, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HeldMediaBatch } from './media-hold.js';
import type { DeliveredAttachment } from './types.js';
import type { InboundMessage } from './types.js';
import { randomUUID } from 'node:crypto';

export interface RetryDelivery {
  sessionId: string;
  text: string;
  mode: 'followup' | 'steer' | 'inject';
  sourceMessageId: string;
  attachments: DeliveredAttachment[];
  isFirstInbound?: boolean;
  createdAt: number;
}
export interface FailedInbound { message: InboundMessage; attempts: number; failedAt: number; reason?: string; }

export interface ContextTokenRecord {
  token: string;
  updatedAt: number;
}

export interface PendingNotice {
  id: string;
  sessionId: string;
  text: string;
  files: Array<{ path: string; description?: string }>;
  createdAt: number;
  replayHeaderSent?: boolean;
  attempts?: number;
  nextAttemptAt?: number;
  quarantined?: boolean;
}

export interface ListEntry {
  id: string;
  title: string;
}

export interface ChannelStateData {
  version: 1;
  syncBuf: string;
  inboundQueue: InboundMessage[];
  inboundAttempts: Record<string, number>;
  failedInbound: FailedInbound[];
  retryDeliveries: Record<string, RetryDelivery>;
  heldMedia: HeldMediaBatch[];
  quarantinedMedia: Array<{ batch: HeldMediaBatch; quarantinedAt: number }>;
  activeSessionId: string;
  ownerUserId: string;
  accountId: string;
  baseUrl: string;
  lastInboundAt: number;
  contextTokens: Record<string, ContextTokenRecord>;
  pendingNotices: PendingNotice[];
  droppedNotices: number;
  seenMessages: string[];
  listSnapshot: ListEntry[];
  counters: {
    inbound: number;
    outbound: number;
    errors: number;
  };
}

export function emptyState(): ChannelStateData {
  return {
    version: 1,
    syncBuf: '',
    inboundQueue: [],
    inboundAttempts: {},
    failedInbound: [],
    retryDeliveries: {},
    heldMedia: [],
    quarantinedMedia: [],
    activeSessionId: '',
    ownerUserId: '',
    accountId: '',
    baseUrl: '',
    lastInboundAt: 0,
    contextTokens: {},
    pendingNotices: [],
    droppedNotices: 0,
    seenMessages: [],
    listSnapshot: [],
    counters: { inbound: 0, outbound: 0, errors: 0 },
  };
}

const MAX_SEEN = 200;
const MAX_PENDING = 20;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Normalize an arbitrary parsed JSON document into the current state shape. */
export function normalizeState(input: unknown): ChannelStateData {
  const base = emptyState();
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return base;
  const raw = input as Record<string, any>;
  const counters = typeof raw.counters === 'object' && raw.counters !== null ? raw.counters : {};
  const contextTokens: Record<string, ContextTokenRecord> = {};
  if (typeof raw.contextTokens === 'object' && raw.contextTokens !== null) {
    for (const [userId, value] of Object.entries(raw.contextTokens)) {
      if (typeof value !== 'object' || value === null) continue;
      const token = asString((value as any).token);
      if (token === '') continue;
      contextTokens[userId] = { token, updatedAt: asNumber((value as any).updatedAt) };
    }
  }
  const pendingNotices: PendingNotice[] = [];
  if (Array.isArray(raw.pendingNotices)) {
    for (const value of raw.pendingNotices) {
      if (typeof value !== 'object' || value === null) continue;
      const item = value as any;
      const text = asString(item.text);
      const files = Array.isArray(item.files)
        ? item.files
            .filter((file: any) => typeof file === 'object' && file !== null && typeof file.path === 'string')
            .map((file: any) => ({ path: file.path, ...(typeof file.description === 'string' ? { description: file.description } : {}) }))
        : [];
      if (text === '' && files.length === 0) continue;
      pendingNotices.push({
        replayHeaderSent: item.replayHeaderSent === true,
        attempts: Math.max(0, Math.floor(asNumber(item.attempts))),
        nextAttemptAt: Math.max(0, asNumber(item.nextAttemptAt)),
        quarantined: item.quarantined === true,
        id: asString(item.id, randomUUID()),
        sessionId: asString(item.sessionId),
        text,
        files,
        createdAt: asNumber(item.createdAt, Date.now()),
      });
    }
  }
  const seenMessages = Array.isArray(raw.seenMessages)
    ? raw.seenMessages.filter((value: unknown): value is string => typeof value === 'string').slice(-MAX_SEEN)
    : [];
  const listSnapshot = Array.isArray(raw.listSnapshot)
    ? raw.listSnapshot
        .filter((entry: any) => typeof entry === 'object' && entry !== null && typeof entry.id === 'string')
        .map((entry: any) => ({ id: entry.id, title: asString(entry.title) }))
    : [];
  return {
    version: 1,
    syncBuf: asString(raw.syncBuf),
    inboundQueue: Array.isArray(raw.inboundQueue) ? raw.inboundQueue.filter((item: any) => item && typeof item === 'object' && typeof item.from === 'string') : [],
    inboundAttempts: raw.inboundAttempts && typeof raw.inboundAttempts === 'object' ? raw.inboundAttempts : {},
    failedInbound: Array.isArray(raw.failedInbound) ? raw.failedInbound.filter((v: any) => v?.message && typeof v.message.from === 'string') : [],
    retryDeliveries: raw.retryDeliveries && typeof raw.retryDeliveries === 'object' ? raw.retryDeliveries : {},
    heldMedia: Array.isArray(raw.heldMedia) ? raw.heldMedia.filter((v: any) => typeof v?.userId === 'string' && Array.isArray(v.attachments)) : [],
    quarantinedMedia: Array.isArray(raw.quarantinedMedia) ? raw.quarantinedMedia.filter((v: any) => typeof v?.batch?.userId === 'string' && Array.isArray(v.batch.attachments)) : [],
    activeSessionId: asString(raw.activeSessionId),
    ownerUserId: asString(raw.ownerUserId),
    accountId: asString(raw.accountId),
    baseUrl: asString(raw.baseUrl),
    lastInboundAt: asNumber(raw.lastInboundAt),
    contextTokens,
    pendingNotices: pendingNotices.slice(-MAX_PENDING),
    droppedNotices: asNumber(raw.droppedNotices) + Math.max(0, pendingNotices.length - MAX_PENDING),
    seenMessages,
    listSnapshot,
    counters: {
      inbound: asNumber(counters.inbound),
      outbound: asNumber(counters.outbound),
      errors: asNumber(counters.errors),
    },
  };
}

/**
 * Durable plugin state: sync cursor, active session, owner binding, cached
 * context tokens, pending completion notices and counters.
 *
 * Writes are serialized, coalesced, and atomic (temp file + rename, mode 0600).
 */
export class StateStore {
  private data: ChannelStateData = emptyState();
  private loaded = false;
  private dirty = false;
  private saving: Promise<void> | undefined;
  private closed = false;
  private saveFailure: unknown;
  private readonly filePath: string;

  constructor(private readonly stateDir: string) {
    this.filePath = join(stateDir, 'state.json');
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<ChannelStateData> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(this.filePath, 'utf8');
      this.data = normalizeState(JSON.parse(text));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        // Keep a copy for diagnosis; never log contents.
        try {
          await copyFile(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        } catch {
          // ignore
        }
        this.data = emptyState();
      }
    }
    this.loaded = true;
    return this.data;
  }

  get(): ChannelStateData {
    if (!this.loaded) throw new Error('state not loaded');
    return this.data;
  }

  /** Mutate state and schedule a coalesced write. */
  update(mutator: (data: ChannelStateData) => void): ChannelStateData {
    if (!this.loaded) throw new Error('state not loaded');
    mutator(this.data);
    this.scheduleSave();
    return this.data;
  }

  cacheContextToken(userId: string, token: string): void {
    if (token === '') return;
    this.update((data) => {
      data.contextTokens[userId] = { token, updatedAt: Date.now() };
    });
  }

  getContextToken(userId: string): ContextTokenRecord | undefined {
    return this.data.contextTokens[userId];
  }

  markSeen(key: string): boolean {
    if (key === '') return true;
    if (this.data.seenMessages.includes(key)) return false;
    this.update((data) => {
      data.seenMessages.push(key);
      if (data.seenMessages.length > MAX_SEEN) data.seenMessages.splice(0, data.seenMessages.length - MAX_SEEN);
      data.counters.inbound += 1;
    });
    return true;
  }

  addPendingNotice(notice: Omit<PendingNotice, 'id' | 'createdAt'>): PendingNotice {
    const entry: PendingNotice = { ...notice, id: randomUUID(), createdAt: Date.now() };
    this.update((data) => {
      data.pendingNotices.push(entry);
      if (data.pendingNotices.length > MAX_PENDING) {
        data.droppedNotices += data.pendingNotices.length - MAX_PENDING;
        data.pendingNotices.splice(0, data.pendingNotices.length - MAX_PENDING);
      }
    });
    return entry;
  }

  removePendingNotices(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    this.update((data) => {
      data.pendingNotices = data.pendingNotices.filter((entry) => !set.has(entry.id));
    });
  }

  takePendingNotices(limit: number, now = Date.now()): PendingNotice[] {
    return this.data.pendingNotices.filter(notice => !notice.quarantined && (notice.nextAttemptAt ?? 0) <= now).slice(0, limit);
  }

  private scheduleSave(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.saving !== undefined) return;
    this.saving = (async () => {
      try {
        while (this.dirty && !this.closed) {
          this.dirty = false;
          try {
            await this.write();
            this.saveFailure = undefined;
          } catch (error) {
            this.saveFailure = error;
          }
        }
      } finally {
        this.saving = undefined;
      }
    })();
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(this.data, null, 2)}\n`;
    try {
      await writeFile(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600).catch(() => {});
      await rename(temp, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => {});
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  /** Last background save failure, if any. State remains in memory. */
  get lastSaveFailure(): unknown {
    return this.saveFailure;
  }

  async flush(): Promise<void> {
    if (!this.loaded || this.closed) return;
    // Both explicit flushes and background updates use the same worker.
    this.scheduleSave();
    while (this.saving !== undefined) await this.saving;
    if (this.saveFailure !== undefined) throw this.saveFailure;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    if (this.saving !== undefined) await this.saving;
  }
}
