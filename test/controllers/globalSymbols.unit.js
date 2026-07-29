'use strict';

const chai = require('chai');
const sharp = require('sharp');
const {
  createGlobalSymbolsProvider
} = require('../../api/helpers/globalSymbols');

const expect = chai.expect;

function createV2Label(overrides = {}) {
  const { picto: pictoOverrides = {}, ...labelOverrides } = overrides;
  return {
    id: 42,
    text: 'apple',
    language: 'eng',
    picto: {
      id: 314,
      symbolset_id: 7,
      part_of_speech: 'noun',
      image_url: 'https://globalsymbols.com/uploads/apple.svg',
      native_format: 'svg',
      adaptable: true,
      symbolset: {
        name: 'Mulberry Symbols',
        slug: 'mulberry',
        publisher: 'Paxtoncrafts Charitable Trust',
        publisher_url: 'https://mulberrysymbols.org/',
        licence: {
          name: 'CC BY-SA',
          version: '4.0',
          url: 'https://creativecommons.org/licenses/by-sa/4.0/'
        }
      },
      ...pictoOverrides
    },
    ...labelOverrides
  };
}

describe('Global Symbols provider', function() {
  it('uses v2 server credentials and returns signed, attributed PNG candidates', async function() {
    const calls = [];
    const provider = createGlobalSymbolsProvider({
      apiKey: 'server-only-key',
      proxySecret: 'independent-proxy-secret',
      http: {
        get: async function get(url, options) {
          calls.push({ url, options });
          if (url.endsWith('/labels/search')) {
            return { data: [createV2Label()] };
          }
          if (url === 'https://globalsymbols.com/uploads/apple.svg') {
            return {
              data: Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#28a745"/></svg>'
              ),
              headers: { 'content-type': 'image/svg+xml' }
            };
          }
          throw new Error(`Unexpected URL: ${url}`);
        }
      }
    });

    const labels = await provider.searchLabels({
      query: 'apple',
      language: 'eng',
      limit: 5
    });

    expect(provider.configured).to.equal(true);
    expect(calls[0].url).to.equal(
      'https://globalsymbols.com/api/v2/labels/search'
    );
    expect(calls[0].options.headers['X-Api-Key']).to.equal('server-only-key');
    expect(calls[0].options.params).to.deep.equal({
      query: 'apple',
      language: 'eng',
      language_iso_format: '639-3',
      limit: 5,
      include_preview: true
    });
    expect(labels).to.have.length(1);
    expect(labels[0].picto.image_url).to.match(
      /^\/pictograms\/globalsymbols\/[A-Za-z0-9_-]+\.[a-f0-9]{32}\/image$/
    );
    expect(labels[0].pictogramAttribution).to.include({
      provider: 'globalsymbols',
      originalId: '314',
      name: 'Global Symbols / Mulberry Symbols',
      license: 'CC BY-SA 4.0',
      repoKey: 'mulberry'
    });
    expect(JSON.stringify(labels)).not.to.include('server-only-key');
    expect(JSON.stringify(labels)).not.to.include('independent-proxy-secret');

    const token = labels[0].picto.image_url.split('/')[3];
    const image = await provider.loadImage(token);
    expect(image.contentType).to.equal('image/png');
    const metadata = await sharp(image.buffer).metadata();
    expect(metadata).to.include({ format: 'png', width: 300, height: 200 });
  });

  it('provides attributed v2 candidates to the missing-word runtime', async function() {
    const provider = createGlobalSymbolsProvider({
      apiKey: 'server-only-key',
      proxySecret: 'independent-proxy-secret',
      http: {
        get: async function get() {
          return { data: [createV2Label({ text: 'water' })] };
        }
      }
    });

    const results = await provider.searchRuntimePictograms({
      token: '喝水',
      query: 'water',
      locale: 'en'
    });

    expect(results).to.have.length(1);
    expect(results[0]).to.include({
      originalId: '314',
      label: 'water',
      token: '喝水'
    });
    expect(results[0].source.provider).to.equal('globalsymbols');
  });

  it('keeps the legacy v1 editor fallback without inventing attribution', async function() {
    let request;
    const provider = createGlobalSymbolsProvider({
      apiKey: '',
      proxySecret: 'independent-proxy-secret',
      http: {
        get: async function get(url, options) {
          request = { url, options };
          return {
            data: [
              {
                id: 9,
                text: 'apple',
                language: 'eng',
                picto: {
                  id: 10,
                  image_url:
                    'https://globalsymbols.com/uploads/legacy-apple.png'
                }
              }
            ]
          };
        }
      }
    });

    const labels = await provider.searchLabels({
      query: 'apple',
      language: 'eng'
    });

    expect(request.url).to.equal(
      'https://globalsymbols.com/api/v1/labels/search'
    );
    expect(request.options.headers).not.to.have.property('X-Api-Key');
    expect(request.options.params).not.to.have.property('include_preview');
    expect(labels).to.have.length(1);
    expect(labels[0]).not.to.have.property('pictogramAttribution');
    expect(
      await provider.searchRuntimePictograms({
        token: '苹果',
        query: 'apple',
        locale: 'en'
      })
    ).to.deep.equal([]);
  });

  it('rejects untrusted image hosts and unsigned proxy tokens', async function() {
    let requestCount = 0;
    const provider = createGlobalSymbolsProvider({
      apiKey: 'server-only-key',
      proxySecret: 'independent-proxy-secret',
      http: {
        get: async function get() {
          requestCount += 1;
          return {
            data: [
              createV2Label({
                picto: { image_url: 'https://evil.example/apple.svg' }
              })
            ]
          };
        }
      }
    });

    expect(
      await provider.searchLabels({ query: 'apple', language: 'eng' })
    ).to.deep.equal([]);

    let error;
    try {
      await provider.loadImage('not-signed');
    } catch (caught) {
      error = caught;
    }
    expect(error).to.have.property('status', 400);
    expect(requestCount).to.equal(1);
  });
});
