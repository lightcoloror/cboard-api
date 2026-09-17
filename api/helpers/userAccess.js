'use strict';

const UNAUTHORIZED_MESSAGE = 'You are not authorized to access this user.';
const UNAUTHORIZED_CODE = 'USER_ACCESS_UNAUTHORIZED';
const FORBIDDEN_CODE = 'USER_ACCESS_FORBIDDEN';

function failure() {
  return {
    ok: false,
    status: 401,
    body: {
      message: UNAUTHORIZED_MESSAGE,
      error: { code: UNAUTHORIZED_CODE }
    }
  };
}

function forbidden() {
  return {
    ok: false,
    status: 403,
    body: {
      message: UNAUTHORIZED_MESSAGE,
      error: { code: FORBIDDEN_CODE }
    }
  };
}

function scalarId(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const id = String(value).trim();
    return id || null;
  }
  if (value && typeof value === 'object' && typeof value.toString === 'function') {
    const id = String(value).trim();
    return id && id !== '[object Object]' ? id : null;
  }
  return null;
}

function resolvedUserId(user) {
  if (!user || typeof user !== 'object') return null;
  return scalarId(user.id) || scalarId(user._id);
}

function authenticated(req) {
  const user = req && req.user;
  const id = resolvedUserId(user);
  if (!id) return failure();

  if (req.auth && (!scalarId(req.auth.id) || scalarId(req.auth.id) !== id)) {
    return failure();
  }

  return { ok: true, user, id };
}

function requireAdmin(req) {
  const result = authenticated(req);
  if (!result.ok) return result;
  if (result.user.role !== 'admin') return forbidden();
  return result;
}

function requireSelfOrAdmin(req, targetId) {
  const result = authenticated(req);
  if (!result.ok) return result;
  if (result.user.role === 'admin' || String(targetId) === result.id) {
    return result;
  }
  return forbidden();
}

module.exports = {
  authenticated,
  requireAdmin,
  requireSelfOrAdmin,
  resolvedUserId,
  UNAUTHORIZED_CODE,
  UNAUTHORIZED_MESSAGE,
  FORBIDDEN_CODE
};
