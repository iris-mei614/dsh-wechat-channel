/**
 * Shared types for the WeChat iLink channel.
 *
 * The plugin deliberately avoids runtime imports from `@deepseek-ai/*`
 * packages: DSH bundles its own copy of those packages, and a profile-installed
 * plugin cannot resolve them from its own `node_modules`. Everything host-side
 * is described structurally and accessed through the public `ctx` surface.
 */

export type DeliveryMode = 'followup' | 'steer' | 'inject';

export interface SessionEventLike {
  readonly type: string;
  readonly data?: any;
}

export interface SessionLike {
  readonly id: string;
  readonly header?: {
    readonly id?: string;
    readonly cwd?: string;
    readonly agentPreset?: string;
    readonly origin?: 'subagent';
  };
  readonly events?: readonly SessionEventLike[];
}

export interface AgentLike {
  readonly id: string;
  readonly status: 'idle' | 'running';
  readonly session: SessionLike;
  readonly inbox?: {
    readonly nextTurn: readonly unknown[];
    readonly nextStep: readonly unknown[];
  };
  followup(message: unknown): void;
  steer(message: unknown): void;
  inject(message: unknown): void;
  cancel(cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }): void;
  whenIdle?(): Promise<void>;
}

export interface AgentHandleLike {
  readonly agent: AgentLike;
  dispose(): Promise<void>;
}

export interface PeerSession {
  id: string;
  title: string;
  cwd: string;
  status: 'idle' | 'running' | 'offline';
  live: boolean;
}

export interface SessionStatus {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'offline';
  exists: boolean;
  cwd?: string;
}

export type TurnOutcomeKind =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'
  | 'forked'
  | 'unknown';

export interface TurnResult {
  sessionId: string;
  turn: number;
  kind: TurnOutcomeKind;
  /** Human-readable failure reason for `error`/`aborted` outcomes. */
  error?: string;
  /** Last non-empty assistant text produced in the turn. */
  text: string;
  /** Files declared through the `present` tool during the turn. */
  files: Array<{ path: string; description?: string }>;
  /** Whether this turn was started by a WeChat-delivered message. */
  fromWechat: boolean;
}

/**
 * DSH-facing operations. Implemented over the public `agents` / `sessionQuery`
 * services; a fake implementation backs the channel tests.
 */
export interface AgentBridge {
  deliver(
    sessionId: string,
    text: string,
    mode: DeliveryMode,
    source: { userId: string; messageId: string },
    attachments?: readonly DeliveredAttachment[],
  ): Promise<{ messageId: string }>;
  /**
   * Best-effort operator notice into a live DSH session (does not resume offline
   * sessions and must not trigger WeChat turn-end pushes).
   */
  notifySession(sessionId: string, text: string): Promise<boolean>;
  createSession(cwd?: string): Promise<string>;
  listSessions(): Promise<PeerSession[]>;
  sessionStatus(sessionId: string): Promise<SessionStatus>;
  cancelSession(sessionId: string): Promise<boolean>;
  resolveSession(idOrPrefix: string): Promise<string | undefined>;
  sessionCwd(sessionId: string): Promise<string | undefined>;
  /**
   * Pin a display title via DSH `sessionTitle.rename` when available.
   * Returns false when the host cannot rename (missing service / offline).
   */
  setSessionTitle?(sessionId: string, title: string): Promise<boolean>;
  onTurnComplete(listener: (result: TurnResult) => void): () => void;
  /** Optional live activity hints (tool names etc.) for progress pings. */
  onTurnActivity?(listener: (info: { sessionId: string; activity: string }) => void): () => void;
  /** Best-effort “new empty conversation”: create a session at the same cwd and return its id. */
  clearSession?(sessionId: string): Promise<string>;
  /** Current default model label for `/model`. */
  currentModelLabel?(): string;
  /** List known model labels when the host exposes them. */
  listModels?(): Promise<string[]>;
  /** Select a model by label / id when the host supports it. */
  selectModel?(spec: string): Promise<{ ok: boolean; message: string }>;
  dispose(): Promise<void>;
}

export interface LoginQr {
  qrcode: string;
  url: string;
}

export interface QrStatus {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}

export interface IlinkCredentials {
  token: string;
  accountId?: string;
  baseUrl?: string;
}

export interface InboundMessageItem {
  type?: number;
  textItem?: { text?: string };
  voiceItem?: { text?: string };
  /**
   * Original iLink item_list element. Retained so media can be downloaded via
   * `downloadMediaFromItem` without losing encrypt_query_param / aes_key.
   */
  raw?: unknown;
}

export interface InboundMessage {
  from?: string;
  to?: string;
  groupId?: string;
  messageType?: number;
  messageId?: number;
  clientId?: string;
  contextToken?: string;
  items?: ReadonlyArray<InboundMessageItem>;
}

export interface DeliveredAttachment {
  /** Absolute path in the session workspace (always set when saved to disk). */
  path: string;
  kind: 'image' | 'voice' | 'file' | 'video';
  fileName: string;
  bytes: number;
  mediaType?: string;
  /** Durable DSH attachment ref when ctx.attachments succeeded. */
  attachment?: { type: 'image' | 'file'; ref: Record<string, unknown> };
}

export interface PollResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: InboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/**
 * Low-level iLink operations. The real implementation wraps
 * `wechat-ilink-client`; tests substitute an in-memory transport.
 */
export interface IlinkTransport {
  setCredentials(credentials: IlinkCredentials): void;
  getCredentials(): IlinkCredentials | undefined;
  getUpdates(syncBuf: string, timeoutMs: number, signal?: AbortSignal): Promise<PollResponse>;
  sendText(to: string, text: string, contextToken: string): Promise<void>;
  sendMedia(to: string, filePath: string, caption: string | undefined, contextToken: string): Promise<void>;
  /** Download media bytes for inbound items that carry CDN encrypt params. */
  downloadInboundMedia?(message: InboundMessage): Promise<
    Array<{ kind: 'image' | 'voice' | 'file' | 'video'; data: Uint8Array; fileName?: string }>
  >;
  requestQrCode(botType: string): Promise<LoginQr>;
  pollQrStatus(qrcode: string): Promise<QrStatus>;
  dispose(): Promise<void>;
}

export interface LoggerLike {
  info(format: unknown, ...params: unknown[]): void;
  warn(format: unknown, ...params: unknown[]): void;
  error(format: unknown, ...params: unknown[]): void;
  debug(format: unknown, ...params: unknown[]): void;
}

export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: any, value: any): Array<{ type: 'text'; text: string }>;
  };
  execute(args: any, exec: any): Promise<unknown>;
}

/** Minimal structural view of the Cordis plugin context. */
export interface PluginContextLike {
  logger(name?: string): LoggerLike;
  effect(execute: () => any, label?: string): any;
  on(event: string, listener: (...args: any[]) => any): () => void;
  get(name: string): any;
  tools: { register(tool: ToolDefinitionLike): () => void };
  [key: string]: any;
}
