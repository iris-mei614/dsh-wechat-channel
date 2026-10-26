import type { LoggerLike } from './types.js';

/**
 * Secrets are collected here and scrubbed from every log line and error
 * message. The plugin never logs raw bot tokens or context tokens.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  add(secret: string | undefined | null): void {
    if (typeof secret === 'string' && secret.length >= 4) this.secrets.add(secret);
  }

  remove(secret: string | undefined | null): void {
    if (typeof secret === 'string') this.secrets.delete(secret);
  }

  redact(value: unknown): string {
    let text: string;
    if (typeof value === 'string') text = value;
    else if (value instanceof Error) text = value.stack ?? value.message;
    else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    for (const secret of this.secrets) {
      if (secret.length > 0) text = text.split(secret).join('[redacted]');
    }
    return text;
  }
}

export interface SafeLogger {
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
  debug(message: string, ...params: unknown[]): void;
}

export function createSafeLogger(logger: LoggerLike, redactor: Redactor): SafeLogger {
  const wrap = (method: keyof LoggerLike) => (message: string, ...params: unknown[]) => {
    const safeMessage = redactor.redact(message);
    const safeParams = params.map((value) => redactor.redact(value));
    try {
      (logger[method] as (...args: unknown[]) => void)(safeMessage, ...safeParams);
    } catch {
      // Logging must never take the channel down.
    }
  };
  return {
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    debug: wrap('debug'),
  };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
