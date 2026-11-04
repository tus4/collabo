// Behavioral DOM smoke test. Optional dev dependency: linkedom@0.18.13.
// This is not a browser layout or visual rendering test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {parseHTML} = require('linkedom');
const root = path.resolve(__dirname, '..');
function boot(initialStorage = []) {
 const {window:dom,document} = parseHTML(fs.readFileSync(path.join(root,'template/platform.html'),'utf8'));
 // linkedom lacks the browser's writable HTMLSelectElement.value implementation.
 Object.defineProperty(dom.HTMLSelectElement.prototype, 'value', {get(){const o=[...this.options].find(x=>x.selected)||this.options[0];return o?o.value:''},set(v){const options=[...this.options];for(const o of options)o.selected=false;const match=options.find(o=>o.value===String(v));if(match)match.selected=true},configurable:true});
 const storage = new Map(initialStorage), downloads = [], fetches = [];
 const eventTarget = new dom.EventTarget();
 class TestURL extends URL { static createObjectURL(blob){downloads.push(blob);return 'blob:test';} static revokeObjectURL(){} }
 const sandbox = {document,console,Date,Math,Number,Array,Map,Set,JSON,Promise,Intl,URL:TestURL,Blob,performance,setTimeout,clearTimeout,
  location:{hash:'',href:'https://tus4.github.io/collabo/'},history:{replaceState(){}},
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  addEventListener:eventTarget.addEventListener.bind(eventTarget),removeEventListener:eventTarget.removeEventListener.bind(eventTarget),
  requestAnimationFrame:cb=>setTimeout(cb,0), Event:dom.Event,
  fetch:async url=>{fetches.push(url);try{return {ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(root,'docs',url),'utf8'))};}catch(e){return {ok:false,status:404};}}
 };
 sandbox.window=sandbox;sandbox.self=sandbox;
 const context=vm.createContext(sandbox);
 for(const script of document.querySelectorAll('script[src]')) {
  const file=script.getAttribute('src');
  assert.ok(file.startsWith('platform/'),'unexpected application script: '+file);
  vm.runInContext(fs.readFileSync(path.join(root,'template',file),'utf8'),context,{filename:file});
 }
 return {dom,document,storage,downloads,fetches,sandbox};
}
const NAV_KEY='collabo:investment-platform:nav-order:v2';
const OLD_NAV_KEY='collabo:investment-platform:nav-order:v1';
const defaultOrder=['overview','allocation','cma','hedge','fx','alternative'];
// The requested canonical order must replace an older v1 preference once.
const {dom,document,storage,downloads,fetches,sandbox}=boot([[OLD_NAV_KEY,JSON.stringify(['fx','obsolete','fx','allocation'])]]);
const order=(doc=document)=>Array.from(doc.querySelectorAll('#module-nav [data-tab]'),el=>el.dataset.tab);
const wait=()=>new Promise(r=>setTimeout(r,80));
// Preserve event.target across await as browsers do (linkedom clears it after dispatch).
const change=el=>{const event=new dom.Event('change',{bubbles:true});el.dispatchEvent(event);Object.defineProperty(event,'target',{value:el,configurable:true});};
function click(sel){const el=document.querySelector(sel);assert.ok(el,sel);el.dispatchEvent(new dom.Event('click',{bubbles:true}));}
function assertSubtab(group,key) {
 const buttons=[...document.querySelectorAll('[data-'+group+'-tab]')];
 const panels=[...document.querySelectorAll('[data-'+group+'-panel]')];
 assert.equal(buttons.filter(button=>button.getAttribute('aria-selected')==='true').length,1,group+' requires one active subtab');
 assert.equal(panels.filter(panel=>!panel.hidden).length,1,group+' requires one visible subpanel');
 const button=document.querySelector('[data-'+group+'-tab="'+key+'"]');
 const panel=document.querySelector('[data-'+group+'-panel="'+key+'"]');
 assert.equal(button.getAttribute('aria-selected'),'true');
 assert.equal(panel.hidden,false);
 assert.equal(button.getAttribute('aria-controls'),panel.id,'subtab must control its corresponding panel');
 assert.equal(panel.getAttribute('aria-labelledby'),button.id,'subpanel must be labelled by its subtab');
}
function csvRows(text) {
 // Model exports quote every cell; quoted commas and escaped quotes are valid.
 return text.replace(/^\ufeff/,'').trim().split(/\r?\n/).map(line=>
  [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match=>match[1].replace(/""/g,'"')));
}
function csvObjects(text) {
 const rows=csvRows(text),header=rows.shift();
 return rows.map(row=>Object.fromEntries(header.map((key,i)=>[key,row[i]])));
}
function near(actual,expected,label) {
 assert.ok(Math.abs(Number(actual)-expected)<1e-10,label+': '+actual+' != '+expected);
}
function format(value) {
 return value.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function hedgeInputs() {
 const input={currency:'USD',confirmed:true};
 for(const key of ['localReturn','fxReturn','premium','assetVol','fxVol','correlation']) {
  input[key]=Number(document.querySelector('[data-hedge="'+key+'"]').value)/(key==='correlation'?1:100);
 }
 input.hedgeRatio=Number(document.querySelector('#hedge-ratio').value)/100;
 return input;
}
function navEvent(tab,type,properties={}) {
 const event=new dom.Event(type,{bubbles:true,cancelable:true});
 Object.assign(event,properties);
 document.querySelector('#module-nav [data-tab="'+tab+'"]').dispatchEvent(event);
 return event;
}
function dragTab(from,to,commit=true) {
 const data=new Map(), dataTransfer={setData:(type,value)=>data.set(type,value),getData:type=>data.get(type)||''};
 const before=storage.get(NAV_KEY);
 navEvent(from,'dragstart',{dataTransfer});
 assert.equal(dataTransfer.effectAllowed,'move');
 assert.equal(navEvent(to,'dragover',{dataTransfer}).defaultPrevented,true);
 assert.equal(storage.get(NAV_KEY),before,'drag hover must not persist unfinished changes');
 if(commit)navEvent(to,'drop',{dataTransfer});
 navEvent(from,'dragend',{dataTransfer});
}
(async()=>{
 await wait();
 assert.deepEqual(order(),defaultOrder,'v1 saved order must not override the new canonical order');
 assert.equal(document.getElementById('view-overview').hidden,false,'Overview must be the default screen');
 assert.equal(document.querySelector('[aria-current="page"]').dataset.tab,'overview');
 assert.equal(document.querySelectorAll('.page-heading p').length,0,'page heading subtitles remain');
 assert.equal(document.querySelector('.page-heading').textContent.includes('USDKRW · 데이터와 모형에 따른 전망 분포'),false);
 assert.equal(document.querySelectorAll('#overview-portfolios .summary-card').length,5,'five portfolio summary cards required');
 assert.equal(document.querySelectorAll('#overview-fx .summary-card').length,4,'four currency summary cards required');
 assert.equal(document.querySelectorAll('#overview-hedge .summary-card').length,3,'three hedge summary cards required');
 assert.equal(document.querySelectorAll('#hedge-model-summary .monitor-model-card').length,3,'Hedge monitoring requires A/B/C cards');
 assert.equal(document.querySelectorAll('#fx-model-summary .monitor-model-card').length,4,'Currency monitoring requires all model statuses');
 assert.equal(document.getElementById('hedge-comparison-csv').disabled,true,'unconfirmed assumptions must not export model comparisons');
 for(const key of ['B','C','consensus']) {
  const card=document.querySelector('#fx-model-summary [data-fx-summary="'+key+'"]');
  assert.ok(card,'missing currency monitoring card '+key);
  assert.match(card.textContent,/미산출/,'missing model must retain an explicit status');
 }
 const commonQuality=document.getElementById('fx-quality-status');
 assert.ok(commonQuality,'Currency quality status missing');
 assert.equal(commonQuality.closest('[data-fx-panel]'),null,'quality status must remain outside individual model panels');
 assert.match(commonQuality.textContent,/동일 관측값/,'data-quality flags missing from Currency workspace');
 for(const id of ['fx-model-b','fx-model-c','fx-model-consensus']) {
  assert.match(document.getElementById(id).textContent,/미산출/,'unavailable FX models must not contain fabricated forecasts');
 }
 for(const [group,keys] of [['hedge',['monitoring','a','b','c']],['fx',['monitoring','a','b','c','consensus']]]) {
  click('[data-tab="'+group+'"]');
  for(const key of keys){
   click('[data-'+group+'-tab="'+key+'"]');await wait();assertSubtab(group,key);
   if(group==='fx')assert.equal(commonQuality.hidden,false,'data-quality status must remain visible on '+key);
  }
  const lastButton=document.querySelector('[data-'+group+'-tab="'+keys.at(-1)+'"]');
  const forward=new dom.Event('keydown',{bubbles:true,cancelable:true});Object.assign(forward,{key:'ArrowRight'});lastButton.dispatchEvent(forward);
  assert.equal(forward.defaultPrevented,true);assertSubtab(group,'monitoring');
  const firstButton=document.querySelector('[data-'+group+'-tab="monitoring"]');
  const end=new dom.Event('keydown',{bubbles:true,cancelable:true});Object.assign(end,{key:'End'});firstButton.dispatchEvent(end);
  assertSubtab(group,keys.at(-1));
  click('[data-'+group+'-tab="monitoring"]');
 }
 click('[data-tab="overview"]');
 click('[data-summary-portfolio="minVol"]');
 assert.equal(document.getElementById('view-allocation').hidden,false,'portfolio summary must open Optimizer');
 assert.match(document.getElementById('selected-summary').textContent,/Min Vol/);
 click('[data-tab="overview"]');
 click('#overview-fx [data-summary-fx="A"]');
 assert.equal(document.getElementById('view-fx').hidden,false,'FX summary must open Currency');
 assertSubtab('fx','a');
 click('[data-tab="overview"]');
 click('#overview-hedge [data-summary-hedge="B"]');
 assert.equal(document.getElementById('view-hedge').hidden,false,'hedge summary must open Hedge');
 assertSubtab('hedge','b');
 click('[data-hedge-tab="monitoring"]');
 click('#hedge-model-summary [data-summary-hedge="C"]');assertSubtab('hedge','c');
 click('[data-tab="fx"]');click('[data-fx-tab="monitoring"]');
 click('#fx-model-summary [data-summary-fx="A"]');assertSubtab('fx','a');
 click('[data-hedge-tab="monitoring"]');
 click('[data-fx-tab="monitoring"]');
 assert.equal(document.querySelector('#module-nav .nav-symbol, #module-nav .nav-arrow'),null,'sidebar tab icons remain');
 assert.equal(document.querySelector('.sidebar a[href="market.html"]'),null,'market link remains in sidebar');
 assert.ok(!Array.from(document.querySelectorAll('summary')).some(el=>el.textContent==='계산 기준과 가정'),'allocation assumptions note remains');
 for(const [tab,label] of Object.entries({overview:'Overview',allocation:'Optimizer',cma:'CMA',hedge:'Hedge',fx:'Currency',alternative:'Alternative'})) {
  assert.equal(document.querySelector('[data-tab="'+tab+'"]').textContent.trim(),label);
 }
 assert.ok(document.querySelector('#frontier-chart svg'),'allocation frontier missing');
 assert.equal(document.querySelectorAll('#weights-table tbody tr').length,8,'all asset weights must be visible');
 for(const row of document.querySelectorAll('#weights-table tbody tr')) {
  const cells=row.querySelectorAll('td');
  assert.match(cells[4].textContent,/^(?:[+-]?[1-9]\d*|0)%p$/,'current-weight delta must be integer without signed zero');
  assert.match(cells[1].textContent,/\d+\.\d{2}%$/,'current-weight precision should be unchanged');
 }

 for(const tab of ['overview','hedge','cma','fx','alternative','allocation']){click('[data-tab="'+tab+'"]');await wait();assert.equal(document.getElementById('view-'+tab).hidden,false);}
 // Moving modules must leave the active view selected and save only committed order.
 dragTab('alternative','overview');
 assert.deepEqual(order(),['alternative','overview','allocation','cma','hedge','fx']);
 assert.equal(document.querySelector('[aria-current="page"]').dataset.tab,'allocation');
 assert.equal(document.getElementById('view-allocation').hidden,false);
 assert.deepEqual(JSON.parse(storage.get(NAV_KEY)),order());
 dragTab('overview','fx');
 assert.deepEqual(order(),['alternative','allocation','cma','hedge','fx','overview']);
 const committed=order();
 dragTab('cma','alternative',false);
 assert.deepEqual(order(),committed,'cancelled drag must preserve the committed order');
 navEvent('allocation','drop',{dataTransfer:{getData:()=> 'fx'}});
 assert.deepEqual(order(),committed,'external drag payload must not reorder modules');
 navEvent('alternative','keydown',{altKey:true,key:'ArrowRight'});
 assert.deepEqual(order(),['allocation','alternative','cma','hedge','fx','overview']);
 navEvent('alternative','keydown',{altKey:true,key:'ArrowUp'});
 assert.deepEqual(order(),committed);
 navEvent('alternative','keydown',{altKey:true,key:'ArrowLeft'});
 assert.deepEqual(order(),committed,'first module cannot move beyond the first position');
 navEvent('overview','keydown',{altKey:true,key:'ArrowDown'});
 assert.deepEqual(order(),committed,'last module cannot move beyond the last position');
 assert.deepEqual(JSON.parse(storage.get(NAV_KEY)),order());
 const restored=boot(Array.from(storage));await wait();
 assert.deepEqual(order(restored.document),committed,'committed tab order should survive a reload');
 const legacyV2=boot([[NAV_KEY,JSON.stringify(['fx','obsolete','fx','allocation'])]]);await wait();
 assert.deepEqual(order(legacyV2.document),['fx','allocation','overview','cma','hedge','alternative'],'v2 saved order must discard unknown/duplicate IDs and append missing tabs');
 const corrupt=boot([[NAV_KEY,'{invalid json']]);await wait();
 assert.deepEqual(order(corrupt.document),defaultOrder,'invalid storage must fall back to default order');
 assert.ok(corrupt.document.querySelector('#frontier-chart svg'),'bad nav storage must not block analytics');
 sandbox.localStorage.setItem=()=>{throw Error('storage unavailable')};
 navEvent('alternative','keydown',{altKey:true,key:'ArrowDown'});
 assert.deepEqual(order(),['allocation','alternative','cma','hedge','fx','overview'],'navigation should still work if persistence is blocked');
 sandbox.localStorage.setItem=(k,v)=>storage.set(k,v);
 navEvent('alternative','keydown',{altKey:true,key:'ArrowUp'});
 click('[data-tab="fx"]');await wait();
 assert.ok(document.querySelector('#forecast-chart svg'),'FX chart missing');
 assert.ok(document.querySelectorAll('#forecast-table tbody tr').length===12,'forecast anchor missing');
 assert.ok(commonQuality.textContent.length,'shared forecast quality status missing');
 assert.equal(commonQuality.hidden,false,'shared forecast quality status must be visible');
 assert.equal(document.querySelector('#forecast-warning'),null,'duplicate monitoring quality warning must remain removed');
 click('#forecast-csv');await wait();assert.ok(downloads.length,'forecast download missing');
 // MC failure must not erase usable analytic forecasts or observed data-quality evidence.
 const mcImplementation=sandbox.CollaboModels.monteCarlo;
 const mcLookback=document.getElementById('forecast-lookback'),originalLookback=mcLookback.value;
 const qualityBeforeMCFailure=commonQuality.textContent;
 try {
  sandbox.CollaboModels.monteCarlo=()=>{throw new Error('simulated MC failure');};
  mcLookback.value=originalLookback==='60'?'36':'60';change(mcLookback);await wait();
  assert.ok(document.querySelector('#forecast-chart svg'),'MC failure must preserve analytic chart');
  assert.equal(document.getElementById('forecast-csv').disabled,false,'MC failure must preserve analytic CSV');
  assert.equal(document.getElementById('fx-error').hidden,true,'MC failure is not an analytic forecast error');
  assert.equal(commonQuality.hidden,false);
  assert.equal(commonQuality.textContent,qualityBeforeMCFailure,'MC failure must retain source date and quality evidence');
  assert.equal(document.querySelector('#model-a-chart'),null,'failed MC must clear model A chart');
  assert.match(document.getElementById('fx-model-a').textContent,/simulated MC failure/,'model A must show its own failure');
  assert.equal(document.querySelector('[data-model-csv="fx-a"]').disabled,true);
  assert.equal(document.getElementById('fx-comparison-csv').disabled,true);
  const beforeAnalyticExport=downloads.length;click('#forecast-csv');
  assert.equal(downloads.length,beforeAnalyticExport+1,'analytic CSV should remain downloadable during MC failure');
  const analyticRows=csvObjects(await downloads.at(-1).text());
  assert.ok(analyticRows.length>0&&analyticRows.every(row=>Number.isFinite(Number(row.median_krw))));
 } finally {
  sandbox.CollaboModels.monteCarlo=mcImplementation;
  mcLookback.value=originalLookback;change(mcLookback);await wait();
 }
 assert.ok(document.querySelector('#model-a-chart svg'),'restored MC must recover model A');
 assert.equal(document.querySelector('[data-model-csv="fx-a"]').disabled,false);
 assert.equal(document.getElementById('fx-comparison-csv').disabled,false);

 click('[data-tab="hedge"]');await wait();
 for(const currency of ['JPY','EUR','AUD','USD']){click('[data-currency="'+currency+'"]');await wait();assert.ok(document.querySelector('#hedge-chart svg'),currency+' chart missing');}
 const confirm=document.querySelector('#premium-confirm');confirm.checked=true;change(confirm);await wait();
 assert.ok(document.querySelector('#hedge-table tbody tr'),'hedge comparison missing');
 assert.equal(document.querySelectorAll('#hedge-model-comparison tbody tr').length,4,'comparison requires a common unhedged baseline and A/B/C');
 const hedgeHorizon=document.getElementById('hedge-summary-horizon');
 assert.equal(hedgeHorizon.value,'12');
 const comparisonCorrelation=document.querySelector('[data-hedge="correlation"]');comparisonCorrelation.value='-0.4';change(comparisonCorrelation);
 const comparisonCostInput=document.querySelector('#hedge-model-a [data-model-control="hedgeCost"]');comparisonCostInput.value='0.4';change(comparisonCostInput);
 const comparisonInput=hedgeInputs();
 const comparisonCost=Number(document.querySelector('#hedge-model-a [data-model-control="hedgeCost"]').value)/100;
 const comparisonGamma=Number(document.querySelector('#hedge-model-b [data-model-control="riskAversion"]').value);
 for(const horizon of [3,6,9,12]) {
  hedgeHorizon.value=String(horizon);change(hedgeHorizon);
  for(const model of ['A','B','C']) {
   const expected=sandbox.CollaboModels.hedge(comparisonInput,{model,cost:comparisonCost,riskAversion:comparisonGamma});
   const row=expected.rows.find(row=>row.horizon===horizon);
   const card=document.querySelector('#hedge-model-summary [data-hedge-summary="'+model+'"]');
   assert.ok(card.textContent.includes(format(expected.ratio*100)),model+' card ratio differs from detail result');
   assert.ok(card.textContent.includes(format(row.mean*100)),model+' card must change to selected '+horizon+'M: expected '+format(row.mean*100)+' in '+card.textContent);
   assert.ok(card.textContent.includes(format(row.approxVol*100)),model+' card risk differs from detail result');
   const comparison=document.querySelector('#hedge-model-comparison [data-comparison-model="'+model+'"]');
   assert.ok(comparison.textContent.includes(format(row.mean*100)),model+' comparison row must use selected horizon');
  }
 }
 click('#hedge-comparison-csv');
 const hedgeComparisonRows=csvObjects(await downloads.at(-1).text());
 assert.equal(hedgeComparisonRows.length,16,'comparison export must include all quarters');
 for(const model of ['unhedged','A','B','C']) {
  const rows=hedgeComparisonRows.filter(row=>row.model===model);
  assert.deepEqual(rows.map(row=>Number(row.horizon_months)),[3,6,9,12]);
  const expected=sandbox.CollaboModels.hedge(model==='unhedged'?{...comparisonInput,hedgeRatio:0}:comparisonInput,
   {model:model==='unhedged'?'A':model,cost:model==='unhedged'?0:comparisonCost,riskAversion:comparisonGamma});
  rows.forEach((row,i)=>{
   assert.equal(row.status,'available');
   near(row.hedge_ratio,expected.ratio,model+' CSV hedge ratio');
   near(row.expected_return,expected.rows[i].mean,model+' CSV expected return');
   near(row.approx_vol,expected.rows[i].approxVol,model+' CSV volatility');
  });
 }
 const baseline=hedgeComparisonRows.find(row=>row.model==='unhedged'&&row.horizon_months==='12');
 const covariance=comparisonInput.correlation*comparisonInput.assetVol*comparisonInput.fxVol;
 near(baseline.expected_return,(1+comparisonInput.localReturn)*(1+comparisonInput.fxReturn)-1+covariance,'baseline independent cash-flow identity');
 near(baseline.approx_vol,Math.sqrt(comparisonInput.assetVol**2+comparisonInput.fxVol**2+2*covariance),'baseline independent variance identity');
 const domestic=document.querySelector('#hedge-model-a [data-model-control="domesticRate"]');domestic.value='3';change(domestic);
 const foreign=document.querySelector('#hedge-model-a [data-model-control="foreignRate"]');foreign.value='5';change(foreign);
 assert.ok(!document.querySelector('#hedge-model-a').textContent.includes('금리 입력 필요'),'CIP inputs must calculate a comparison');
 click('[data-currency="JPY"]');await wait();
 assert.equal(document.querySelector('#hedge-model-a [data-model-control="foreignRate"]').value,'','switching currency must clear the previous foreign rate');
 assert.equal(document.querySelector('#hedge-model-a [data-model-control="domesticRate"]').value,'3','switching currency preserves the KRW rate');
 assert.match(document.querySelector('#hedge-model-a').textContent,/금리 입력 필요/,'new currency cannot reuse a stale CIP comparison');
 assert.equal(document.querySelector('#premium-confirm').checked,false,'new currency requires premium confirmation');
 click('[data-currency="USD"]');await wait();confirm.checked=true;change(confirm);await wait();
 const gamma=document.querySelector('#hedge-model-b [data-model-control="riskAversion"]');const previousGamma=gamma.value;gamma.value='0';change(gamma);
 assert.equal(document.querySelectorAll('#hedge-model-b tbody tr').length,0,'invalid gamma must clear B output');
 assert.equal(document.querySelector('[data-model-csv="hedge-b"]').disabled,true,'invalid gamma must disable B export');
 assert.match(document.querySelector('#hedge-model-summary [data-hedge-summary="B"]').textContent,/미산출/);
 assert.match(document.querySelector('#hedge-model-comparison [data-comparison-model="B"]').textContent,/위험회피/,'invalid comparison row must name the failed input');
 click('#hedge-comparison-csv');
 const partialHedgeRows=csvObjects(await downloads.at(-1).text());
 for(const row of partialHedgeRows) {
  if(row.model==='B') {
   assert.equal(row.status,'unavailable');assert.ok(row.reason,'invalid B reason missing');
   for(const key of ['hedge_ratio','expected_return','approx_vol'])assert.equal(row[key],'','invalid B must not export stale/zero '+key);
  } else assert.equal(row.status,'available','B error must not suppress '+row.model);
 }
 for(const model of ['a','c']){
  assert.equal(document.querySelectorAll('#hedge-model-'+model+' tbody tr').length,4,'gamma must not suppress model '+model);
  assert.equal(document.querySelector('[data-model-csv="hedge-'+model+'"]').disabled,false,'gamma must not disable model '+model+' export');
 }
 const correctedGamma=document.querySelector('#hedge-model-b [data-model-control="riskAversion"]');correctedGamma.value=previousGamma;change(correctedGamma);
 assert.equal(document.querySelectorAll('#hedge-model-b tbody tr').length,4,'corrected gamma must restore B output');
 for(const model of ['a','b','c']) {
  const root=document.getElementById('hedge-model-'+model);
  assert.ok(root.querySelectorAll('tbody tr').length>=4,'hedge '+model+' quarterly rows missing');
  assert.ok(!root.textContent.includes('NaN'),'hedge '+model+' contains invalid numbers');
  const before=downloads.length;click('[data-model-csv="hedge-'+model+'"]');
  assert.equal(downloads.length,before+1,'hedge model CSV missing');
  const exported=await downloads.at(-1).text();
  assert.ok(!exported.includes('NaN'),'hedge CSV contains invalid numbers');
  const rows=csvRows(exported),header=rows.shift();
  assert.deepEqual(rows.map(row=>Number(row[header.indexOf('horizon_months')])),[3,6,9,12]);
  assert.ok(rows.every(row=>row[header.indexOf('model')]===model.toUpperCase()));
  assert.ok(rows.every(row=>row[header.indexOf('input_type')]==='user_assumption'));
  assert.ok(rows.every(row=>{const h=Number(row[header.indexOf('hedge_ratio')]);return h>=0&&h<=1;}),'exported hedge ratio must be a fraction');
  assert.ok(rows.every(row=>Number(row[header.indexOf('lower95')])<=Number(row[header.indexOf('expected_return')])&&Number(row[header.indexOf('expected_return')])<=Number(row[header.indexOf('upper95')])),'exported hedge uncertainty must bracket expected return');
 }
 const beforeModelDownload=downloads.length;click('[data-model-csv="fx-a"]');
 assert.equal(downloads.length,beforeModelDownload+1,'FX A CSV missing');
 const fxExport=await downloads.at(-1).text();assert.ok(!fxExport.includes('NaN'),'FX A CSV contains invalid numbers');
 const fxRows=csvRows(fxExport),fxHeader=fxRows.shift();
 assert.deepEqual(fxRows.map(row=>Number(row[fxHeader.indexOf('horizon_months')])),[3,6,9,12]);
 const fxSource=JSON.parse(fs.readFileSync(path.join(root,'docs/data/market.json'),'utf8')).series.find(series=>series.category==='FX'&&series.code==='USDKRW');
 assert.ok(fxSource,'USDKRW source series missing');
 assert.ok(commonQuality.textContent.includes(fxSource.latest.date),'shared quality status must retain source date');
 const fxHorizon=document.getElementById('fx-summary-horizon');
 for(const horizon of [3,6,9,12]) {
  fxHorizon.value=String(horizon);change(fxHorizon);
  const row=fxRows.find(row=>Number(row[fxHeader.indexOf('horizon_months')])===horizon);
  const card=document.querySelector('#fx-model-summary [data-fx-summary="A"]');
  assert.ok(card.textContent.includes(format(Number(row[fxHeader.indexOf('mean_krw')]))),'FX card mean must match selected quarter in model CSV');
  assert.ok(card.textContent.includes(format(Number(row[fxHeader.indexOf('lower95_krw')]))),'FX card interval must match selected quarter');
 }
 click('#fx-comparison-csv');
 const fxComparisonRows=csvObjects(await downloads.at(-1).text());
 assert.equal(fxComparisonRows.length,16,'FX comparison export must include every model and quarter');
 for(const model of ['A','B','C','consensus']) {
  const rows=fxComparisonRows.filter(row=>row.model===model);
  assert.deepEqual(rows.map(row=>Number(row.horizon_months)),[3,6,9,12]);
  for(const row of rows) {
   if(model==='A') {
    assert.equal(row.status,'available');
    const original=fxRows.find(source=>source[fxHeader.indexOf('horizon_months')]===row.horizon_months);
    for(const key of ['mean_krw','median_krw','lower95_krw','upper95_krw','var975_loss_fraction'])near(row[key],Number(original[fxHeader.indexOf(key)]),'FX comparison '+key);
   } else {
    assert.equal(row.status,'unavailable');assert.ok(row.reason,'unavailable FX model reason missing');
    for(const key of ['mean_krw','median_krw','lower95_krw','upper95_krw','var975_loss_fraction'])assert.equal(row[key],'','missing FX data must not become zero');
   }
  }
 }
 assert.ok(fxRows.every(row=>row[fxHeader.indexOf('asof')]===fxSource.latest.date),'FX export must retain the source date');
 assert.ok(fxRows.every(row=>Number(row[fxHeader.indexOf('lower95_krw')])<=Number(row[fxHeader.indexOf('median_krw')])&&Number(row[fxHeader.indexOf('median_krw')])<=Number(row[fxHeader.indexOf('upper95_krw')])),'FX export uncertainty must bracket the median');
 confirm.checked=false;change(confirm);await wait();
 assert.equal(document.getElementById('hedge-comparison-csv').disabled,true,'unconfirmed comparison must not export');
 for(const card of document.querySelectorAll('#hedge-model-summary .monitor-model-card'))assert.match(card.textContent,/미산출/,'unconfirmed card must clear stale results');
 for(const model of ['a','b','c']) {
  assert.equal(document.querySelector('[data-model-csv="hedge-'+model+'"]').disabled,true,'unconfirmed hedge assumptions must disable CSV');
  assert.equal(document.querySelectorAll('#hedge-model-'+model+' tbody tr').length,0,'unconfirmed hedge assumptions must clear prior results');
 }
 confirm.checked=true;change(confirm);await wait();
 const assetVolInput=document.querySelector('[data-hedge="assetVol"]'),validAssetVol=assetVolInput.value;
 assetVolInput.value='1000';change(assetVolInput);
 assert.equal(document.querySelector('#hedge-metrics').textContent,'','out-of-range risk must clear scenario output');
 assert.equal(document.getElementById('hedge-comparison-csv').disabled,true,'out-of-range risk must disable comparison export');
 for(const model of ['A','B','C']) {
  assert.match(document.querySelector('#hedge-model-summary [data-hedge-summary="'+model+'"]').textContent,/미산출/);
  assert.equal(document.querySelector('[data-model-csv="hedge-'+model.toLowerCase()+'"]').disabled,true);
 }
 assetVolInput.value=validAssetVol;change(assetVolInput);
 assert.equal(document.getElementById('hedge-comparison-csv').disabled,false,'corrected risk must restore valid comparison');
 click('[data-tab="cma"]');await wait();
 assert.equal(document.querySelectorAll('#cma-table tbody tr').length,8);
 assert.equal(document.querySelector('#cma-table tbody tr:last-child td').textContent,'유동자산');
 assert.equal(document.querySelectorAll('#correlation-table tbody tr').length,8);
 assert.equal(document.querySelectorAll('#correlation-table thead th').length,9);
 assert.equal(document.querySelectorAll('#overview-portfolios .summary-weight').length,40,'five portfolios must each include eight assets');
 click('#save-scenario');assert.ok(storage.size,'save missing');click('#export-scenario');await wait();assert.ok(downloads.length>=2,'scenario download missing');
 const saved=JSON.parse(await downloads[downloads.length-1].text());
 assert.equal(saved.version,2);
 assert.equal(saved.assets.length,8);
 assert.equal(saved.assets[7].id,'asset-7');
 assert.equal(saved.assets[7].current,0);
 assert.equal(saved.assets[7].saa,0);
 const current=document.querySelector('[data-asset="0"][data-field="current"]');const original=current.value;current.value='99';change(current);assert.equal(document.querySelector('#allocation-results').hidden,true);assert.ok(document.querySelector('#cma-error').textContent.includes('100%'));assert.equal(document.querySelectorAll('#overview-portfolios [data-summary-portfolio]').length,0,'invalid CMA must clear actionable stale Overview portfolio results');current.value=original;change(current);assert.equal(document.querySelector('#allocation-results').hidden,false);assert.equal(document.querySelectorAll('#overview-portfolios .summary-card').length,5,'corrected CMA must restore Overview cards');
 const corr=document.querySelector('[data-corr-i="0"][data-corr-j="1"]');const corrOriginal=corr.value;corr.value='0.20';change(corr);assert.equal(document.querySelector('#corr-1-0').textContent,'0.20');corr.value=corrOriginal;change(corr);
 const fileInput=document.querySelector('#scenario-file');async function importJson(obj){const value=JSON.stringify(obj);Object.defineProperty(fileInput,'files',{value:[{size:value.length,text:async()=>value}],configurable:true});change(fileInput);await wait();}
 await importJson({...saved,rf:.03});assert.equal(document.querySelector('#risk-free').value,'3.00');
 await importJson({...saved,rf:.06,assets:saved.assets.map(a=>({...a,max:.10}))});assert.equal(document.querySelector('#risk-free').value,'3.00');assert.ok(document.querySelector('#toast').textContent.includes('실패'));
 // Legacy seven-asset files keep their inputs and acquire a zero-weight liquid asset.
 const legacy=JSON.parse(JSON.stringify({...saved,version:1,rf:.029,assets:saved.assets.slice(0,7),corr:saved.corr.slice(0,7).map(row=>row.slice(0,7))}));
 Object.assign(legacy.assets[0],{mu:.041,vol:.051,min:.05,max:.4});
 legacy.corr[0][1]=legacy.corr[1][0]=.05;
 await importJson(legacy);assert.equal(document.querySelector('#risk-free').value,'2.90');
 click('#export-scenario');const migrated=JSON.parse(await downloads.at(-1).text());
 assert.equal(migrated.version,2);
 assert.deepEqual(migrated.assets.slice(0,7),legacy.assets,'migration must preserve all original asset assumptions and limits');
 assert.deepEqual(migrated.corr.slice(0,7).map(row=>row.slice(0,7)),legacy.corr,'migration must preserve the old correlation block');
 assert.equal(migrated.assets[7].current,0);assert.equal(migrated.assets[7].saa,0);
 assert.deepEqual(migrated.corr[7],[0,0,0,0,0,0,0,1]);
 assert.ok(migrated.corr.slice(0,7).every(row=>row[7]===0));
 const oldScenarioKey='collabo:investment-platform:scenario:v1',scenarioKey='collabo:investment-platform:scenario:v2';
 storage.delete(scenarioKey);storage.set(oldScenarioKey,JSON.stringify(legacy));
 click('#reset-scenario');click('#load-scenario');assert.equal(document.querySelector('#risk-free').value,'2.90','old browser saves must remain readable');
 click('#save-scenario');assert.equal(JSON.parse(storage.get(scenarioKey)).version,2);
 assert.equal(storage.get(oldScenarioKey),JSON.stringify(legacy),'migration must not overwrite the legacy saved copy');
 storage.set(scenarioKey,JSON.stringify({...migrated,rf:.031}));
 click('#load-scenario');assert.equal(document.querySelector('#risk-free').value,'3.10','the new saved scenario takes precedence over legacy storage');
 // Invalid versions, asset IDs, and dimensions fail without replacing the current state.
 const swapped=legacy.assets.slice();[swapped[0],swapped[1]]=[swapped[1],swapped[0]];
 for(const invalid of [{...legacy,version:2},{...saved,version:1},{...legacy,assets:swapped},{...legacy,corr:legacy.corr.map((row,i)=>i===0?row.concat(0):row)}]){
  await importJson(invalid);assert.equal(document.querySelector('#risk-free').value,'3.10');assert.ok(document.querySelector('#toast').textContent.includes('실패'));
 }
 // Edit the liquid row and verify the resulting current portfolio independently via CSV.
 await importJson(saved);
 const editAsset=(index,field,value)=>{const input=document.querySelector('[data-asset="'+index+'"][data-field="'+field+'"]');input.value=String(value);change(input);};
 for(const [index,field,value] of [[7,'mu',3.25],[7,'vol',1.25],[7,'min',10],[7,'max',20],[0,'current',10],[7,'current',10],[0,'saa',15],[7,'saa',10]])editAsset(index,field,value);
 assert.equal(document.querySelector('#allocation-results').hidden,false);
 click('[data-portfolio="current"]');click('#allocation-csv');
 const allocationRows=csvRows(await downloads.at(-1).text()),allocationHeader=allocationRows.shift();
 assert.equal(allocationRows.length,8);assert.equal(allocationRows[7][0],'유동자산');
 const column=name=>allocationHeader.indexOf(name);
 const value=(row,name)=>Number(row[column(name)]);
 assert.equal(value(allocationRows[7],'current_weight'),.1);assert.equal(value(allocationRows[7],'saa_weight'),.1);
 assert.equal(value(allocationRows[7],'assumption_mu_annual'),.0325);assert.equal(value(allocationRows[7],'assumption_vol_annual'),.0125);
 const currentWeights=saved.assets.map((asset,i)=>i===0?.1:i===7?.1:asset.current);
 const expectedReturn=saved.assets.reduce((sum,asset,i)=>sum+currentWeights[i]*(i===7?.0325:asset.mu),0);
 const variance=currentWeights.reduce((sum,wi,i)=>sum+currentWeights.reduce((inner,wj,j)=>inner+wi*wj*saved.corr[i][j]*(i===7?.0125:saved.assets[i].vol)*(j===7?.0125:saved.assets[j].vol),0),0);
 const csvReturn=allocationRows.reduce((sum,row)=>sum+value(row,'selected_weight')*value(row,'assumption_mu_annual'),0);
 const csvRisk=allocationRows.reduce((sum,row)=>sum+value(row,'risk_contribution_annual'),0);
 assert.ok(Math.abs(csvReturn-expectedReturn)<1e-12,'liquid-asset expected return must be included once');
 assert.ok(Math.abs(csvRisk-Math.sqrt(variance))<1e-10,'risk contributions must sum to independently computed volatility');
 assert.ok(Math.abs(value(allocationRows[7],'risk_contribution_annual')-.1**2*.0125**2/Math.sqrt(variance))<1e-10,'liquid-asset risk contribution must be included');
 const liquidCorr=document.querySelector('[data-corr-i="0"][data-corr-j="7"]');liquidCorr.value='.10';change(liquidCorr);assert.equal(document.querySelector('#corr-7-0').textContent,'0.10');
 click('#save-scenario');const liquidSaved=JSON.parse(storage.get(scenarioKey));
 click('#reset-scenario');click('#load-scenario');click('#export-scenario');
 const liquidRestored=JSON.parse(await downloads.at(-1).text());
 assert.deepEqual(liquidRestored.assets,liquidSaved.assets);assert.deepEqual(liquidRestored.corr,liquidSaved.corr,'liquid assumptions and correlation must survive save/load');
 // A 100% liquid portfolio with zero volatility has a defined return and undefined Sharpe.
 const allLiquid={...saved,assets:saved.assets.map((asset,i)=>({...asset,min:0,max:i===7?1:asset.max,current:i===7?1:0,saa:i===7?1:0,...(i===7?{vol:0}:{})}))};
 await importJson(allLiquid);assert.equal(document.querySelector('#allocation-results').hidden,false);
 click('[data-portfolio="current"]');
 const metrics=[...document.querySelectorAll('#portfolio-metrics .metric')].map(node=>node.textContent);
 assert.equal(metrics[0],'2.50%');assert.equal(metrics[1],'0.00%');assert.equal(metrics[2],'—');
 assert.ok(!/NaN|Infinity/.test(document.querySelector('#frontier-chart').innerHTML),'zero-volatility boundary must not corrupt the chart');
 await importJson({...saved,rf:.03});
 sandbox.localStorage.setItem=()=>{throw Error('storage unavailable')};click('#save-scenario');assert.ok(document.querySelector('#toast').textContent.includes('저장 실패'));sandbox.localStorage.setItem=(k,v)=>storage.set(k,v);
 click('[data-tab="fx"]');const lookback=document.querySelector('#forecast-lookback');lookback.value='36';change(lookback);await wait();assert.ok(document.querySelector('#oos-results').textContent.includes('추정창 36개월'));const method=document.querySelector('#forecast-method');method.value='scenario';change(method);const drift=document.querySelector('#forecast-drift');drift.value='10';change(drift);await wait();assert.equal(document.querySelector('#forecast-drift-label').hidden,false);assert.ok(!document.querySelector('#forecast-chart').innerHTML.includes('NaN'));
 drift.value='200';change(drift);await wait();
 assert.equal(document.querySelector('#fx-error').hidden,false,'out-of-range scenario drift must fail monitoring');
 assert.equal(document.querySelector('#forecast-chart').innerHTML,'');
 assert.equal(document.querySelector('#model-a-chart'),null,'invalid drift must clear A output');
 assert.equal(document.querySelector('#forecast-csv').disabled,true);
 assert.equal(document.querySelector('[data-model-csv="fx-a"]').disabled,true);
 assert.equal(document.querySelector('#fx-comparison-csv').disabled,true);
 assert.match(document.querySelector('#fx-model-summary [data-fx-summary="A"]').textContent,/미산출/);
 assert.match(document.querySelector('#overview-fx .summary-card').textContent,/미산출/,'Overview must clear stale A result');
 drift.value='';change(drift);method.value='random-walk';change(method);await wait();
 assert.equal(document.querySelector('#fx-error').hidden,true,'unused blank drift must not block random walk');
 assert.ok(document.querySelector('#forecast-chart svg'));assert.ok(document.querySelector('#model-a-chart svg'));
 assert.equal(document.querySelector('#forecast-csv').disabled,false);
 assert.equal(document.querySelector('[data-model-csv="fx-a"]').disabled,false);
 assert.equal(document.querySelector('#fx-comparison-csv').disabled,false);
 click('#export-scenario');
 const recoveredScenario=JSON.parse(await downloads.at(-1).text());
 assert.equal(recoveredScenario.fx.method,'random-walk');
 assert.equal(recoveredScenario.fx.annualDrift,0,'inactive blank drift must serialize as a valid neutral default');
 method.value='scenario';change(method);drift.value='10';change(drift);
 click('[data-tab="hedge"]');for(const [key,value] of [['localReturn','5'],['fxReturn','-10'],['premium','-2']]){const input=document.querySelector('[data-hedge="'+key+'"]');input.value=value;change(input);}confirm.checked=true;change(confirm);const ratio=document.querySelector('#hedge-ratio');ratio.value='100';ratio.dispatchEvent(new dom.Event('input',{bubbles:true}));assert.ok(document.querySelector('#hedge-metrics').textContent.includes('2.50'));
 click('[data-tab="allocation"]');const point=document.querySelector('[data-frontier="12"]');point.dispatchEvent(new dom.Event('click',{bubbles:true}));assert.ok(document.querySelector('#selected-summary').textContent.includes('조합 선택'));click('#allocation-csv');
 assert.ok(fetches.every(url=>url.startsWith('data/')),'unexpected external fetch');
 console.log(JSON.stringify({result:'PASS',sixTabs:true,overviewCards:[5,4,3],modelSubtabs:true,monitorCards:true,comparisonCSV:true,sharedValidation:true,mcFailureIsolation:true,tabDragAndKeyboard:true,tabPersistence:true,allocationSVG:true,fxSVG:true,hedgeCurrencies:4,cmaAssets:8,legacyScenarioMigration:true,liquidAssetEditing:true,zeroVolatilityLiquidPortfolio:true,storage:true,downloads:downloads.length,fetches:fetches.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
