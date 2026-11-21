'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const {
  loadMulberryPartIndex,
  getMulberryPart,
  loadCleanMulberrySvg,
  searchMulberryParts,
  decomposeConceptToMulberryParts,
  scoreBgeInt8TopK
} = require('../../api/helpers/mulberryPartIndex');

describe('Mulberry symbol part index (Step 1)', function () {
  this.timeout(15000);

  let indexDoc;

  before(function () {
    indexDoc = loadMulberryPartIndex();
  });

  it('indexes all 3436 Mulberry SVGs with CC BY-SA 2.0 attribution and default-board counts', function () {
    expect(indexDoc.license).to.equal('CC BY-SA 2.0');
    expect(indexDoc.parts).to.be.an('array').with.lengthOf(3436);
    expect(indexDoc.stats.totalParts).to.equal(3436);
    expect(indexDoc.stats.inDefaultBoardsCount).to.equal(764);
    expect(indexDoc.stats.dormantUnmountedCount).to.equal(2672);
    expect(indexDoc.stats.trimFallbackCount).to.equal(0);
    expect(indexDoc.stats.dotStRemainingCount).to.equal(0);
    expect(indexDoc.stats.classAttrRemainingCount).to.equal(0);
  });

  it('computes valid tightViewBox bounds across all 3436 parts including non-square SVGs', function () {
    let trimmedCount = 0;
    for (const part of indexDoc.parts) {
      expect(part.tightViewBox).to.be.an('array').with.lengthOf(4);
      const [, , tw, th] = part.tightViewBox;
      expect(Number.isFinite(tw) && tw > 0).to.equal(true);
      expect(Number.isFinite(th) && th > 0).to.equal(true);
      if (part.contentRatio < 0.9) trimmedCount += 1;
    }
    expect(trimmedCount).to.be.greaterThan(2000);

    for (const id of ['add', 'communication_book_portable', 'cushion_2', 'battery_1a', 'glasses']) {
      const part = getMulberryPart(id);
      expect(part).to.not.equal(null);
      expect(part.tightViewBox[2]).to.be.lessThan(part.origViewBox[2]);
      expect(part.tightViewBox[3]).to.be.lessThan(part.origViewBox[3]);
      expect(part.contentRatio).to.be.lessThan(0.85);
    }
  });

  it('decompresses all 3436 clean SVGs with zero .st classes and isolates instancePrefix IDs', function () {
    for (const part of indexDoc.parts) {
      const svg = loadCleanMulberrySvg(part.partId);
      expect(svg).to.be.a('string').and.include('<svg');
      expect(/\.st\d+/.test(svg)).to.equal(false);
      expect(/\bclass="/.test(svg)).to.equal(false);
    }

    for (const file of ['arrest_,_to.svg', 'ask_,_to.svg', 'extra_2.svg']) {
      const part = getMulberryPart(file);
      expect(part).to.not.equal(null);
      const isolated = loadCleanMulberrySvg(file, { instancePrefix: 'slotA' });
      expect(isolated).to.include(`slotA_${part.partId}__`);
      expect(isolated).to.not.include(`mp_${part.partId}__`);
    }

    const extraIsolated = loadCleanMulberrySvg('extra_2.svg', { instancePrefix: 'slotB' });
    expect(extraIsolated).to.include('url(#slotB_extra_2__b)');
    expect(extraIsolated).to.include('href="#slotB_extra_2__a"');
  });

  it('blocks homographs, Crowdin mistranslations, and crowdin_suspect leakage by default', function () {
    const forbiddenAssertions = [
      { query: '眼镜盒', forbiddenFiles: ['box_,_to.svg', 'xylophone.svg'] },
      { query: '盒子', forbiddenFiles: ['box_,_to.svg'] },
      { query: '拼图', forbiddenFiles: ['celery.svg', 'vase.svg'] },
      { query: '杯子', forbiddenFiles: ['cupboard.svg'] },
      { query: '火车', forbiddenFiles: ['mars.svg'] },
      { query: '滑雪', forbiddenFiles: ['skunk.svg'] },
      { query: '锯子', forbiddenFiles: ['paw.svg', 'paw_1.svg', 'sausages.svg', 'sausages_2.svg'] },
      { query: '耳机', forbiddenFiles: ['earrings.svg'] },
      { query: '文件夹', forbiddenFiles: ['file.svg'] },
      { query: '拐杖', forbiddenFiles: ['stick.svg'] },
      { query: '折叠拐杖', forbiddenFiles: ['stick.svg'] }
    ];

    for (const { query, forbiddenFiles } of forbiddenAssertions) {
      const res = searchMulberryParts(query, { limit: 12 });
      const returnedFiles = res.candidates.map(c => c.file);
      for (const badFile of forbiddenFiles) {
        expect(returnedFiles, `${query} must not return ${badFile}`).to.not.include(badFile);
      }
      for (const cand of res.candidates) {
        expect(cand.trustTier).to.not.equal('crowdin_suspect');
        expect(cand.autoComposeAllowed).to.equal(true);
      }
    }

    expect(searchMulberryParts('奶油').candidates.map(c => c.file)).to.include('cream.svg');
    expect(searchMulberryParts('耳机').candidates[0].file).to.equal('headphones.svg');
    expect(searchMulberryParts('文件夹').candidates[0].file).to.equal('arch_lever_file.svg');
    expect(searchMulberryParts('拐杖').candidates.map(c => c.file)).to.include('walking_stick.svg');

    // Suspect untranslated entries stay gated unless allowSuspect: true
    expect(searchMulberryParts('beansprouts').candidates).to.have.lengthOf(0);
    const audited = searchMulberryParts('beansprouts', { allowSuspect: true });
    expect(audited.candidates.map(c => c.file)).to.include('beansprouts.svg');
    expect(audited.candidates[0].trustTier).to.equal('crowdin_suspect');
  });

  it('recalls and decomposes 2026-11-13 missing AAC concepts accurately', function () {
    const aidBattery = decomposeConceptToMulberryParts('助听器电池');
    expect(aidBattery.recommendedTier).to.equal('compose_ready');
    expect(aidBattery.matchedParts.map(p => p.partId)).to.include.members(['hearing_aid_1', 'battery_1a']);

    const cushion = decomposeConceptToMulberryParts('轮椅坐垫');
    expect(cushion.recommendedTier).to.equal('compose_ready');
    expect(cushion.matchedParts.map(p => p.partId)).to.include.members(['wheelchair', 'cushion_2']);

    const glassesCase = decomposeConceptToMulberryParts('眼镜盒');
    expect(glassesCase.recommendedTier).to.equal('compose_with_modifier');
    expect(glassesCase.matchedParts.map(p => p.partId)).to.include('glasses');
    expect(glassesCase.matchedParts.map(p => p.file)).to.not.include('box_,_to.svg');

    const umbrella = decomposeConceptToMulberryParts('打伞');
    expect(umbrella.recommendedTier).to.equal('compose_with_modifier');
    expect(umbrella.matchedParts.map(p => p.partId)).to.include('umbrella');

    const glucoseStrip = decomposeConceptToMulberryParts('血糖试纸');
    expect(glucoseStrip.recommendedTier).to.equal('regen_from_ref');
    expect(glucoseStrip.unmatchedSpans.join('')).to.include('试纸');
  });

  it('scores full 3436 int8 BGE embeddings under 20ms with accurate ranking and exclusions', function () {
    const metaPath = path.resolve(__dirname, '../../api/data/mulberrySymbolPartBgeMeta.json');
    const binPath = path.resolve(__dirname, '../../api/data/mulberrySymbolPartBgeInt8.bin');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const bin = fs.readFileSync(binPath);

    expect(meta.count).to.equal(3436);
    expect(meta.dim).to.equal(512);
    expect(bin.length).to.equal(3436 * 512);

    const rowIdx = meta.partIds.indexOf('cushion_2');
    expect(rowIdx).to.be.at.least(0);
    const probeVec = new Float32Array(512);
    const offset = rowIdx * 512;
    for (let d = 0; d < 512; d += 1) {
      probeVec[d] = bin.readInt8(offset + d) * meta.scales[rowIdx];
    }

    const t0 = performance.now();
    const topK = scoreBgeInt8TopK(probeVec, { limit: 5 });
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).to.be.lessThan(20);
    expect(topK).to.have.lengthOf(5);
    expect(topK[0].partId).to.equal('cushion_2');
    expect(topK[0].cosine).to.be.greaterThan(0.98);

    // Hybrid search with queryVector
    const hybrid = searchMulberryParts('坐垫', { queryVector: probeVec, limit: 5 });
    expect(hybrid.candidates[0].partId).to.equal('cushion_2');
    expect(hybrid.candidates[0].bgeCosine).to.be.greaterThan(0.98);

    // Respects box_,_to exclusion on container query even in BGE mode
    const boxRow = meta.partIds.indexOf('box___to') >= 0
      ? meta.partIds.indexOf('box___to')
      : meta.partIds.indexOf('box_to');
    expect(boxRow).to.be.at.least(0);
    const boxVec = new Float32Array(512);
    for (let d = 0; d < 512; d += 1) {
      boxVec[d] = bin.readInt8(boxRow * 512 + d) * meta.scales[boxRow];
    }
    const filteredBox = scoreBgeInt8TopK(boxVec, { limit: 5, excludeQuery: '眼镜盒' });
    expect(filteredBox.map(x => x.file)).to.not.include('box_,_to.svg');
  });
});
