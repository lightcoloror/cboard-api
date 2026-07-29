'use strict';

const chai = require('chai');
const sharp = require('sharp');
const {
  MAX_PICTOGRAM_CANDIDATES_PER_TOKEN,
  MAX_QUERY_TOKENS,
  createPictogramSearch,
  normalizeTokens
} = require('../../api/helpers/pictogramSearch');
const { getReviewedArasaacIds } = require('../../api/helpers/pictogramLexicon');
const reviewedArasaac = require('../../api/data/picinterpreterReviewedArasaac.json');

const expect = chai.expect;

describe('Pictogram search helper', function() {
  it('keeps the reviewed PicInterpreter index bounded and traceable', function() {
    const concepts = Object.keys(reviewedArasaac.concepts);

    expect(reviewedArasaac.schemaVersion).to.equal(1);
    expect(reviewedArasaac.caseCount).to.equal(41);
    expect(reviewedArasaac.sourceSha256).to.match(/^[A-F0-9]{64}$/);
    expect(concepts).to.have.length(138);
    expect(Object.keys(reviewedArasaac.aliases)).to.have.length(21);
    Object.entries(reviewedArasaac.aliases).forEach(([alias, concept]) => {
      expect(alias.trim()).to.equal(alias);
      expect(concepts).to.include(concept);
      expect(getReviewedArasaacIds(alias)).to.deep.equal(
        reviewedArasaac.concepts[concept]
      );
    });
    concepts.forEach(concept => {
      expect(concept.trim()).to.equal(concept);
      expect(reviewedArasaac.concepts[concept]).to.have.length.within(1, 4);
      reviewedArasaac.concepts[concept].forEach(id => {
        expect(id).to.be.a('number');
        expect(Number.isInteger(id) && id > 0).to.equal(true);
      });
    });
  });

  it('loads only exact caregiver-reviewed PicInterpreter concepts', function() {
    expect(getReviewedArasaacIds('现在')).to.deep.equal([13026, 25736]);
    expect(getReviewedArasaacIds('打电话')).to.deep.equal([4691, 36305]);
    expect(getReviewedArasaacIds('然后')).to.deep.equal([13080]);
    expect(getReviewedArasaacIds('一点')).to.deep.equal([7209]);
    expect(getReviewedArasaacIds('慢慢')).to.deep.equal([4676]);
    expect(getReviewedArasaacIds('受伤了')).to.deep.equal([]);
    expect(getReviewedArasaacIds('抬')).to.deep.equal([]);
    expect(getReviewedArasaacIds('叫')).to.deep.equal([]);
    expect(getReviewedArasaacIds('体温')).to.deep.equal([]);
    expect(getReviewedArasaacIds('呼吸困难')).to.deep.equal([]);
    expect(getReviewedArasaacIds('按铃')).to.deep.equal([]);
    expect(getReviewedArasaacIds(' 不存在词 ')).to.deep.equal([]);
  });

  it('prioritizes a reviewed ARASAAC id ahead of live provider results', async function() {
    let requestCount = 0;
    const search = createPictogramSearch({
      http: {
        get: async function get() {
          requestCount += 1;
          return {
            data: [{ _id: 999 }, { _id: 2248 }, { _id: 888 }, { _id: 777 }]
          };
        }
      }
    });

    const results = await search.searchRuntimePictograms(['水']);

    expect(requestCount).to.equal(1);
    expect(
      results.map(result => result.pictogram.source.originalId)
    ).to.deep.equal(['2248', '999', '888', '777']);
  });

  it('returns a reviewed candidate when the live ARASAAC query fails', async function() {
    let requestCount = 0;
    const search = createPictogramSearch({
      http: {
        get: async function get() {
          requestCount += 1;
          throw new Error('offline');
        }
      }
    });

    const results = await search.searchRuntimePictograms(['测体温']);

    expect(requestCount).to.equal(1);
    expect(results).to.have.length(1);
    expect(results[0].pictogram.source.originalId).to.equal('36852');
    expect(results[0].pictogram.source.license).to.equal('CC BY-NC-SA 4.0');
  });

  it('normalizes, de-duplicates and bounds public search input', function() {
    const tokens = [' 苹果 ', '苹果', '。', 3, 'a'.repeat(25)];
    for (let index = 0; index < 20; index += 1) {
      tokens.push(`词${index}`);
    }

    const normalized = normalizeTokens(tokens);
    expect(normalized[0]).to.equal('苹果');
    expect(normalized).to.have.length(MAX_QUERY_TOKENS);
    expect(normalized).not.to.include('。');
  });

  it('falls back to a verified English ARASAAC query', async function() {
    const urls = [];
    const search = createPictogramSearch({
      http: {
        get: async function get(url) {
          urls.push(url);
          if (url.includes('/zh/')) return { data: [] };
          if (url.includes('/en/bestsearch/banana')) {
            return { data: [{ _id: 123 }] };
          }
          return { data: [] };
        }
      }
    });

    const results = await search.searchRuntimePictograms(['香蕉']);
    expect(results).to.have.length(1);
    expect(urls).to.deep.equal([
      'https://api.arasaac.org/v1/pictograms/zh/bestsearch/%E9%A6%99%E8%95%89',
      'https://api.arasaac.org/v1/pictograms/zh/search/%E9%A6%99%E8%95%89',
      'https://api.arasaac.org/v1/pictograms/en/bestsearch/banana'
    ]);
    expect(results[0].pictogram.imageUrl).to.equal(
      '/pictograms/arasaac/123/image'
    );
    expect(results[0].pictogram.source.provider).to.equal('arasaac');
  });

  it('reuses reviewed PicInterpreter spoken aliases for English fallback', async function() {
    const urls = [];
    const search = createPictogramSearch({
      http: {
        get: async function get(url) {
          urls.push(url);
          if (url.includes('/zh/')) return { data: [] };
          if (url.includes('/en/bestsearch/')) {
            return { data: [{ _id: urls.length }] };
          }
          return { data: [] };
        }
      }
    });

    const results = await search.searchRuntimePictograms([
      '体温高',
      '看个电视'
    ]);

    expect(results.map(result => result.token)).to.deep.equal([
      '体温高',
      '看个电视'
    ]);
    expect(urls.some(url => url.includes('/en/bestsearch/fever'))).to.equal(
      true
    );
    expect(
      urls.some(url => url.includes('/en/bestsearch/watch%20tv'))
    ).to.equal(true);
  });

  it('reuses verified PicInterpreter utensil terms without guessing ambiguous labels', async function() {
    const urls = [];
    const search = createPictogramSearch({
      http: {
        get: async function get(url) {
          urls.push(url);
          if (url.includes('/zh/')) return { data: [] };
          return { data: [{ _id: urls.length }] };
        }
      }
    });

    const results = await search.searchRuntimePictograms([
      '勺',
      '勺子',
      '叉子',
      '碗',
      '刀具'
    ]);

    expect(results.map(result => result.token)).to.deep.equal([
      '勺',
      '勺子',
      '叉子',
      '碗'
    ]);
    expect(urls.some(url => url.includes('/en/bestsearch/spoon'))).to.equal(
      true
    );
    expect(urls.some(url => url.includes('/en/bestsearch/fork'))).to.equal(
      true
    );
    expect(urls.some(url => url.includes('/en/bestsearch/bowl'))).to.equal(
      true
    );
    expect(
      urls.some(url => url.includes('/en/') && url.endsWith('/razor'))
    ).to.equal(false);
  });

  it('falls back to broad ARASAAC search when ranked search is empty', async function() {
    const urls = [];
    const search = createPictogramSearch({
      http: {
        get: async function get(url) {
          urls.push(url);
          return url.includes('/bestsearch/')
            ? { data: [] }
            : { data: [{ _id: 456 }] };
        }
      }
    });

    const results = await search.searchRuntimePictograms(['香蕉']);

    expect(results).to.have.length(1);
    expect(urls).to.deep.equal([
      'https://api.arasaac.org/v1/pictograms/zh/bestsearch/%E9%A6%99%E8%95%89',
      'https://api.arasaac.org/v1/pictograms/zh/search/%E9%A6%99%E8%95%89'
    ]);
    expect(results[0].pictogram.source.originalId).to.equal('456');
  });

  it('uses attributed Global Symbols v2 results after ARASAAC misses', async function() {
    const urls = [];
    const search = createPictogramSearch({
      globalSymbolsApiKey: 'server-only-key',
      globalSymbolsProxySecret: 'independent-proxy-secret',
      http: {
        get: async function get(url, options) {
          urls.push(url);
          if (url.includes('api.arasaac.org')) return { data: [] };
          if (url.endsWith('/api/v2/labels/search')) {
            expect(options.headers['X-Api-Key']).to.equal('server-only-key');
            return {
              data: [
                {
                  id: 42,
                  text: '杯子',
                  language: 'zho',
                  picto: {
                    id: 314,
                    symbolset_id: 7,
                    image_url: 'https://globalsymbols.com/uploads/cup.svg',
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
                    }
                  }
                }
              ]
            };
          }
          throw new Error(`Unexpected URL: ${url}`);
        }
      }
    });

    const results = await search.searchRuntimePictograms(['不存在词']);

    expect(results).to.have.length(1);
    expect(results[0].pictogram.source).to.include({
      provider: 'globalsymbols',
      originalId: '314',
      license: 'CC BY-SA 4.0',
      repoKey: 'mulberry'
    });
    expect(results[0].pictogram.imageUrl).to.match(
      /^\/pictograms\/globalsymbols\/[A-Za-z0-9_-]+\.[a-f0-9]{32}\/image$/
    );
    expect(urls.some(url => url.endsWith('/api/v2/labels/search'))).to.equal(
      true
    );
  });

  it('returns a bounded de-duplicated ARASAAC candidate list in provider order', async function() {
    const search = createPictogramSearch({
      http: {
        get: async function get() {
          return {
            data: [
              { _id: 101 },
              { _id: 102 },
              { _id: 101 },
              { _id: 103 },
              { _id: 104 },
              { _id: 105 },
              { _id: 'invalid' }
            ]
          };
        }
      }
    });

    const results = await search.searchRuntimePictograms(['未审核词']);

    expect(results).to.have.length(MAX_PICTOGRAM_CANDIDATES_PER_TOKEN);
    expect(
      results.map(result => result.pictogram.source.originalId)
    ).to.deep.equal(['101', '102', '103', '104']);
    expect(results.every(result => result.token === '未审核词')).to.equal(true);
  });

  it('reuses a bounded positive result cache across requests', async function() {
    let requestCount = 0;
    const search = createPictogramSearch({
      maxSearchCacheEntries: 1,
      http: {
        get: async function get() {
          requestCount += 1;
          return { data: [{ _id: requestCount }] };
        }
      }
    });

    const first = await search.searchRuntimePictograms(['未审核词']);
    const second = await search.searchRuntimePictograms(['未审核词']);
    await search.searchRuntimePictograms(['另一个未审核词']);
    const afterEviction = await search.searchRuntimePictograms(['未审核词']);

    expect(first[0].pictogram.source.originalId).to.equal('1');
    expect(second[0].pictogram.source.originalId).to.equal('1');
    expect(afterEviction[0].pictogram.source.originalId).to.equal('3');
    expect(requestCount).to.equal(3);
  });

  it('coalesces concurrent searches for the same token', async function() {
    let requestCount = 0;
    const search = createPictogramSearch({
      http: {
        get: async function get() {
          requestCount += 1;
          await new Promise(resolve => setImmediate(resolve));
          return { data: [{ _id: 123 }] };
        }
      }
    });

    const [first, second] = await Promise.all([
      search.searchRuntimePictograms(['苹果']),
      search.searchRuntimePictograms(['苹果'])
    ]);

    expect(first).to.deep.equal(second);
    expect(requestCount).to.equal(1);
  });

  it('expires a negative result without retaining it indefinitely', async function() {
    let currentTime = 100;
    let requestCount = 0;
    const search = createPictogramSearch({
      now: () => currentTime,
      negativeCacheTtlMs: 10,
      http: {
        get: async function get() {
          requestCount += 1;
          return { data: [] };
        }
      }
    });

    await search.searchRuntimePictograms(['不存在词']);
    currentTime = 109;
    await search.searchRuntimePictograms(['不存在词']);
    currentTime = 110;
    await search.searchRuntimePictograms(['不存在词']);

    expect(requestCount).to.equal(4);
  });

  it('falls back to an allowed OpenSymbols repository with complete attribution', async function() {
    const gets = [];
    const posts = [];
    const remoteImage =
      'https://d123.cloudfront.net/libraries/mulberry/apple.svg';
    const search = createPictogramSearch({
      opensymbolsSecret: 'server-only-secret',
      http: {
        post: async function post(url, body, options) {
          posts.push({ url, body, options });
          return { data: { access_token: 'short-lived-token' } };
        },
        get: async function get(url, options) {
          gets.push({ url, options });
          if (url.includes('api.arasaac.org')) return { data: [] };
          if (url.endsWith('/api/v2/symbols')) {
            return {
              data: [
                {
                  id: 1,
                  symbol_key: 'mixed-license-result',
                  repo_key: 'noun-project',
                  license: 'mixed',
                  image_url:
                    'https://d123.cloudfront.net/libraries/noun/mixed.svg'
                },
                {
                  id: 2,
                  symbol_key: 'apple-symbol',
                  name: 'apple',
                  repo_key: 'mulberry',
                  license: 'CC BY-SA 2.0 UK',
                  license_url:
                    'https://creativecommons.org/licenses/by-sa/2.0/uk/',
                  author: 'Paxtoncrafts Charitable Trust',
                  author_url: 'https://mulberrysymbols.org/',
                  details_url: '/symbols/mulberry/apple-symbol?id=2',
                  image_url: remoteImage
                }
              ]
            };
          }
          if (url === remoteImage) {
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

    const results = await search.searchRuntimePictograms(['香蕉']);
    expect(results).to.have.length(1);
    expect(posts).to.have.length(1);
    expect(posts[0].options.params).to.deep.equal({
      secret: 'server-only-secret'
    });
    const openSymbolsRequest = gets.find(item =>
      item.url.endsWith('/api/v2/symbols')
    );
    expect(openSymbolsRequest.options.headers.Authorization).to.equal(
      'Bearer short-lived-token'
    );
    expect(results[0].pictogram.source).to.include({
      provider: 'opensymbols',
      repoKey: 'mulberry',
      license: 'CC BY-SA 2.0 UK',
      author: 'Paxtoncrafts Charitable Trust'
    });
    expect(results[0].pictogram.imageUrl).to.match(
      /^\/pictograms\/opensymbols\/[A-Za-z0-9_-]+\.[a-f0-9]{32}\/image$/
    );
    expect(JSON.stringify(results)).not.to.include('server-only-secret');
    expect(JSON.stringify(results)).not.to.include('short-lived-token');

    const proxyToken = results[0].pictogram.imageUrl.split('/')[3];
    const image = await search.loadOpenSymbolsImage(proxyToken);
    expect(image.contentType).to.equal('image/png');
    expect(image.buffer.subarray(0, 8)).to.deep.equal(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    const metadata = await sharp(image.buffer).metadata();
    expect(metadata).to.include({ format: 'png', width: 300, height: 200 });
  });

  it('coalesces OpenSymbols token exchange across different tokens', async function() {
    let tokenRequestCount = 0;
    const search = createPictogramSearch({
      opensymbolsSecret: 'server-only-secret',
      http: {
        post: async function post() {
          tokenRequestCount += 1;
          await new Promise(resolve => setImmediate(resolve));
          return { data: { access_token: 'shared-token' } };
        },
        get: async function get(url, options) {
          if (url.includes('api.arasaac.org')) return { data: [] };
          if (url.endsWith('/api/v2/symbols')) {
            const name = options.params.q;
            return {
              data: [
                {
                  symbol_key: name,
                  repo_key: 'mulberry',
                  license: 'CC BY-SA 2.0 UK',
                  image_url: `https://d123.cloudfront.net/${encodeURIComponent(
                    name
                  )}.svg`
                }
              ]
            };
          }
          throw new Error(`Unexpected URL: ${url}`);
        }
      }
    });

    const [apple, water] = await Promise.all([
      search.searchRuntimePictograms(['苹果']),
      search.searchRuntimePictograms(['喝水'])
    ]);

    expect(apple).to.have.length(1);
    expect(water).to.have.length(1);
    expect(tokenRequestCount).to.equal(1);
  });

  it('coalesces concurrent OpenSymbols token refresh after 401', async function() {
    let tokenRequestCount = 0;
    const search = createPictogramSearch({
      opensymbolsSecret: 'server-only-secret',
      http: {
        post: async function post() {
          tokenRequestCount += 1;
          await new Promise(resolve => setImmediate(resolve));
          return {
            data: {
              access_token:
                tokenRequestCount === 1 ? 'expired-token' : 'fresh-token'
            }
          };
        },
        get: async function get(url, options) {
          if (url.includes('api.arasaac.org')) return { data: [] };
          if (url.endsWith('/api/v2/symbols')) {
            if (options.headers.Authorization === 'Bearer expired-token') {
              const error = new Error('expired');
              error.response = { status: 401 };
              throw error;
            }
            const name = options.params.q;
            return {
              data: [
                {
                  symbol_key: name,
                  repo_key: 'mulberry',
                  license: 'CC BY-SA 2.0 UK',
                  image_url: `https://d123.cloudfront.net/${encodeURIComponent(
                    name
                  )}.svg`
                }
              ]
            };
          }
          throw new Error(`Unexpected URL: ${url}`);
        }
      }
    });

    const results = await Promise.all([
      search.searchRuntimePictograms(['苹果']),
      search.searchRuntimePictograms(['喝水'])
    ]);

    expect(results[0]).to.have.length(1);
    expect(results[1]).to.have.length(1);
    expect(tokenRequestCount).to.equal(2);
  });

  it('rejects an unsigned OpenSymbols image before making a request', async function() {
    let called = false;
    const search = createPictogramSearch({
      opensymbolsSecret: 'server-only-secret',
      http: {
        get: async function get() {
          called = true;
          return { data: Buffer.from('image') };
        }
      }
    });

    let error;
    try {
      await search.loadOpenSymbolsImage('not-signed');
    } catch (caught) {
      error = caught;
    }

    expect(error).to.have.property('status', 400);
    expect(called).to.equal(false);
  });

  it('rejects an unsafe image proxy id before making a request', async function() {
    let called = false;
    const search = createPictogramSearch({
      http: {
        get: async function get() {
          called = true;
          return { data: Buffer.from('image') };
        }
      }
    });

    let error;
    try {
      await search.loadArasaacImage('https://example.com/file');
    } catch (caught) {
      error = caught;
    }

    expect(error).to.have.property('status', 400);
    expect(called).to.equal(false);
  });
});
