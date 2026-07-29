'use strict';

const gpt = require('../../../api/controllers/gpt');

module.exports = {
  ...gpt,
  getCommunicationAiUsage(req, res) {
    return res.status(200).json({
      month: '2026-07',
      requestCount: 0,
      reportedRequestCount: 0,
      unreportedRequestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      providerReported: false,
      breakdown: []
    });
  }
};
