'use strict';
function createBearerAuthenticator({ auth, users, sessions }) {
  return async (req, token) => {
    if (!auth.verifyToken(req, token)) return false;
    const user = await users.getById(req.auth.id);
    if (!user || !auth.isTokenCurrentForUser(req.auth, user) || !await sessions.valid(req.auth)) return false;
    req.user = user;
    return true;
  };
}
exports.createBearerAuthenticator = createBearerAuthenticator;
