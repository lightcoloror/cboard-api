'use strict';
const { expect } = require('chai');
const { createGlobalSymbolsProvider } = require('../../api/helpers/globalSymbols');
const { createPictogramSearch } = require('../../api/helpers/pictogramSearch');
const symbolset = { id: 7, name: 'Synthetic library', slug: 'synthetic',
  publisher: 'Fixture author', licence: { name: 'CC BY-SA', version: '4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' } };
const label = { id: 8, text: '苹果', language: 'zho', picto: { id: 9, symbolset_id: 7,
  image_url: 'https://globalsymbols.com/uploads/fixture.png' } };
const request = { token: '苹果', query: 'apple', locale: 'en' };
function setup(extra = {}) {
  const calls = [];
  const provider = createGlobalSymbolsProvider({ apiKey: '', proxySecret: 'synthetic-signing-secret', allowLegacyRuntime: true,
    http: { get: async (url, options) => {
      calls.push({ url, options });
      return { data: url.endsWith('/symbolsets') ? [symbolset] : [label] };
    } }, ...extra });
  return { provider, calls };
}
describe('Global Symbols explicit legacy runtime bridge', function() {
  it('fills live v2 metadata for editor and runtime with authenticated deduplicated requests', async function() {
    const h = setup({ apiKey: 'synthetic-v2-key', allowLegacyRuntime: false });
    const [editor, runtime] = await Promise.all([
      h.provider.searchLabels({ query: 'apple', language: 'en', limit: 4 }),
      h.provider.searchRuntimePictograms(request)
    ]);
    expect(editor[0].pictogramAttribution.license).to.equal('CC BY-SA 4.0');
    expect(runtime[0].source.license).to.equal('CC BY-SA 4.0');
    expect(h.calls.filter(x => x.url.endsWith('/symbolsets'))).to.have.length(1);
    expect(h.calls.every(x => x.url.includes('/api/v2/') && x.options.headers['X-Api-Key'] === 'synthetic-v2-key')).to.equal(true);
    expect(label.picto).not.to.have.property('symbolset');
  });
  it('does not fall back to anonymous metadata when v2 metadata rejects authentication', async function() {
    const urls = [];
    const h = setup({ apiKey: 'synthetic-v2-key', http: { get: async url => {
      urls.push(url);
      if (url.endsWith('/symbolsets')) throw Object.assign(new Error('rejected'), { response: { status: 401 } });
      return { data: [label] };
    } } });
    expect(await h.provider.searchRuntimePictograms(request)).to.deep.equal([]);
    expect(await h.provider.searchRuntimePictograms(request)).to.deep.equal([]);
    expect(urls).to.deep.equal(['https://globalsymbols.com/api/v2/labels/search', 'https://globalsymbols.com/api/v2/symbolsets']);
  });
  it('joins source metadata without modifying cached labels, and shares bounded metadata cache', async function() {
    const h = setup();
    const [a, b] = await Promise.all([h.provider.searchRuntimePictograms(request), h.provider.searchRuntimePictograms({ ...request, query: 'pear' })]);
    expect(a[0].source).to.include({ provider: 'globalsymbols', originalId: '9', license: 'CC BY-SA 4.0' });
    expect(b).to.have.length(1);
    expect(a[0].imageUrl).to.match(/^\/pictograms\/globalsymbols\/[A-Za-z0-9_-]+\.[a-f0-9]{32}\/image$/);
    expect(h.calls.filter(x => x.url.endsWith('/symbolsets'))).to.have.length(1);
    expect(h.calls.every(x => !x.options.headers['X-Api-Key'])).to.equal(true);
    expect(label.picto).not.to.have.property('symbolset');
    expect(h.provider.mode).to.equal('legacy-v1');
  });
  it('is disabled without an explicit runtime switch', async function() {
    const h = setup({ allowLegacyRuntime: false });
    expect(await h.provider.searchRuntimePictograms(request)).to.deep.equal([]);
    expect(h.calls).to.have.length(0);
  });
  it('requires server signing configuration even in anonymous mode', async function() {
    const h = setup({ proxySecret: '' });
    expect(await h.provider.searchRuntimePictograms(request)).to.deep.equal([]);
    expect(h.calls).to.have.length(0);
  });
  it('never downgrades a rejected v2 credential to v1', async function() {
    const urls = [];
    const h = setup({ apiKey: 'synthetic-rejected-key', http: { get: async url => {
      urls.push(url); throw Object.assign(new Error('rejected'), { response: { status: 401 } });
    } } });
    expect(await h.provider.searchRuntimePictograms(request)).to.deep.equal([]);
    expect(urls).to.deep.equal(['https://globalsymbols.com/api/v2/labels/search']);
    expect(h.provider.mode).to.equal('v2');
  });
  it('excludes unknown libraries or missing licenses instead of inventing attribution', async function() {
    for (const sets of [[], [{ ...symbolset, id: 999 }], [{ ...symbolset, licence: null }]]) {
      const h = setup({ http: { get: async url => ({ data: url.endsWith('/symbolsets') ? sets : [label] }) } });
      expect(await h.provider.searchRuntimePictograms(request)).to.deep.equal([]);
    }
  });
  it('negative-caches metadata failures and retries after the bounded interval', async function() {
    let time = 0, count = 0;
    const h = setup({ now: () => time, negativeCacheTtlMs: 10, http: { get: async url => {
      if (!url.endsWith('/symbolsets')) return { data: [label] };
      if (++count === 1) throw new Error('offline');
      return { data: [symbolset] };
    } } });
    expect(await h.provider.searchRuntimePictograms(request)).to.deep.equal([]);
    expect(await h.provider.searchRuntimePictograms(request)).to.deep.equal([]);
    expect(count).to.equal(1);
    time = 11;
    expect(await h.provider.searchRuntimePictograms(request)).to.have.length(1);
    expect(count).to.equal(2);
  });
  it('uses the existing search, semantic review and candidate ranking pipeline', async function() {
    const search = createPictogramSearch({ globalSymbolsApiKey: '', globalSymbolsProxySecret: 'synthetic-signing-secret',
      globalSymbolsAllowLegacyRuntime: true, opensymbolsSecret: '', http: { get: async url => ({
        data: url.includes('api.arasaac.org') ? [] : url.endsWith('/symbolsets') ? [symbolset] : [{ ...label, text: '合成词组' }]
      }) } });
    const rows = await search.searchRuntimePictograms(['合成词组']);
    expect(rows).to.have.length(1);
    expect(rows[0].pictogram.source.provider).to.equal('globalsymbols');
    expect(rows[0].pictogram.semantics.requiresReview).to.equal(true);
  });
});
