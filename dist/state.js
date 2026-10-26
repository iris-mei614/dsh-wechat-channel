import { chmod, mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export function emptyState() {
    return {
        version: 1,
        syncBuf: '',
        activeSessionId: '',
        ownerUserId: '',
        accountId: '',
        baseUrl: '',
        lastInboundAt: 0,
        contextTokens: {},
        pendingNotices: [],
        seenMessages: [],
        listSnapshot: [],
        counters: { inbound: 0, outbound: 0, errors: 0 },
    };
}
const MAX_SEEN = 200;
const MAX_PENDING = 20;
function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
function asNumber(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
/** Normalize an arbitrary parsed JSON document into the current state shape. */
export function normalizeState(input) {
    const base = emptyState();
    if (typeof input !== 'object' || input === null || Array.isArray(input))
        return base;
    const raw = input;
    const counters = typeof raw.counters === 'object' && raw.counters !== null ? raw.counters : {};
    const contextTokens = {};
    if (typeof raw.contextTokens === 'object' && raw.contextTokens !== null) {
        for (const [userId, value] of Object.entries(raw.contextTokens)) {
            if (typeof value !== 'object' || value === null)
                continue;
            const token = asString(value.token);
            if (token === '')
                continue;
            contextTokens[userId] = { token, updatedAt: asNumber(value.updatedAt) };
        }
    }
    const pendingNotices = [];
    if (Array.isArray(raw.pendingNotices)) {
        for (const value of raw.pendingNotices) {
            if (typeof value !== 'object' || value === null)
                continue;
            const item = value;
            const text = asString(item.text);
            const files = Array.isArray(item.files)
                ? item.files
                    .filter((file) => typeof file === 'object' && file !== null && typeof file.path === 'string')
                    .map((file) => ({ path: file.path, ...(typeof file.description === 'string' ? { description: file.description } : {}) }))
                : [];
            if (text === '' && files.length === 0)
                continue;
            pendingNotices.push({
                id: asString(item.id, randomUUID()),
                sessionId: asString(item.sessionId),
                text,
                files,
                createdAt: asNumber(item.createdAt, Date.now()),
            });
        }
    }
    const seenMessages = Array.isArray(raw.seenMessages)
        ? raw.seenMessages.filter((value) => typeof value === 'string').slice(-MAX_SEEN)
        : [];
    const listSnapshot = Array.isArray(raw.listSnapshot)
        ? raw.listSnapshot
            .filter((entry) => typeof entry === 'object' && entry !== null && typeof entry.id === 'string')
            .map((entry) => ({ id: entry.id, title: asString(entry.title) }))
        : [];
    return {
        version: 1,
        syncBuf: asString(raw.syncBuf),
        activeSessionId: asString(raw.activeSessionId),
        ownerUserId: asString(raw.ownerUserId),
        accountId: asString(raw.accountId),
        baseUrl: asString(raw.baseUrl),
        lastInboundAt: asNumber(raw.lastInboundAt),
        contextTokens,
        pendingNotices: pendingNotices.slice(-MAX_PENDING),
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
    stateDir;
    data = emptyState();
    loaded = false;
    dirty = false;
    saving;
    closed = false;
    saveFailure;
    filePath;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.filePath = join(stateDir, 'state.json');
    }
    get path() {
        return this.filePath;
    }
    async load() {
        await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
        try {
            const text = await readFile(this.filePath, 'utf8');
            this.data = normalizeState(JSON.parse(text));
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                // Keep a copy for diagnosis; never log contents.
                try {
                    await copyFile(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
                }
                catch {
                    // ignore
                }
                this.data = emptyState();
            }
        }
        this.loaded = true;
        return this.data;
    }
    get() {
        if (!this.loaded)
            throw new Error('state not loaded');
        return this.data;
    }
    /** Mutate state and schedule a coalesced write. */
    update(mutator) {
        if (!this.loaded)
            throw new Error('state not loaded');
        mutator(this.data);
        this.scheduleSave();
        return this.data;
    }
    cacheContextToken(userId, token) {
        if (token === '')
            return;
        this.update((data) => {
            data.contextTokens[userId] = { token, updatedAt: Date.now() };
        });
    }
    getContextToken(userId) {
        return this.data.contextTokens[userId];
    }
    markSeen(key) {
        if (key === '')
            return true;
        if (this.data.seenMessages.includes(key))
            return false;
        this.update((data) => {
            data.seenMessages.push(key);
            if (data.seenMessages.length > MAX_SEEN)
                data.seenMessages.splice(0, data.seenMessages.length - MAX_SEEN);
            data.counters.inbound += 1;
        });
        return true;
    }
    addPendingNotice(notice) {
        const entry = { ...notice, id: randomUUID(), createdAt: Date.now() };
        this.update((data) => {
            data.pendingNotices.push(entry);
            if (data.pendingNotices.length > MAX_PENDING)
                data.pendingNotices.splice(0, data.pendingNotices.length - MAX_PENDING);
        });
        return entry;
    }
    removePendingNotices(ids) {
        if (ids.length === 0)
            return;
        const set = new Set(ids);
        this.update((data) => {
            data.pendingNotices = data.pendingNotices.filter((entry) => !set.has(entry.id));
        });
    }
    takePendingNotices(limit) {
        return this.data.pendingNotices.slice(0, limit);
    }
    scheduleSave() {
        if (this.closed)
            return;
        this.dirty = true;
        if (this.saving !== undefined)
            return;
        this.saving = (async () => {
            try {
                while (this.dirty && !this.closed) {
                    this.dirty = false;
                    try {
                        await this.write();
                        this.saveFailure = undefined;
                    }
                    catch (error) {
                        this.saveFailure = error;
                    }
                }
            }
            finally {
                this.saving = undefined;
            }
        })();
    }
    async write() {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        const body = `${JSON.stringify(this.data, null, 2)}\n`;
        await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
        await chmod(temp, 0o600).catch(() => { });
        await rename(temp, this.filePath);
        await chmod(this.filePath, 0o600).catch(() => { });
    }
    /** Last background save failure, if any. State remains in memory. */
    get lastSaveFailure() {
        return this.saveFailure;
    }
    async flush() {
        if (!this.loaded)
            return;
        this.dirty = true;
        if (this.saving !== undefined) {
            await this.saving;
            if (this.dirty)
                await this.flush();
            return;
        }
        try {
            await this.write();
            this.dirty = false;
            this.saveFailure = undefined;
        }
        catch (error) {
            this.saveFailure = error;
            throw error;
        }
    }
    async close() {
        await this.flush();
        this.closed = true;
        if (this.saving !== undefined)
            await this.saving;
    }
}
