'use strict';
// Behavioral DOM verification; rendering/layout are verified separately in-browser.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const root=path.resolve(__dirname,'..');
const S=require('../template/platform/simulation.js');
const Export=require('../template/platform/chart-export.js');
const data=JSON.parse(fs.readFileSync(path.join(root,'template/platform/simulation-data.json'),'utf8'));
const html=fs.readFileSync(path.join(root,'template/platform.html'),'utf8');
const uiSource=fs.readFileSync(path.join(root,'template/platform/simulation-ui.js'),'utf8');
const ids=['simulation-table','simulation-frontier','simulation-performance'];
async function boot(fetchOverride) {
 const {window:dom,document}=parseHTML(html);
 Object.defineProperty(dom.HTMLSelectElement.prototype,'value',{get(){return ([...this.options].find(x=>x.selected)||this.options[0])?.value||''},set(value){for(const option of this.options)option.removeAttribute('selected');[...this.options].find(option=>option.value===String(value))?.setAttribute('selected','')},configurable:true});
 const snapshots=new Map(),downloads=[];
 const realExport=Export.create({document,download:(filename,body)=>downloads.push({filename,body}),csv:rows=>JSON.stringify(rows)});
 const chartExport={set(id,snapshot){snapshots.set(id,snapshot.rows);realExport.set(id,snapshot)},clear(id){snapshots.delete(id);realExport.clear(id)}};
 const sandbox={CollaboSimulation:S,document,console,Date,Math,Number,Array,Map,Set,JSON,Promise,Intl};
 vm.runInNewContext(uiSource,sandbox);
 const fetch=fetchOverride|| (async url=>{assert.equal(url,'platform/simulation-data.json');return {ok:true,json:async()=>data}});
 const ui=sandbox.CollaboSimulationUI.create({document,chartExport,fetch});await ui.load();
 const $=name=>document.getElementById('simulation-'+name);
 const event=(el,type,properties={})=>{const e=new dom.Event(type,{bubbles:true,cancelable:true});Object.assign(e,properties);el.dispatchEvent(e)};
 const change=(name,value,type='change')=>{const el=$(name);assert.ok(el,name);el.value=String(value);event(el,type)};
 const click=selector=>{const el=document.querySelector(selector);assert.ok(el,selector);event(el,'click')};
 const csv=id=>{const button=document.querySelector('[data-chart-csv="'+id+'"]');assert.ok(button,id);assert.equal(button.disabled,false,id);const n=downloads.length;click('[data-chart-csv="'+id+'"]');assert.equal(downloads.length,n+1,id);return JSON.parse(downloads.at(-1).body)};
 return {dom,document,$,event,change,click,csv,snapshots,downloads};
}
function objects(rows){const [header,...body]=rows;return body.map(row=>Object.fromEntries(header.map((name,i)=>[name,row[i]])))}
function near(a,b,label){assert.ok(Math.abs(a-b)<1e-10,`${label}: ${a} != ${b}`)}
(async()=>{
 const h=await boot();const {$,document,change,click,csv,snapshots,event}=h;
 assert.equal($('error').hidden,true,$('error').textContent);assert.equal($('results').hidden,false);
 assert.match($('quality').textContent,/KBPMABIN.*검증 대기.*잠정/);
 assert.equal($('basis').value,'local');assert.equal($('mode').value,'correlation');assert.equal($('evaluation').value,'holdout');
 assert.equal($('rf').disabled,true);assert.equal($('performance-end').disabled,false);
 assert.ok(document.querySelector('#cma-panel-reference #correlation-simulation'),'simulation must be in Reference Portfolio');
 assert.ok(document.querySelector('#reference-results').compareDocumentPosition($('title'))&4,'simulation follows reference results');
 const opts=()=>({start:$('start').value,end:$('end').value,performanceEnd:$('performance-end').value,basis:$('basis').value,mode:$('mode').value,objective:$('objective').value,rf:$('objective').value==='minVol'?0:Number($('rf').value)/100,customRho:Number($('rho-value').value),evaluation:$('evaluation').value});
 function verifyAll(){
  const result=S.calculate(data,opts());
  assert.equal($('error').hidden,true,$('error').textContent);
  const table=objects(csv(ids[0]));assert.equal(table.length,4);
  table.forEach((row,i)=>{const scenario=result.scenarios[i];assert.equal(row.scenario,scenario.id);assert.match(row.data_quality,/검증 대기/);near(row.correlation,scenario.rho,'rho');near(row.equity_weight,scenario.optimum.weight,'weight');assert.equal(row.actual_start,scenario.startDate);assert.equal(row.actual_end,scenario.endDate)});
  const frontier=objects(csv(ids[1]));assert.ok(frontier.length>4);
  for(const scenario of result.scenarios){const rows=frontier.filter(row=>row.scenario===scenario.id&&row.point_type==='efficient');assert.equal(rows.length,scenario.frontier.length);rows.forEach((row,i)=>{near(row.expected_return_annual,scenario.frontier[i].expectedReturn,'frontier mean');near(row.volatility_annual,scenario.frontier[i].annualVol,'frontier volatility')})}
  assert.ok($('frontier').querySelector('svg'));assert.match($('baseline').textContent,/μ/);
  if(!result.performance.error){
   const p=objects(csv(ids[2]));assert.equal(p.length,result.performance.points.length);assert.ok($('performance').querySelector('svg'));
   result.performance.points.forEach((point,i)=>{assert.equal(p[i].date,point.date);result.performance.keys.forEach((key,j)=>near(p[i][key+'_index_100'],point.values[j],'performance CSV'))});
   assert.equal($('performance-period').textContent,result.performance.startDate+' – '+result.performance.endDate);
   assert.equal(p[0].rebalance,'monthly');assert.equal(p[0].evaluation,opts().evaluation);
  }
  return result;
 }
 const initial=verifyAll();assert.equal(initial.performance.startDate,opts().end,'available training-end month-end anchors holdout');assert.ok(initial.performance.points.slice(1).every(point=>point.date>opts().end),'all realized holdout returns end after training');
 // All controls drive newly calculated snapshots, not stale cached output.
 change('start','2015-12-31');verifyAll();
 change('end','2022-12-30');verifyAll();
 change('performance-end','2025-12-31');verifyAll();
 change('basis','krw');verifyAll();
 change('mode','full');verifyAll();assert.match($('method').textContent,/재추정/);
 change('objective','maxSharpe');assert.equal($('rf').disabled,false);verifyAll();
 change('rf','2.5');verifyAll();
 change('rho','-0.65','input');assert.equal($('rho-value').value,'-0.65');verifyAll();
 change('rho-value','0.35');near(Number($('rho').value),.35,'number/range synchronization');verifyAll();
 change('rho-value','-0.40','input');near(Number($('rho').value),-.40,'live number/range synchronization');verifyAll();
 change('evaluation','inSample');assert.equal($('performance-end').disabled,true);verifyAll();assert.match($('performance-mode').textContent,/표본내/);
 // Focus, keyboard and pointer use real SVG event handlers without needing layout.
 for(const name of ['frontier','performance']){
  const surface=$(name).querySelector('svg');const tip=$(name).querySelector('.simulation-tip');
  surface.getBoundingClientRect=()=>({left:0,top:0,width:960,height:340});
  assert.equal(surface.getAttribute('tabindex'),'0');assert.ok(document.getElementById(surface.getAttribute('aria-describedby')));
  event(surface,'focus');assert.equal(tip.hidden,false);const first=tip.textContent;
  event(surface,'keydown',{key:'End'});assert.equal(tip.hidden,false);assert.notEqual(tip.textContent,first,'End inspects final point');
  event(surface,'keydown',{key:'ArrowLeft'});assert.equal(tip.hidden,false);
  event(surface,'keydown',{key:'Home'});assert.equal(tip.textContent,first);
  event(surface,'keydown',{key:'Escape'});assert.equal(tip.hidden,true);
  event(surface,'pointermove',{clientX:400,clientY:120});assert.equal(tip.hidden,false);assert.equal(surface.querySelector('[data-inspection]').getAttribute('visibility'),'visible');
  event(surface,'pointerleave');assert.equal(tip.hidden,true);
 }
 // Invalid inputs clear exports and graphics; valid input restores both.
 const assertCleared=()=>{assert.equal($('error').hidden,false);assert.equal($('results').hidden,true);for(const id of ids){assert.equal(snapshots.has(id),false);assert.equal(document.querySelector('[data-chart-csv="'+id+'"]').disabled,true)}assert.equal($('frontier').innerHTML,'');assert.equal($('performance').innerHTML,'')};
 change('rho-value','');assertCleared();change('rho-value','1.2');assertCleared();change('rho-value','.25');verifyAll();
 change('rf','');assertCleared();change('rf','2');verifyAll();
 change('start','2026-01-01');assertCleared();change('start','2015-12-31');verifyAll();
 // Empty future window suppresses performance only, preserving valid model results.
 change('evaluation','holdout');change('end','2026-10-30');change('performance-end','2026-10-30');
 assert.equal($('error').hidden,true);assert.equal($('results').hidden,false);assert.ok($('frontier').querySelector('svg'));
 assert.equal(snapshots.has(ids[0]),true);assert.equal(snapshots.has(ids[1]),true);assert.equal(snapshots.has(ids[2]),false);assert.equal(document.querySelector('[data-chart-csv="'+ids[2]+'"]').disabled,true);
 click('#simulation-reset');verifyAll();assert.equal($('mode').value,'correlation');assert.equal($('rho-value').value,'0.00');
 const failed=await boot(async()=>({ok:false,status:503}));assert.equal(failed.$('error').hidden,false);assert.match(failed.$('error').textContent,/503/);assert.equal(failed.$('results').hidden,true);assert.equal(failed.snapshots.size,0);
 console.log('Correlation Simulation DOM: controls, CSV, chart inspection, invalidation, recovery and fetch failure passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
