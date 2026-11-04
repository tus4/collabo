'use strict';
// Behavioral integration checks; no browser-layout claims.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {parseHTML} = require('linkedom');
const XLSX = require('../template/platform/vendor/xlsx.full.min.js');
const root = path.resolve(__dirname, '..');
const STORAGE_KEY = 'collabo:investment-platform:scenario:v2';

function boot() {
  const {window:dom, document} = parseHTML(fs.readFileSync(path.join(root,'template/platform.html'),'utf8'));
  Object.defineProperty(dom.HTMLSelectElement.prototype,'value',{
    get(){return ([...this.options].find(o=>o.selected)||this.options[0])?.value||'';},
    set(value){for(const option of this.options)option.removeAttribute('selected');const selected=[...this.options].find(option=>option.value===value);if(selected)selected.setAttribute('selected','');}, configurable:true
  });
  const storage=new Map(), downloads=[], events=new dom.EventTarget();
  class TestURL extends URL {static createObjectURL(blob){downloads.push(blob);return 'blob:test';}static revokeObjectURL(){}}
  const sandbox={document,console,Date,Math,Number,Array,Map,Set,JSON,Promise,Intl,URL:TestURL,Blob,
    ArrayBuffer,Uint8Array,DataView,TextDecoder,TextEncoder,performance,setTimeout,clearTimeout,
    location:{hash:'',href:'https://tus4.github.io/collabo/'},history:{replaceState(){}},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),
    requestAnimationFrame:cb=>setTimeout(cb,0),Event:dom.Event,
    fetch:async url=>{try{return {ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(root,'docs',url),'utf8'))};}catch(_){return {ok:false,status:404};}}
  };
  sandbox.window=sandbox;sandbox.self=sandbox;
  const context=vm.createContext(sandbox);
  for(const script of document.querySelectorAll('script[src]')) {
    const file=script.getAttribute('src');
    assert.ok(file.startsWith('platform/'));
    vm.runInContext(fs.readFileSync(path.join(root,'template',file),'utf8'),context,{filename:file});
  }
  return {dom,document,storage,downloads};
}

const {dom,document,storage,downloads}=boot();
const $=id=>document.getElementById(id);
const wait=()=>new Promise(resolve=>setTimeout(resolve,70));
function click(id){const el=$(id);assert.ok(el,id);el.dispatchEvent(new dom.Event('click',{bubbles:true}));}
function event(el,type='change'){
  const e=new dom.Event(type,{bubbles:true});el.dispatchEvent(e);
  Object.defineProperty(e,'target',{value:el,configurable:true});
}
function set(id,value,type='change'){const el=$(id);assert.ok(el,id);el.value=String(value);event(el,type);}
function setCma(i,key,value){const el=document.querySelector('#cma-table [data-asset="'+i+'"][data-field="'+key+'"]');assert.ok(el);el.value=String(value);event(el);}
function error(){return $('alternative-error').hidden?'':$('alternative-error').textContent;}
function rowCount(){return document.querySelectorAll('#cma-table tbody tr').length;}
async function snapshot(){click('export-scenario');const result=JSON.parse(await downloads.at(-1).text());delete result.savedAt;return result;}
async function upload(id,file){Object.defineProperty($(id),'files',{value:[file],configurable:true});event($(id));await wait();}
async function importScenario(state){const text=JSON.stringify(state);await upload('scenario-file',{name:'scenario.json',size:Buffer.byteLength(text),text:async()=>text});}
async function add(name,mu=6,vol=10){set('alternative-select','new');set('alternative-name',name);set('alternative-mu',mu);set('alternative-vol',vol);click('alternative-apply');await wait();assert.equal(error(),'');}
function bookBytes(sheets){const workbook=XLSX.utils.book_new();for(const [name,rows] of sheets)XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(rows),name);return XLSX.write(workbook,{type:'array',bookType:'xlsx',compression:true});}
async function uploadWorkbook(name,bytes){await upload('alternative-file',{name,size:bytes.byteLength,arrayBuffer:async()=>bytes});}
function near(a,b,tol=1e-8){assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);}
function assertReference(equityWeight){
  assert.equal($('reference-results').hidden,false,'Reference stays usable with dynamic CMA assets');
  assert.equal($('reference-error').hidden,true);
  assert.equal(document.querySelectorAll('#reference-assets tbody tr').length,2,'Reference component count remains two');
  assert.equal(document.querySelectorAll('#reference-correlation tbody tr').length,3,'Reference observed matrix remains three by three');
  assert.ok([...document.querySelectorAll('#reference-correlation tbody tr')].every(row=>row.querySelectorAll('td').length===3));
  assert.match($('reference-source').textContent,/data_bb\.xlsx/);
  assert.match($('reference-source').textContent,/월별 리밸런싱/);
  assert.match($('reference-correlation').textContent,/레퍼런스/);
  assert.doesNotMatch($('reference-metrics').textContent+$('reference-assets').textContent,/undefined|NaN/);
  near(Number($('reference-equity').value)/100,equityWeight);
}

(async()=>{
  await wait();
  const original=await snapshot();
  assert.equal(rowCount(),8);
  assert.equal(original.assets[7].name,'유동자산');
  assertReference(.6);
  assert.equal(document.querySelectorAll('#alternative-list tbody tr').length,1);

  await add('Infrastructure <A>');
  assert.equal(rowCount(),9);
  assert.equal(document.querySelectorAll('#weights-table tbody tr').length,9);
  assert.equal(document.querySelectorAll('#overview-portfolios .summary-card')[0].querySelectorAll('.summary-weight').length,9);
  assert.equal(document.querySelector('#alternative-list a'),null,'custom name must render as text');
  let state=await snapshot(),custom=state.assets.at(-1),customId=custom.id;
  near(custom.mu,.06);near(custom.vol,.10);assert.equal(custom.current,0);assert.equal(custom.saa,0);
  near(state.assets.reduce((sum,a)=>sum+a.current,0),1);near(state.assets.reduce((sum,a)=>sum+a.saa,0),1);
  assert.equal(state.corr.length,9);assert.equal(state.corr.at(-1).at(-1),1);
  assert.deepEqual(state.corr.at(-1).slice(0,-1),Array(8).fill(0));
  assert.deepEqual(state.assets.slice(0,8).map(a=>a.current),original.assets.map(a=>a.current));
  assertReference(.6);
  const beforeReferenceEdit=state;
  set('reference-equity',70,'input');assertReference(.7);
  state=await snapshot();assert.deepEqual(state.assets,beforeReferenceEdit.assets);assert.deepEqual(state.corr,beforeReferenceEdit.corr);
  near(state.reference.equityWeight,.7);

  set('alternative-mu',7.25,'input');click('alternative-apply');await wait();
  state=await snapshot();near(state.assets.at(-1).mu,.0725);
  assertReference(.7);
  const valid=state;
  set('alternative-vol',-1,'input');click('alternative-apply');await wait();
  assert.ok(error());assert.deepEqual(await snapshot(),valid,'invalid vol must be atomic');
  set('alternative-select',customId);
  set('alt-corr-asset-0',.99,'input');set('alt-corr-asset-1',-.99,'input');click('alternative-apply');await wait();
  assert.match(error(),/준정부호/);assert.deepEqual(await snapshot(),valid,'invalid full correlation matrix must be atomic');

  set('alternative-select','asset-6');set('alternative-mu',5.75,'input');click('alternative-apply');await wait();
  assert.equal(error(),'');near((await snapshot()).assets[6].mu,.0575);
  assert.equal($('alternative-remove').hidden,true,'baseline alternative cannot be deleted');
  set('alternative-select',customId);
  setCma(0,'current',10);setCma(8,'current',10);
  click('alternative-remove');await wait();
  assert.match(error(),/0%/);assert.equal(rowCount(),9);
  setCma(8,'current',0);setCma(0,'current',20);
  await add('Private Debt',5,7);const debtId=(await snapshot()).assets.at(-1).id;
  assert.equal(rowCount(),10);set('alternative-select','new');assert.equal($('alternative-apply').disabled,true);
  assertReference(.7);set('reference-equity',25,'input');assertReference(.25);
  set('alternative-select',customId);click('alternative-remove');await wait();
  state=await snapshot();assert.equal(state.assets.length,9);assert.equal(state.assets.at(-1).id,debtId);
  assert.ok(!state.assets.some(a=>a.id===customId));assert.equal(state.corr.length,9);assert.ok(state.corr.every(row=>row.length===9));
  customId=debtId;

  click('save-scenario');const saved=JSON.parse(storage.get(STORAGE_KEY));
  assert.equal(saved.version,2);assert.equal(saved.assets.length,9);
  set('alternative-select',customId);set('alternative-mu',9,'input');click('alternative-apply');await wait();
  click('load-scenario');await wait();state=await snapshot();near(state.assets.find(a=>a.id===customId).mu,.05);
  assertReference(.25);
  await importScenario(saved);assert.equal(rowCount(),9);
  const v1={...original,version:1,assets:original.assets.slice(0,7),corr:original.corr.slice(0,7).map(row=>row.slice(0,7))};
  await importScenario(v1);assert.equal(rowCount(),8,'legacy v1 import appends liquid asset');
  assert.equal((await snapshot()).version,2,'legacy scenarios migrate to v2');
  assert.equal((await snapshot()).assets[7].name,'유동자산');

  // Real XLSX bytes exercise parser, sheet controls, column mapping and CMA apply.
  const x=Array.from({length:12},(_,i)=>.004+.012*Math.sin(i*.8));
  const centered=x.map(v=>v-x.reduce((a,b)=>a+b,0)/x.length);
  const z0=x.map((_,i)=>Math.cos(i*1.4)),zm=z0.reduce((a,b)=>a+b,0)/z0.length;
  const z=z0.map(v=>v-zm),projection=z.reduce((s,v,i)=>s+v*centered[i],0)/centered.reduce((s,v)=>s+v*v,0);
  const orth=z.map((v,i)=>v-projection*centered[i]),scale=Math.sqrt(centered.reduce((s,v)=>s+v*v,0)/orth.reduce((s,v)=>s+v*v,0));
  const y=x.map((_,i)=>.003+.2*centered[i]+Math.sqrt(.96)*scale*orth[i]);
  const dates=x.map((_,i)=>`2025-${String(i+1).padStart(2,'0')}-28`);
  const rows=[['Date','Uploaded Asset','국내주식'],...dates.map((date,i)=>[date,x[i],y[i]])];
  const bytes=bookBytes([['Notes',[['ignore','unused']]],['Monthly',rows]]);
  set('alternative-select','new');await uploadWorkbook('alternative-fixture.xlsx',bytes);
  assert.equal(error(),'');assert.equal($('alternative-sheet').options.length,2);
  set('alternative-sheet','1');set('alternative-kind','return');set('alternative-unit','decimal');set('alternative-basis','KRW-total');
  assert.equal(document.querySelector('[data-alternative-map="asset-4"]').value,'2','CMA name automatically maps');
  click('alternative-estimate');await wait();assert.equal(error(),'');
  assert.match($('alternative-preview').textContent,/12개/);near(Number($('alt-corr-asset-4').value),.2);
  near(Number($('alternative-mu').value)/100,x.reduce((a,b)=>a+b,0));
  const beforeDirtyPreview=await snapshot();
  set('alternative-unit','percent');
  assert.equal($('alternative-apply').disabled,true,'changed units invalidate estimated draft');
  click('alternative-apply');await wait();
  assert.deepEqual(await snapshot(),beforeDirtyPreview,'dirty estimates cannot enter CMA');
  set('alternative-unit','decimal');
  assert.equal($('alternative-apply').disabled,true,'changing back still requires fresh estimation');
  click('alternative-estimate');await wait();assert.equal(error(),'');assert.equal($('alternative-apply').disabled,false);
  click('alternative-apply');await wait();assert.equal(error(),'');state=await snapshot();assert.equal(state.assets.length,9);
  custom=state.assets.at(-1);assert.equal(custom.name,'Uploaded Asset');assert.equal(custom.provenance.method,'history');
  assert.equal(custom.provenance.file,'alternative-fixture.xlsx');assert.equal(custom.provenance.compared[0].count,12);
  near(state.corr.at(-1)[4],.2);near(state.corr[4].at(-1),.2);
  click('save-scenario');click('load-scenario');await wait();state=await snapshot();assert.equal(state.assets.at(-1).provenance.count,12);

  // No common return dates: do not silently substitute zero correlation or apply.
  const disjoint=[['Date','No Overlap','국내주식'],...dates.map((date,i)=>[date,i<6?x[i]:null,i>=6?y[i]:null])];
  set('alternative-select','new');await uploadWorkbook('disjoint.xlsx',bookBytes([['Data',disjoint]]));
  set('alternative-kind','return');set('alternative-basis','KRW-total');
  click('alternative-estimate');await wait();assert.match(error(),/상관계수 산출 불가/);
  assert.equal($('alternative-preview').textContent,'');assert.equal(rowCount(),9);
  console.log('Alternative DOM smoke: dynamic assets, atomic validation, weights/removal, 10-asset cap, v1/v2 persistence, real XLSX sheet mapping and estimates passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
