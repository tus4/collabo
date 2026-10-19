// Behavioral DOM smoke test. Optional dev dependency: linkedom@0.18.13.
// This is not a browser layout or visual rendering test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {parseHTML} = require('linkedom');
const root = path.resolve(__dirname, '..');
const {window:dom,document} = parseHTML(fs.readFileSync(path.join(root,'template/platform.html'),'utf8'));
// linkedom lacks the browser's writable HTMLSelectElement.value implementation.
Object.defineProperty(dom.HTMLSelectElement.prototype, 'value', {get(){const o=[...this.options].find(x=>x.selected)||this.options[0];return o?o.value:''},set(v){for(const o of this.options)o.selected=o.value===v},configurable:true});
const storage = new Map(), downloads = [], errors = [], fetches = [];
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
for(const file of ['analytics.js','fx.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,'template/platform',file),'utf8'),context,{filename:file});
const wait=()=>new Promise(r=>setTimeout(r,80));
// Preserve event.target across await as browsers do (linkedom clears it after dispatch).
const change=el=>{const event=new dom.Event('change',{bubbles:true});el.dispatchEvent(event);Object.defineProperty(event,'target',{value:el,configurable:true});};
function click(sel){const el=document.querySelector(sel);assert.ok(el,sel);el.dispatchEvent(new dom.Event('click',{bubbles:true}));}
(async()=>{
 await wait();
 assert.ok(document.querySelector('#frontier-chart svg'),'allocation frontier missing');
 assert.ok(document.querySelectorAll('#weights-table tbody tr').length>=7,'asset weights missing');
 for(const tab of ['hedge','cma','fx','allocation']){click('[data-tab="'+tab+'"]');await wait();assert.equal(document.getElementById('view-'+tab).hidden,false);}
 click('[data-tab="fx"]');await wait();
 assert.ok(document.querySelector('#forecast-chart svg'),'FX chart missing');
 assert.ok(document.querySelectorAll('#forecast-table tbody tr').length===12,'forecast anchor missing');
 assert.ok(document.querySelector('#forecast-warning').textContent.length,'forecast model assumptions missing');
 click('#forecast-csv');await wait();assert.ok(downloads.length,'forecast download missing');
 click('[data-tab="hedge"]');await wait();
 for(const currency of ['JPY','EUR','AUD','USD']){click('[data-currency="'+currency+'"]');await wait();assert.ok(document.querySelector('#hedge-chart svg'),currency+' chart missing');}
 const confirm=document.querySelector('#premium-confirm');confirm.checked=true;change(confirm);await wait();
 assert.ok(document.querySelector('#hedge-table tbody tr'),'hedge comparison missing');
 click('[data-tab="cma"]');await wait();
 assert.equal(document.querySelectorAll('#cma-table tbody tr').length,7);
 click('#save-scenario');assert.ok(storage.size,'save missing');click('#export-scenario');await wait();assert.ok(downloads.length>=2,'scenario download missing');
 const saved=JSON.parse(await downloads[downloads.length-1].text());
 const current=document.querySelector('[data-asset="0"][data-field="current"]');const original=current.value;current.value='99';change(current);assert.equal(document.querySelector('#allocation-results').hidden,true);assert.ok(document.querySelector('#cma-error').textContent.includes('100%'));current.value=original;change(current);assert.equal(document.querySelector('#allocation-results').hidden,false);
 const corr=document.querySelector('[data-corr-i="0"][data-corr-j="1"]');const corrOriginal=corr.value;corr.value='0.20';change(corr);assert.equal(document.querySelector('#corr-1-0').textContent,'0.20');corr.value=corrOriginal;change(corr);
 const fileInput=document.querySelector('#scenario-file');async function importJson(obj){const value=JSON.stringify(obj);Object.defineProperty(fileInput,'files',{value:[{size:value.length,text:async()=>value}],configurable:true});change(fileInput);await wait();}
 await importJson({...saved,rf:.03});assert.equal(document.querySelector('#risk-free').value,'3.00');
 await importJson({...saved,rf:.06,assets:saved.assets.map(a=>({...a,max:.10}))});assert.equal(document.querySelector('#risk-free').value,'3.00');assert.ok(document.querySelector('#toast').textContent.includes('실패'));
 sandbox.localStorage.setItem=()=>{throw Error('storage unavailable')};click('#save-scenario');assert.ok(document.querySelector('#toast').textContent.includes('저장 실패'));sandbox.localStorage.setItem=(k,v)=>storage.set(k,v);
 click('[data-tab="fx"]');const lookback=document.querySelector('#forecast-lookback');lookback.value='36';change(lookback);await wait();assert.ok(document.querySelector('#oos-results').textContent.includes('추정창 36개월'));const method=document.querySelector('#forecast-method');method.value='scenario';change(method);const drift=document.querySelector('#forecast-drift');drift.value='10';change(drift);await wait();assert.equal(document.querySelector('#forecast-drift-label').hidden,false);assert.ok(!document.querySelector('#forecast-chart').innerHTML.includes('NaN'));
 click('[data-tab="hedge"]');for(const [key,value] of [['localReturn','5'],['fxReturn','-10'],['premium','-2']]){const input=document.querySelector('[data-hedge="'+key+'"]');input.value=value;change(input);}confirm.checked=true;change(confirm);const ratio=document.querySelector('#hedge-ratio');ratio.value='100';ratio.dispatchEvent(new dom.Event('input',{bubbles:true}));assert.ok(document.querySelector('#hedge-metrics').textContent.includes('2.50'));
 click('[data-tab="allocation"]');const point=document.querySelector('[data-frontier="12"]');point.dispatchEvent(new dom.Event('click',{bubbles:true}));assert.ok(document.querySelector('#selected-summary').textContent.includes('조합 선택'));click('#allocation-csv');
 assert.ok(fetches.every(url=>url.startsWith('data/')),'unexpected external fetch');
 console.log(JSON.stringify({result:'PASS',fourTabs:true,allocationSVG:true,fxSVG:true,hedgeCurrencies:4,cmaAssets:7,storage:true,downloads:downloads.length,fetches:fetches.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
