'use strict';
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { createPictogramSearch } = require('../../api/helpers/pictogramSearch');
const {getEnglishFallback} = require('../../api/helpers/pictogramLexicon');
const { buildArasaacSemanticFields } = require('../../api/helpers/pictogramSemantics');

describe('Pictogram semantic provenance', function() {
  it('reuses the untimed dining scene, rejects timed dinners and caches the result', async function() {
    let calls=0;
    const search=createPictogramSearch({opensymbolsSecret:'',globalSymbolsApiKey:'',http:{get:async url=>{
      calls++;
      return {data:url.endsWith('/dine')?[4593,6970,28675,38057].map(_id=>({_id,keywords:[{keyword:'dine'},{keyword:'dinner'}]})):[]};
    }}});
    const rows=await search.searchRuntimePictograms(['吃饭']);
    expect(rows.map(r=>r.pictogram.source.originalId)).to.deep.equal(['38057']);
    expect(rows[0].pictogram.semantics.requiresReview).to.equal(true);
    const count=calls;
    expect(await search.searchRuntimePictograms(['吃饭'])).to.deep.equal(rows);
    expect(calls).to.equal(count);
  });
  it('a partial night candidate does not block a later exact tonight candidate', async function() {
    let laterCalls=0;
    const search=createPictogramSearch({opensymbolsSecret:'',globalSymbolsApiKey:'synthetic-key',
      globalSymbolsProxySecret:'synthetic-proxy-secret',http:{get:async url=>{
        if(url.includes('api.arasaac.org')) return {data:url.endsWith('/night')?[{_id:7181,keywords:[{keyword:'night'}]}]:[]};
        laterCalls++;
        return {data:[{id:1,text:'tonight',language:'eng',picto:{id:123,symbolset_id:7,
          image_url:'https://globalsymbols.com/uploads/tonight.svg',
          symbolset:{name:'Mulberry',slug:'mulberry',licence:{name:'CC BY-SA',version:'4.0',url:'https://creativecommons.org/licenses/by-sa/4.0/'}}}}]};
      }}});
    const rows=await search.searchRuntimePictograms(['今晚']);
    expect(laterCalls).to.be.greaterThan(0);
    expect(rows.map(r=>r.pictogram.source.originalId)).to.deep.equal(['123','7181']);
    expect(rows.every(r=>r.pictogram.semantics.requiresReview)).to.equal(true);
  });
  it('ranks everyday help ahead of medical and rescue before caching', async function() {
    const items=[
      {_id:9046,keywords:[{keyword:'rescue'},{keyword:'help'}],categories:['swimming pool']},
      {_id:10141,keywords:[{keyword:'help'},{keyword:'assist'}],categories:['medical procedure']},
      {_id:4570,keywords:[{keyword:'help'},{keyword:'cooperate'}],categories:['usual verbs']}
    ];
    let calls=0;
    const search=createPictogramSearch({opensymbolsSecret:'',globalSymbolsApiKey:'',
      http:{get:async()=>{calls++;return {data:items};}}});
    const result=await search.searchRuntimePictograms(['请帮忙']);
    expect(result.map(r=>r.pictogram.source.originalId)).to.deep.equal(['4570','10141','9046']);
    expect(result.every(r=>r.pictogram.semantics.requiresReview)).to.equal(true);
    const firstCalls=calls;
    expect(await search.searchRuntimePictograms(['请帮忙'])).to.deep.equal(result);
    expect(calls).to.equal(firstCalls);
  });
  it('ranks all eligible results before taking four, retaining the late audited action', async function() {
    const items = [1,2,3,4].map(_id=>({_id,keywords:[{keyword:'go home'}]}));
    items.push({_id:29714,keywords:[{keyword:'come back'}]});
    const search = createPictogramSearch({opensymbolsSecret:'',globalSymbolsApiKey:'',
      http:{get:async()=>({data:items})}});
    const results = await search.searchRuntimePictograms(['回家']);
    expect(results.map(row=>row.pictogram.source.originalId)).to.deep.equal(['29714','1','2','3']);
    expect(results[0].pictogram.semantics.requiresReview).to.equal(true);
  });
  it('expands home retrieval by audited image meaning, ranks and caches both choices', async function() {
    const urls=[];
    const search=createPictogramSearch({opensymbolsSecret:'',globalSymbolsApiKey:'',http:{get:async url=>{
      urls.push(url);
      const query=decodeURIComponent(url.split('/').pop());
      if(query==='come back') return {data:[{_id:999,keywords:[{keyword:'come back'}]}, {_id:29714,keywords:[{keyword:'return'},{keyword:'come back'}]}]};
      if(query==='arrive') return {data:[{_id:16807,keywords:[{keyword:'arrive'}]}, {_id:16805,keywords:[{keyword:'arrive'}]}]};
      return {data:[]};
    }}});
    const result=await search.searchRuntimePictograms(['回家']);
    expect(result.map(r=>r.pictogram.source.originalId)).to.deep.equal(['29714','16805']);
    expect(result.map(r=>r.pictogram.semantics.candidateMatch)).to.deep.equal(['strong','approximate']);
    expect(result.map(r=>r.pictogram.label)).to.deep.equal(['return','arrive']);
    result.forEach(r=>expect(r.pictogram.semantics.requiresReview).to.equal(true));
    const count=urls.length;
    expect(await search.searchRuntimePictograms(['回家'])).to.deep.equal(result);
    expect(urls.length).to.equal(count);
    expect(await search.searchRuntimePictograms(['离家','家'])).to.deep.equal([]);
  });
  it('qualifies polysemous fallback queries without dropping the source phrase', function() {
    expect(getEnglishFallback('公园')).to.equal('public park');
    expect(getEnglishFallback('停车')).to.equal('park a car');
    expect(getEnglishFallback('停车场')).to.equal('parking lot');
    expect(getEnglishFallback('呼吸困难')).to.equal('difficulty breathing');
    expect(getEnglishFallback('哥哥')).to.equal('older brother');
    expect(getEnglishFallback('回家')).to.equal('go home');
    expect(getEnglishFallback('有')).to.equal('have');
    expect(getEnglishFallback('吃药')).to.equal('take medicines');
    expect(getEnglishFallback('服药')).to.equal('take medicines');
  });
  it('retains wrong-sense provenance but excludes it from search and cache results', async function() {
    let calls=0;
    const search=createPictogramSearch({http:{get:async()=>{
      calls++; return {data:[{_id:999999,keywords:[{keyword:'停车场',meaning:'停放车辆的地点'}],categories:['transport']}]};
    }}});
    const first=await search.searchRuntimePictograms(['公园']);
    const second=await search.searchRuntimePictograms(['公园']);
    expect(first.some(item=>item.pictogram.source.originalId==='999999')).to.equal(false);
    const wrong=buildArasaacSemanticFields('公园','公园','zh',999999,
      {keywords:[{keyword:'停车场',meaning:'停放车辆的地点'}],categories:['transport']});
    expect(wrong.labels.zh).to.deep.equal(['停车场']);
    expect(wrong.semantics).to.include({queryText:'公园',relation:'conflict',requiresReview:true});
    expect(wrong.semantics.sourceDefinitions).to.deep.equal(['停放车辆的地点']);
    expect(wrong.semantics.sourceCategories).to.deep.equal(['transport']);
    expect(second).to.deep.equal(first);
    expect(calls).to.equal(4);
  });
  it('does not turn an English fallback string into verified source metadata', async function() {
    const search=createPictogramSearch({http:{get:async url=>({data:url.includes('/zh/')?[]:[{_id:999999}]})}});
    const result=await search.searchRuntimePictograms(['停车场']);
    expect(result).to.deep.equal([]);
    const unknown=buildArasaacSemanticFields('停车场','parking lot','en',999999);
    expect(unknown.labels).to.deep.equal({zh:[],en:[]});
    expect(unknown.label).to.equal('图片 #999999');
    expect(unknown.semantics.sourceLabels).to.deep.equal([]);
    expect(unknown.semantics.lookupText).to.equal('parking lot');
  });
  it('skips unrelated top hits and continues the existing fallback before limiting results', async function() {
    const requests=[];
    const search=createPictogramSearch({http:{get:async url=>{
      requests.push(url);
      const unrelated=['New Year\'s Eve','interview','cream','body cream'].map((keyword,i)=>({_id:90000+i,keywords:[{keyword}]}));
      return {data: url.includes('/en/search/')
        ? [...unrelated,{_id:999999,keywords:[{keyword:'go home'}]}] : unrelated};
    }}});
    const result=await search.searchRuntimePictograms(['回家']);
    expect(result.map(item=>item.pictogram.source.originalId)).to.deep.equal(['999999']);
    expect(result[0].pictogram.semantics.requiresReview).to.equal(true);
    expect(requests).to.have.length(4);
  });
  it('uses the same reviewed concept index as the shared client core', function() {
    const core=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../cboard/src/common/communicationSupport/picinterpreterReviewedArasaac.json'),'utf8'));
    expect(require('../../api/data/picinterpreterReviewedArasaac.json')).to.deep.equal(core);
  });
  it('retrieves a whole oral-medication action without accepting medicine objects or auto-adopting it', async function() {
    const search = createPictogramSearch({opensymbolsSecret:'',globalSymbolsApiKey:'',http:{get:async url=>({data: url.includes('/en/') ? [
      {_id:2855,keywords:[{keyword:'pills'}]},
      {_id:30117,keywords:[{keyword:'oral medication'},{keyword:'take medicines'}]},
      {_id:31969,keywords:[{keyword:'intramuscular medication'}]}
    ] : []})}});
    const results = await search.searchRuntimePictograms(['吃药','服药']);
    expect(results).to.have.length(2);
    results.forEach(({pictogram})=>{
      expect(pictogram.source.originalId).to.equal('30117');
      expect(pictogram.semantics.requiresReview).to.equal(true);
      expect(pictogram.semantics.lookupText).to.equal('take medicines');
      expect(pictogram.label).to.equal('oral medication');
    });
  });
});
