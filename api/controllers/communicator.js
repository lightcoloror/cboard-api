const { paginatedResponse } = require('../helpers/response');
const { getORQuery } = require('../helpers/query');
const Communicator = require('../models/Communicator');
const { withLegacyAccountWrite } = require('../helpers/legacyAccountWrite');

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Care markers are created only by the authorized patient workspace service.
// Reject them even for legacy admins; hiding them in queries is not a write gate.
function rejectCareMarkers(req, res) {
  if (req.body && ['careProfileId', 'careFamilyId'].some(field =>
    Object.prototype.hasOwnProperty.call(req.body, field))) {
    return res.status(400).json({
      message: 'Patient workspace identifiers cannot be set through legacy communicator endpoints',
      error: { code: 'CARE_MARKER_RESERVED' }
    });
  }
  return null;
}

module.exports = {
  createCommunicator: createCommunicator,
  listCommunicators: listCommunicators,
  getCommunicator: getCommunicator,
  updateCommunicator: updateCommunicator,
  removeCommunicator: removeCommunicator,
  getCommunicatorsEmail: getCommunicatorsEmail
};

function getIdempotencyKey(req) {
  const value = req.get
    ? req.get(IDEMPOTENCY_KEY_HEADER)
    : req.headers && req.headers['idempotency-key'];
  return typeof value === 'string' ? value.trim() : '';
}

function findIdempotentCommunicator(email, clientCreationKey, session) {
  const query = Communicator.findOne({ email, clientCreationKey });
  return (session ? query.session(session) : query).exec();
}

function lifecycleFailure(error, res) {
  if (error && ['ACCOUNT_CLOSING', 'ACCOUNT_CLOSED', 'LEGACY_OWNER_UNAVAILABLE',
    'LEGACY_OWNER_CHANGED', 'ACCOUNT_UNAVAILABLE', 'INVALID_ACCOUNT_IDS'].includes(error.code)) {
    return res.status(error.status || 409).json({ message: 'Account is unavailable for this change', error: { code: error.code } });
  }
  return null;
}

function getCommunicatorQuery(req, id) {
  const query = { _id: id };
  if (!req.user.isAdmin) {
    query.email = req.user.email;
  }
  return query;
}

function sendCommunicatorResponse(res, communicator) {
  return res.status(200).json({
    success: 1,
    id: communicator._id,
    communicator: {
      id: communicator._id,
      name: communicator.name,
      author: communicator.author,
      email: communicator.email,
      description: communicator.description,
      rootBoard: communicator.rootBoard,
      boards: communicator.boards,
      defaultBoardsIncluded: communicator.defaultBoardsIncluded,
      lastEdited: communicator.lastEdited
    },
    message: 'Communicator saved successfully'
  });
}

async function createCommunicator(req, res) {
  const reservedMarker = rejectCareMarkers(req, res);
  if (reservedMarker) return reservedMarker;
  const clientCreationKey = getIdempotencyKey(req);
  const authenticatedEmail = req.user && req.user.email;

  if (clientCreationKey && !IDEMPOTENCY_KEY_PATTERN.test(clientCreationKey)) {
    return res.status(400).json({
      message: 'Invalid Idempotency-Key header'
    });
  }

  if (!authenticatedEmail) {
    return res.status(403).json({
      message: 'Authenticated user email is required'
    });
  }

  const ownerEmail = req.user.isAdmin ? req.body.email : authenticatedEmail;
  const communicatorData = { ...req.body };
  communicatorData.email = ownerEmail;
  delete communicatorData.clientCreationKey;
  if (clientCreationKey) {
    communicatorData.clientCreationKey = clientCreationKey;
  }

  try {
    const communicator = await withLegacyAccountWrite(req.user.id, [ownerEmail], async session => {
      if (clientCreationKey) {
      const existingCommunicator = await findIdempotentCommunicator(
        ownerEmail,
        clientCreationKey, session
      );
      if (existingCommunicator) {
        return existingCommunicator;
      }
      }
      return new Communicator(communicatorData).save(session ? { session } : undefined);
    });
    return sendCommunicatorResponse(res, communicator);
  } catch (err) {
    const rejected = lifecycleFailure(err, res);
    if (rejected) return rejected;
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED !== 'true' && clientCreationKey && err && err.code === 11000) {
      const existingCommunicator = await findIdempotentCommunicator(
        ownerEmail,
        clientCreationKey
      ).catch(() => null);
      if (existingCommunicator) {
        return sendCommunicatorResponse(res, existingCommunicator);
      }
    }

    return res.status(409).json({
      message: 'Error saving communicator',
      error: err.message
    });
  }
}

async function listCommunicators(req, res) {
  const { search = '' } = req.query;

  const searchFields = ['name', 'author', 'description', 'email'];
  let query =
    search && search.length ? getORQuery(searchFields, search, true) : {};
  if (!req.user.isAdmin) {
    query = { ...query, email: req.user.email };
  }

  const response = await paginatedResponse(Communicator, { query }, req.query);

  return res.status(200).json(response);
}

async function getCommunicatorsEmail(req, res) {
  const email = req.swagger.params.email.value;

  if (!req.user.isAdmin && req.user.email !== email) {
    return res.status(403).json({
      message: "You are not authorized to get this user's communicators."
    });
  }

  const { search = '' } = req.query;

  const searchFields = ['name', 'author', 'description'];
  const query =
    search && search.length ? getORQuery(searchFields, search, true) : {};

  const response = await paginatedResponse(
    Communicator,
    { query: { ...query, email } },
    req.query
  );

  return res.status(200).json(response);
}

function getCommunicator(req, res) {
  const id = req.swagger.params.id.value;
  Communicator.findOne(getCommunicatorQuery(req, id), function(
    err,
    communicator
  ) {
    if (err) {
      return res.status(500).json({
        message: 'Error getting board. ',
        error: err.message
      });
    }

    if (!communicator) {
      return res.status(404).json({
        message: `Communicator does not exist. Communicator ID: ${id}`
      });
    }

    return res.status(200).json(communicator);
  });
}

async function updateCommunicator(req, res) {
  const reservedMarker = rejectCareMarkers(req, res);
  if (reservedMarker) return reservedMarker;
  const id = req.swagger.params.id.value;
  let communicator = null;
  try {
    communicator = await Communicator.findOne(
      getCommunicatorQuery(req, id)
    ).exec();
    if (!communicator) {
      return res.status(404).json({
        message: `Unable to find communicator. Communicator ID: ${id}`
      });
    }
  } catch (err) {
    return res.status(500).json({
      message: 'Error updating communicator.',
      error: err.message
    });
  }

  const updateData = { ...req.body };
  delete updateData.clientCreationKey;
  delete updateData.__v;
  delete updateData._id;
  delete updateData.id;
  delete updateData.createdAt;
  delete updateData.lastEdited;
  if (!req.user.isAdmin) {
    delete updateData.email;
  }

  // Validate rootBoard is present in boards field
  const rootBoard = updateData.rootBoard || communicator.rootBoard;
  const boards = updateData.boards || communicator.boards;

  if (boards.indexOf(rootBoard) < 0) {
    return res.status(400).json({
      message: `RootBoard '${rootBoard}' does not exist in boards: ${boards.join(
        ', '
      )}`
    });
  }

  try {
    const originalEmail = communicator.email;
    const nextEmail = req.user.isAdmin &&
      Object.prototype.hasOwnProperty.call(updateData, 'email')
      ? updateData.email
      : originalEmail;
    const result = await withLegacyAccountWrite(
      req.user.id,
      [originalEmail, nextEmail],
      async session => {
        let current = communicator;
        if (session) {
          const query = Communicator.findOne({ _id: id, email: originalEmail });
          current = await query.session(session).exec();
          if (!current) {
            const error = new Error('LEGACY_OWNER_CHANGED');
            error.status = 409;
            error.code = 'LEGACY_OWNER_CHANGED';
            throw error;
          }
        }
        const currentRootBoard = updateData.rootBoard || current.rootBoard;
        const currentBoards = updateData.boards || current.boards;
        if (currentBoards.indexOf(currentRootBoard) < 0) {
          return {
            status: 400,
            body: {
              message: `RootBoard '${currentRootBoard}' does not exist in boards: ${currentBoards.join(
                ', '
              )}`
            }
          };
        }
        for (const key in updateData) current[key] = updateData[key];
        const dbCommunicator = await current.save(
          session ? { session } : undefined
        );
        return {
          status: dbCommunicator ? 200 : 404,
          body: dbCommunicator || {
            message: `Unable to update communicator. Communicator Id: ${id}`
          }
        };
      }
    );
    return res.status(result.status).json(result.body);
  } catch (err) {
    const rejected = lifecycleFailure(err, res);
    if (rejected) return rejected;
    return res.status(500).json({
      message: 'Error saving communicator.',
      error: err.message
    });
  }
}

async function removeCommunicator(req, res) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      message: 'Only administrators can remove communicators'
    });
  }
  const id = req.swagger.params.id.value;
  try {
    const authorized = await Communicator.findOne({ _id: id }).exec();
    if (!authorized) {
      return res.status(404).json({
        message: `Communicator not found. Communicator Id: ${id}`,
        error: 'Communicator not found.'
      });
    }
    const result = await withLegacyAccountWrite(
      req.user.id,
      [authorized.email],
      async session => {
        if (!session) {
          return new Promise(resolve => {
            Communicator.findByIdAndRemove(id, (err, communicator) => {
              if (err || !communicator) {
                resolve({
                  status: 404,
                  body: {
                    message: `Communicator not found. Communicator Id: ${id}`,
                    error: err ? err.message : 'Communicator not found.'
                  }
                });
                return;
              }
              resolve({ status: 200, body: communicator });
            });
          });
        }
        const query = Communicator.findOneAndDelete({
          _id: id,
          email: authorized.email
        });
        const deleted = await query.session(session).exec();
        return deleted
          ? { status: 200, body: deleted }
          : {
              status: 404,
              body: {
                message: `Communicator not found. Communicator Id: ${id}`,
                error: 'Communicator not found.'
              }
            };
      }
    );
    return res.status(result.status).json(result.body);
  } catch (err) {
    const rejected = lifecycleFailure(err, res);
    if (rejected) return rejected;
    return res.status(404).json({
      message: `Communicator not found. Communicator Id: ${id}`,
      error: err.message
    });
  }
}
