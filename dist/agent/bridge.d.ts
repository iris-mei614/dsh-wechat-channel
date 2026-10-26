import type { AgentBridge, DeliveredAttachment, DeliveryMode, PeerSession, PluginContextLike, SessionStatus, TurnResult } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import type { SafeLogger } from '../log.js';
/** Build a native frozen DSH user message without importing the host package. */
export declare function createWechatUserMessage(text: string, userId: string, messageId: string, attachments?: readonly DeliveredAttachment[]): unknown;
/** Operator-facing notice that must not be treated as a WeChat-originated turn. */
export declare function createChannelNoticeMessage(text: string): unknown;
/**
 * DSH host adapter.
 *
 * Delivery uses the same public primitives as `dsh-agent-message` in DSH
 * 0.1.x: `agents.followup/steer/inject` for live sessions and
 * `agents.resume` for offline ones, composed with the same Agent preset
 * (`agentPresets.mount`) so resumed sessions keep their tools.
 */
export declare class DshAgentBridge implements AgentBridge {
    private readonly ctx;
    private readonly config;
    private readonly log;
    private readonly handles;
    private readonly resumes;
    private readonly turnStates;
    private readonly turnListeners;
    private readonly activityListeners;
    private readonly disposers;
    private disposed;
    constructor(ctx: PluginContextLike, config: ResolvedConfig, log: SafeLogger);
    private get agents();
    private get query();
    private liveAgent;
    private isArchived;
    private assertPeer;
    private defaultAgentOptions;
    private inspectSession;
    private compose;
    deliver(sessionId: string, text: string, mode: DeliveryMode, source: {
        userId: string;
        messageId: string;
    }, attachments?: readonly DeliveredAttachment[]): Promise<{
        messageId: string;
    }>;
    /**
     * Push a short operator notice into a *live* session without resuming offline
     * ones and without marking the turn as WeChat-originated.
     */
    notifySession(sessionId: string, text: string): Promise<boolean>;
    private ensureLive;
    createSession(cwd?: string): Promise<string>;
    /**
     * Pin a WeChat-originated display title through DSH `sessionTitle.rename`.
     * Uses the live session object; resumes offline sessions when needed.
     */
    setSessionTitle(sessionId: string, title: string): Promise<boolean>;
    listSessions(): Promise<PeerSession[]>;
    sessionStatus(sessionId: string): Promise<SessionStatus>;
    cancelSession(sessionId: string): Promise<boolean>;
    resolveSession(idOrPrefix: string): Promise<string | undefined>;
    sessionCwd(sessionId: string): Promise<string | undefined>;
    onTurnComplete(listener: (result: TurnResult) => void): () => void;
    onTurnActivity(listener: (info: {
        sessionId: string;
        activity: string;
    }) => void): () => void;
    private emitActivity;
    currentModelLabel(): string;
    listModels(): Promise<string[]>;
    selectModel(spec: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    clearSession(sessionId: string): Promise<string>;
    private onInboxClaimed;
    private onSessionEvent;
    private pruneTurns;
    dispose(): Promise<void>;
}
