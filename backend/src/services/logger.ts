type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVELS, value);
}

let current: number = LEVELS.info;
const configuredLevel = process.env.LOG_LEVEL;

if (configuredLevel !== undefined) {
  const level = configuredLevel.toLowerCase();

  if (isLogLevel(level)) {
    current = LEVELS[level];
  }
}

export const logger = {
  debug: (...a: unknown[]) => current <= 0 && console.log('[debug]', ...a),
  info:  (...a: unknown[]) => current <= 1 && console.log('[info]',  ...a),
  warn:  (...a: unknown[]) => current <= 2 && console.warn('[warn]',  ...a),
  error: (...a: unknown[]) => current <= 3 && console.error('[error]', ...a),
};
