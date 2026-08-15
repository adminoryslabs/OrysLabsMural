export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

function stamp(): string {
  return new Date().toISOString();
}

/**
 * Plain stdout/stderr logging. Docker collects it; there is no log shipping in
 * this deployment and a class of 25 does not warrant one.
 */
export const consoleLogger: Logger = {
  info(message, ...details) {
    console.log(`${stamp()} [yjs] ${message}`, ...details);
  },
  warn(message, ...details) {
    console.warn(`${stamp()} [yjs] ${message}`, ...details);
  },
  error(message, ...details) {
    console.error(`${stamp()} [yjs] ${message}`, ...details);
  },
};

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
