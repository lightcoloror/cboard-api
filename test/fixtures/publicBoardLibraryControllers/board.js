'use strict';

module.exports = {
  getPublicBoardBundle(req, res) {
    const id = req.swagger.params.id.value;
    return res.status(200).json({
      format: 'cboard-public-board-bundle',
      contractVersion: 1,
      rootBoardId: id,
      source: 'cboard-public',
      sourceUrl: 'https://github.com/cboard-org/cboard',
      licenseStatus: 'unknown',
      warnings: ['Verify image rights before reuse.'],
      data: [
        {
          id,
          name: 'Public board',
          author: 'CBoard author',
          isPublic: true,
          tiles: []
        }
      ],
      diagnostics: {
        boardCount: 1,
        tileCount: 0,
        unavailableLinkedBoardCount: 0
      }
    });
  },
  getPublicBoardTileImage(req, res) {
    return res
      .status(200)
      .type('png')
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
};
