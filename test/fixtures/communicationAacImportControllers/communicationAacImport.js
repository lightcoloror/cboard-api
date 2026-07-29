'use strict';

module.exports = {
  convertCommunicationAacFile(req, res) {
    const file = req.files.file[0];
    return res.status(200).json({
      format: 'picinterpreter-aac-conversion',
      contractVersion: 1,
      sourceFormat: req.swagger.params.format.value,
      sourceFileName: file.originalname,
      capabilities: {
        text: true,
        layout: true,
        embeddedRasterImages: false,
        touchChatCustomImages: false
      },
      warnings: [],
      documents: [
        {
          path: 'boards/home.obf',
          board: { format: 'open-board-0.1', id: 'home' }
        }
      ]
    });
  }
};
