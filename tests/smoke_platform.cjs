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
 Object.defineProperty(dom.HTMLSelectElement.prototype, 'value', {get(){const o=[...this.options].find(x=>x.selected)||this.options[0];return o?o.value:''},set(v){for(const o of this.options)o.selected=false;const match=[...this.options].find(o=>o.value===v);if(match)match.selected=true},configurable:true});
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
 assert.equal(document.getElementById('reference-results').hidden,false,'reference data loads independently');
 assertSubtab('cma','assumptions');
 click('[data-tab="cma"]');click('[data-cma-tab="reference"]');assertSubtab('cma','reference');
 assert.equal(document.getElementById('correlation-table').hidden,true);
 assert.ok(document.getElementById('reference-metrics').textContent.includes('9.76'));
 assert.ok(document.getElementById('reference-metrics').textContent.includes('9.72'));
 assert.equal(document.querySelectorAll('#reference-correlation .selected-col').length,7);
 assert.ok(document.getElementById('reference-correlation').textContent.includes('레퍼런스'));
 assert.ok(document.querySelector('#reference-chart svg'));
 const referenceInput=(id,value)=>{const input=document.getElementById(id);input.value=value;input.dispatchEvent(new dom.Event('input',{bubbles:true}));};
 referenceInput('reference-equity','100');assert.equal(document.getElementById('reference-bond').value,'0.00');
 assert.ok(document.getElementById('reference-metrics').textContent.includes('15.51'));
 referenceInput('reference-bond','100');assert.equal(document.getElementById('reference-equity').value,'0.00');
 assert.ok(document.getElementById('reference-metrics').textContent.includes('1.15'));
 referenceInput('reference-equity','');assert.equal(document.getElementById('reference-results').hidden,true);
 assert.equal(document.getElementById('reference-csv').disabled,true);assert.ok(document.getElementById('reference-correlation').textContent.includes('미산출'));
 referenceInput('reference-equity','101');assert.equal(document.getElementById('reference-results').hidden,true);
 click('#reference-reset');assert.ok(document.getElementById('reference-metrics').textContent.includes('9.76'));
 const refBasis=document.getElementById('reference-basis');refBasis.value='krw';change(refBasis);
 assert.ok(document.getElementById('reference-metrics').textContent.includes('10.95'));
 assert.ok(document.getElementById('reference-metrics').textContent.includes('8.91'));
 const refPeriod=document.getElementById('reference-lookback');refPeriod.value='60';change(refPeriod);
 assert.ok(document.getElementById('reference-metrics').textContent.includes('10.38'));
 click('#reference-csv');const refRows=csvRows(await downloads.at(-1).text());assert.equal(refRows.length,61);
 assert.equal(refRows[1][3],'krw');assert.equal(refRows[1][7],'60');assert.equal(refRows.at(-1)[11],'2026-09-30');
 assert.ok(Math.abs(Number(refRows[1][8])-.10376050346117967)<1e-12);
 click('#save-scenario');referenceInput('reference-equity','25');click('#load-scenario');
 assert.equal(document.getElementById('reference-equity').value,'60.00');assert.equal(document.getElementById('reference-basis').value,'krw');
 click('#reset-scenario');assert.equal(document.getElementById('reference-lookback').value,'120');assert.equal(document.getElementById('reference-basis').value,'local');
 const cmaKey=new dom.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(cmaKey,'key',{value:'Home'});document.getElementById('cma-tab-reference').dispatchEvent(cmaKey);assertSubtab('cma','assumptions');
 click('[data-tab="overview"]');
 assert.deepEqual(order(),defaultOrder,'v1 saved order must not override the new canonical order');
 assert.equal(document.getElementById('view-overview').hidden,false,'Overview must be the default screen');
 assert.equal(document.querySelector('[aria-current="page"]').dataset.tab,'overview');
 assert.equal(document.querySelectorAll('.page-heading p').length,0,'page heading subtitles remain');
 assert.equal(document.querySelector('.page-heading').textContent.includes('USDKRW · 데이터와 모형에 따른 전망 분포'),false);
 assert.equal(document.querySelectorAll('#overview-portfolios .summary-card').length,5,'five portfolio summary cards required');
 assert.equal(document.querySelectorAll('#overview-fx .summary-card').length,4,'four currency summary cards required');
 assert.equal(document.querySelectorAll('#overview-hedge .summary-card').length,3,'three hedge summary cards required');
 for(const id of ['fx-model-b','fx-model-c','fx-model-consensus']) {
  assert.match(document.getElementById(id).textContent,/미산출/,'unavailable FX models must not contain fabricated forecasts');
 }
 for(const [group,keys] of [['hedge',['monitoring','a','b','c']],['fx',['monitoring','a','b','c','consensus']]]) {
  click('[data-tab="'+group+'"]');
  for(const key of keys){click('[data-'+group+'-tab="'+key+'"]');await wait();assertSubtab(group,key);}
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
 click('[data-summary-fx="A"]');
 assert.equal(document.getElementById('view-fx').hidden,false,'FX summary must open Currency');
 assertSubtab('fx','a');
 click('[data-tab="overview"]');
 click('[data-summary-hedge="B"]');
 assert.equal(document.getElementById('view-hedge').hidden,false,'hedge summary must open Hedge');
 assertSubtab('hedge','b');
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
 assert.ok(document.querySelector('#forecast-warning').textContent.length,'forecast model assumptions missing');
 click('#forecast-csv');await wait();assert.ok(downloads.length,'forecast download missing');
 click('[data-tab="hedge"]');await wait();
 for(const currency of ['JPY','EUR','AUD','USD']){click('[data-currency="'+currency+'"]');await wait();assert.ok(document.querySelector('#hedge-chart svg'),currency+' chart missing');}
 const confirm=document.querySelector('#premium-confirm');confirm.checked=true;change(confirm);await wait();
 assert.ok(document.querySelector('#hedge-table tbody tr'),'hedge comparison missing');
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
 assert.ok(fxRows.every(row=>row[fxHeader.indexOf('asof')]===fxSource.latest.date),'FX export must retain the source date');
 assert.ok(fxRows.every(row=>Number(row[fxHeader.indexOf('lower95_krw')])<=Number(row[fxHeader.indexOf('median_krw')])&&Number(row[fxHeader.indexOf('median_krw')])<=Number(row[fxHeader.indexOf('upper95_krw')])),'FX export uncertainty must bracket the median');
 confirm.checked=false;change(confirm);await wait();
 for(const model of ['a','b','c']) {
  assert.equal(document.querySelector('[data-model-csv="hedge-'+model+'"]').disabled,true,'unconfirmed hedge assumptions must disable CSV');
  assert.equal(document.querySelectorAll('#hedge-model-'+model+' tbody tr').length,0,'unconfirmed hedge assumptions must clear prior results');
 }
 confirm.checked=true;change(confirm);await wait();
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
 click('[data-tab="hedge"]');for(const [key,value] of [['localReturn','5'],['fxReturn','-10'],['premium','-2']]){const input=document.querySelector('[data-hedge="'+key+'"]');input.value=value;change(input);}confirm.checked=true;change(confirm);const ratio=document.querySelector('#hedge-ratio');ratio.value='100';ratio.dispatchEvent(new dom.Event('input',{bubbles:true}));assert.ok(document.querySelector('#hedge-metrics').textContent.includes('2.50'));
 click('[data-tab="allocation"]');const point=document.querySelector('[data-frontier="12"]');point.dispatchEvent(new dom.Event('click',{bubbles:true}));assert.ok(document.querySelector('#selected-summary').textContent.includes('조합 선택'));click('#allocation-csv');
 assert.ok(fetches.every(url=>url.startsWith('data/')||url==='platform/reference-data.json'),'unexpected external fetch');
 console.log(JSON.stringify({result:'PASS',sixTabs:true,overviewCards:[5,4,3],modelSubtabs:true,tabDragAndKeyboard:true,tabPersistence:true,allocationSVG:true,fxSVG:true,hedgeCurrencies:4,cmaAssets:8,referencePortfolio:true,legacyScenarioMigration:true,liquidAssetEditing:true,zeroVolatilityLiquidPortfolio:true,storage:true,downloads:downloads.length,fetches:fetches.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
