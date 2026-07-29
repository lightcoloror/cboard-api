'use strict';

var mongoose = require('mongoose');
var config = require('./config');
const seeds = require('./seeds');
const {
  ensureCommunicationIndexes,
  markCommunicationIndexesPending
} = require('./api/helpers/communicationIndexes');

mongoose.connect(config.databaseUrl, { 
  useNewUrlParser: true,
  useFindAndModify: false
});
mongoose.connection.on('connected', () => {
  console.log('Connected to ' + config.env + ' database ');
  seeds();
  ensureCommunicationIndexes()
    .then(() => console.log('Communication indexes are ready'))
    .catch(err =>
      console.error('Communication index initialization failed: ' + err.message)
    );
});
mongoose.connection.on('error', err =>
  console.log('Database connection error: ' + err)
);
mongoose.connection.on('disconnected', () => {
  markCommunicationIndexesPending();
  console.log('Disconnected from database');
});

process.on('SIGINT', () =>
  mongoose.connection.close(() => {
    console.log('Finished App and disconnected from database');
    process.exit(0);
  })
);

module.exports = mongoose.connection;
