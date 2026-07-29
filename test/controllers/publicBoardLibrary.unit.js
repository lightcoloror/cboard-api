'use strict';

const chai = require('chai');
const {
  PublicBoardLibraryError,
  buildPublicBoardBundle,
  sanitizePublicBoard
} = require('../../api/helpers/publicBoardLibrary');

const expect = chai.expect;

function board(id, values = {}) {
  return {
    _id: id,
    __v: 7,
    name: values.name || id,
    author: values.author || 'CBoard author',
    email: values.email || 'private@example.com',
    isPublic: values.isPublic !== false,
    tiles: values.tiles || []
  };
}

describe('Public board library bundle', function() {
  it('traverses only public linked boards and strips private fields and links', async function() {
    const records = {
      root: board('root', {
        tiles: [
          { id: 'open', label: '公开', loadBoard: 'public-child' },
          { id: 'private', label: '私人', loadBoard: 'private-child' }
        ]
      }),
      'public-child': board('public-child', {
        tiles: [{ id: 'back', label: '返回', loadBoard: 'root' }]
      })
    };
    const result = await buildPublicBoardBundle(null, 'root', {
      findPublicBoard: async id => records[id] || null
    });

    expect(result.data).to.have.length(2);
    expect(result.data[0]).not.to.have.property('email');
    expect(result.data[0]).not.to.have.property('_id');
    expect(result.data[0]).not.to.have.property('__v');
    expect(result.data[0].tiles[0].loadBoard).to.equal('public-child');
    expect(result.data[0].tiles[1]).not.to.have.property('loadBoard');
    expect(result.diagnostics).to.deep.equal({
      boardCount: 2,
      tileCount: 3,
      unavailableLinkedBoardCount: 1
    });
    expect(result.warnings.join(' ')).to.match(/private/i);
  });

  it('returns a typed 404 for an unpublished root board', async function() {
    let caught;
    try {
      await buildPublicBoardBundle(null, 'private-root', {
        findPublicBoard: async () => null
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(PublicBoardLibraryError);
    expect(caught).to.include({
      statusCode: 404,
      code: 'PUBLIC_BOARD_NOT_FOUND'
    });
  });

  it('fails closed when a public graph exceeds configured resource limits', async function() {
    let caught;
    try {
      await buildPublicBoardBundle(null, 'root', {
        maxBoards: 1,
        findPublicBoard: async id =>
          board(id, {
            tiles:
              id === 'root'
                ? [{ id: 'next', label: '下页', loadBoard: 'child' }]
                : []
          })
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.include({
      statusCode: 413,
      code: 'PUBLIC_BOARD_BUNDLE_TOO_LARGE'
    });
  });

  it('sanitizes public list records without mutating the source', function() {
    const source = board('root');
    const sanitized = sanitizePublicBoard(source);

    expect(sanitized).not.to.have.property('email');
    expect(sanitized.id).to.equal('root');
    expect(source.email).to.equal('private@example.com');
  });

  it('adds a stable offline image path without replacing the source URL', async function() {
    const result = await buildPublicBoardBundle(null, 'root', {
      findPublicBoard: async () =>
        board('root', {
          tiles: [
            {
              id: 'water cup',
              label: '水',
              image: 'https://cdncboard.azureedge.net/boards/water.png'
            }
          ]
        })
    });

    expect(result.data[0].tiles[0]).to.include({
      image: 'https://cdncboard.azureedge.net/boards/water.png',
      offlineImagePath: '/board/public/root/tile/water%20cup/image'
    });
  });
});
