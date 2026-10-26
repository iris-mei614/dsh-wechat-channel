/**
 * Secrets are collected here and scrubbed from every log line and error
 * message. The plugin never logs raw bot tokens or context tokens.
 */
export class Redactor {
    secrets = new Set();
    add(secret) {
        if (typeof secret === 'string' && secret.length >= 4)
            this.secrets.add(secret);
    }
    remove(secret) {
        if (typeof secret === 'string')
            this.secrets.delete(secret);
    }
    redact(value) {
        let text;
        if (typeof value === 'string')
            text = value;
        else if (value instanceof Error)
            text = value.stack ?? value.message;
        else {
            try {
                text = JSON.stringify(value);
            }
            catch {
                text = String(value);
            }
        }
        for (const secret of this.secrets) {
            if (secret.length > 0)
                text = text.split(secret).join('[redacted]');
        }
        return text;
    }
}
export function createSafeLogger(logger, redactor) {
    const wrap = (method) => (message, ...params) => {
        const safeMessage = redactor.redact(message);
        const safeParams = params.map((value) => redactor.redact(value));
        try {
            logger[method](safeMessage, ...safeParams);
        }
        catch {
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
export function describeError(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
