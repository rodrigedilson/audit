export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  constructor(
    private readonly context: string,
    private readonly level: LogLevel = LogLevel.INFO,
  ) {}

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) {
      this.log('DEBUG', message, data);
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) {
      this.log('INFO', message, data);
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.level <= LogLevel.WARN) {
      this.log('WARN', message, data);
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    if (this.level <= LogLevel.ERROR) {
      this.log('ERROR', message, data);
    }
  }

  private log(level: string, message: string, data?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, level, context: this.context, message, ...data };
    const output = level === 'ERROR' ? console.error : console.log;
    output(JSON.stringify(entry));
  }
}
