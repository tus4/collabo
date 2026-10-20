(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const A = window.CollaboAnalytics, F = window.CollaboFX;
  const COLORS = ['#61cdb8', '#91aeb8', '#759ee9', '#a6a0d6', '#e8bf71', '#d99178', '#9fb272'];
  const NAMES = ['국내시가', '국내장부', '해외시가', '해외장부', '국내주식', '해외주식', '대체투자'];
  const STORAGE_KEY = 'collabo:investment-platform:scenario:v1';
  const NAV_STORAGE_KEY = 'collabo:investment-platform:nav-order:v1';
  const TABS = {allocation:'Optimizer',hedge:'Hedge',cma:'CMA',fx:'Currency',alternative:'Alternative'};
  const LABELS = {current:'현재',saa:'SAA',minVol:'Min Vol',maxSharpe:'Max Sharpe',target:'목표 근접',custom:'조합 선택'};
  const CAPTIONS = {current:'현재 투자비중',saa:'전략 자산배분',minVol:'최소 변동성',maxSharpe:'최대 샤프비율',target:'목표수익률 근접 조합'};
  let market = null, fxHistory = [], allocation = null, forecast = null, selected = 'maxSharpe', customPoint = null, currentTab = 'allocation', hedgeSeq = 0, toastTimer;
  const cache = new Map();
  function defaults() {
    const mu = [.037,.033,.047,.042,.075,.08,.065], vol = [.045,.012,.085,.03,.20,.18,.10];
    const current = [.20,.15,.15,.10,.10,.15,.15], saa = [.25,.15,.15,.10,.10,.15,.10];
    const factors = [[.55,0,0],[.20,0,0],[.40,0,.60],[.20,0,.25],[0,.75,0],[0,.70,.35],[.15,.40,.15]];
    return {version:1, assets:NAMES.map((name,i)=>({id:'asset-'+i,name,mu:mu[i],vol:vol[i],min:0,max:.5,current:current[i],saa:saa[i]})),
      corr:factors.map((f,i)=>factors.map((g,j)=>i===j?1:f.reduce((s,v,k)=>s+v*g[k],0))),rf:.025,target:.055,shock:0,
      hedge:{currency:'USD',localReturn:.05,fxReturn:0,premium:0,hedgeRatio:.5,assetVol:.08,fxVol:.10,correlation:0,confirmed:false},
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
    if(!Object.keys(TABS).includes(tab)) tab='allocation'; currentTab=tab;
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
    $('cma-table').innerHTML='<table class="editable-table"><thead><tr><th>자산군</th>'+fields.map(f=>'<th>'+f[1]+'</th>').join('')+'</tr></thead><tbody>'+state.assets.map((a,i)=>'<tr><td><span class="asset-dot" style="background:'+COLORS[i]+'"></span>'+esc(a.name)+'</td>'+fields.map(([key,label])=>'<td><input type="number" step="0.1" '+(key==='mu'?'min="-100" max="100"':'min="0" max="100"')+' value="'+(Number.isFinite(a[key])?number(a[key]*100).replace(/,/g,''):'')+'" data-asset="'+i+'" data-field="'+key+'" aria-label="'+esc(a.name+' '+label+' 퍼센트')+'"></td>').join('')+'</tr>').join('')+'</tbody></table>';
    $('correlation-table').innerHTML='<table class="correlation-table"><thead><tr><th>상관계수</th>'+NAMES.map(n=>'<th>'+n+'</th>').join('')+'</tr></thead><tbody>'+NAMES.map((n,i)=>'<tr><td>'+n+'</td>'+NAMES.map((_,j)=>i<j?'<td><input type="number" min="-1" max="1" step="0.01" value="'+number(state.corr[i][j]).replace(/,/g,'')+'" data-corr-i="'+i+'" data-corr-j="'+j+'" aria-label="'+n+' 및 '+NAMES[j]+' 상관계수"></td>':'<td class="fixed-cell" id="corr-'+i+'-'+j+'">'+number(state.corr[i][j])+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
    $('risk-free').value=number(state.rf*100).replace(/,/g,''); $('target-return').value=number(state.target*100).replace(/,/g,''); $('mu-shock').value=number(state.shock*100).replace(/,/g,''); renderTotals();
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
  }
  function chosen() { return selected==='custom'?customPoint:allocation[selected]; }
  function renderAllocation() {
    if(!allocation)return;const p=chosen(),delta=p.return-allocation.current.return;
    $('portfolio-metrics').innerHTML=metric('기대수익률',number(p.return*100),'%',LABELS[selected]+' · 현재 대비 '+signed(delta*100)+'%p',true)+metric('예상 변동성',number(p.vol*100),'%','연율 · CMA 공분산 기준')+metric('샤프비율',(p.sharpeDefined===false?'—':number(p.sharpe)),'','무위험수익률 '+pct(state.rf))+metric('투자 자산군','7','','현재 / SAA / 최적안 비교');
    $('portfolio-choices').innerHTML=['current','saa','minVol','maxSharpe','target'].map(key=>'<button class="portfolio-choice'+(selected===key?' active':'')+'" data-portfolio="'+key+'" aria-pressed="'+(selected===key)+'"><span class="choice-radio"></span><span><span class="choice-name">'+LABELS[key]+'</span><span class="choice-caption" style="display:block">'+CAPTIONS[key]+'</span></span><span class="choice-value">'+pct(allocation[key].return)+'</span></button>').join('');
    $('selected-summary').innerHTML='<div class="summary-row"><span>선택안</span><strong>'+LABELS[selected]+'</strong></div><div class="summary-row"><span>수익률 가정 이동</span><strong>'+signed(state.shock*100)+'%p</strong></div><div class="summary-row"><span>비중 합계</span><strong>'+pct(p.weights.reduce((a,b)=>a+b,0))+'</strong></div>';
    const min=allocation.result.frontier[0].return,max=allocation.result.frontier[allocation.result.frontier.length-1].return;
    $('target-note').textContent='목표 '+pct(state.target)+' → 근접 조합 '+pct(allocation.target.return)+' · 효율적 경계 범위 '+pct(min)+'–'+pct(max)+(state.target<min||state.target>max?' · 목표가 범위 밖이므로 가장 가까운 경계 조합을 표시합니다.':' · 35개 계산 조합 중 선택합니다.');
    $('weights-table').innerHTML='<table><thead><tr><th>자산군</th><th>현재</th><th>SAA</th><th>'+LABELS[selected]+'</th><th>현재 대비</th></tr></thead><tbody>'+NAMES.map((n,i)=>{const delta=(p.weights[i]-state.assets[i].current)*100,rounded=Math.sign(delta)*Math.round(Math.abs(delta))||0;return '<tr><td><span class="asset-dot" style="background:'+COLORS[i]+'"></span>'+n+'</td><td>'+number(state.assets[i].current*100)+'%</td><td>'+number(state.assets[i].saa*100)+'%</td><td class="selected-col">'+number(p.weights[i]*100)+'%</td><td class="'+signClass(rounded)+'">'+(rounded>0?'+':'')+number(rounded,0)+'%p</td></tr>';}).join('')+'</tbody></table>';
    const riskMax=Math.max(...p.contributions.map(Math.abs),.000001);
    $('risk-bars').innerHTML=NAMES.map((n,i)=>'<div class="risk-row"><span>'+n+'</span><div class="risk-track"><div class="risk-fill" style="width:'+Math.min(100,Math.abs(p.contributions[i])/riskMax*100)+'%;background:'+(p.contributions[i]<0?'#d99191':COLORS[i])+'"></div></div><span class="risk-value '+signClass(p.contributions[i])+'">'+number(p.contributions[i]*100)+'</span></div>').join('');
    drawFrontier(p);
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
    $('forecast-drift-label').hidden=state.fx.method!=='scenario';if(!fxHistory.length)return;
    try {requireNumber(state.fx.annualDrift,'로그 드리프트',-1,1);forecast=F.forecast(fxHistory,state.fx);const last=forecast.rows[forecast.rows.length-1],method={"random-walk":'랜덤워크',historical:'역사적 드리프트',scenario:'사용자 시나리오'}[state.fx.method];
      showError('fx-error','');
      $('fx-metrics').innerHTML=metric('마지막 관측 환율',number(forecast.spot),'원',forecast.asof+' · USDKRW')+metric(state.fx.months+'개월 전망 중앙값',number(last.median),'원',method,true)+metric('연율 변동성',number(forecast.annualVol*100),'%',forecast.observations+'개월 로그수익률 기준')+metric('95% 예측 범위',number(last.lower95,0)+'–'+number(last.upper95,0),'원',last.date+' · 조건부 분포');
      $('forecast-caption').textContent='관측 기준 '+forecast.asof+' · '+method+' · 연간 로그 드리프트 '+pct(forecast.annualDrift);
      let warning=$('forecast-warning');if(!warning){warning=document.createElement('div');warning.id='forecast-warning';warning.className='notice';$('fx-metrics').after(warning);}const warnings=forecast.warnings||[];warning.textContent=warnings.join(' ');warning.hidden=!warnings.length;
      drawForecast(forecast);
      $('forecast-table').innerHTML='<table><thead><tr><th>전망 시점</th><th>중앙값</th><th>68% 하단</th><th>68% 상단</th><th>95% 하단</th><th>95% 상단</th></tr></thead><tbody>'+forecast.rows.filter(r=>r.horizon>0).map(r=>'<tr><td>'+esc(r.date)+'</td><td class="selected-col">'+number(r.median)+'</td><td>'+number(r.lower68)+'</td><td>'+number(r.upper68)+'</td><td>'+number(r.lower95)+'</td><td>'+number(r.upper95)+'</td></tr>').join('')+'</tbody></table>';
      renderOos();$('forecast-csv').disabled=false;
    }catch(error){forecast=null;showError('fx-error',failMessage(error));$('forecast-chart').innerHTML='';$('fx-metrics').innerHTML='';$('forecast-table').innerHTML='';$('oos-results').textContent='유효한 전망 가정이 필요합니다.';if($('forecast-warning'))$('forecast-warning').hidden=true;$('forecast-csv').disabled=true;}
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
      $('oos-results').innerHTML='<div class="subtle-tag">'+esc(oos.startDate)+'–'+esc(oos.endDate)+' · '+oos.observations+'개월 · 추정창 '+state.fx.lookback+'개월</div><div class="oos-grid">'+[['randomWalk','랜덤워크'],['historical','역사적 드리프트']].map(([key,label])=>{const p=oos[key];return '<div class="oos-card"><div class="label">'+label+'</div><strong>'+number(p.rmse)+' <span style="font-size:11px">원</span></strong><p>RMSE · 1개월 앞</p><p>68% 범위 포함률 '+pct(p.coverage68)+'</p><p>95% 범위 포함률 '+pct(p.coverage95)+'</p></div>';}).join('')+'</div><p class="fineprint">'+esc((oos.warnings||[]).join(' '))+'</p>';
    }catch(error){$('oos-results').textContent='표본 외 평가: '+failMessage(error);}
  }
  function importState(raw) {
    if(!raw||raw.version!==1||!Array.isArray(raw.assets)||raw.assets.length!==7||!Array.isArray(raw.corr)||raw.corr.length!==7)throw new Error('지원하는 COLLABO v1 가정 파일이 아닙니다.');
    const next=defaults();
    next.assets=raw.assets.map((a,i)=>{if(!a||a.id!=='asset-'+i)throw new Error('자산군 순서 또는 ID가 올바르지 않습니다.');const result={id:'asset-'+i,name:NAMES[i]};['mu','vol','min','max','current','saa'].forEach(k=>result[k]=requireNumber(a[k],NAMES[i]+' '+k,k==='mu'?-1:0,1));return result;});
    next.corr=raw.corr.map(row=>{if(!Array.isArray(row)||row.length!==7)throw new Error('상관행렬 크기를 확인하십시오.');return row.map(v=>requireNumber(v,'상관계수',-1,1));});
    next.rf=requireNumber(raw.rf,'무위험수익률',-.2,.5);next.target=requireNumber(raw.target,'목표수익률',-1,1);next.shock=requireNumber(raw.shock,'가정 이동',-.5,.5);
    if(raw.hedge){if(!['USD','JPY','EUR','AUD'].includes(raw.hedge.currency))throw new Error('지원하지 않는 통화입니다.');next.hedge.currency=raw.hedge.currency;['localReturn','fxReturn','premium','assetVol','fxVol','correlation','hedgeRatio'].forEach(k=>next.hedge[k]=requireNumber(raw.hedge[k],'환헤지 '+k,['assetVol','fxVol','hedgeRatio'].includes(k)?0:-1,1));next.hedge.confirmed=raw.hedge.confirmed===true;F.scenario(next.hedge);}
    if(raw.fx){if(!['random-walk','historical','scenario'].includes(raw.fx.method)||![3,6,12,24].includes(raw.fx.months)||![36,60,120].includes(raw.fx.lookback))throw new Error('전망 모형·기간을 확인하십시오.');next.fx={method:raw.fx.method,months:raw.fx.months,lookback:raw.fx.lookback,annualDrift:requireNumber(raw.fx.annualDrift,'로그 드리프트',-1,1),band68:raw.fx.band68!==false,band95:raw.fx.band95!==false};}
    validateState(next);return next;
  }
  function applyState(next) { state=next;selected='maxSharpe';customPoint=null;renderCma();renderHedgeInputs();renderForecastControls();recalculate();renderHedgeMarket();renderForecast(); }
  function wireEvents() {
    wireNavigation();
    document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>activate(b.dataset.open)));
    window.addEventListener('hashchange',()=>activate(location.hash.slice(1)));
    $('cma-table').addEventListener('change',e=>{if(e.target.dataset.asset!==undefined){state.assets[Number(e.target.dataset.asset)][e.target.dataset.field]=fieldNumber(e.target);recalculate();}});
    $('correlation-table').addEventListener('change',e=>{const t=e.target;if(t.dataset.corrI!==undefined){const i=Number(t.dataset.corrI),j=Number(t.dataset.corrJ),v=fieldNumber(t,1);state.corr[i][j]=v;state.corr[j][i]=v;$('corr-'+j+'-'+i).textContent=number(v);recalculate();}});
    [['risk-free','rf'],['target-return','target'],['mu-shock','shock']].forEach(([id,key])=>$(id).addEventListener('change',()=>{state[key]=fieldNumber($(id));recalculate();}));
    $('portfolio-choices').addEventListener('click',e=>{const b=e.target.closest('[data-portfolio]');if(b&&allocation){selected=b.dataset.portfolio;renderAllocation();}});
    const selectFront=e=>{const point=e.target.closest('[data-frontier]');if(point&&allocation){customPoint=allocation.result.frontier[Number(point.dataset.frontier)];selected='custom';renderAllocation();}};
    $('frontier-chart').addEventListener('click',selectFront);$('frontier-chart').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectFront(e);}});
    $('allocation-csv').addEventListener('click',()=>{if(!allocation)return;const p=chosen();download('collabo-allocation.csv',csv([['asset','current_weight','saa_weight','selected_weight','change_weight','risk_contribution_annual','assumption_mu_annual','assumption_vol_annual'],...NAMES.map((n,i)=>[n,state.assets[i].current,state.assets[i].saa,p.weights[i],p.weights[i]-state.assets[i].current,p.contributions[i],allocation.assets[i].mu,allocation.assets[i].vol])]),'text/csv;charset=utf-8');});
    $('save-scenario').addEventListener('click',()=>{try{importState(state);localStorage.setItem(STORAGE_KEY,JSON.stringify({...state,savedAt:new Date().toISOString()}));notify('현재 가정을 이 브라우저에 저장했습니다.');}catch(e){notify('저장 실패: '+failMessage(e));}});
    $('load-scenario').addEventListener('click',()=>{try{const value=localStorage.getItem(STORAGE_KEY);if(!value)throw new Error('저장된 가정이 없습니다.');applyState(importState(JSON.parse(value)));notify('저장된 가정을 불러왔습니다.');}catch(e){notify('불러오기 실패: '+failMessage(e));}});
    $('export-scenario').addEventListener('click',()=>{try{importState(state);download('collabo-scenario-v1.json',JSON.stringify({...state,savedAt:new Date().toISOString()},null,2),'application/json');}catch(e){notify(failMessage(e));}});
    $('import-scenario').addEventListener('click',()=>$('scenario-file').click());
    $('scenario-file').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>100000)throw new Error('파일 크기는 100KB 이하여야 합니다.');applyState(importState(JSON.parse(await file.text())));notify('검증된 가정을 적용했습니다.');}catch(err){notify('가져오기 실패: '+failMessage(err));}finally{e.target.value='';}});
    $('reset-scenario').addEventListener('click',()=>{applyState(defaults());notify('화면의 가정을 초기값으로 되돌렸습니다. 저장된 가정은 유지됩니다.');});
    $('currency-picker').addEventListener('click',e=>{const b=e.target.closest('[data-currency]');if(!b)return;state.hedge.currency=b.dataset.currency;state.hedge.confirmed=false;renderHedgeInputs();renderHedgeMarket();});
    $('hedge-inputs').addEventListener('change',e=>{const key=e.target.dataset.hedge;if(!key)return;state.hedge[key]=fieldNumber(e.target,key==='correlation'?1:100);if(key==='premium'){state.hedge.confirmed=false;$('premium-confirm').checked=false;}renderHedgeScenario();});
    $('premium-confirm').addEventListener('change',()=>{state.hedge.confirmed=$('premium-confirm').checked;renderHedgeScenario();});
    $('hedge-ratio').addEventListener('input',()=>{state.hedge.hedgeRatio=Number($('hedge-ratio').value)/100;renderHedgeScenario();});
    [['forecast-method','method'],['forecast-months','months'],['forecast-lookback','lookback']].forEach(([id,key])=>$(id).addEventListener('change',()=>{state.fx[key]=key==='method'?$(id).value:Number($(id).value);renderForecast();}));
    $('forecast-drift').addEventListener('change',()=>{state.fx.annualDrift=fieldNumber($('forecast-drift'));renderForecast();});
    ['band68','band95'].forEach(id=>$(id).addEventListener('change',()=>{state.fx[id]=$(id).checked;if(forecast)drawForecast(forecast);}));
    $('forecast-csv').addEventListener('click',()=>{if(!forecast)return;download('collabo-usdkrw-forecast-'+forecast.asof+'.csv',csv([['asof','method','lookback_months','annual_log_drift','annual_log_vol','horizon_months','date','median_krw','mean_krw','lower68_krw','upper68_krw','lower95_krw','upper95_krw'],...forecast.rows.map(r=>[forecast.asof,forecast.method,state.fx.lookback,forecast.annualDrift,forecast.annualVol,r.horizon,r.date,r.median,r.mean,r.lower68,r.upper68,r.lower95,r.upper95])]),'text/csv;charset=utf-8');});
  }
  async function start() {
    wireEvents();activate(location.hash.slice(1));renderCma();renderHedgeInputs();renderForecastControls();recalculate();$('forecast-csv').disabled=true;
    try{if(!F)throw new Error('환율 계산 모듈을 불러오지 못했습니다.');const response=await fetch('data/market.json');if(!response.ok)throw new Error('시장 데이터 요청 실패 ('+response.status+')');market=await response.json();if(!Array.isArray(market.series)||!Array.isArray(market.dates))throw new Error('시장 데이터 형식을 확인하십시오.');renderMarket();renderHedgeMarket();const usd=findSeries('FX',/^USDKRW$/i);fxHistory=await loadSeries(usd);renderForecast();}
    catch(error){showError('data-error',failMessage(error)+' · 시장 데이터와 환율전망을 표시할 수 없습니다. CMA 기반 자산배분은 사용할 수 있습니다.');$('market-strip').innerHTML='<span class="muted">시장 데이터 연결을 확인하십시오.</span>';$('source-footer').textContent='시장 원자료 연결 오류';}
  }
  start();
})();
