'use strict';
const { expect } = require('chai');
const { createPictogramSearch } = require('../../api/helpers/pictogramSearch');
const item = (_id, labels, categories = []) => ({ _id, keywords: labels.map(keyword => ({ keyword })), categories });
describe('Context candidate repairs through the existing search and cache', function() {
  for (const scenario of [
    { token:'停车场', items:[item(5379,['放置车辆','停车场']),item(6283,['停车场']),item(24755,['停车场'])], ids:['6283','24755'] },
    { token:'请帮忙', items:[item(25620,['help']),item(998,['help','welfare benefits']),item(9046,['help','rescue']),item(4570,['help','aid']),item(12252,['help','support'])], ids:['4570','12252','9046'] },
    { token:'刹车', items:[item(37920,['刹车'])], ids:['37920'] }
  ]) it(`filters and ranks ${scenario.token} before response/cache`, async function() {
    let calls=0;
    const search=createPictogramSearch({opensymbolsSecret:'',globalSymbolsApiKey:'',http:{get:async()=>{calls++;return {data:scenario.items};}}});
    const result=await search.searchRuntimePictograms([scenario.token]);
    expect(result.map(row=>row.pictogram.source.originalId)).to.deep.equal(scenario.ids);
    expect(result.every(row=>row.pictogram.semantics.requiresReview)).to.equal(true);
    const firstCalls=calls;
    expect(await search.searchRuntimePictograms([scenario.token])).to.deep.equal(result);
    expect(calls).to.equal(firstCalls);
  });
});
