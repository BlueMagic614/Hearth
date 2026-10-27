export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const notFound = () => new HttpError(404, 'Not found');
