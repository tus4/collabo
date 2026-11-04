(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const A = window.CollaboAnalytics, F = window.CollaboFX, M = window.CollaboModels, R = window.CollaboReference;
  const COLORS = ['#61cdb8', '#91aeb8', '#759ee9', '#a6a0d6', '#e8bf71', '#d99178', '#9fb272', '#b8c6d8'];
  const NAMES = ['국내시가', '국내장부', '해외시가', '해외장부', '국내주식', '해외주식', '대체투자', '유동자산'];
  const STORAGE_KEY = 'collabo:investment-platform:scenario:v2';
  const LEGACY_STORAGE_KEY = 'collabo:investment-platform:scenario:v1';
  const names = () => state.assets.map(a=>a.name);
  const color = i => COLORS[i % COLORS.length];
  let alternativeUI = null;
  const NAV_STORAGE_KEY = 'collabo:investment-platform:nav-order:v2';
  const TABS = {overview:'Overview',allocation:'Optimizer',cma:'CMA',hedge:'Hedge',fx:'Currency',alternative:'Alternative'};
  const LABELS = {current:'현재',saa:'SAA',minVol:'Min Vol',maxSharpe:'Max Sharpe',target:'목표 근접',custom:'조합 선택'};
  const CAPTIONS = {current:'현재 투자비중',saa:'전략 자산배분',minVol:'최소 변동성',maxSharpe:'최대 샤프비율',target:'목표수익률 근접 조합'};
  let market = null, fxHistory = [], allocation = null, forecast = null, selected = 'maxSharpe', customPoint = null, currentTab = 'overview', hedgeSeq = 0, toastTimer;
  const cache = new Map();
  let modelForecast=null, modelForecastKey='', hedgeModels={}, hedgeBaseline=null, hedgeReasons={}, fxModelError='';
  const summaryHorizon={hedge:12,fx:12};
  const subTabs={hedge:'monitoring',fx:'monitoring',cma:'assumptions'};
  let referenceData=null, referenceResult=null, referenceLoadError='';
  const modelNames={A:'환율모형 A',B:'환율모형 B',C:'환율모형 C',consensus:'컨센서스'};
  const missingFX={B:'학습 산출물 없음',C:'모형 사양 미확인',consensus:'원자료 없음'};
  function defaults() {
    const mu = [.037,.033,.047,.042,.075,.08,.065,.025], vol = [.045,.012,.085,.03,.20,.18,.10,.005];
    const current = [.20,.15,.15,.10,.10,.15,.15,0], saa = [.25,.15,.15,.10,.10,.15,.10,0];
    const factors = [[.55,0,0],[.20,0,0],[.40,0,.60],[.20,0,.25],[0,.75,0],[0,.70,.35],[.15,.40,.15],[0,0,0]];
    return {version:2, assets:NAMES.map((name,i)=>({id:'asset-'+i,name,mu:mu[i],vol:vol[i],min:0,max:i===7?1:.5,current:current[i],saa:saa[i]})),
      corr:factors.map((f,i)=>factors.map((g,j)=>i===j?1:f.reduce((s,v,k)=>s+v*g[k],0))),rf:.025,target:.055,shock:0,
      hedge:{currency:'USD',localReturn:.05,fxReturn:0,premium:0,hedgeRatio:.5,assetVol:.08,fxVol:.10,correlation:0,confirmed:false},
      models:{hedgeCost:0,riskAversion:3,domesticRate:null,foreignRate:null},
      reference:{equityWeight:.6,lookback:120,basis:'local'},
      fx:{method:'random-walk',months:12,lookback:120,annualDrift:0,band68:true,band95:true}};
  }
  let state = defaults();
  const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = (value,digits=2) => Number.isFinite(value)?value.toLocaleString('ko-KR',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
  const pct = value => Number.isFinite(value)?number(value*100)+'%':'—';
  const signed = value => (value>0?'+':'')+number(value);
  const signClass = value => value>0?'positive':value<0?'negative':'';
  function notify(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,4500); }
  function showError(id,message) { $(id).textContent=message||''; $(id).hidden=!message; }
  function failMessage(error) { return error instanceof Error?error.message:String(error); }
  function requireNumber(value,label,min=-Infinity,max=Infinity) { if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max) throw new Error(label+' 입력 범위를 확인하십시오.'); return value; }
  function validateState(s) {
    if(!A) throw new Error('자산배분 계산 모듈을 불러오지 못했습니다.');
    if(!Array.isArray(s.assets)||s.assets.length<8||s.assets.length>10)throw new Error('CMA는 기본 8개를 포함해 최대 10개 자산을 지원합니다.');
    const ids=new Set(),assetNames=new Set();
    s.assets.forEach((a,i)=>{
      if(!a||typeof a.name!=='string'||!a.name.trim()||a.name.length>60||assetNames.has(a.name))throw new Error('자산명은 중복 없는 1~60자여야 합니다.');
      if(typeof a.id!=='string'||ids.has(a.id)||(i<8?a.id!=='asset-'+i:!/^alternative-[1-9][0-9]*$/.test(a.id)||a.kind!=='alternative'))throw new Error('자산군 순서 또는 ID가 올바르지 않습니다.');
      ids.add(a.id);assetNames.add(a.name);
    });
    s.assets.forEach(a=>['mu','vol','min','max','current','saa'].forEach(k=>requireNumber(a[k],a.name+' '+k,k==='mu'?-1:0,1)));
    A.validateModel(s.assets,s.corr);
    A.portfolio(s.assets.map(a=>a.current),s.assets,s.corr,s.rf);
    A.portfolio(s.assets.map(a=>a.saa),s.assets,s.corr,s.rf);
    requireNumber(s.rf,'무위험수익률',-.2,.5); requireNumber(s.target,'목표수익률',-1,1); requireNumber(s.shock,'수익률 가정 이동',-.5,.5);
    return true;
  }
  function fieldNumber(input,scale=100) { const text=input.value.trim(); return text===''?NaN:Number(text)/scale; }
  function download(filename,content,type) { const blob=new Blob([content],{type:type||'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); }
  function csv(rows) { return '\ufeff'+rows.map(row=>row.map(value=>{let text=String(value??'');if(typeof value==='string'&&/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';}).join(',')).join('\r\n'); }
  function metric(label,value,unit,note,accent=false) { return '<article class="metric-card'+(accent?' accent':'')+'"><div class="label">'+esc(label)+'</div><div class="metric'+(accent?' gold-text':'')+'">'+esc(value)+'<span class="metric-unit">'+esc(unit||'')+'</span></div><small>'+esc(note||'')+'</small></article>'; }
  function activate(tab) {
    if(!Object.keys(TABS).includes(tab)) tab='overview'; currentTab=tab;
    document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-'+tab);
    document.querySelectorAll('[data-tab]').forEach(el=>{const active=el.dataset.tab===tab;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    if(location.hash!=='#'+tab) history.replaceState(null,'','#'+tab);
    document.title=TABS[tab]+' | COLLABO';
  }
  function wireNavigation() {
    const nav=$('module-nav'),buttons=[...nav.querySelectorAll('[data-tab]')],ids=buttons.map(b=>b.dataset.tab);
    let saved=[];
    try { const raw=JSON.parse(localStorage.getItem(NAV_STORAGE_KEY)); if(Array.isArray(raw))saved=raw; } catch(_) { /* Default order remains usable when storage is unavailable. */ }
    const order=[...new Set([...saved.filter(id=>ids.includes(id)),...ids])];
    order.forEach(id=>nav.appendChild(buttons.find(b=>b.dataset.tab===id)));
    let dragged=null;
    const currentOrder=()=>[...nav.querySelectorAll('[data-tab]')];
    function saveOrder(button) {
      const items=currentOrder();
      try {
        localStorage.setItem(NAV_STORAGE_KEY,JSON.stringify(items.map(b=>b.dataset.tab)));
        $('nav-order-status').textContent=button.textContent+' '+(items.indexOf(button)+1)+'번째로 이동. 탭 순서를 저장했습니다.';
      } catch(_) { notify('탭 순서를 변경했지만 이 브라우저에 저장하지 못했습니다.'); }
    }
    function clearDrag() {
      dragged=null;
      buttons.forEach(b=>b.classList.remove('dragging','drag-over'));
    }
    buttons.forEach(button=>{
      button.addEventListener('click',()=>activate(button.dataset.tab));
      button.addEventListener('dragstart',event=>{
        dragged=button;button.classList.add('dragging');
        if(event.dataTransfer){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',button.dataset.tab);}
      });
      button.addEventListener('dragover',event=>{
        if(!dragged||dragged===button)return;
        event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';
        buttons.forEach(b=>b.classList.toggle('drag-over',b===button));
      });
      button.addEventListener('dragleave',()=>button.classList.remove('drag-over'));
      button.addEventListener('drop',event=>{
        if(!dragged)return;
        event.preventDefault();
        if(dragged!==button){
          const items=currentOrder(),moved=dragged;
          nav.insertBefore(moved,items.indexOf(moved)<items.indexOf(button)?button.nextSibling:button);
          moved.focus();saveOrder(moved);
        }
        clearDrag();
      });
      button.addEventListener('dragend',clearDrag);
      button.addEventListener('keydown',event=>{
        if(!event.altKey||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
        event.preventDefault();
        const items=currentOrder(),from=items.indexOf(button),step=['ArrowUp','ArrowLeft'].includes(event.key)?-1:1,to=from+step;
        if(to<0||to>=items.length)return;
        nav.insertBefore(button,step>0?items[to].nextSibling:items[to]);
        button.focus();saveOrder(button);
      });
    });
  }
  function renderCma() {
    const fields=[['mu','기대수익률'],['vol','변동성'],['min','하한'],['max','상한'],['current','현재 비중'],['saa','SAA 비중']];
    $('cma-table').innerHTML='<table class="editable-table"><thead><tr><th>자산군</th>'+fields.map(f=>'<th>'+f[1]+'</th>').join('')+'</tr></thead><tbody>'+state.assets.map((a,i)=>'<tr><td><span class="asset-dot" style="background:'+color(i)+'"></span>'+esc(a.name)+'</td>'+fields.map(([key,label])=>'<td><input type="number" step="0.1" '+(key==='mu'?'min="-100" max="100"':'min="0" max="100"')+' value="'+(Number.isFinite(a[key])?number(a[key]*100).replace(/,/g,''):'')+'" data-asset="'+i+'" data-field="'+key+'" aria-label="'+esc(a.name+' '+label+' 퍼센트')+'"></td>').join('')+'</tr>').join('')+'</tbody></table>';
    $('correlation-table').innerHTML='<table class="correlation-table"><thead><tr><th>상관계수</th>'+names().map(n=>'<th>'+esc(n)+'</th>').join('')+'</tr></thead><tbody>'+names().map((n,i)=>'<tr><td>'+esc(n)+'</td>'+names().map((_,j)=>i<j?'<td><input type="number" min="-1" max="1" step="0.01" value="'+number(state.corr[i][j]).replace(/,/g,'')+'" data-corr-i="'+i+'" data-corr-j="'+j+'" aria-label="'+esc(n)+' 및 '+esc(names()[j])+' 상관계수"></td>':'<td class="fixed-cell" id="corr-'+i+'-'+j+'">'+number(state.corr[i][j])+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
    $('risk-free').value=number(state.rf*100).replace(/,/g,''); $('target-return').value=number(state.target*100).replace(/,/g,''); $('mu-shock').value=number(state.shock*100).replace(/,/g,''); renderTotals();
    if(alternativeUI)alternativeUI.refresh();
  }
  function renderTotals() {
    const sums=['current','saa','min','max'].map(key=>state.assets.reduce((sum,a)=>sum+a[key],0));
    $('cma-totals').innerHTML=['현재 합계','SAA 합계','하한 합계','상한 합계'].map((label,i)=>'<span>'+label+'<strong class="'+((i<2?Math.abs(sums[i]-1)>1e-7:i===2?sums[i]>1+1e-7:sums[i]<1-1e-7)||!Number.isFinite(sums[i])?'invalid':'')+'">'+pct(sums[i])+'</strong></span>').join('');
  }
  function recalculate() {
    renderTotals();
    try { validateState(state); const assets=state.assets.map(a=>({...a,mu:a.mu+state.shock}));
      const result=A.optimize(assets,state.corr,{rf:state.rf,points:35});
      allocation={assets,result,current:A.portfolio(assets.map(a=>a.current),assets,state.corr,state.rf),saa:A.portfolio(assets.map(a=>a.saa),assets,state.corr,state.rf),minVol:result.minVol,maxSharpe:result.maxSharpe,target:A.selectTarget(result,state.target)};
      showError('model-error','');showError('cma-error','');$('allocation-results').hidden=false;$('export-scenario').disabled=false;
      if(selected==='custom'){selected='maxSharpe';customPoint=null;} renderAllocation();
    } catch(error) { allocation=null; const message='입력 오류 · '+failMessage(error); showError('model-error',message);showError('cma-error',message);$('allocation-results').hidden=true;$('portfolio-metrics').innerHTML=metric('유효한 가정 필요','—','','CMA에서 입력값을 확인하십시오.');$('export-scenario').disabled=true; }
    renderOverviewPortfolios();
  }
  function chosen() { return selected==='custom'?customPoint:allocation[selected]; }
  function renderAllocation() {
    if(!allocation)return;const p=chosen(),delta=p.return-allocation.current.return;
    $('portfolio-metrics').innerHTML=metric('기대수익률',number(p.return*100),'%',LABELS[selected]+' · 현재 대비 '+signed(delta*100)+'%p',true)+metric('예상 변동성',number(p.vol*100),'%','연율 · CMA 공분산 기준')+metric('샤프비율',(p.sharpeDefined===false?'—':number(p.sharpe)),'','무위험수익률 '+pct(state.rf))+metric('투자 자산군',String(state.assets.length),'','현재 / SAA / 최적안 비교');
    $('portfolio-choices').innerHTML=['current','saa','minVol','maxSharpe','target'].map(key=>'<button class="portfolio-choice'+(selected===key?' active':'')+'" data-portfolio="'+key+'" aria-pressed="'+(selected===key)+'"><span class="choice-radio"></span><span><span class="choice-name">'+LABELS[key]+'</span><span class="choice-caption" style="display:block">'+CAPTIONS[key]+'</span></span><span class="choice-value">'+pct(allocation[key].return)+'</span></button>').join('');
    $('selected-summary').innerHTML='<div class="summary-row"><span>선택안</span><strong>'+LABELS[selected]+'</strong></div><div class="summary-row"><span>수익률 가정 이동</span><strong>'+signed(state.shock*100)+'%p</strong></div><div class="summary-row"><span>비중 합계</span><strong>'+pct(p.weights.reduce((a,b)=>a+b,0))+'</strong></div>';
    const min=allocation.result.frontier[0].return,max=allocation.result.frontier[allocation.result.frontier.length-1].return;
    $('target-note').textContent='목표 '+pct(state.target)+' · 근접 조합 '+pct(allocation.target.return)+' · 범위 '+pct(min)+'–'+pct(max)+(state.target<min||state.target>max?' · 범위 밖':'');
    $('weights-table').innerHTML='<table><thead><tr><th>자산군</th><th>현재</th><th>SAA</th><th>'+LABELS[selected]+'</th><th>현재 대비</th></tr></thead><tbody>'+names().map((n,i)=>{const delta=(p.weights[i]-state.assets[i].current)*100,rounded=Math.sign(delta)*Math.round(Math.abs(delta))||0;return '<tr><td><span class="asset-dot" style="background:'+color(i)+'"></span>'+esc(n)+'</td><td>'+number(state.assets[i].current*100)+'%</td><td>'+number(state.assets[i].saa*100)+'%</td><td class="selected-col">'+number(p.weights[i]*100)+'%</td><td class="'+signClass(rounded)+'">'+(rounded>0?'+':'')+number(rounded,0)+'%p</td></tr>';}).join('')+'</tbody></table>';
    const riskMax=Math.max(...p.contributions.map(Math.abs),.000001);
    $('risk-bars').innerHTML=names().map((n,i)=>'<div class="risk-row"><span>'+esc(n)+'</span><div class="risk-track"><div class="risk-fill" style="width:'+Math.min(100,Math.abs(p.contributions[i])/riskMax*100)+'%;background:'+(p.contributions[i]<0?'#d99191':color(i))+'"></div></div><span class="risk-value '+signClass(p.contributions[i])+'">'+number(p.contributions[i]*100)+'</span></div>').join('');
    drawFrontier(p);
    renderOverviewPortfolios();
  }
  function svgStart(width,height,label) { return '<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(label)+'">'; }
  function linePath(points,x,y) { return points.map((p,i)=>(i?'L':'M')+x(p).toFixed(2)+','+y(p).toFixed(2)).join(' '); }
  function drawFrontier(p) {
    const W=700,H=315,L=58,R=30,T=27,B=44,front=allocation.result.frontier;
    const all=[...front,allocation.current,allocation.saa,p],xs=all.map(v=>v.vol*100),ys=all.map(v=>v.return*100);
    let xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);const xp=Math.max((xmax-xmin)*.13,.5),yp=Math.max((ymax-ymin)*.16,.5);xmin=Math.max(0,xmin-xp);xmax+=xp;ymin-=yp;ymax+=yp;
    const x=v=>L+(v.vol*100-xmin)/(xmax-xmin)*(W-L-R),y=v=>H-B-(v.return*100-ymin)/(ymax-ymin)*(H-T-B);
    let svg=svgStart(W,H,'연간 변동성 대비 기대수익률 효율적 경계선. 샤프비율별 색상.').replace('role="img"','role="group"');
    for(let i=0;i<=4;i++){const yy=T+i*(H-T-B)/4,xx=L+i*(W-L-R)/4;svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#27374a" stroke-dasharray="3 4"/><text x="'+(L-10)+'" y="'+(yy+3)+'" text-anchor="end">'+number(ymax-i*(ymax-ymin)/4,1)+'%</text><text x="'+xx+'" y="'+(H-20)+'" text-anchor="middle">'+number(xmin+i*(xmax-xmin)/4,1)+'%</text>';}
    svg+='<text x="'+L+'" y="13">기대수익률</text><text x="'+(W-R)+'" y="'+(H-2)+'" text-anchor="end">연율 변동성</text><path d="'+linePath(front,x,y)+'" fill="none" stroke="#426558" stroke-width="1.6"/>';
    const sharpes=front.filter(v=>v.sharpeDefined!==false).map(v=>v.sharpe).filter(Number.isFinite),smin=Math.min(...sharpes),smax=Math.max(...sharpes);
    $('sharpe-range').textContent=number(smin)+'–'+number(smax);
    front.forEach((v,i)=>{let t=(v.sharpe-smin)/(smax-smin||1);if(!Number.isFinite(t))t=.5;const color='rgb('+[Math.round(77+146*t),Math.round(133+58*t),Math.round(150-35*t)].join(',')+')';svg+='<circle class="point-button" data-frontier="'+i+'" tabindex="0" role="button" aria-label="조합 '+(i+1)+', 수익률 '+pct(v.return)+', 변동성 '+pct(v.vol)+'" cx="'+x(v)+'" cy="'+y(v)+'" r="4.2" fill="'+color+'"><title>수익률 '+pct(v.return)+' · 변동성 '+pct(v.vol)+' · Sharpe '+(v.sharpeDefined===false?'—':number(v.sharpe))+'</title></circle>';});
    [['현재',allocation.current,'#c4ced9'],['SAA',allocation.saa,'#759ee9']].forEach(([label,v,color])=>{svg+='<circle cx="'+x(v)+'" cy="'+y(v)+'" r="5.5" fill="'+color+'" stroke="#111b29" stroke-width="2"/><text x="'+(x(v)+10)+'" y="'+(y(v)+4)+'" style="fill:'+color+'">'+label+'</text>';});
    svg+='<circle cx="'+x(p)+'" cy="'+y(p)+'" r="11" fill="#e8bf7118" stroke="#e8bf7155"/><circle cx="'+x(p)+'" cy="'+y(p)+'" r="5" fill="#e8bf71" stroke="#111b29" stroke-width="1.5"/><text x="'+(x(p)-10)+'" y="'+(y(p)-13)+'" text-anchor="end" style="fill:#e8bf71">'+LABELS[selected]+'</text></svg>';
    $('frontier-chart').innerHTML=svg;
  }
  function sparkline(series) { const pts=(series.spark||[]).map(p=>({x:p[0],value:p[1]})).filter(p=>Number.isFinite(p.value));if(pts.length<2)return '';const min=Math.min(...pts.map(p=>p.value)),max=Math.max(...pts.map(p=>p.value));return '<svg class="sparkline" viewBox="0 0 80 26" aria-hidden="true"><path d="'+linePath(pts,p=>2+(p.x-pts[0].x)/(pts[pts.length-1].x-pts[0].x||1)*76,p=>23-(p.value-min)/(max-min||1)*20)+'" fill="none" stroke="#46cfbc" stroke-width="1.5"/></svg>'; }
  function findSeries(category,pattern) { return market?.series.find(s=>s.category===category&&pattern.test(s.code||s.name||'')); }
  function renderMarket() {
    const picks=[['USDKRW',findSeries('FX',/^USDKRW$/i)],['한국 10Y',findSeries('RATE',/^한국_10y$/i)],['미국 10Y',findSeries('RATE',/^UST10y$/i)],['DXY',findSeries('FX',/^DXY$/i)]];
    $('market-strip').innerHTML=picks.map(([label,s])=>'<div class="market-tile"><span class="label">'+label+'</span><strong>'+number(s?.latest?.value)+(s?.unit==='pct'?'<span style="font-size:12px;margin-left:3px">%</span>':'')+'</strong><small>'+(s?esc(s.latest.date):'데이터 없음')+'</small>'+(s?sparkline(s):'')+'</div>').join('');
    $('source-footer').textContent='원자료 '+market.sources.map(s=>s.file+' / '+s.sheet).join(', ')+' · '+market.series.length+'개 시계열';
  }
  async function loadSeries(series) {
    if(!series||!/^[a-z0-9_-]+$/i.test(series.id))throw new Error('필요한 시계열을 찾을 수 없습니다.');
    if(!cache.has(series.id)){cache.set(series.id,fetch('data/series/'+encodeURIComponent(series.id)+'.json').then(r=>{if(!r.ok)throw new Error('시계열 데이터 요청 실패 ('+r.status+')');return r.json();}).then(data=>F.points(market.dates,data)).catch(e=>{cache.delete(series.id);throw e;}));}
    return cache.get(series.id);
  }
  function renderHedgeInputs() {
    const fields=[['localReturn','현지 자산수익률 (%)',-100,100],['fxReturn','대원화 환율 변화 (%)',-100,100],['premium','연간 헤지 프리미엄 (%)',-100,100],['assetVol','자산 변동성 (% / 연)',0,100],['fxVol','환율 변동성 (% / 연)',0,100],['correlation','자산·환율 상관계수',-1,1]];
    $('hedge-inputs').innerHTML=fields.map(([key,label,min,max])=>'<label>'+label+'<input type="number" data-hedge="'+key+'" min="'+min+'" max="'+max+'" step="'+(key==='correlation'?'0.1':'0.5')+'" value="'+number(state.hedge[key]*(key==='correlation'?1:100)).replace(/,/g,'')+'" aria-label="'+label+'"></label>').join('');
    $('premium-confirm').checked=state.hedge.confirmed;$('hedge-ratio').value=state.hedge.hedgeRatio*100;$('hedge-ratio-value').textContent=number(state.hedge.hedgeRatio*100,0)+'%';
    document.querySelectorAll('[data-currency]').forEach(el=>{const active=el.dataset.currency===state.hedge.currency;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});
    renderHedgeScenario();
  }
  function renderHedgeScenario() {
    $('hedge-ratio-value').textContent=number(state.hedge.hedgeRatio*100,0)+'%';
    renderHedgeModels();
    if(!state.hedge.confirmed){$('hedge-error').textContent='계산하려면 연간 프리미엄 가정의 단위를 확인하십시오.';$('hedge-error').hidden=false;$('hedge-metrics').innerHTML='';$('hedge-table').innerHTML='<p class="muted">연간 프리미엄 확인 후 비교 결과를 표시합니다.</p>';return;}
    try {const current=F.scenario(state.hedge),rows=[0,.5,1].map(h=>({h,p:F.scenario({...state.hedge,hedgeRatio:h})}));
      $('hedge-error').hidden=true;
      $('hedge-metrics').innerHTML=metric('원화 기준 시나리오 수익률',number(current.krwReturn*100),'%','헤지 비율 '+number(state.hedge.hedgeRatio*100,0)+'% · '+state.hedge.currency,true)+metric('헤지 손익 기여',signed(current.hedgePnl*100),'%p','초기 원금 기준 · 프리미엄 − 환율 변화')+metric('변동성 근사',number(current.approxVol*100),'%','1차 근사 · 연율');
      $('hedge-table').innerHTML='<table><thead><tr><th>헤지 비율</th><th>미헤지 수익률</th><th>헤지 손익 기여</th><th>원화 수익률</th><th>변동성 근사</th></tr></thead><tbody>'+rows.map(({h,p})=>'<tr><td>'+number(h*100,0)+'% '+(h===0?'· 미헤지':h===1?'· 전액 헤지':'· 절반 헤지')+'</td><td>'+pct(p.unhedgedReturn)+'</td><td class="'+signClass(p.hedgePnl)+'">'+signed(p.hedgePnl*100)+'%p</td><td class="selected-col">'+pct(p.krwReturn)+'</td><td>'+pct(p.approxVol)+'</td></tr>').join('')+'</tbody></table>';
    } catch(error) { $('hedge-error').textContent=failMessage(error);$('hedge-error').hidden=false;$('hedge-metrics').innerHTML='';$('hedge-table').innerHTML=''; }
  }
  async function renderHedgeMarket() {
    if(!market)return;const seq=++hedgeSeq,currency=state.hedge.currency,series=[3,6,12].map(m=>findSeries('HEDGE',new RegExp('^'+currency+'KRW_HP_'+m+'M$','i')));
    $('hedge-chart-title').textContent=currency+' 헤지 프리미엄';
    $('hedge-market').innerHTML=series.map((s,i)=>'<article class="hedge-market-card"><div class="hedge-market-top"><span>'+currency+' / KRW · '+[3,6,12][i]+'M</span><span class="badge">원자료</span></div><strong>'+number(s?.latest?.value)+'<span style="font-size:17px">%</span></strong><small>'+(s?esc(s.latest.date+' · '+s.name):'데이터 없음')+'</small></article>').join('');
    $('hedge-chart').innerHTML='<div class="empty-chart">시계열 불러오는 중…</div>';
    try {const data=await Promise.all(series.map(loadSeries));if(seq!==hedgeSeq)return; const end=Math.max(...data.flat().map(p=>Date.parse(p.date))),cut=end-3*365.25*86400000;
      drawTimeSeries('hedge-chart',data.map((history,i)=>({name:[3,6,12][i]+'M',color:['#46cfbc','#e8bf71','#759ee9'][i],points:history.filter(p=>Date.parse(p.date)>=cut)})),'헤지 프리미엄 원자료 (%)');
    }catch(error){if(seq===hedgeSeq)$('hedge-chart').innerHTML='<div class="empty-chart">'+esc(failMessage(error))+'</div>';}
  }
  function drawTimeSeries(id,lines,label) {
    const points=lines.flatMap(l=>l.points);if(!points.length){$(id).innerHTML='<div class="empty-chart">표시할 관측값이 없습니다.</div>';return;}
    const W=700,H=330,L=51,R=18,T=25,B=37,minX=Math.min(...points.map(p=>Date.parse(p.date))),maxX=Math.max(...points.map(p=>Date.parse(p.date))),vs=points.map(p=>p.value);let low=Math.min(...vs),high=Math.max(...vs),pad=Math.max((high-low)*.15,.1);low-=pad;high+=pad;
    const x=p=>L+(Date.parse(p.date)-minX)/(maxX-minX||1)*(W-L-R),y=p=>H-B-(p.value-low)/(high-low)*(H-T-B);
    let svg=svgStart(W,H,label);
    for(let i=0;i<5;i++){let yy=T+i*(H-T-B)/4;svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#27374a" stroke-dasharray="3 4"/><text x="'+(L-8)+'" y="'+(yy+3)+'" text-anchor="end">'+number(high-i*(high-low)/4,1)+'</text>';let xx=L+i*(W-L-R)/4;svg+='<text x="'+xx+'" y="'+(H-13)+'" text-anchor="middle">'+new Date(minX+i*(maxX-minX)/4).toISOString().slice(0,7)+'</text>';}
    lines.forEach(line=>svg+='<path d="'+linePath(line.points,x,y)+'" fill="none" stroke="'+line.color+'" stroke-width="1.7"><title>'+esc(line.name)+'</title></path>');svg+='</svg>';$(id).innerHTML=svg;
  }
  function renderForecastControls() {
    $('forecast-method').value=state.fx.method;$('forecast-months').value=String(state.fx.months);$('forecast-lookback').value=String(state.fx.lookback);$('forecast-drift').value=number(state.fx.annualDrift*100).replace(/,/g,'');$('band68').checked=state.fx.band68;$('band95').checked=state.fx.band95;$('forecast-drift-label').hidden=state.fx.method!=='scenario';
  }
  function renderForecast() {
    $('forecast-drift-label').hidden=state.fx.method!=='scenario';
    renderFXModels();
    if(!fxHistory.length)return;
    try {forecast=F.forecast(fxHistory,state.fx);const last=forecast.rows[forecast.rows.length-1],method={"random-walk":'랜덤워크',historical:'역사적 드리프트',scenario:'사용자 시나리오'}[state.fx.method];
      showError('fx-error','');
      $('fx-metrics').innerHTML=metric('마지막 관측 환율',number(forecast.spot),'원',forecast.asof+' · USDKRW')+metric(state.fx.months+'개월 전망 중앙값',number(last.median),'원',method,true)+metric('연율 변동성',number(forecast.annualVol*100),'%',forecast.observations+'개월 로그수익률 기준')+metric('95% 예측 범위',number(last.lower95,0)+'–'+number(last.upper95,0),'원',last.date+' · 조건부 분포');
      $('forecast-caption').textContent='관측 기준 '+forecast.asof+' · '+method+' · 연간 로그 드리프트 '+pct(forecast.annualDrift);
      renderFXQuality(forecast);
      drawForecast(forecast);
      $('forecast-table').innerHTML='<table><thead><tr><th>전망 시점</th><th>중앙값</th><th>68% 하단</th><th>68% 상단</th><th>95% 하단</th><th>95% 상단</th></tr></thead><tbody>'+forecast.rows.filter(r=>r.horizon>0).map(r=>'<tr><td>'+esc(r.date)+'</td><td class="selected-col">'+number(r.median)+'</td><td>'+number(r.lower68)+'</td><td>'+number(r.upper68)+'</td><td>'+number(r.lower95)+'</td><td>'+number(r.upper95)+'</td></tr>').join('')+'</tbody></table>';
      renderOos();$('forecast-csv').disabled=false;
    }catch(error){forecast=null;showError('fx-error',failMessage(error));$('forecast-chart').innerHTML='';$('fx-metrics').innerHTML='';$('forecast-table').innerHTML='';$('oos-results').textContent='유효한 전망 가정이 필요합니다.';$('forecast-csv').disabled=true;}
  }
  function drawForecast(fc) {
    const history=F.monthly(fxHistory).slice(-25),future=fc.rows,W=1000,H=380,L=65,R=27,T=26,B=44;
    const pts=[...history,...future.map(p=>({date:p.date,value:p.median}))],minX=Date.parse(history[0].date),maxX=Date.parse(future[future.length-1].date);
    let values=history.map(p=>p.value).concat(future.flatMap(p=>state.fx.band95?[p.lower95,p.upper95]:state.fx.band68?[p.lower68,p.upper68]:[p.median]));let min=Math.min(...values),max=Math.max(...values),pad=Math.max((max-min)*.12,20);min-=pad;max+=pad;
    const x=p=>L+(Date.parse(p.date)-minX)/(maxX-minX)*(W-L-R),yy=v=>H-B-(v-min)/(max-min)*(H-T-B),y=p=>yy(p.value);
    let svg=svgStart(W,H,'USDKRW 과거 월말 관측, 전망 중앙값 및 68%와 95% 조건부 예측 범위');
    for(let i=0;i<=5;i++){const yv=T+i*(H-T-B)/5;svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yv+'" y2="'+yv+'" stroke="#27374a" stroke-dasharray="3 5"/><text x="'+(L-12)+'" y="'+(yv+4)+'" text-anchor="end">'+number(max-i*(max-min)/5,0)+'</text>';}
    for(let i=0;i<=6;i++){const xv=L+i*(W-L-R)/6;svg+='<text x="'+xv+'" y="'+(H-15)+'" text-anchor="middle">'+new Date(minX+i*(maxX-minX)/6).toISOString().slice(0,7)+'</text>';}
    const anchor=x(future[0]);svg+='<rect x="'+anchor+'" y="'+T+'" width="'+(W-R-anchor)+'" height="'+(H-T-B)+'" fill="#46cfbc04"/><text x="'+(anchor+12)+'" y="'+(T+10)+'" style="fill:#8aacae">전망</text>';
    function band(lower,upper,fill){return '<path d="'+linePath(future,x,p=>yy(p[upper]))+' '+linePath([...future].reverse(),x,p=>yy(p[lower])).replace(/^M/,'L')+' Z" fill="'+fill+'"/>';}
    if(state.fx.band95)svg+=band('lower95','upper95','#2d5f763d');if(state.fx.band68)svg+=band('lower68','upper68','#4b92a357');
    svg+='<path d="'+linePath(history,x,y)+'" fill="none" stroke="#a6b5c7" stroke-width="2.2"/><line x1="'+anchor+'" x2="'+anchor+'" y1="'+T+'" y2="'+(H-B)+'" stroke="#6b8599" stroke-width="1" stroke-dasharray="4 5"/><path d="'+linePath(future,x,p=>yy(p.median))+'" fill="none" stroke="#e8bf71" stroke-width="2.4" stroke-dasharray="6 4"/><circle cx="'+anchor+'" cy="'+yy(fc.spot)+'" r="4" fill="#e8bf71"/>';
    const last=future[future.length-1];svg+='<circle cx="'+x(last)+'" cy="'+yy(last.median)+'" r="4.3" fill="#e8bf71"/><text x="'+(x(last)-9)+'" y="'+(yy(last.median)-11)+'" text-anchor="end" style="fill:#e8bf71;font-size:13px">'+number(last.median,0)+'</text></svg>';$('forecast-chart').innerHTML=svg;
  }
  function renderOos() {
    try {const oos=F.evaluate(fxHistory,{testMonths:24,minTrainMonths:24,lookback:state.fx.lookback});
      $('oos-results').innerHTML='<div class="subtle-tag">'+esc(oos.startDate)+'–'+esc(oos.endDate)+' · '+oos.observations+'개월 · 추정창 '+state.fx.lookback+'개월</div><div class="oos-grid">'+[['randomWalk','랜덤워크'],['historical','역사적 드리프트']].map(([key,label])=>{const p=oos[key];return '<div class="oos-card"><div class="label">'+label+'</div><strong>'+number(p.rmse)+' <span style="font-size:11px">원</span></strong><p>RMSE · 1개월 앞</p><p>68% 범위 포함률 '+pct(p.coverage68)+'</p><p>95% 범위 포함률 '+pct(p.coverage95)+'</p></div>';}).join('')+'</div>';
    }catch(error){$('oos-results').textContent='표본 외 평가: '+failMessage(error);}
  }
  function importState(raw) {
    if(!raw||![1,2].includes(raw.version)||!Array.isArray(raw.assets)||raw.assets.length<(raw.version===1?7:8)||raw.assets.length>10||(raw.version===1&&raw.assets.length!==7)||!Array.isArray(raw.corr)||raw.corr.length!==raw.assets.length)throw new Error('지원하는 COLLABO v1/v2 가정 파일이 아닙니다.');
    const next=defaults(), liquidAsset=next.assets[7];
    next.assets=raw.assets.map((a,i)=>{
      if(!a)throw new Error('자산군 입력을 확인하십시오.');
      const result={id:a.id,name:i<6||i===7||raw.version===1?NAMES[i]:a.name};
      if(i>=8)result.kind=a.kind;
      ['mu','vol','min','max','current','saa'].forEach(k=>result[k]=requireNumber(a[k],result.name+' '+k,k==='mu'?-1:0,1));
      if(a.provenance){
        const p=a.provenance;
        if(!['manual','history','mixed'].includes(p.method))throw new Error('대체자산 추정 출처를 확인하십시오.');
        result.provenance={method:p.method};
        if(p.method!=='manual'){
          for(const key of ['file','sheet','frequency','basis','start','end']){if(typeof p[key]!=='string'||p[key].length>255)throw new Error('대체자산 추정 출처를 확인하십시오.');result.provenance[key]=p[key];}
          if(!['daily','monthly','quarterly'].includes(p.frequency)||!['KRW-total','local-total','price'].includes(p.basis))throw new Error('시계열 주기·수익률 기준을 확인하십시오.');
          if(!Number.isInteger(p.count)||p.count<3||p.count>20000)throw new Error('추정 표본 수를 확인하십시오.');result.provenance.count=p.count;
          if(!Array.isArray(p.compared)||p.compared.length>9)throw new Error('상관계수 추정 출처를 확인하십시오.');
          result.provenance.compared=p.compared.map(c=>{
            if(!c||!raw.assets.some(b=>b.id===c.id)||!Number.isInteger(c.count)||c.count<3||c.count>20000||typeof c.start!=='string'||typeof c.end!=='string'||c.start.length>10||c.end.length>10)throw new Error('상관계수 추정 표본을 확인하십시오.');
            return {id:c.id,count:c.count,start:c.start,end:c.end};
          });
        }
      }
      return result;
    });
    next.corr=raw.corr.map(row=>{if(!Array.isArray(row)||row.length!==raw.assets.length)throw new Error('상관행렬 크기를 확인하십시오.');return row.map(v=>requireNumber(v,'상관계수',-1,1));});
    if(raw.version===1){next.assets.push(liquidAsset);next.corr.forEach(row=>row.push(0));next.corr.push([...Array(7).fill(0),1]);}
    next.rf=requireNumber(raw.rf,'무위험수익률',-.2,.5);next.target=requireNumber(raw.target,'목표수익률',-1,1);next.shock=requireNumber(raw.shock,'가정 이동',-.5,.5);
    if(raw.hedge){if(!['USD','JPY','EUR','AUD'].includes(raw.hedge.currency))throw new Error('지원하지 않는 통화입니다.');next.hedge.currency=raw.hedge.currency;['localReturn','fxReturn','premium','assetVol','fxVol','correlation','hedgeRatio'].forEach(k=>next.hedge[k]=requireNumber(raw.hedge[k],'환헤지 '+k,['assetVol','fxVol','hedgeRatio'].includes(k)?0:-1,1));next.hedge.confirmed=raw.hedge.confirmed===true;F.scenario(next.hedge);}
    if(raw.fx){if(!['random-walk','historical','scenario'].includes(raw.fx.method)||![3,6,12,24].includes(raw.fx.months)||![36,60,120].includes(raw.fx.lookback))throw new Error('전망 모형·기간을 확인하십시오.');next.fx={method:raw.fx.method,months:raw.fx.months,lookback:raw.fx.lookback,annualDrift:F.validateForecastOptions(raw.fx).annualDrift,band68:raw.fx.band68!==false,band95:raw.fx.band95!==false};}
    if(raw.models){next.models.hedgeCost=requireNumber(raw.models.hedgeCost,'연간 헤지 비용',0,1);next.models.riskAversion=requireNumber(raw.models.riskAversion,'위험회피도',.01,1000);['domesticRate','foreignRate'].forEach(k=>next.models[k]=raw.models[k]===null?null:requireNumber(raw.models[k],'CIP 금리',-.99,1));}
    if(raw.reference){next.reference={equityWeight:requireNumber(raw.reference.equityWeight,'레퍼런스 해외주식 비중',0,1),lookback:raw.reference.lookback,basis:raw.reference.basis};if(![0,60,120].includes(next.reference.lookback)||!['local','krw'].includes(next.reference.basis))throw new Error('레퍼런스 추정 기간·환율 기준을 확인하십시오.');}
    validateState(next);return next;
  }
  function applyState(next) { state=next;selected='maxSharpe';customPoint=null;renderCma();syncReferenceControls();renderReference();renderHedgeInputs();renderForecastControls();recalculate();renderHedgeMarket();renderForecast(); }
  function wireEvents() {
    wireNavigation();
    wireModels();
    alternativeUI=window.CollaboAlternativeUI.mount({getState:()=>state,apply:next=>applyState(importState(next)),validate:validateState,esc,number,notify});
    wireReference();
    document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>activate(b.dataset.open)));
    window.addEventListener('hashchange',()=>activate(location.hash.slice(1)));
    $('cma-table').addEventListener('change',e=>{if(e.target.dataset.asset!==undefined){const a=state.assets[Number(e.target.dataset.asset)],key=e.target.dataset.field;a[key]=fieldNumber(e.target);if(['mu','vol'].includes(key)&&a.provenance?.method==='history')a.provenance.method='mixed';recalculate();alternativeUI.refresh();}});
    $('correlation-table').addEventListener('change',e=>{const t=e.target;if(t.dataset.corrI!==undefined){const i=Number(t.dataset.corrI),j=Number(t.dataset.corrJ),v=fieldNumber(t,1);state.corr[i][j]=v;state.corr[j][i]=v;[i,j].forEach((k,index)=>{const a=state.assets[k];if(a.provenance?.method==='history')a.provenance.method='mixed';if(a.provenance?.compared)a.provenance.compared=a.provenance.compared.filter(c=>c.id!==state.assets[index===0?j:i].id);});$('corr-'+j+'-'+i).textContent=number(v);recalculate();alternativeUI.refresh();}});
    [['risk-free','rf'],['target-return','target'],['mu-shock','shock']].forEach(([id,key])=>$(id).addEventListener('change',()=>{state[key]=fieldNumber($(id));recalculate();}));
    $('portfolio-choices').addEventListener('click',e=>{const b=e.target.closest('[data-portfolio]');if(b&&allocation){selected=b.dataset.portfolio;renderAllocation();}});
    const selectFront=e=>{const point=e.target.closest('[data-frontier]');if(point&&allocation){customPoint=allocation.result.frontier[Number(point.dataset.frontier)];selected='custom';renderAllocation();}};
    $('frontier-chart').addEventListener('click',selectFront);$('frontier-chart').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectFront(e);}});
    $('allocation-csv').addEventListener('click',()=>{if(!allocation)return;const p=chosen();download('collabo-allocation.csv',csv([['asset','current_weight','saa_weight','selected_weight','change_weight','risk_contribution_annual','assumption_mu_annual','assumption_vol_annual'],...names().map((n,i)=>[n,state.assets[i].current,state.assets[i].saa,p.weights[i],p.weights[i]-state.assets[i].current,p.contributions[i],allocation.assets[i].mu,allocation.assets[i].vol])]),'text/csv;charset=utf-8');});
    $('save-scenario').addEventListener('click',()=>{try{const validated=importState(state);localStorage.setItem(STORAGE_KEY,JSON.stringify({...validated,savedAt:new Date().toISOString()}));notify('현재 가정을 이 브라우저에 저장했습니다.');}catch(e){notify('저장 실패: '+failMessage(e));}});
    $('load-scenario').addEventListener('click',()=>{try{const value=localStorage.getItem(STORAGE_KEY)??localStorage.getItem(LEGACY_STORAGE_KEY);if(!value)throw new Error('저장된 가정이 없습니다.');applyState(importState(JSON.parse(value)));notify('저장된 가정을 불러왔습니다.');}catch(e){notify('불러오기 실패: '+failMessage(e));}});
    $('export-scenario').addEventListener('click',()=>{try{const validated=importState(state);download('collabo-scenario-v2.json',JSON.stringify({...validated,savedAt:new Date().toISOString()},null,2),'application/json');}catch(e){notify(failMessage(e));}});
    $('import-scenario').addEventListener('click',()=>$('scenario-file').click());
    $('scenario-file').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>100000)throw new Error('파일 크기는 100KB 이하여야 합니다.');applyState(importState(JSON.parse(await file.text())));notify('검증된 가정을 적용했습니다.');}catch(err){notify('가져오기 실패: '+failMessage(err));}finally{e.target.value='';}});
    $('reset-scenario').addEventListener('click',()=>{applyState(defaults());notify('화면의 가정을 초기값으로 되돌렸습니다. 저장된 가정은 유지됩니다.');});
    $('currency-picker').addEventListener('click',e=>{const b=e.target.closest('[data-currency]');if(!b)return;if(state.hedge.currency!==b.dataset.currency)state.models.foreignRate=null;state.hedge.currency=b.dataset.currency;state.hedge.confirmed=false;renderHedgeInputs();renderHedgeMarket();});
    $('hedge-inputs').addEventListener('change',e=>{const key=e.target.dataset.hedge;if(!key)return;state.hedge[key]=fieldNumber(e.target,key==='correlation'?1:100);if(key==='premium'){state.hedge.confirmed=false;$('premium-confirm').checked=false;}renderHedgeScenario();});
    $('premium-confirm').addEventListener('change',()=>{state.hedge.confirmed=$('premium-confirm').checked;renderHedgeScenario();});
    $('hedge-ratio').addEventListener('input',()=>{state.hedge.hedgeRatio=Number($('hedge-ratio').value)/100;renderHedgeScenario();});
    [['forecast-method','method'],['forecast-months','months'],['forecast-lookback','lookback']].forEach(([id,key])=>$(id).addEventListener('change',()=>{state.fx[key]=key==='method'?$(id).value:Number($(id).value);renderForecast();}));
    $('forecast-drift').addEventListener('change',()=>{state.fx.annualDrift=fieldNumber($('forecast-drift'));renderForecast();});
    ['band68','band95'].forEach(id=>$(id).addEventListener('change',()=>{state.fx[id]=$(id).checked;if(forecast)drawForecast(forecast);}));
    $('forecast-csv').addEventListener('click',()=>{if(!forecast)return;download('collabo-usdkrw-forecast-'+forecast.asof+'.csv',csv([['asof','method','lookback_months','annual_log_drift','annual_log_vol','horizon_months','date','median_krw','mean_krw','lower68_krw','upper68_krw','lower95_krw','upper95_krw'],...forecast.rows.map(r=>[forecast.asof,forecast.method,state.fx.lookback,forecast.annualDrift,forecast.annualVol,r.horizon,r.date,r.median,r.mean,r.lower68,r.upper68,r.lower95,r.upper95])]),'text/csv;charset=utf-8');});
  }
  function activateSubtab(group, tab) {
    const choices=group==='cma'?['assumptions','reference']:group==='hedge'?['monitoring','a','b','c']:['monitoring','a','b','c','consensus'];
    if(!choices.includes(tab))tab=choices[0];subTabs[group]=tab;
    if(group==='cma'){$('correlation-table').hidden=tab==='reference';$('cma-badge').textContent=tab==='reference'?'과거 수익률 기반 추정':'초기값은 편집 가능한 가정';$('cma-correlation-badge').textContent=tab==='reference'?'월수익률 · 관측값':'입력·추정 가정';}
    if(group==='fx')$('forecast-csv').hidden=tab!=='monitoring';
    document.querySelectorAll('[data-'+group+'-tab]').forEach(button=>{
      const active=button.getAttribute('data-'+group+'-tab')===tab;
      button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
    });
    document.querySelectorAll('[data-'+group+'-panel]').forEach(panel=>panel.hidden=panel.getAttribute('data-'+group+'-panel')!==tab);
  }
  function openModel(group,tab){activate(group);activateSubtab(group,tab.toLowerCase());}
  function stat(label,value){return '<div class="summary-stat"><span>'+esc(label)+'</span><strong>'+value+'</strong></div>';}
  function renderOverviewPortfolios(){
    if(!$('overview-portfolios'))return;
    showError('overview-error',allocation?'':'CMA 입력값을 확인하십시오.');
    if(!allocation){$('overview-portfolios').innerHTML='';return;}
    $('overview-portfolios').innerHTML=['current','saa','minVol','maxSharpe','target'].map(key=>{
      const p=allocation[key];
      return '<article class="summary-card'+(key===selected?' accent':'')+'"><div class="summary-card-head"><h3>'+LABELS[key]+'</h3><button class="button small" data-summary-portfolio="'+key+'">상세 ↗</button></div><div class="summary-stats">'+stat('기대수익률',pct(p.return))+stat('변동성',pct(p.vol))+stat('Sharpe',p.sharpeDefined===false?'—':number(p.sharpe))+'</div><div class="summary-weights">'+names().map((name,i)=>'<div class="summary-weight"><span>'+esc(name)+'</span><div class="summary-weight-track"><span class="summary-weight-fill" style="width:'+(p.weights[i]*100).toFixed(2)+'%;background:'+color(i)+'"></span></div><strong>'+number(p.weights[i]*100)+'%</strong></div>').join('')+'</div></article>';
    }).join('');
  }
  function quarterRows(result){return result?result.rows.filter(row=>[3,6,9,12].includes(row.horizon)):[];}
  function fxQuarterTable(result){
    return '<div class="table-scroll"><table class="quarter-table"><thead><tr><th>기간</th><th>평균 · 원</th><th>95% · 원</th><th>VaR 97.5% · %</th></tr></thead><tbody>'+quarterRows(result).map(row=>'<tr><th>+'+row.horizon+'M</th><td>'+number(row.mean)+'</td><td>'+number(row.lower95)+'–'+number(row.upper95)+'</td><td>'+number(row.var975*100)+'</td></tr>').join('')+'</tbody></table></div>';
  }
  function hedgeQuarterTable(result){
    return '<div class="table-scroll"><table class="quarter-table"><thead><tr><th>기간</th><th>누적 수익 · %</th><th>95% 1차 근사 · %</th><th>VaR 97.5% · %</th></tr></thead><tbody>'+(result?.rows||[]).map(row=>'<tr><th>+'+row.horizon+'M</th><td>'+number(row.mean*100)+'</td><td>'+number(row.lower95*100)+'–'+number(row.upper95*100)+'</td><td>'+number(row.var975*100)+'</td></tr>').join('')+'</tbody></table></div>';
  }
  function unavailableTable(kind){
    const titles=kind==='fx'?['기간','평균 · 원','95% · 원','VaR 97.5% · %']:['기간','누적 수익 · %','95% 1차 근사 · %','VaR 97.5% · %'];
    return '<div class="table-scroll"><table class="quarter-table"><thead><tr>'+titles.map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+[3,6,9,12].map(h=>'<tr><th>+'+h+'M</th><td>—</td><td>—</td><td>—</td></tr>').join('')+'</tbody></table></div>';
  }
  function renderFXModels(errorMessage){
    if(!$('fx-model-a'))return;
    let error=errorMessage||'';
    if(fxHistory.length&&M){
      try{
        F.validateForecastOptions(state.fx);
        const key=JSON.stringify([fxHistory.at(-1),fxHistory.length,state.fx.method,state.fx.lookback,state.fx.method==='scenario'?state.fx.annualDrift:null]);
        if(key!==modelForecastKey){modelForecast=M.monteCarlo(fxHistory,{...state.fx,months:12,paths:20000,seed:20261102});modelForecastKey=key;}
      }catch(e){error=failMessage(e);modelForecast=null;modelForecastKey='';}
    }else {modelForecast=null;modelForecastKey='';error=error||'시장 데이터 대기';}
    const fc=modelForecast;fxModelError=error;
    renderFXSummary();
    renderFXQuality(fc,error);
    $('overview-status').textContent=fc?'USDKRW · '+fc.asof+(fc.quality.trailingUnchangedObservations>=5?' · 동일 관측값 '+fc.quality.trailingUnchangedObservations+'개':''):'USDKRW · '+(error||'미산출');
    $('overview-fx').innerHTML=['A','B','C','consensus'].map(key=>{
      const available=key==='A'&&fc,reason=key==='A'?error:missingFX[key];
      return '<article class="summary-card"><div class="summary-card-head"><h3>'+modelNames[key]+'</h3><button class="button small" data-summary-fx="'+key+'">상세 ↗</button></div><div class="model-status">'+(available?'USDKRW · '+esc(fc.asof)+' · MC':'미산출 · '+esc(reason))+'</div>'+(available?fxQuarterTable(fc):unavailableTable('fx'))+'</article>';
    }).join('');
    $('fx-model-a').innerHTML='<div class="model-toolbar"><span class="badge">MONTE CARLO · 20,000 × 252</span><button class="button small" data-monitor="fx">모형 설정</button><button class="button small" data-model-csv="fx-a" '+(!fc?'disabled':'')+'>CSV 내보내기</button></div>'+(fc?'<div class="metric-grid three">'+metric('기준 환율',number(fc.spot),'원',fc.asof)+metric('12개월 중앙값',number(fc.rows.at(-1).median),'원','USDKRW',true)+metric('연율 변동성',number(fc.annualVol*100),'%',fc.observations+'개월')+'</div><article class="panel"><div class="panel-head"><h2>환율모형 A</h2><span class="badge">68% · 95% 조건부 구간</span></div><div id="model-a-chart" class="chart"></div></article><article class="panel">'+fxQuarterTable(fc)+'</article>':'<div class="model-empty" role="status">'+esc(error||'미산출')+'</div>');
    if(fc)drawModelForecast(fc);
    ['B','C','consensus'].forEach(key=>{$('fx-model-'+key.toLowerCase()).innerHTML='<article class="panel"><div class="panel-head"><h2>'+modelNames[key]+'</h2><span class="badge">미산출</span></div><div class="model-empty" role="status">'+missingFX[key]+'</div>'+unavailableTable('fx')+'</article>';});
  }
  function drawModelForecast(fc){
    const W=1000,H=350,L=68,R=30,T=22,B=42,rows=fc.rows;
    const low=Math.min(...rows.map(r=>r.lower95)),high=Math.max(...rows.map(r=>r.upper95)),pad=Math.max((high-low)*.12,1),min=low-pad,max=high+pad;
    const x=r=>L+r.horizon/12*(W-L-R),y=v=>H-B-(v-min)/(max-min)*(H-T-B);
    let svg=svgStart(W,H,'환율모형 A 표본 경로, 평균, 중앙값과 68% 및 95% 조건부 구간');
    for(let i=0;i<=4;i++){const v=min+(max-min)*i/4,yy=y(v);svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#27374a"/><text x="'+(L-10)+'" y="'+(yy+4)+'" text-anchor="end">'+number(v,0)+'</text>';}
    [0,3,6,9,12].forEach(h=>{const xx=x({horizon:h});svg+='<line x1="'+xx+'" x2="'+xx+'" y1="'+T+'" y2="'+(H-B)+'" stroke="#27374a"/><text x="'+xx+'" y="'+(H-15)+'" text-anchor="middle">'+h+'M</text>';});
    const band=(lo,hi,color)=>'<path d="'+linePath(rows,x,r=>y(r[hi]))+' '+linePath([...rows].reverse(),x,r=>y(r[lo])).replace(/^M/,'L')+' Z" fill="'+color+'"/>';
    svg+=band('lower95','upper95','#2d5f763d')+band('lower68','upper68','#4b92a357');
    svg+='<defs><clipPath id="mc-plot-clip"><rect x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'"/></clipPath></defs><g clip-path="url(#mc-plot-clip)">';
    (fc.samplePaths||[]).slice(0,12).forEach(path=>{
      const points=path.rows||path;
      if(Array.isArray(points))svg+='<path d="'+linePath(points,(p,i)=>x({horizon:p.horizon??i}),p=>y(typeof p==='number'?p:(p.value??p.spot)))+'" fill="none" stroke="#759ee9" opacity=".18" stroke-width="1"/>';
    });
    svg+='</g>';
    [['median','#e8bf71','중앙값'],['mean','#46cfbc','평균']].forEach(([key,color,label],i)=>{svg+='<path d="'+linePath(rows,x,r=>y(r[key]))+'" fill="none" stroke="'+color+'" stroke-width="2"/><text x="'+(L+12+i*100)+'" y="'+(T+13)+'" style="fill:'+color+'">'+label+'</text>';});
    $('model-a-chart').innerHTML=svg+'</svg>';
  }
  function modelControl(key,label,value,scale=100,min=0,max=100,step=.1){return '<label>'+label+'<input type="number" data-model-control="'+key+'" value="'+(Number.isFinite(value)?String(Math.round(value*scale*1e8)/1e8):'')+'" min="'+min+'" max="'+max+'" step="'+step+'"></label>';}
  function renderHedgeModels(){
    if(!$('hedge-model-a'))return;hedgeModels={};hedgeBaseline=null;const reasons={};
    ['A','B','C'].forEach(key=>{
      try{if(!M)throw new Error('모형 모듈 없음');hedgeModels[key]=M.hedge(state.hedge,{model:key,cost:state.models.hedgeCost,riskAversion:state.models.riskAversion});}
      catch(error){reasons[key]=failMessage(error);}
    });
    try{hedgeBaseline=M.hedge({...state.hedge,hedgeRatio:0},{model:'A',cost:0});}catch(_){}
    hedgeReasons=reasons;renderHedgeSummary();
    const captions={A:'고정 헤지 · CIP 비교',B:'비용·위험 최적화',C:'최소분산'};
    $('overview-hedge').innerHTML=['A','B','C'].map(key=>{const result=hedgeModels[key];return '<article class="summary-card"><div class="summary-card-head"><h3>환헤지모형 '+key+'</h3><button class="button small" data-summary-hedge="'+key+'">상세 ↗</button></div><div class="model-status">'+esc(state.hedge.currency)+' · '+captions[key]+'</div><div class="summary-stats">'+stat('헤지비율',result?pct(result.ratio):'—')+stat('입력 가정',result?'연율':'미확인')+'</div>'+(result?hedgeQuarterTable(result):unavailableTable('hedge'))+'</article>';}).join('');
    ['A','B','C'].forEach(key=>{
      const result=hedgeModels[key];
      let controls='<div class="model-toolbar"><span class="badge assumption">'+state.hedge.currency+' · 입력 가정</span><button class="button small" data-monitor="hedge">수익·위험 입력</button><button class="button small" data-model-csv="hedge-'+key.toLowerCase()+'" '+(!result?'disabled':'')+'>CSV 내보내기</button></div>';
      controls+='<div class="form-grid">'+modelControl('hedgeCost','연간 헤지 비용 (%)',state.models.hedgeCost);
      if(key==='B')controls+=modelControl('riskAversion','위험회피도 γ',state.models.riskAversion,1,.01,1000,.1);
      controls+='</div>';
      let cipHtml='';
      if(key==='A'){
        cipHtml='<article class="panel"><div class="panel-head"><h2>CIP 비교</h2><span class="badge assumption">1년 단리 · 사용자 입력</span></div><div class="form-grid">'+modelControl('domesticRate','원화 금리 (%)',state.models.domesticRate,100,-99,100)+modelControl('foreignRate','외화 금리 (%)',state.models.foreignRate,100,-99,100)+'</div>';
        try{const cip=M.cip({domesticRate:state.models.domesticRate,foreignRate:state.models.foreignRate,months:12});cipHtml+='<div class="summary-stats">'+stat('CIP 프리미엄',pct(cip.annualPremium))+stat('입력 − CIP',state.hedge.confirmed?signed((state.hedge.premium-cip.annualPremium)*100)+'%p':'—')+'</div>';}
        catch(_){cipHtml+='<div class="model-status">금리 입력 필요</div>';}
        cipHtml+='</article>';
      }
      $('hedge-model-'+key.toLowerCase()).innerHTML=controls+cipHtml+'<article class="panel"><div class="panel-head"><h2>환헤지모형 '+key+'</h2><span class="badge">'+captions[key]+'</span></div>'+(result?'<div class="summary-stats">'+stat('헤지비율',pct(result.ratio))+stat('순 프리미엄',pct(result.netPremium))+'</div>'+hedgeQuarterTable(result):'<div class="model-empty" role="status">'+esc(reasons[key])+'</div>')+'</article>';
    });
  }
  function renderFXQuality(fc,error){
    $('fx-quality-status').hidden=false;
    $('fx-quality-status').textContent=fc?['USDKRW',fc.asof,...forecastQuality(fc)].join(' · '):'USDKRW · '+(error||'미산출');
  }
  function forecastQuality(fc){
    const items=[];
    if(fc.quality.trailingUnchangedObservations>=5)items.push('동일 관측값 '+fc.quality.trailingUnchangedObservations+'개');
    if(fc.estimation.partialLatestMonthExcluded)items.push('최신 부분월 추정 제외');
    if(fc.estimation.skippedGaps)items.push('월 누락 '+fc.estimation.skippedGaps+'개');
    return items;
  }
  function monitorCard(group,key,label,status,metrics,foot,available){
    return '<article class="monitor-model-card'+(available?'':' model-unavailable')+'" data-'+group+'-summary="'+key+'"><div class="model-card-top"><h3>'+label+'</h3><button class="button small" data-summary-'+group+'="'+key+'" aria-label="'+label+' 상세">상세 ↗</button></div><div class="model-status">'+esc(status)+'</div><div class="model-card-metrics">'+metrics+'</div><div class="model-card-foot">'+esc(foot)+'</div></article>';
  }
  function renderFXSummary(){
    const fc=modelForecast,h=summaryHorizon.fx,row=fc?.rows.find(r=>r.horizon===h);
    $('fx-model-summary').innerHTML=['A','B','C','consensus'].map(key=>{
      const r=key==='A'?row:null,reason=key==='A'?fxModelError:missingFX[key];
      return monitorCard('fx',key,modelNames[key],r?fc.asof+' · +'+h+'M · MC':'미산출 · '+(reason||'시장 데이터 대기'),
        stat('평균 · 원',r?number(r.mean):'—')+stat('중앙값 · 원',r?number(r.median):'—')+stat('95% 하단 · 원',r?number(r.lower95):'—')+stat('95% 상단 · 원',r?number(r.upper95):'—'),
        r?'VaR 97.5% '+pct(r.var975)+' · 미헤지 USD 손실':'+'+h+'M · 예측값 없음',Boolean(r));
    }).join('');
    $('fx-comparison-csv').disabled=!fc;
  }
  function renderHedgeSummary(){
    const h=summaryHorizon.hedge,base=hedgeBaseline?.rows.find(r=>r.horizon===h);
    const labels={A:'고정 헤지 · CIP 비교',B:'비용·위험 최적화',C:'최소분산'};
    $('hedge-model-summary').innerHTML=['A','B','C'].map(key=>{
      const result=hedgeModels[key],row=result?.rows.find(r=>r.horizon===h);
      return monitorCard('hedge',key,'환헤지모형 '+key,row?state.hedge.currency+' · '+labels[key]:'미산출 · '+hedgeReasons[key],
        stat('헤지비율',result?pct(result.ratio):'—')+stat('누적 기대수익',row?pct(row.mean):'—')+stat('변동성 · 1차 근사',row?pct(row.approxVol):'—')+stat('VaR 97.5% · 손실',row?pct(row.var975):'—'),
        '+'+h+'M · 입력 가정 · 비용 차감',Boolean(row));
    }).join('');
    $('hedge-model-comparison').innerHTML='<table><thead><tr><th>모형 · +'+h+'M</th><th>헤지비율</th><th>누적 기대수익</th><th>미헤지 대비 · %p</th><th>변동성 · 1차 근사</th><th>변동성 감소 · %p</th><th>상태</th></tr></thead><tbody>'+['unhedged','A','B','C'].map(key=>{
      const result=key==='unhedged'?hedgeBaseline:hedgeModels[key],row=result?.rows.find(r=>r.horizon===h);
      return '<tr data-comparison-model="'+key+'"><th>'+(key==='unhedged'?'미헤지':'모형 '+key)+'</th><td>'+(result?pct(result.ratio):'—')+'</td><td>'+(row?pct(row.mean):'—')+'</td><td>'+(row&&base?signed((row.mean-base.mean)*100):'—')+'</td><td>'+(row?pct(row.approxVol):'—')+'</td><td>'+(row&&base?signed((base.approxVol-row.approxVol)*100):'—')+'</td><td>'+esc(row?'입력 가정':hedgeReasons[key]||'프리미엄 단위 확인 필요')+'</td></tr>';
    }).join('')+'</tbody></table>';
    $('hedge-comparison-csv').disabled=!Object.keys(hedgeModels).length;
  }
  function exportHedgeComparison(){
    if(!Object.keys(hedgeModels).length)return;
    const rows=[['model','status','reason','currency','input_type','horizon_months','hedge_ratio','expected_return','approx_vol','var975_loss_fraction','return_change_vs_unhedged','vol_reduction_vs_unhedged','annual_premium','annual_cost','risk_aversion']];
    for(const h of [3,6,9,12])for(const key of ['unhedged','A','B','C']){
      const result=key==='unhedged'?hedgeBaseline:hedgeModels[key],r=result?.rows.find(r=>r.horizon===h),base=hedgeBaseline?.rows.find(r=>r.horizon===h);
      rows.push([key,r?'available':'unavailable',r?'':hedgeReasons[key]||'프리미엄 단위 확인 필요',state.hedge.currency,'user_assumption',h,result?.ratio,r?.mean,r?.approxVol,r?.var975,r&&base?r.mean-base.mean:null,r&&base?base.approxVol-r.approxVol:null,state.hedge.premium,key==='unhedged'?0:state.models.hedgeCost,key==='B'?result?.riskAversion:null]);
    }
    download('collabo-hedge-comparison.csv',csv(rows),'text/csv;charset=utf-8');
  }
  function exportFXComparison(){
    if(!modelForecast)return;const f=modelForecast;
    const rows=[['model','status','reason','asof','method','horizon_months','date','mean_krw','median_krw','lower95_krw','upper95_krw','var975_loss_fraction','annual_log_drift','annual_log_vol','lookback_months','paths','seed','quality']];
    for(const h of [3,6,9,12])for(const key of ['A','B','C','consensus']){
      const r=key==='A'?f.rows.find(r=>r.horizon===h):null;
      rows.push([key,r?'available':'unavailable',r?'':missingFX[key],r?f.asof:null,r?f.method:null,h,r?.date,r?.mean,r?.median,r?.lower95,r?.upper95,r?.var975,r?f.annualDrift:null,r?f.annualVol:null,r?state.fx.lookback:null,r?f.paths:null,r?f.seed:null,r?forecastQuality(f).join(' · '):null]);
    }
    download('collabo-fx-comparison-'+f.asof+'.csv',csv(rows),'text/csv;charset=utf-8');
  }
  function wireModels(){
    for(const group of ['hedge','fx'])$(group+'-summary-horizon').addEventListener('change',()=>{const h=Number($(group+'-summary-horizon').value);if(![3,6,9,12].includes(h))return;summaryHorizon[group]=h;if(group==='hedge')renderHedgeSummary();else renderFXSummary();});
    $('hedge-comparison-csv').addEventListener('click',exportHedgeComparison);
    $('fx-comparison-csv').addEventListener('click',exportFXComparison);
    ['hedge','fx','cma'].forEach(group=>{
      const buttons=[...document.querySelectorAll('[data-'+group+'-tab]')];
      buttons.forEach((button,i)=>{
        button.addEventListener('click',()=>activateSubtab(group,button.getAttribute('data-'+group+'-tab')));
        button.addEventListener('keydown',event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
          activateSubtab(group,buttons[index].getAttribute('data-'+group+'-tab'));buttons[index].focus();
        });
      });activateSubtab(group,group==='cma'?'assumptions':'monitoring');
    });
    document.addEventListener('click',event=>{
      const p=event.target.closest('[data-summary-portfolio]');if(p&&allocation){selected=p.dataset.summaryPortfolio;renderAllocation();activate('allocation');}
      const fx=event.target.closest('[data-summary-fx]');if(fx)openModel('fx',fx.dataset.summaryFx);
      const h=event.target.closest('[data-summary-hedge]');if(h)openModel('hedge',h.dataset.summaryHedge);
      const monitor=event.target.closest('[data-monitor]');if(monitor)openModel(monitor.dataset.monitor,'monitoring');
      const exportButton=event.target.closest('[data-model-csv]');if(!exportButton||exportButton.disabled)return;
      const name=exportButton.dataset.modelCsv;
      if(name==='fx-a'&&modelForecast){const f=modelForecast;download('collabo-fx-model-a-'+f.asof+'.csv',csv([['asof','model','method','horizon_months','date','mean_krw','median_krw','lower68_krw','upper68_krw','lower95_krw','upper95_krw','var975_loss_fraction','paths','seed'],...quarterRows(f).map(r=>[f.asof,'A',f.method,r.horizon,r.date,r.mean,r.median,r.lower68,r.upper68,r.lower95,r.upper95,r.var975,20000,20261102])]),'text/csv;charset=utf-8');}
      else if(name.startsWith('hedge-')){const key=name.slice(-1).toUpperCase(),result=hedgeModels[key];if(!result)return;download('collabo-hedge-model-'+key.toLowerCase()+'.csv',csv([['model','currency','input_type','horizon_months','hedge_ratio','expected_return','approx_vol','lower68','upper68','lower95','upper95','var975_loss_fraction','annual_premium','annual_cost','risk_aversion'],...result.rows.map(r=>[key,state.hedge.currency,'user_assumption',r.horizon,result.ratio,r.mean,r.approxVol,r.lower68,r.upper68,r.lower95,r.upper95,r.var975,state.hedge.premium,state.models.hedgeCost,key==='B'?state.models.riskAversion:''])]),'text/csv;charset=utf-8');}
    });
    document.addEventListener('change',event=>{const input=event.target.closest('[data-model-control]');if(!input)return;const key=input.dataset.modelControl;state.models[key]=fieldNumber(input,key==='riskAversion'?1:100);renderHedgeModels();});
  }

  function syncReferenceControls() {
    const s=state.reference;
    $('reference-equity').value=number(s.equityWeight*100).replace(/,/g,'');
    $('reference-bond').value=number((1-s.equityWeight)*100).replace(/,/g,'');
    $('reference-weight').value=s.equityWeight*100;
    $('reference-lookback').value=String(s.lookback);$('reference-basis').value=s.basis;
  }
  function referenceBasisLabel() { return state.reference.basis==='krw'?'원화 환노출':'환율 미반영'; }
  function renderReference() {
    const w=state.reference.equityWeight,valid=Number.isFinite(w)&&w>=0&&w<=1;
    ['reference-equity','reference-bond','reference-weight'].forEach(id=>$(id).setAttribute('aria-invalid',String(!valid)));
    $('reference-allocation').innerHTML=valid?'<div class="reference-weight-labels"><span>해외주식 <strong>'+pct(w)+'</strong></span><span>국내채권 <strong>'+pct(1-w)+'</strong></span></div><div class="reference-weight-track"><span style="width:'+(w*100)+'%"></span></div>':'';
    referenceResult=null;$('reference-csv').disabled=true;$('reference-results').hidden=true;
    $('reference-metrics').innerHTML='';$('reference-chart').innerHTML='';$('reference-assets').innerHTML='';$('reference-source').textContent='';
    $('reference-correlation').textContent='원자료 확인 중';$('reference-correlation-period').textContent='월수익률 · 관측 상관계수';
    try {
      if(!R)throw new Error('레퍼런스 계산 모듈을 불러오지 못했습니다.');
      if(!valid)throw new Error('해외주식·국내채권 비중은 0–100% 범위여야 합니다.');
      if(referenceLoadError)throw new Error(referenceLoadError);
      if(!referenceData){showError('reference-error','');return;}
      const result=R.calculate(referenceData,state.reference);referenceResult=result;
      const basis=referenceBasisLabel(),sample=result.observations+'개월 · '+basis;
      $('reference-metrics').innerHTML=metric('기대수익률',number(result.expectedReturn*100),'% / 연','과거 월수익률 · 산술 연율',true)+metric('연환산 변동성',number(result.annualVol*100),'%',sample)+metric('연복리 수익률',result.cagr===null?'—':number(result.cagr*100),'%',result.cagr===null?'결측 구간 · 미산출':'CAGR · 과거 실현값');
      $('reference-period').textContent=result.startDate+'–'+result.endDate;
      const names=['해외주식','국내채권'],indices=['미국_S&P500_TR','한국종합 (KBPMABIN INDEX)'];
      $('reference-assets').innerHTML='<table><thead><tr><th>자산</th><th>시계열</th><th>비중</th><th>기대수익률 · 연</th><th>변동성 · 연</th></tr></thead><tbody>'+names.map((name,i)=>'<tr><th>'+name+'</th><td>'+indices[i]+'</td><td>'+pct(result.weights[i])+'</td><td>'+pct(result.assetStats[i].expectedReturn)+'</td><td>'+pct(result.assetStats[i].annualVol)+'</td></tr>').join('')+'</tbody></table>';
      $('reference-source').textContent='data_bb.xlsx · D · 원자료 '+result.sourceAsOf+' · '+basis+' · 월별 리밸런싱'+(result.gapCount?' · 결측 구간 '+result.gapCount+'개':'');
      const labels=[...names,'레퍼런스'];
      $('reference-correlation').innerHTML='<table class="correlation-table reference-matrix"><thead><tr><th scope="col">관측 상관계수</th>'+labels.map((name,i)=>'<th scope="col"'+(i===2?' class="selected-col"':'')+'>'+name+'</th>').join('')+'</tr></thead><tbody>'+labels.map((name,i)=>'<tr><th scope="row"'+(i===2?' class="selected-col"':'')+'>'+name+'</th>'+result.correlation[i].map((v,j)=>'<td'+(i===2||j===2?' class="selected-col"':'')+'>'+number(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
      $('reference-correlation-period').textContent=result.rows[0].date.slice(0,7)+'–'+result.endDate.slice(0,7)+' · '+sample;
      drawReference(result);showError('reference-error','');$('reference-results').hidden=false;$('reference-csv').disabled=false;
    }catch(error){const message=failMessage(error);showError('reference-error',message);$('reference-correlation').textContent='미산출 · '+message;}
  }
  function drawReference(result) {
    if(result.gapCount){$('reference-chart').textContent='결측 구간 · 누적 성과 미산출';return;}
    const levels=[100,100,100],points=[{date:result.startDate,values:[...levels]}];
    result.rows.forEach(row=>{[row.equity,row.bond,row.reference].forEach((r,i)=>levels[i]*=1+r);points.push({date:row.date,values:[...levels]});});
    const W=740,H=260,L=58,R=22,T=20,B=35,values=points.flatMap(p=>p.values),lo=Math.floor(Math.min(...values)/20)*20,hi=Math.max(lo+20,Math.ceil(Math.max(...values)/20)*20);
    const x=i=>L+i/(points.length-1)*(W-L-R),y=v=>H-B-(v-lo)/(hi-lo)*(H-T-B);
    let svg=svgStart(W,H,'레퍼런스와 구성 자산의 누적 성과, 시작 100');
    for(let i=0;i<=4;i++){const v=lo+i*(hi-lo)/4,yy=y(v);svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#27374a" stroke-dasharray="3 4"/><text x="'+(L-10)+'" y="'+(yy+4)+'" text-anchor="end">'+number(v,0)+'</text>';}
    for(let i=0;i<=5;i++){const k=Math.round(i*(points.length-1)/5),xx=x(k);svg+='<line x1="'+xx+'" x2="'+xx+'" y1="'+T+'" y2="'+(H-B)+'" stroke="#27374a" stroke-dasharray="3 4"/><text x="'+xx+'" y="'+(H-10)+'" text-anchor="middle">'+points[k].date.slice(2,7).replace('-','.')+'</text>';}
    ['#5276b5','#61cdb8','#e8bf71'].forEach((color,j)=>{svg+='<path d="'+points.map((p,i)=>(i?'L':'M')+x(i).toFixed(2)+','+y(p.values[j]).toFixed(2)).join(' ')+'" fill="none" stroke="'+color+'" stroke-width="'+(j===2?2.5:1.5)+'"/>';});
    $('reference-chart').innerHTML=svg+'</svg>';
  }
  async function loadReference() {
    renderReference();
    try{const response=await fetch('platform/reference-data.json');if(!response.ok)throw new Error('레퍼런스 원자료 요청 실패 ('+response.status+')');referenceData=await response.json();if(referenceData.schemaVersion!==1)throw new Error('레퍼런스 원자료 버전을 확인하십시오.');}
    catch(error){referenceData=null;referenceLoadError=failMessage(error);}
    renderReference();
  }
  function wireReference() {
    ['reference-equity','reference-bond','reference-weight'].forEach(id=>$(id).addEventListener('input',()=>{
      const value=fieldNumber($(id)),w=id==='reference-bond'?1-value:value;
      state.reference.equityWeight=w;
      if(Number.isFinite(w)&&w>=0&&w<=1){if(id!=='reference-equity')$('reference-equity').value=number(w*100).replace(/,/g,'');if(id!=='reference-bond')$('reference-bond').value=number((1-w)*100).replace(/,/g,'');if(id!=='reference-weight')$('reference-weight').value=w*100;}
      renderReference();
    }));
    ['reference-lookback','reference-basis'].forEach(id=>$(id).addEventListener('change',()=>{state.reference[id==='reference-lookback'?'lookback':'basis']=id==='reference-lookback'?Number($(id).value):$(id).value;renderReference();}));
    $('reference-reset').addEventListener('click',()=>{state.reference.equityWeight=.6;syncReferenceControls();renderReference();});
    $('reference-csv').addEventListener('click',()=>{
      const r=referenceResult;if(!r)return;
      download('collabo-reference-'+r.endDate+'.csv',csv([['source_asof','sample_start','sample_end','basis','rebalance','equity_weight','bond_weight','months','expected_return_annual','vol_annual','cagr','date','equity_return','bond_return','reference_return','cumulative_return'],...r.rows.map(row=>[r.sourceAsOf,r.startDate,r.endDate,r.basis,'monthly',r.weights[0],r.weights[1],r.observations,r.expectedReturn,r.annualVol,r.cagr,row.date,row.equity,row.bond,row.reference,row.cumulative])]),'text/csv;charset=utf-8');
    });
  }
  async function start() {
    wireEvents();activate(location.hash.slice(1));renderCma();renderHedgeInputs();renderForecastControls();recalculate();renderFXModels();$('forecast-csv').disabled=true;
    syncReferenceControls();loadReference();
    try{if(!F)throw new Error('환율 계산 모듈을 불러오지 못했습니다.');const response=await fetch('data/market.json');if(!response.ok)throw new Error('시장 데이터 요청 실패 ('+response.status+')');market=await response.json();if(!Array.isArray(market.series)||!Array.isArray(market.dates))throw new Error('시장 데이터 형식을 확인하십시오.');renderMarket();renderHedgeMarket();const usd=findSeries('FX',/^USDKRW$/i);fxHistory=await loadSeries(usd);renderForecast();}
    catch(error){showError('data-error',failMessage(error)+' · 시장 데이터와 환율전망을 표시할 수 없습니다. CMA 기반 자산배분은 사용할 수 있습니다.');$('market-strip').innerHTML='<span class="muted">시장 데이터 연결을 확인하십시오.</span>';$('source-footer').textContent='시장 원자료 연결 오류';renderFXModels(failMessage(error));}
  }
  start();
})();
