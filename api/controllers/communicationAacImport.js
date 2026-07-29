'use strict';

const {
  CommunicationAacImportError,
  createCommunicationAacImportService
} = require('../helpers/communicationAacImport');

const convertAacFile = createCommunicationAacImportService();

function requestParameter(req, name) {
  const swaggerParameter =
    req && req.swagger && req.swagger.params && req.swagger.params[name];
  if (swaggerParameter && swaggerParameter.value !== undefined) {
    return swaggerParameter.value;
  }
  return req && req.query ? req.query[name] : undefined;
}

function createCommunicationAacImportController({
  convert = convertAacFile
} = {}) {
  async function convertCommunicationAacFile(req, res) {
    if (!req.user) {
      return res.status(400).json({
        message: 'Are you logged in? Is bearer token present?'
      });
    }
    const file =
      req.files && Array.isArray(req.files.file) && req.files.file.length
        ? req.files.file[0]
        : null;
    if (!file || !Buffer.isBuffer(file.buffer)) {
      return res.status(400).json({ message: 'AAC import file is required' });
    }

    try {
      const result = await convert({
        buffer: file.buffer,
        fileName: file.originalname,
        format: requestParameter(req, 'format'),
        locale: requestParameter(req, 'locale') || 'zh-CN'
      });
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof CommunicationAacImportError) {
        if (error.statusCode === 429) res.set('Retry-After', '5');
        return res.status(error.statusCode).json({
          error: { code: error.code, message: error.message }
        });
      }
      return res.status(500).json({
        error: {
          code: 'AAC_IMPORT_FAILED',
          message: 'Unable to convert the AAC file'
        }
      });
    }
  }

  return { convertCommunicationAacFile };
}

const controller = createCommunicationAacImportController();

module.exports = {
  convertCommunicationAacFile: controller.convertCommunicationAacFile,
  createCommunicationAacImportController,
  requestParameter
};
