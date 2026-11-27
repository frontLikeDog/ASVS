/** HTTP-mapped error raised by the orchestration service and routes. */
export class OrchestrationHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OrchestrationHttpError';
  }
}
