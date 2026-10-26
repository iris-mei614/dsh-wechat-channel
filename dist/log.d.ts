import type { LoggerLike } from './types.js';
/**
 * Secrets are collected here and scrubbed from every log line and error
 * message. The plugin never logs raw bot tokens or context tokens.
 */
export declare class Redactor {
    private readonly secrets;
    add(secret: string | undefined | null): void;
    remove(secret: string | undefined | null): void;
    redact(value: unknown): string;
}
export interface SafeLogger {
    info(message: string, ...params: unknown[]): void;
    warn(message: string, ...params: unknown[]): void;
    error(message: string, ...params: unknown[]): void;
    debug(message: string, ...params: unknown[]): void;
}
export declare function createSafeLogger(logger: LoggerLike, redactor: Redactor): SafeLogger;
export declare function describeError(error: unknown): string;
