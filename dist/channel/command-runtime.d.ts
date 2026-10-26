import type { AgentBridge } from '../types.js';
import type { StateStore } from '../state.js';
import type { ResolvedConfig } from '../config.js';
export interface CommandRuntimeDeps {
    config: ResolvedConfig;
    state: StateStore;
    bridge: AgentBridge;
    sendReply: (userId: string, text: string) => Promise<void>;
    setActiveSession: (sessionId: string, clearList?: boolean) => void;
    /** Mark a freshly created session so the first followup can name it. */
    noteUntitledSession: (sessionId: string) => void;
    formatStatus: () => Promise<string>;
    deliverText: (userId: string, text: string, mode: 'followup' | 'steer' | 'inject', sourceMessageId: string) => Promise<void>;
    retryLastFailure: (userId: string) => Promise<boolean>;
    noteError: (error: unknown) => void;
    describeError: (error: unknown) => string;
    logError: (format: string, ...params: unknown[]) => void;
}
/** Local WeChat slash-commands; kept out of WechatChannel to shrink the orchestrator. */
export declare function runWechatCommand(deps: CommandRuntimeDeps, userId: string, name: string, args: string): Promise<void>;
//# sourceMappingURL=command-runtime.d.ts.map