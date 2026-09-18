'use strict';

const SAFE_CODE = /^[A-Z0-9_]{1,80}$/;

function statusFrom(error) {
  const status = Number(error && (error.statusCode || error.status));
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}

function codeFrom(error, status) {
  if (status === 401) return 'LOGIN_REQUIRED';
  if (status === 403) return 'USER_ACCESS_FORBIDDEN';

  const code = error && error.code;
  if (typeof code === 'string' && SAFE_CODE.test(code) && code !== 'SERVER_ERROR') {
    return code;
  }

  if (status === 503) return 'SERVICE_UNAVAILABLE';
  return status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'HTTP_REQUEST_FAILED';
}

function createHttpErrorHandler() {
  return function httpErrorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);

    const status = statusFrom(error);
    res.set('Cache-Control', 'no-store');
    return res.status(status).json({ code: codeFrom(error, status) });
  };
}

module.exports = {
  createHttpErrorHandler,
  statusFrom,
  codeFrom
};
