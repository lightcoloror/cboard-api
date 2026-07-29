const { paginatedResponse } = require('../helpers/response');
const { getORQuery } = require('../helpers/query');
const Communicator = require('../models/Communicator');

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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

function findIdempotentCommunicator(email, clientCreationKey) {
  return Communicator.findOne({ email, clientCreationKey }).exec();
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
    if (clientCreationKey) {
      const existingCommunicator = await findIdempotentCommunicator(
        ownerEmail,
        clientCreationKey
      );
      if (existingCommunicator) {
        return sendCommunicatorResponse(res, existingCommunicator);
      }
    }

    const communicator = await new Communicator(communicatorData).save();
    return sendCommunicatorResponse(res, communicator);
  } catch (err) {
    if (clientCreationKey && err && err.code === 11000) {
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

  for (let key in updateData) {
    communicator[key] = updateData[key];
  }

  try {
    const dbCommunicator = await communicator.save();
    if (!dbCommunicator) {
      return res.status(404).json({
        message: `Unable to update communicator. Communicator Id: ${id}`
      });
    }

    return res.status(200).json(dbCommunicator);
  } catch (err) {
    return res.status(500).json({
      message: 'Error saving communicator.',
      error: err.message
    });
  }
}

function removeCommunicator(req, res) {
  const id = req.swagger.params.id.value;
  Communicator.findByIdAndRemove(id, function(err, communicator) {
    if (err) {
      return res.status(404).json({
        message: `Communicator not found. Communicator Id: ${id}`,
        error: err.message
      });
    }
    if (!communicator) {
      return res.status(404).json({
        message: 'Communicator not found. Communicator Id: ' + id,
        error: 'Communicator not found.'
      });
    }
    return res.status(200).json(communicator);
  });
}
