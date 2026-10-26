import type {
  AgentBridge,
  IlinkTransport,
  PluginContextLike,
} from '../types.js';
import type { ResolvedConfig } from '../config.js';
import type { Redactor, SafeLogger } from '../log.js';
import type { StateStore } from '../state.js';
import type { Clock } from '../rate-limit.js';
import type { SetupPhase } from '../onboarding.js';

export type ConnectionStatus =
  | 'starting'
  | 'waiting-login'
  | 'connected'
  | 'reconnecting'
  | 'expired'
  | 'stopped'
  | 'error';

export interface ChannelDeps {
  ctx: PluginContextLike;
  config: ResolvedConfig;
  state: StateStore;
  transport: IlinkTransport;
  bridge: AgentBridge;
  logger: SafeLogger;
  redactor: Redactor;
  clock?: Clock;
}

export interface ChannelStatusSnapshot {
  status: ConnectionStatus;
  connected: boolean;
  /** First-run journey stage (login → first WeChat message → session → ready). */
  setupPhase: SetupPhase;
  setupLabel: string;
  nextAction: string;
  hasContextToken: boolean;
  windowRemainingMs?: number;
  accountId: string;
  ownerUserId: string;
  activeSessionId: string;
  activeSessionStatus: string;
  activeSessionTitle: string;
  lastInboundAt: number;
  lastPollAt: number;
  pendingNotices: number;
  queueSize: number;
  counters: { inbound: number; outbound: number; errors: number };
  loginQrUrl?: string;
  loginPageUrl?: string;
  lastError?: string;
}

export interface LoginBeginResult {
  connected: boolean;
  status: ConnectionStatus;
  qrUrl?: string;
  message: string;
}
