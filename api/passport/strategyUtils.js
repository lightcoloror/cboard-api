function hasRequiredStrategyConfig(values = []) {
  return values.every(value => typeof value === 'string' && value.trim().length);
}

function warnStrategyDisabled(name) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  console.warn(
    `[auth] ${name} strategy disabled because required environment variables are missing`
  );
}

module.exports = {
  hasRequiredStrategyConfig,
  warnStrategyDisabled
};
