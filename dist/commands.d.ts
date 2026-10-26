import type { PeerSession } from './types.js';
export interface ParsedCommand {
    name: string;
    args: string;
}
/**
 * Parse a plugin-local command. Returns `null` for ordinary text.
 * `/steer <text>` is deliberately a command so it can choose the steering
 * delivery mode; plain text always uses `followup`.
 *
 * Bare keywords like `重试` (no leading slash) are accepted for a few
 * high-frequency actions so WeChat users can tap-reply without typing `/`.
 */
export declare function parseCommand(text: string): ParsedCommand | null;
export declare const COMMAND_HELP: string;
/** Render `/list` output and keep the 1-based indices used by `/switch`. */
export declare function formatSessionList(sessions: readonly PeerSession[], activeSessionId: string): string;
/** Resolve a `/switch` argument against the most recent `/list` snapshot. */
export declare function resolveSwitchArgument(argument: string, snapshot: readonly {
    id: string;
    title: string;
}[]): {
    id?: string;
    error?: string;
};
//# sourceMappingURL=commands.d.ts.map