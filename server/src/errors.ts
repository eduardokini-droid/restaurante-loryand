export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const notFound = (what = 'Recurso') => new AppError(404, 'not_found', `${what} no encontrado`);
export const forbidden = (msg = 'No tienes permiso para esta acción') => new AppError(403, 'forbidden', msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const badRequest = (msg: string) => new AppError(400, 'bad_request', msg);
