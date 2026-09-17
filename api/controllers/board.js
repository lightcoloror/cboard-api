var ObjectId = require('mongoose').Types.ObjectId;
const moment = require('moment');

const { paginatedResponse } = require('../helpers/response');
const { getORQuery } = require('../helpers/query');
const Board = require('../models/Board');
const { getCbuilderBoardbyId } = require('../helpers/cbuilder');
const {
  processBase64Images,
  hasBase64Images
} = require('../helpers/imageProcessor');
const {
  PublicBoardLibraryError,
  buildPublicBoardBundle,
  sanitizePublicBoard
} = require('../helpers/publicBoardLibrary');
const { loadPublicBoardTileImage } = require('../helpers/publicBoardImage');
const { withLegacyAccountWrite } = require('../helpers/legacyAccountWrite');

const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || 'cblob';
// Upper bound on ids per /board/byids request. Guards against runaway clients
// (e.g. a copy-loop bug) without limiting any healthy user.
const MAX_BOARDS_BY_IDS = 3000;

function lifecycleFailure(error, res) {
  if (error && [
    'ACCOUNT_CLOSING',
    'ACCOUNT_CLOSED',
    'LEGACY_OWNER_UNAVAILABLE',
    'LEGACY_OWNER_CHANGED',
    'ACCOUNT_UNAVAILABLE'
  ].includes(error.code)) {
    return res.status(error.status || 409).json({
      message: 'Account is unavailable for this change',
      error: { code: error.code }
    });
  }
  return null;
}

function lifecycleEnabled() {
  return process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true';
}

function queryWithSession(query, session) {
  if (!session) return query;
  if (!query || typeof query.session !== 'function') {
    throw new Error('Board query does not support transaction sessions');
  }
  return query.session(session);
}

module.exports = {
  createBoard: createBoard,
  listBoard: listBoard,
  deleteBoard: deleteBoard,
  getBoard: getBoard,
  updateBoard: updateBoard,
  getBoardsEmail: getBoardsEmail,
  getBoardsSync: getBoardsSync,
  getBoardsByIds: getBoardsByIds,
  getPublicBoards: getPublicBoards,
  getPublicBoardBundle: getPublicBoardBundle,
  getPublicBoardTileImage: getPublicBoardTileImage,
  reportPublicBoard: reportPublicBoard,
  getCbuilderBoard: getCbuilderBoard
};

async function createBoard(req, res) {
  const boardData = { ...req.body };
  if (!req.user.isAdmin) {
    boardData.email = req.user.email;
  }

  const board = new Board(boardData);
  board.lastEdited = moment().format();
  try {
    const savedBoard = await withLegacyAccountWrite(
      req.user.id,
      [boardData.email],
      async session => {
        const saved = await board.save(session ? { session } : undefined);
        return { status: 200, body: saved.toJSON() };
      }
    );
    return res.status(savedBoard.status).json(savedBoard.body);
  } catch (error) {
    const rejected = lifecycleFailure(error, res);
    if (rejected) return rejected;
    return res.status(409).json({
      message: 'Error saving board',
      error: error.message
    });
  }
}

async function listBoard(req, res) {
  const { search = '' } = req.query;
  const searchFields = ['name', 'author', 'email'];
  const query =
    search && search.length ? getORQuery(searchFields, search, true) : {};

  const response = await paginatedResponse(Board, { query }, req.query);

  return res.status(200).json(response);
}

async function getBoardsEmail(req, res) {
  const email = req.swagger.params.email.value;

  if (!req.user.isAdmin && req.user.email !== email) {
    return res.status(403).json({
      message: "You are not authorized to get this user's boards."
    });
  }

  const { search = '' } = req.query;

  const searchFields = ['name', 'author'];
  const query =
    search && search.length ? getORQuery(searchFields, search, true) : {};

  const response = await paginatedResponse(
    Board,
    { query: { ...query, email } },
    req.query
  );

  return res.status(200).json(response);
}

async function getBoardsSync(req, res) {
  const email = req.swagger.params.email.value;

  if (!req.user.isAdmin && req.user.email !== email) {
    return res.status(403).json({
      message: "You are not authorized to get this user's boards."
    });
  }

  try {
    const boards = await Board.find({ email })
      .select('lastEdited')
      .lean()
      .exec();

    const data = boards.map(b => ({
      id: b._id,
      lastEdited: b.lastEdited
    }));

    return res.status(200).json({ total: data.length, data });
  } catch (err) {
    return res.status(500).json({
      message: 'Error getting boards for sync.',
      error: err.message
    });
  }
}

async function getBoardsByIds(req, res) {
  // Shape and non-empty are validated by swagger. The size cap is enforced
  // here because swagger does not validate array maxItems for request bodies.
  const { ids } = req.swagger.params.body.value;

  if (ids.length > MAX_BOARDS_BY_IDS) {
    return res.status(400).json({
      message: `ids cannot contain more than ${MAX_BOARDS_BY_IDS} items.`
    });
  }

  const validIds = ids.filter(id => ObjectId.isValid(id));
  if (!validIds.length) {
    return res.status(400).json({
      message: 'ids must contain at least one valid board id.'
    });
  }

  try {
    const query = { _id: { $in: validIds } };

    if (!req.user.isAdmin) {
      query.email = req.user.email;
    }

    const boards = await Board.find(query)
      .lean()
      .exec();

    // Normalize _id -> id and drop the Mongoose version key to match the toJSON() output
    const data = boards.map(({ _id, __v, ...rest }) => ({ ...rest, id: _id }));

    return res.status(200).json({ total: data.length, data });
  } catch (err) {
    return res.status(500).json({
      message: 'Error getting boards by ids.',
      error: err.message
    });
  }
}

async function getPublicBoards(req, res) {
  const { search = '' } = req.query;
  const searchFields = ['name', 'author'];
  const query =
    search && search.length ? getORQuery(searchFields, search, true) : {};
  const response = await paginatedResponse(
    Board,
    { query: { ...query, isPublic: true } },
    req.query
  );
  response.data = response.data.map(sanitizePublicBoard).filter(Boolean);

  return res.status(200).json(response);
}

async function getPublicBoardBundle(req, res) {
  const id = req.swagger.params.id.value;
  if (!ObjectId.isValid(id)) {
    return res.status(404).json({
      message: 'Public board does not exist'
    });
  }

  try {
    const bundle = await buildPublicBoardBundle(Board, id);
    res.set('Cache-Control', 'public, max-age=60');
    return res.status(200).json(bundle);
  } catch (error) {
    if (error instanceof PublicBoardLibraryError) {
      return res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message
        }
      });
    }
    return res.status(500).json({
      error: {
        code: 'PUBLIC_BOARD_BUNDLE_FAILED',
        message: 'Unable to create public board bundle'
      }
    });
  }
}

async function getPublicBoardTileImage(req, res) {
  const id = req.swagger.params.id.value;
  const tileId = req.swagger.params.tileId.value;
  if (!ObjectId.isValid(id)) {
    return res.status(404).json({
      message: 'Public board does not exist'
    });
  }

  try {
    const image = await loadPublicBoardTileImage(Board, id, tileId);
    res.set({
      'Cache-Control': 'public, max-age=86400',
      'Content-Type': image.contentType,
      'X-Content-Type-Options': 'nosniff'
    });
    return res.status(200).send(image.buffer);
  } catch (error) {
    if (error instanceof PublicBoardLibraryError) {
      return res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message
        }
      });
    }
    return res.status(500).json({
      error: {
        code: 'PUBLIC_BOARD_IMAGE_FAILED',
        message: 'Unable to load public board image'
      }
    });
  }
}

async function deleteBoard(req, res) {
  const id = req.swagger.params.id.value;
  if (!lifecycleEnabled()) {
    const query = { _id: id };
    if (!req.user.isAdmin) query.email = req.user.email;
    return new Promise(resolve => {
      Board.findOneAndRemove(query, function(err, boards) {
        if (err || !boards) {
          resolve(res.status(404).json({
            message: 'Board not found. Board Id: ' + id,
            error: err ? err.message : 'Board not found.'
          }));
          return;
        }
        resolve(res.status(200).json(boards));
      });
    });
  }
  const query = { _id: id };
  if (!req.user.isAdmin) query.email = req.user.email;
  try {
    const authorized = await Board.findOne(query).exec();
    if (!authorized) return res.status(404).json({
      message: 'Board not found. Board Id: ' + id,
      error: 'Board not found.'
    });
    const result = await withLegacyAccountWrite(req.user.id, [authorized.email], async session => {
      const removeQuery = Board.findOneAndDelete({ _id: id, email: authorized.email });
      const deleted = await queryWithSession(removeQuery, session).exec();
      return deleted
        ? { status: 200, body: deleted }
        : { status: 404, body: { message: 'Board not found. Board Id: ' + id, error: 'Board not found.' } };
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    const rejected = lifecycleFailure(error, res);
    if (rejected) return rejected;
    return res.status(404).json({ message: 'Board not found. Board Id: ' + id, error: error.message });
  }
}

function getBoard(req, res) {
  const id = req.swagger.params.id.value;
  //  Validate id
  if (!ObjectId.isValid(id)) {
    return res.status(404).json({
      message: 'Invalid ID for a Board. Board Id: ' + id
    });
  }
  Board.findOne({ _id: id }, function(err, boards) {
    if (err) {
      return res.status(500).json({
        message: 'Error getting board. ',
        error: err.message
      });
    }
    if (!boards) {
      return res.status(404).json({
        message: 'Board does not exist. Board Id: ' + id
      });
    }
    return res.status(200).json(boards.toJSON());
  });
}

async function updateBoard(req, res) {
  const id = req.swagger.params.id.value;
  let isLocalUpdateNeeded = false;

  try {
    const query = { _id: id };
    if (!req.user.isAdmin) {
      query.email = req.user.email;
    }

    const initialQuery = Board.findOne(query);
    const board = await (initialQuery && typeof initialQuery.exec === 'function'
      ? initialQuery.exec()
      : initialQuery);

    if (!board) {
      return res.status(404).json({
        message: 'Unable to find board. board Id: ' + id
      });
    }

    const updateData = { ...req.body };
    delete updateData.__v;
    delete updateData._id;
    delete updateData.id;
    if (!req.user.isAdmin) {
      delete updateData.email;
    }

    const hasImages = Boolean(
      updateData.tiles &&
      Array.isArray(updateData.tiles) &&
      hasBase64Images(updateData.tiles)
    );
    if (hasImages && lifecycleEnabled()) {
      try {
        await withLegacyAccountWrite(
          req.user.id,
          [
            board.email,
            Object.prototype.hasOwnProperty.call(updateData, 'email')
              ? updateData.email
              : board.email
          ],
          async () => true
        );
      } catch (gateError) {
        const rejected = lifecycleFailure(gateError, res);
        if (rejected) return rejected;
        throw gateError;
      }
    }
    if (hasImages) {
      try {
        const imageProcessResult = await processBase64Images(
          updateData.tiles,
          BLOB_CONTAINER_NAME,
          id
        );
        updateData.tiles = imageProcessResult.tiles;
        isLocalUpdateNeeded = true;
      } catch (imageError) {
        console.error('Base64 images uploading failed:', {
          boardId: id,
          error: imageError.message,
          tilesCount: updateData.tiles.length
        });
      }
    }

    try {
      const result = await withLegacyAccountWrite(
        req.user.id,
        [board.email, req.user.isAdmin && Object.prototype.hasOwnProperty.call(updateData, 'email') ? updateData.email : board.email],
        async session => {
          let current = board;
          if (session) {
            const currentQuery = Board.findOne({ _id: id, email: board.email });
            current = await queryWithSession(currentQuery, session).exec();
            if (!current) {
              const ownerError = new Error('LEGACY_OWNER_CHANGED');
              ownerError.code = 'LEGACY_OWNER_CHANGED';
              ownerError.status = 409;
              throw ownerError;
            }
          }
          for (const key in updateData) current[key] = updateData[key];
          current.lastEdited = moment().format();
          const savedBoard = await current.save(session ? { session } : undefined);
          if (!savedBoard) return { status: 404, body: { message: 'Unable to find board. board id: ' + id } };
          const response = savedBoard.toJSON();
          response.isLocalUpdateNeeded = isLocalUpdateNeeded;
          return { status: 200, body: response };
        }
      );
      return res.status(result.status).json(result.body);
    } catch (err) {
      const rejected = lifecycleFailure(err, res);
      if (rejected) return rejected;
      return res.status(500).json({
        message: 'Error saving board. ',
        error: err.message
      });
    }
  } catch (err) {
    return res.status(500).json({
      message: 'Error updating board. ',
      error: err.message
    });
  }
}

function reportPublicBoard(req, res) {
  const { nev } = require('../mail');
  nev.sendReportEmail(req.body, function(err, info) {
    if (err) {
      return res.status(500).json({
        message: 'ERROR: sending report email FAILED ' + info
      });
    }
    return res.status(200).json({ message: 'Email sent successfuly' });
  });
}

async function getCbuilderBoard(req, res) {
  const id = req.swagger.params.id.value;
  try {
    const board = await getCbuilderBoardbyId(id);
    if (!board) {
      return res.status(404).json({
        message: 'Cbuilder Board not found. Board Id: ' + id
      });
    }
    if (!req.user.isAdmin && req.auth.email !== board.email) {
      return res.status(401).json({
        message: 'You are not authorized to get this board.'
      });
    }
    const newBoard = new Board(board);
    return res.status(200).json(newBoard.toJSON());
  } catch (err) {
    return res.status(500).json({
      message: 'Error getting Cbuilder Board ',
      error: err.message
    });
  }
}
