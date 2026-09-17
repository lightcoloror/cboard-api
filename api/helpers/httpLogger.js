'use strict';

const UNMATCHED_ROUTE = 'unmatched';

function fixedOperationId(req) {
  const operationId = req && req.swagger && req.swagger.operation && req.swagger.operation.operationId;
  return typeof operationId === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(operationId)
    ? operationId
    : null;
}

function fixedRouteTemplate(req) {
  const route = req && req.route;
  const path = route && route.path;
  if (typeof path !== 'string' || path.length === 0 || path.length > 512 || path[0] !== '/') {
    return null;
  }
  // Express route paths are templates. Reject anything that could be a URL or
  // otherwise contain data supplied by a request before exposing it to logs.
  if (/[^A-Za-z0-9_./:{}*?()[\]-]/.test(path) || path.includes('?')) {
    return null;
  }
  return path;
}

function routeLabel(req) {
  return fixedOperationId(req) || fixedRouteTemplate(req) || UNMATCHED_ROUTE;
}

function createHttpLogFormat() {
  return ':method :http-route :status :response-time ms';
}

function registerHttpLoggerTokens(morgan) {
  morgan.token('http-route', routeLabel);
}

module.exports = {
  UNMATCHED_ROUTE,
  createHttpLogFormat,
  registerHttpLoggerTokens,
  routeLabel
};
