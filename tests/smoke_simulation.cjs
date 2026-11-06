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
const defaults=[-1,-.5,0,.5,1];
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
 const customInputs=()=>[...document.querySelectorAll('#simulation-custom-list [data-custom-rho]')];
 const customRanges=()=>[...document.querySelectorAll('#simulation-custom-list [data-custom-range]')];
 const customChange=(index,value,type='input',range=false)=>{const el=(range?customRanges():customInputs())[index];assert.ok(el,'Custom '+index);el.value=String(value);event(el,type)};
 const click=selector=>{const el=typeof selector==='string'?document.querySelector(selector):selector;assert.ok(el,String(selector));assert.equal(el.disabled,false,'button enabled: '+selector);event(el,'click')};
 const csv=id=>{const button=document.querySelector('[data-chart-csv="'+id+'"]');assert.ok(button,id);assert.equal(button.disabled,false,id);const n=downloads.length;click(button);assert.equal(downloads.length,n+1,id);return JSON.parse(downloads.at(-1).body)};
 return {dom,document,$,event,change,customInputs,customRanges,customChange,click,csv,snapshots,downloads};
}
function objects(rows){const [header,...body]=rows;return body.map(row=>Object.fromEntries(header.map((name,i)=>[name,row[i]])))}
function near(a,b,label){assert.ok(Math.abs(a-b)<1e-10,`${label}: ${a} != ${b}`)}
(async()=>{
 const h=await boot();const {$,document,change,customInputs,customRanges,customChange,click,csv,snapshots,event}=h;
 assert.equal($('error').hidden,true,$('error').textContent);assert.equal($('results').hidden,false);
 assert.equal($('quality'),null,'simulation quality annotation is omitted from the UI');
 assert.equal($('basis').value,'local');assert.equal($('mode').value,'correlation');assert.equal($('evaluation').value,'holdout');
 assert.equal($('rf').disabled,true);assert.equal($('performance-end').disabled,false);
 assert.ok(document.querySelector('#cma-panel-correlation #correlation-simulation'),'simulation belongs to Correlation');
 assert.equal(document.querySelector('#cma-panel-reference #correlation-simulation'),null);
 assert.deepEqual(customInputs().map(el=>Number(el.value)),defaults);
 assert.equal(Boolean($('show-observed').checked),false,'default view focuses on custom scenarios');
 const opts=()=>({start:$('start').value,end:$('end').value,performanceEnd:$('performance-end').value,basis:$('basis').value,mode:$('mode').value,objective:$('objective').value,rf:$('objective').value==='minVol'?0:Number($('rf').value)/100,customRhos:customInputs().map(el=>Number(el.value)),evaluation:$('evaluation').value});
 function verifyAll(){
  const result=S.calculate(data,opts());
  const visible=result.scenarios.filter(s=>$('show-observed').checked||s.id.startsWith('custom-'));
  assert.equal($('error').hidden,true,$('error').textContent);
  const table=objects(csv(ids[0]));assert.equal(table.length,visible.length);
  table.forEach((row,i)=>{const scenario=visible[i];assert.equal(row.scenario,scenario.id);assert.match(row.data_quality,/검증 대기/);near(row.correlation,scenario.rho,'rho');near(row.equity_weight,scenario.optimum.weight,'weight');assert.equal(row.actual_start,scenario.startDate);assert.equal(row.actual_end,scenario.endDate)});
  const frontier=objects(csv(ids[1]));assert.ok(frontier.length>=visible.length);
  for(const scenario of visible){const rows=frontier.filter(row=>row.scenario===scenario.id&&row.point_type==='efficient');assert.equal(rows.length,scenario.frontier.length);rows.forEach((row,i)=>{near(row.expected_return_annual,scenario.frontier[i].expectedReturn,'frontier mean');near(row.volatility_annual,scenario.frontier[i].annualVol,'frontier volatility')})}
  assert.equal(new Set(frontier.map(row=>row.scenario)).size,visible.length,'hidden scenarios do not leak into frontier CSV');
  assert.ok($('frontier').querySelector('svg'));assert.match($('baseline').textContent,/μ/);
  assert.doesNotMatch($('performance-legend').textContent,/60:40/);
  assert.doesNotMatch($('performance-stats').textContent,/60:40/);
  if(!result.performance.error){
   const raw=csv(ids[2]),p=objects(raw);assert.equal(p.length,result.performance.points.length);assert.ok($('performance').querySelector('svg'));
   assert.equal(raw[0].some(name=>name.includes('benchmark')),false,'60:40 removed from export');
   const base=result.performance.keys.indexOf('custom-1');
   result.performance.points.forEach((point,i)=>{assert.equal(p[i].date,point.date);visible.forEach(s=>{const j=result.performance.keys.indexOf(s.id);near(p[i][s.id+'_index_100'],point.values[j],'performance CSV');near(p[i][s.id+'_equity_weight'],s.optimum.weight,'performance weight CSV');near(p[i][s.id+'_difference_pt'],point.values[j]-point.values[base],'difference CSV uses first Custom')})});
   assert.equal(p[0].performance_view,$('performance-view').value);assert.equal(p[0].include_observed,Boolean($('show-observed').checked));
   assert.equal(p[0].custom_rhos,opts().customRhos.join(';'));
   assert.equal(raw[0].filter(name=>name.endsWith('_index_100')).length,visible.length,'only visible performance series exported');
   assert.equal($('performance-period').textContent,result.performance.startDate+' – '+result.performance.endDate);
   assert.equal(p[0].rebalance,'monthly');assert.equal(p[0].evaluation,opts().evaluation);
  }
  return result;
 }
 const initial=verifyAll();
 const overlapping=initial.scenarios.filter(s=>s.id.startsWith('custom-')).some((s,i,rows)=>rows.slice(i+1).some(other=>Math.abs(s.optimum.weight-other.optimum.weight)<1e-12));
 assert.equal(Boolean($('overlap').textContent),overlapping,'identical optima disclose overlapping performance');
 assert.equal(initial.performance.startDate,opts().end,'available training-end month-end anchors holdout');assert.ok(initial.performance.points.slice(1).every(point=>point.date>opts().end),'all realized holdout returns end after training');
 // Multiple custom inputs retain their own value, colour and linked calculation.
 const before=objects(csv(ids[0]));customChange(1,-.65);near(Number(customRanges()[1].value),-.65,'number/range synchronization');verifyAll();
 const after=objects(csv(ids[0]));near(after[0].correlation,before[0].correlation,'unchanged first Custom');assert.notEqual(after[1].equity_weight,before[1].equity_weight,'edited correlation changes optimum');
 customChange(2,.35,'input',true);near(Number(customInputs()[2].value),.35,'range/number synchronization');verifyAll();
 const colorsBefore=[...$('frontier-legend').querySelectorAll('i')].map(el=>el.getAttribute('style'));
 $('show-observed').checked=true;event($('show-observed'),'change');verifyAll();
 const colorsAfter=[...$('frontier-legend').querySelectorAll('i')].slice(3).map(el=>el.getAttribute('style'));
 assert.deepEqual(colorsAfter,colorsBefore,'Custom colours remain stable when observed scenarios are shown');
 // Difference view remains anchored to Custom 1 even with observed series first.
 const rawIndices=objects(csv(ids[2])).map(row=>row['custom-2_index_100']);
 change('performance-view','difference');const differenceResult=verifyAll();
 assert.match($('performance').querySelector('svg').getAttribute('aria-label'),/첫 Custom 대비/);
 assert.deepEqual(objects(csv(ids[2])).map(row=>row['custom-2_index_100']),rawIndices,'view selection preserves raw performance');
 const diffSurface=$('performance').querySelector('svg');event(diffSurface,'focus');event(diffSurface,'keydown',{key:'End'});
 const customRow=[...$('performance').querySelectorAll('.simulation-tip-line')].find(el=>el.textContent.includes('Custom 1 · ρ = -1.00'));
 assert.ok(customRow);assert.match(customRow.textContent,/0\.00 pt$/,'first Custom difference is zero');
 const last=differenceResult.performance.points.at(-1),customIndex=differenceResult.performance.keys.indexOf('custom-2'),baseIndex=differenceResult.performance.keys.indexOf('custom-1');
 const expectedDifference=(last.values[customIndex]-last.values[baseIndex]).toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2});
 const comparisonRow=[...$('performance').querySelectorAll('.simulation-tip-line')].find(el=>el.textContent.includes('Custom 2 · ρ = -0.65'));
 assert.ok(comparisonRow.textContent.endsWith(expectedDifference+' pt'),'hover reports the difference, not raw index');
 change('performance-view','index');verifyAll();
 $('show-observed').checked=false;event($('show-observed'),'change');verifyAll();
 click('#simulation-custom-add');assert.equal(customInputs().length,6);verifyAll();
 click('#simulation-custom-add');assert.equal(customInputs().length,7);assert.equal($('custom-add').disabled,true);verifyAll();
 while(customInputs().length>1){const buttons=document.querySelectorAll('#simulation-custom-list [data-custom-remove]');click(buttons[buttons.length-1]);verifyAll()}
 assert.equal(document.querySelector('#simulation-custom-list [data-custom-remove]').disabled,true,'at least one Custom remains');
 click('#simulation-custom-preset');assert.deepEqual(customInputs().map(el=>Number(el.value)),defaults);assert.equal($('custom-add').disabled,false);verifyAll();
 // All estimation and performance controls drive newly calculated snapshots.
 change('start','2015-12-31');verifyAll();
 change('end','2022-12-30');verifyAll();
 change('performance-end','2025-12-31');verifyAll();
 change('basis','krw');verifyAll();
 change('mode','full');verifyAll();assert.match($('method').textContent,/재추정/);
 change('objective','maxSharpe');assert.equal($('rf').disabled,false);verifyAll();
 change('rf','2.5');verifyAll();
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
 // Invalid and duplicate values clear exports/graphics; recovery restores every series.
 const assertCleared=()=>{assert.equal($('error').hidden,false);assert.equal($('results').hidden,true);for(const id of ids){assert.equal(snapshots.has(id),false);assert.equal(document.querySelector('[data-chart-csv="'+id+'"]').disabled,true)}assert.equal($('frontier').innerHTML,'');assert.equal($('performance').innerHTML,'')};
 customChange(1,'');assertCleared();customChange(1,'1.2');assertCleared();customChange(1,'-1.2');assertCleared();customChange(1,'1');assertCleared();customChange(1,'-.25');verifyAll();
 change('rf','');assertCleared();change('rf','2');verifyAll();
 change('start','2026-01-01');assertCleared();change('start','2015-12-31');verifyAll();
 // Empty future window suppresses performance only, preserving valid model results.
 change('evaluation','holdout');change('end','2026-10-30');change('performance-end','2026-10-30');
 assert.equal($('error').hidden,true);assert.equal($('results').hidden,false);assert.ok($('frontier').querySelector('svg'));
 assert.equal(snapshots.has(ids[0]),true);assert.equal(snapshots.has(ids[1]),true);assert.equal(snapshots.has(ids[2]),false);assert.equal(document.querySelector('[data-chart-csv="'+ids[2]+'"]').disabled,true);
 click('#simulation-reset');verifyAll();assert.equal($('mode').value,'correlation');assert.deepEqual(customInputs().map(el=>Number(el.value)),defaults);assert.equal(Boolean($('show-observed').checked),false);
 const failed=await boot(async()=>({ok:false,status:503}));assert.equal(failed.$('error').hidden,false);assert.match(failed.$('error').textContent,/503/);assert.equal(failed.$('results').hidden,true);assert.equal(failed.snapshots.size,0);
 console.log('Correlation Simulation DOM: multiple Custom inputs, linked CSV/plots, observed visibility, limits, chart inspection, invalidation, recovery and fetch failure passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
