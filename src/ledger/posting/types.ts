export class ValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Voucher validation failed: ${errors.join('; ')}`);
    this.name = 'ValidationError';
  }
}
