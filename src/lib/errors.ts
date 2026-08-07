export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly expose: boolean;

  constructor(
    message: string,
    options: { code: string; statusCode?: number; expose?: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    // When true, message is safe to show to end users (browser / Discord).
    this.expose = options.expose ?? false;
  }
}
