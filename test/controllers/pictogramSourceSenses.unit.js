'use strict';
const {expect}=require('chai');
const fixture=require('../fixtures/pictogram-source-senses-20261015.json');
const {createPictogramSearch}=require('../../api/helpers/pictogramSearch');
const {getEnglishFallback}=require('../../api/helpers/pictogramLexicon');
const {buildPictogramSemantics,rankPictogramCandidates}=require('../../api/helpers/pictogramSemantics');

describe('source-label translation errors and compound concepts',function(){
  it('uses precise queries, filters bad Chinese hits before fallback and caches the valid candidate',async function(){
    const calls=[];
    const search=createPictogramSearch({opensymbolsSecret:'synthetic-test-secret',globalSymbolsApiKey:'',
      http:{post:async()=>({data:{access_token:'synthetic-token'}}),get:async(url,options)=>{
        if(!url.includes('opensymbols.org'))return {data:[]};
        const {q,locale}=options.params;calls.push([q,locale]);
        return {data:fixture.queries.find(row=>row.query===q&&row.locale===locale)?.items||[]};
      }}});
    expect(getEnglishFallback('开心果')).to.equal('pistachio');
    expect(getEnglishFallback('洗手液')).to.equal('liquid soap');
    const nuts=await search.searchRuntimePictograms(['开心果']);
    expect(nuts.map(x=>x.pictogram.source.originalId)).to.deep.equal(['pistachios-008bbe2f']);
    const soap=await search.searchRuntimePictograms(['洗手液']);
    expect(soap.map(x=>x.pictogram.source.originalId)).to.deep.equal(['liquid-soap-cdc5bfc6']);
    expect(calls).to.deep.equal([['开心果','zh'],['洗手液','zh'],['liquid soap','en']]);
    expect(soap[0].pictogram.label).to.equal('liquid soap');
    expect(soap[0].pictogram.labels.zh).to.deep.equal([]);
    expect(soap[0].pictogram.semantics).to.include({queryText:'洗手液',lookupText:'liquid soap',conceptId:'aac:liquid-soap',requiresReview:true});
    expect(await search.searchRuntimePictograms(['洗手液'])).to.deep.equal(soap);
    expect(calls.length).to.equal(3);
  });
  for(const id of ['hand-soaps-eeb0ba8b','hand-soap-687a2868','hand-soap-1-9020b7a6']) {
    it(`keeps the raw Chinese label but rejects visually audited bar soap ${id}`,function(){
      const semantics=buildPictogramSemantics({token:'洗手液',locale:'zh',provider:'opensymbols',originalId:id,sourceLabels:['洗手液']});
      expect(semantics.sourceLabels).to.deep.equal(['洗手液']);
      expect(semantics).to.include({relation:'conflict',conceptId:'aac:bar-soap'});
      expect(rankPictogramCandidates('洗手液',[{id,image:'/synthetic.png',semantics,source:{provider:'opensymbols',originalId:id}}])).to.deep.equal([]);
    });
  }
  it('does not let a shower-gel source with an extra liquid-soap label block fallback',async function(){
    const search=createPictogramSearch({opensymbolsSecret:'synthetic-test-secret',globalSymbolsApiKey:'',
      http:{post:async()=>({data:{access_token:'synthetic-token'}}),get:async(url,options)=>{
        if(url.includes('api.arasaac.org'))return {data:[{_id:3335,keywords:[{keyword:'shower gel'},{keyword:'liquid soap'}]}]};
        const {q,locale}=options.params;
        return {data:fixture.queries.find(row=>row.query===q&&row.locale===locale)?.items||[]};
      }}});
    const result=await search.searchRuntimePictograms(['洗手液']);
    expect(result.map(x=>x.pictogram.source.originalId)).to.deep.equal(['liquid-soap-cdc5bfc6']);
  });
});
