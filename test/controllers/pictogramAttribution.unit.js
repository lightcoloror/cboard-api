'use strict';

const chai = require('chai');
const {
  normalizePublicPictogramAttribution
} = require('../../api/helpers/pictogramAttribution');

const expect = chai.expect;

describe('Pictogram attribution helper', function() {
  const arasaac = {
    provider: 'arasaac',
    originalId: '123',
    name: 'ARASAAC',
    license: 'CC BY-NC-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    author: 'Sergio Palao',
    authorUrl: 'https://arasaac.org/',
    sourceUrl: 'https://arasaac.org/pictograms/123',
    repoKey: 'arasaac'
  };

  it('preserves a complete approved public attribution', function() {
    expect(normalizePublicPictogramAttribution(arasaac)).to.deep.equal(arasaac);
  });

  it('preserves a complete Global Symbols v2 attribution', function() {
    const globalSymbols = {
      ...arasaac,
      provider: 'globalsymbols',
      originalId: '314',
      name: 'Global Symbols / Mulberry Symbols',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      author: 'Paxtoncrafts Charitable Trust',
      authorUrl: 'https://mulberrysymbols.org/',
      sourceUrl: 'https://globalsymbols.com/uploads/apple.svg',
      repoKey: 'mulberry'
    };

    expect(normalizePublicPictogramAttribution(globalSymbols)).to.deep.equal(
      globalSymbols
    );
  });

  it('rejects AI and device-private sources at the API boundary', function() {
    ['ai', 'ai-generated', 'device-private'].forEach(provider => {
      expect(
        normalizePublicPictogramAttribution({ ...arasaac, provider })
      ).to.equal(null);
    });
  });

  it('rejects attribution without a public HTTPS source', function() {
    expect(
      normalizePublicPictogramAttribution({
        ...arasaac,
        sourceUrl: 'http://example.test/pictogram/123'
      })
    ).to.equal(null);
  });
});
