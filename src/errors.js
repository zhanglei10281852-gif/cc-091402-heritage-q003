export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, "bad_request", message, details);
export const notFound = (message) => new HttpError(404, "not_found", message);
export const conflict = (message, details) => new HttpError(409, "conflict", message, details);
