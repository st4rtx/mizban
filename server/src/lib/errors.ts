export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'ابتدا وارد شوید') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'اجازه این کار را ندارید') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'پیدا نشد') => new AppError(404, 'not_found', message);
/** Optimistic-concurrency / state conflicts. `current` carries fresh state so the UI can repair itself. */
export const conflict = (code: string, message: string, current?: unknown) =>
  new AppError(409, code, message, current === undefined ? undefined : { current });
