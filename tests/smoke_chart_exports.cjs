// Current plotted datasets must be downloadable without stale snapshots.
// Behavioral DOM coverage only; this does not verify browser layout.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const exporter=require('../template/platform/chart-export.js');
const root=path.resolve(__dirname,'..');
const {window:dom,document}=parseHTML(fs.readFileSync(path.join(root,'template/platform.html'),'utf8'));
Object.defineProperty(dom.HTMLSelectElement.prototype,'value',{get(){return ([...this.options].find(x=>x.selected)||this.options[0])?.value||''},set(value){for(const option of this.options)option.removeAttribute('selected');[...this.options].find(option=>option.value===String(value))?.setAttribute('selected','')},configurable:true});
const downloads=[],storage=new Map(),events=new dom.EventTarget();
class TestURL extends URL{static createObjectURL(blob){downloads.push(blob);return 'blob:test'}static revokeObjectURL(){}}
const sandbox={document,console,Date,Math,Number,Array,Map,Set,JSON,Promise,Intl,URL:TestURL,Blob,performance,setTimeout,clearTimeout,location:{hash:''},history:{replaceState(){}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),requestAnimationFrame:callback=>setTimeout(callback,0),Event:dom.Event,fetch:async url=>{try{return {ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(root,'docs',url),'utf8'))}}catch(_){return {ok:false,status:404}}}};
sandbox.window=sandbox;sandbox.self=sandbox;
const context=vm.createContext(sandbox);
for(const script of document.querySelectorAll('script[src]'))vm.runInContext(fs.readFileSync(path.join(root,'template',script.getAttribute('src')),'utf8'),context);
const wait=()=>new Promise(resolve=>setTimeout(resolve,60));
const click=selector=>{const element=document.querySelector(selector);assert.ok(element,selector);element.dispatchEvent(new dom.Event('click',{bubbles:true}));};
const change=(id,value,event='change')=>{const element=document.getElementById(id);element.value=String(value);element.dispatchEvent(new dom.Event(event,{bubbles:true}));};
const parse=text=>{const rows=text.replace(/^\ufeff/,'').trim().split(/\r?\n/).map(line=>[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match=>match[1].replace(/""/g,'"')));const header=rows.shift();return {header,rows:rows.map(row=>Object.fromEntries(header.map((key,i)=>[key,row[i]])))}};
async function csv(id){const button=document.querySelector('[data-chart-csv="'+id+'"]');assert.ok(button,id);assert.equal(button.disabled,false,id+' disabled');const before=downloads.length;click('[data-chart-csv="'+id+'"]');assert.equal(downloads.length,before+1,id+' download missing');return parse(await downloads.at(-1).text());}
function near(actual,expected,label){assert.ok(Math.abs(Number(actual)-expected)<1e-9,label+': '+actual+' != '+expected)}
(async()=>{
 await wait();
 const correlationIds=['correlation-series-chart','correlation-rolling-chart'];
 const ids=['overview-portfolios','frontier-chart','risk-bars','hedge-chart','forecast-chart','model-a-chart','reference-chart','reference-allocation',...correlationIds,'simulation-table','simulation-frontier','simulation-performance',...Array.from({length:4},(_,i)=>'market-spark-'+i)];
 assert.equal(document.querySelectorAll('[data-chart-csv]').length,ids.length);
 for(const id of ids)assert.ok((await csv(id)).rows.length>0,id);
 // Historical pair selection is independent of editable CMA assumptions.
 const originalMatrix=document.getElementById('correlation-table').innerHTML;
 const originalCovariance=document.getElementById('covariance-table').innerHTML;
 const correlationData=JSON.parse(fs.readFileSync(path.join(root,'docs/platform/correlation-data.json'),'utf8'));
 const acwi=correlationData.series.find(series=>series.id==='ACWI_TR');
 const aggregate=correlationData.series.find(series=>series.id==='LEGATRUU');
 const acwiLevels=new Map(acwi.observations),bondLevels=new Map(aggregate.observations);
 const commonDates=acwi.observations.filter(([date,value])=>value>0&&bondLevels.get(date)>0).map(([date])=>date).sort();
 for(const [id,value] of [['first','ACWI_TR'],['second','LEGATRUU'],['start',commonDates[0]],['end',commonDates.at(-1)],['window','60']]) {
  const control=document.getElementById('correlation-'+id);
  assert.equal(control.disabled,false,id+' disabled after load');assert.equal(control.value,value,id+' default');
 }
 assert.equal(document.getElementById('correlation-series-error').hidden,true);
 assert.equal(document.querySelector('#cma-panel-correlation article').classList.contains('correlation-timeseries'),true,'time series must precede matrices');
 const defaultLevels=(await csv(correlationIds[0])).rows;
 assert.equal(defaultLevels.length,commonDates.length);
 defaultLevels.forEach((row,i)=>{
  assert.equal(row.date,commonDates[i]);assert.equal(row.series_1,'ACWI_TR');assert.equal(row.series_2,'LEGATRUU');
  near(row.series_1_level,acwiLevels.get(row.date),'ACWI source level');near(row.series_2_level,bondLevels.get(row.date),'bond source level');
 });
 near(defaultLevels[0].series_1_index_100,100,'ACWI rebase');near(defaultLevels[0].series_2_index_100,100,'bond rebase');
 const defaultRolling=(await csv(correlationIds[1])).rows;
 assert.equal(defaultRolling.length,defaultLevels.length);
 assert.equal(defaultRolling[0].series_1_return,'','first displayed level must not use a pre-start return');
 assert.equal(defaultRolling[0].rolling_correlation,'');
 assert.ok(defaultRolling.some(row=>row.rolling_correlation!==''),'full history should contain rolling estimates');
 assert.ok(defaultRolling.every(row=>row.rolling_window==='60'));
 // A different pair and window must replace both CSV snapshots immediately.
 change('correlation-first','LEGATRUU');change('correlation-second','ACWI_TR');change('correlation-window',20);
 const reversed=(await csv(correlationIds[0])).rows;
 assert.equal(reversed[0].series_1,'LEGATRUU');assert.equal(reversed[0].series_2,'ACWI_TR');
 near(reversed.at(-1).series_1_level,defaultLevels.at(-1).series_2_level,'reversed pair');
 const shorterWindow=(await csv(correlationIds[1])).rows;
 assert.ok(shorterWindow.every(row=>row.rolling_window==='20'));
 assert.ok(shorterWindow.some((row,i)=>row.rolling_correlation!==''&&defaultRolling[i].rolling_correlation===''),'shorter rolling window should become available earlier');
 // Restrict both date endpoints and rebase the first retained observation.
 const rangeStart=commonDates.at(-90),rangeEnd=commonDates.at(-10);
 change('correlation-start',rangeStart);change('correlation-end',rangeEnd);
 const ranged=(await csv(correlationIds[0])).rows;
 assert.equal(ranged[0].date,rangeStart);assert.equal(ranged.at(-1).date,rangeEnd);
 assert.ok(ranged.every(row=>row.sample_start===rangeStart&&row.sample_end===rangeEnd&&row.date>=rangeStart&&row.date<=rangeEnd));
 near(ranged[0].series_1_index_100,100,'range bond rebase');near(ranged[0].series_2_index_100,100,'range equity rebase');
 assert.equal((await csv(correlationIds[1])).rows[0].series_1_return,'','range must reset the return baseline');
 change('correlation-second','LEGATRUU');
 const sameSeries=(await csv(correlationIds[1])).rows;
 assert.ok(sameSeries.some(row=>row.rolling_correlation!==''),'same-series sample contains a rolling estimate');
 sameSeries.forEach(row=>{near(row.period_correlation,1,'same-series period correlation');if(row.rolling_correlation!=='')near(row.rolling_correlation,1,'same-series rolling correlation');});
 // Errors must clear charts, metrics and export snapshots, including manual clicks.
 change('correlation-start',commonDates.at(-1));
 assert.equal(document.getElementById('correlation-series-error').hidden,false);
 assert.match(document.getElementById('correlation-series-error').textContent,/시작일/);
 assert.equal(document.getElementById('correlation-stats').textContent,'');
 for(const id of correlationIds){
  assert.equal(document.getElementById(id).textContent,'');
  assert.equal(document.querySelector('[data-chart-csv="'+id+'"]').disabled,true);
  const count=downloads.length;click('[data-chart-csv="'+id+'"]');assert.equal(downloads.length,count,'invalid period downloaded stale '+id);
 }
 click('#correlation-reset');
 assert.equal(document.getElementById('correlation-series-error').hidden,true);
 assert.equal(document.getElementById('correlation-first').value,'ACWI_TR');assert.equal(document.getElementById('correlation-second').value,'LEGATRUU');
 assert.equal(document.getElementById('correlation-start').value,commonDates[0]);assert.equal(document.getElementById('correlation-end').value,commonDates.at(-1));
 assert.equal(document.getElementById('correlation-window').value,'60');
 assert.equal((await csv(correlationIds[0])).rows.length,defaultLevels.length);
 assert.equal(document.getElementById('correlation-table').innerHTML,originalMatrix,'historical controls modified CMA correlations');
 assert.equal(document.getElementById('covariance-table').innerHTML,originalCovariance,'historical controls modified CMA covariance');
 // A short, explicitly gapped fixture keeps CSV available without fabricating rho.
 const {window:sparseDOM,document:sparseDocument}=parseHTML(fs.readFileSync(path.join(root,'template/platform.html'),'utf8'));
 const sparseDownloads=[];
 const sparseExporter=exporter.create({document:sparseDocument,download:(name,text)=>sparseDownloads.push(JSON.parse(text)),csv:JSON.stringify});
 const sparseDates=['2026-01-05','2026-01-06','2026-01-07','2026-01-08','2026-01-09','2026-01-12'];
 const sparseData={schemaVersion:1,source:{asOf:sparseDates.at(-1)},series:[
  {id:'ACWI_TR',label:'ACWI',currency:'USD',observations:sparseDates.map((date,i)=>[date,[100,101,null,104,103,105][i]])},
  {id:'LEGATRUU',label:'Aggregate',currency:'USD',observations:sparseDates.map((date,i)=>[date,[100,102,103,104,106,107][i]])}
 ]};
 await sandbox.CollaboCorrelationUI.create({document:sparseDocument,chartExport:sparseExporter,fetch:async()=>({ok:true,json:async()=>sparseData})}).load();
 assert.equal(sparseDocument.getElementById('correlation-series-error').hidden,true);
 assert.match(sparseDocument.getElementById(correlationIds[1]).textContent,/미산출/);
 for(const id of correlationIds){
  const button=sparseDocument.querySelector('[data-chart-csv="'+id+'"]');assert.ok(button);assert.equal(button.disabled,false,'short sample should remain exportable');
  button.dispatchEvent(new sparseDOM.Event('click',{bubbles:true}));
 }
 const sparseCSV=sparseDownloads.at(-1),sparseHeaders=sparseCSV[0],sparseRows=sparseCSV.slice(1);
 assert.equal(sparseRows.length,5,'missing level should not be imputed');
 assert.ok(sparseRows.every(row=>row[sparseHeaders.indexOf('rolling_correlation')]===null),'short sample fabricated rolling correlation');
 const restarted=sparseRows.find(row=>row[sparseHeaders.indexOf('date')]==='2026-01-08');
 assert.equal(restarted[sparseHeaders.indexOf('gap_before')],true,'missing observation should mark the restarted segment');
 assert.equal(restarted[sparseHeaders.indexOf('series_1_return')],null,'return must not bridge a missing level');
 const overview=(await csv('overview-portfolios')).rows;
 assert.equal(overview.length,40,'five portfolios times eight assets');
 for(const name of ['현재','SAA','Min Vol','Max Sharpe','Target Return'])near(overview.filter(row=>row.portfolio===name).reduce((sum,row)=>sum+Number(row.weight_pct),0),100,'overview weights');
 const frontier=(await csv('frontier-chart')).rows,selected=frontier.find(row=>row.series==='selected');
 assert.equal(frontier.filter(row=>row.series==='current').length,1);
 assert.equal(frontier.filter(row=>row.series==='saa').length,1);
 for(const point of frontier)near(Object.entries(point).filter(([key])=>key.endsWith('_weight_pct')).reduce((sum,[,value])=>sum+Number(value),0),100,'frontier weights');
 const risk=(await csv('risk-bars')).rows;near(risk.reduce((sum,row)=>sum+Number(row.risk_contribution_annual_pct_point),0),Number(selected.vol_annual_pct),'Euler risk sum');
 const reference=(await csv('reference-chart')).rows;
 for(const key of ['equity_index_100','bond_index_100','reference_index_100'])near(reference[0][key],100,'reference start');
 const referenceData=JSON.parse(fs.readFileSync(path.join(root,'docs/platform/reference-data.json'),'utf8'));
 const expected=sandbox.CollaboReference.calculate(referenceData,{equityWeight:.6,lookback:120,basis:'local'});
 near(reference.at(-1).reference_index_100,100*(1+expected.rows.at(-1).cumulative),'reference terminal index');
 change('reference-equity',100,'input');
 const equityOnly=(await csv('reference-chart')).rows;equityOnly.forEach(row=>near(row.reference_index_100,Number(row.equity_index_100),'equity-only chart'));
 near((await csv('reference-allocation')).rows[0].weight_pct,100,'reference weight CSV');
 change('reference-equity','','input');
 assert.equal(document.querySelector('[data-chart-csv="reference-chart"]').disabled,true,'invalid reference must clear export');
 const before=downloads.length;click('[data-chart-csv="reference-chart"]');assert.equal(downloads.length,before,'disabled reference must not download stale data');
 click('#reference-reset');
 const fc=await csv('forecast-chart');assert.equal(fc.rows.filter(row=>row.segment==='history').length,25);assert.equal(fc.rows.filter(row=>row.segment==='forecast').length,13);
 for(const row of fc.rows.filter(row=>row.segment==='forecast')){assert.ok(Number(row.lower95_krw)<=Number(row.median_krw));assert.ok(Number(row.median_krw)<=Number(row.upper95_krw));}
 document.getElementById('band95').checked=false;document.getElementById('band95').dispatchEvent(new dom.Event('change',{bubbles:true}));
 assert.ok(!(await csv('forecast-chart')).header.includes('lower95_krw'),'hidden band exported');
 change('forecast-months',3);assert.equal((await csv('forecast-chart')).rows.filter(row=>row.segment==='forecast').length,4);
 const mc=await csv('model-a-chart');assert.equal(mc.rows.length,13);assert.equal(mc.header.filter(key=>key.startsWith('sample_path_')).length,12);
 for(const key of mc.header.filter(key=>key.startsWith('sample_path_')))near(mc.rows[0][key],Number(mc.rows[0].median_krw),'sample origin');
 const market=JSON.parse(fs.readFileSync(path.join(root,'docs/data/market.json'),'utf8'));
 const usd=market.series.find(series=>series.category==='FX'&&series.code==='USDKRW');
 const spark=(await csv('market-spark-0')).rows;assert.equal(spark.length,usd.spark.length);
 spark.forEach((row,i)=>{assert.equal(row.date,market.dates[usd.spark[i][0]]);near(row.value,usd.spark[i][1],'spark raw data')});
 const hedge=await csv('hedge-chart');assert.deepEqual(hedge.header,['date','3M_pct','6M_pct','12M_pct']);
 const series=market.series.find(series=>series.category==='HEDGE'&&series.code==='USDKRW_HP_3M');
 const raw=JSON.parse(fs.readFileSync(path.join(root,'docs/data/series',series.id+'.json'),'utf8'));
 const points=sandbox.CollaboFX.points(market.dates,raw),last=hedge.rows.at(-1);near(last['3M_pct'],points.at(-1).value,'hedge source last value');
 click('[data-currency="JPY"]');assert.equal(document.querySelector('[data-chart-csv="hedge-chart"]').disabled,true,'loading currency must clear old export');await wait();
 assert.ok(document.querySelector('[data-chart-csv="hedge-chart"]').getAttribute('aria-label').startsWith('JPY'));
 assert.equal(document.querySelectorAll('[data-chart-csv]').length,ids.length,'re-renders duplicate export controls');
 // Invalid CMA must invalidate every allocation snapshot; failed targets only
 // remove the unavailable target's weights from the consolidated Overview CSV.
 change('target-return',99,'input');
 assert.equal((await csv('overview-portfolios')).rows.length,32);
 assert.equal(document.querySelector('[data-chart-csv="risk-bars"]').disabled,true);
 change('target-return',5.5,'input');
 const volInput=document.querySelector('[data-asset="0"][data-field="vol"]'),savedVol=volInput.value;
 volInput.value='-1';volInput.dispatchEvent(new dom.Event('change',{bubbles:true}));
 for(const id of ['overview-portfolios','frontier-chart','risk-bars'])assert.equal(document.querySelector('[data-chart-csv="'+id+'"]').disabled,true,id+' stale invalid-CMA export');
 volInput.value=savedVol;volInput.dispatchEvent(new dom.Event('change',{bubbles:true}));
 for(const id of ['overview-portfolios','frontier-chart','risk-bars'])assert.equal(document.querySelector('[data-chart-csv="'+id+'"]').disabled,false,id+' failed recovery');
 // Empty dates stay empty; data from different dates must never be zipped together.
 assert.deepEqual(exporter.timeSeriesRows([{name:'A',points:[{date:'2026-01-02',value:1}]},{name:'B',points:[{date:'2026-01-03',value:2}]}],'pct'),[['date','A_pct','B_pct'],['2026-01-02',1,''],['2026-01-03','',2]]);
 console.log('PASS chart CSV: '+ids.length+' controls, source values, historical pairs and ranges, short/gapped samples, CMA isolation, units, bands, date alignment, invalid/loading reset, no duplicate buttons');
})().catch(error=>{console.error(error);process.exitCode=1});
