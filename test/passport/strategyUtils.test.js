process.env.NODE_ENV = 'test';

const chai = require('chai');
const expect = chai.expect;

const {
  hasRequiredStrategyConfig
} = require('../../api/passport/strategyUtils');

describe('passport strategy utils', function() {
  it('returns true only when all required values are present', function() {
    expect(hasRequiredStrategyConfig(['a', 'b', 'c'])).to.equal(true);
    expect(hasRequiredStrategyConfig(['a', '', 'c'])).to.equal(false);
    expect(hasRequiredStrategyConfig(['a', '   ', 'c'])).to.equal(false);
    expect(hasRequiredStrategyConfig(['a', null, 'c'])).to.equal(false);
  });
});
