import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@ri/shared';
import { logger } from './logger.js';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  static unauthenticated(msg = 'Please sign in') {
    return new AppError(401, ERROR_CODES.UNAUTHENTICATED, msg);
  }
  static notFound(msg = 'Not found') {
    return new AppError(404, ERROR_CODES.NOT_FOUND, msg);
  }
  static notConfigured(msg: string) {
    return new AppError(503, ERROR_CODES.NOT_CONFIGURED, msg);
  }
}

const body = (code: ErrorCode, message: string, details?: unknown): ApiErrorBody => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body(ERROR_CODES.NOT_FOUND, `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json(body(ERROR_CODES.VALIDATION, 'Invalid request', err.flatten()));
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json(body(err.code, err.message, err.details));
    return;
  }
  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json(body(ERROR_CODES.INTERNAL, 'Something went wrong'));
};
