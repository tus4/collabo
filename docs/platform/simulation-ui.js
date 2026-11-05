/* Period-sensitive covariance estimates and linked portfolio charts. */
(function (root) {
  'use strict';
  root.CollaboSimulationUI = {create};
  function create({document, chartExport, fetch}) {
    const $ = name => document.getElementById('simulation-' + name);
    const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmt = value => Number.isFinite(value) ? value.toLocaleString('ko-KR', {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';
    const pct = value => Number.isFinite(value) ? fmt(value * 100) + '%' : '—';
    const colors = ['#759ee9','#61cdb8','#d6b5ee','#e8bf71','#a8b3c2'];
    const fields = ['start','end','performance-end','basis','mode','objective','rf','evaluation','rho','rho-value'];
    const plots = ['table','frontier','performance'];
    let quality = 'KBPMABIN 원자료 검증 대기 · 잠정 시뮬레이션';
    let data = null, result = null;
    function error(message) { $('error').textContent = message; $('error').hidden = !message; }
    function clear() {
      result = null; $('results').hidden = true;
      plots.forEach(id => { chartExport.clear('simulation-' + id); $(id).innerHTML = ''; });
      ['frontier-legend','performance-legend','performance-stats','baseline','performance-period','performance-mode','method'].forEach(id => $(id).textContent = '');
    }
    function readNumber(name) {
      const value = $(name).value.trim();
      const number = value === '' ? NaN : Number(value);
      $(name).setAttribute('aria-invalid', String(!Number.isFinite(number)));
      return number;
    }
    function options() {
      const objective = $('objective').value;
      const rf = objective === 'minVol' ? 0 : readNumber('rf') / 100;
      if (!Number.isFinite(rf) || rf < -.2 || rf > 1) throw new Error('무위험수익률은 −20%–100% 범위여야 합니다.');
      return {start:$('start').value,end:$('end').value,performanceEnd:$('performance-end').value,
        basis:$('basis').value,mode:$('mode').value,objective,rf,customRho:readNumber('rho-value'),evaluation:$('evaluation').value};
    }
    function legend(id, labels, selected) {
      $(id).innerHTML = labels.map((label,i) => selected && !selected[i] ? '' : '<span><i style="background:'+colors[i]+'"></i>'+esc(label)+'</span>').join('');
    }
    function label(label, i) { return '<span class="simulation-series-label"><i style="background:'+colors[i]+'"></i>'+esc(label)+'</span>'; }
    function metadata(r) {
      return [r.sourceAsOf, data.source?.sha256 || '', data.source?.quality?.status || 'unverified', data.source?.quality?.code || '', quality, r.basis, r.mode, r.objective, r.rf,
        r.training.requestedStart, r.training.requestedEnd, r.scenarios.find(s=>s.id==='custom')?.rho, $('performance-end').value, r.performance.evaluation];
    }
    const metaHead = ['source_asof','source_sha256','quality_status','quality_code','data_quality','basis','mode','objective','risk_free_return_annual','training_start','training_end','custom_rho','requested_performance_end','evaluation'];
    function exportRows(name, rows, r) {
      chartExport.set('simulation-'+name, {label:'Correlation Simulation '+name,mount:$(name+'-head'),
        filename:'collabo-correlation-simulation-'+name+'-'+r.sourceAsOf+'.csv',rows});
    }
    function comparison(r) {
      $('method').textContent = (r.mode==='correlation'?'ρ 단독 · μ·σ 월간 고정':'μ·σ·ρ 주기별 재추정')+' · '+(r.objective==='minVol'?'MinVol':'MaxSharpe');
      $('table').innerHTML = '<table><thead><tr><th scope="col">수익률 주기</th><th scope="col">관측 수</th><th scope="col">ρ</th><th scope="col">ACWI_TR</th><th scope="col">국내채권</th><th scope="col">기대수익률 · 연</th><th scope="col">변동성 · 연</th><th scope="col">실제 추정 구간</th></tr></thead><tbody>'+r.scenarios.map((s,i) => {
        if(s.error || !s.optimum) return '<tr><th scope="row">'+label(s.label,i)+'</th><td colspan="7" class="simulation-error-cell">'+esc(s.error || '미산출')+'</td></tr>';
        return '<tr><th scope="row">'+label(s.label,i)+'</th><td>'+s.n+'</td><td class="simulation-selected">'+fmt(s.rho)+'</td><td>'+pct(s.optimum.weight)+'</td><td>'+pct(1-s.optimum.weight)+'</td><td>'+pct(s.optimum.expectedReturn)+'</td><td>'+pct(s.optimum.annualVol)+'</td><td>'+esc(s.startDate)+' – '+esc(s.endDate)+'</td></tr>';
      }).join('')+'</tbody></table>';
      const columns = [...metaHead,'scenario','observations','correlation','equity_weight','bond_weight','expected_return_annual','volatility_annual','sharpe','actual_start','actual_end','equity_mean_annual','bond_mean_annual','equity_vol_annual','bond_vol_annual','error'];
      exportRows('table',[columns,...r.scenarios.map(s=>[...metadata(r),s.id,s.n,s.rho,s.optimum?.weight,s.optimum?1-s.optimum.weight:null,s.optimum?.expectedReturn,s.optimum?.annualVol,s.optimum?.sharpe,s.startDate,s.endDate,...(s.means||[null,null]),...(s.vols||[null,null]),s.error||''])],r);
      $('baseline').innerHTML = '<span>월간 기준 μ · ACWI_TR '+pct(r.baseline.means[0])+' / 국내채권 '+pct(r.baseline.means[1])+'</span><span>월간 기준 σ · ACWI_TR '+pct(r.baseline.vols[0])+' / 국내채권 '+pct(r.baseline.vols[1])+'</span><span>사용자 ρ · 월간 μ·σ</span>';
    }
    const W=960,H=340,L=64,R=24,T=28,B=46;
    function axisRange(values,zero=false) {
      let lo=Math.min(...values),hi=Math.max(...values);
      if(zero)lo=Math.min(0,lo);
      const pad=Math.max((hi-lo)*.08,.01);
      return [zero?Math.max(0,lo-pad):lo-pad,hi+pad];
    }
    function grid(xRange,yRange,xLabel,yLabel,dateTicks) {
      const x=v=>L+(v-xRange[0])/(xRange[1]-xRange[0])*(W-L-R);
      const y=v=>H-B-(v-yRange[0])/(yRange[1]-yRange[0])*(H-T-B);
      let svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" tabindex="0" aria-label="'+esc(yLabel+' · '+xLabel)+'"><title>'+esc(yLabel+' · '+xLabel)+'</title>';
      for(let i=0;i<=4;i++) {
        const value=yRange[0]+i*(yRange[1]-yRange[0])/4, yy=y(value);
        svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#27374a" stroke-dasharray="3 4"/><text x="'+(L-10)+'" y="'+(yy+4)+'" text-anchor="end">'+fmt(value)+'</text>';
      }
      const ticks=dateTicks || Array.from({length:6},(_,i)=>({value:xRange[0]+i*(xRange[1]-xRange[0])/5,label:fmt(xRange[0]+i*(xRange[1]-xRange[0])/5)}));
      ticks.forEach(tick=>{const xx=x(tick.value);svg+='<line x1="'+xx+'" x2="'+xx+'" y1="'+T+'" y2="'+(H-B)+'" stroke="#27374a" stroke-dasharray="3 4"/><text x="'+xx+'" y="'+(H-B+18)+'" text-anchor="middle">'+esc(tick.label)+'</text>';});
      svg+='<text x="'+L+'" y="14">'+esc(yLabel)+'</text><text x="'+(W-R)+'" y="'+(H-5)+'" text-anchor="end">'+esc(xLabel)+'</text>';
      return {svg,x,y};
    }
    function path(points,x,y,keyX,keyY) {
      let connected=false;
      return points.map(p=>{if(!Number.isFinite(p[keyY])||!Number.isFinite(p[keyX])){connected=false;return '';}
        const command=connected?'L':'M';connected=true;return command+x(p[keyX]).toFixed(2)+','+y(p[keyY]).toFixed(2);}).join(' ');
    }
    function bindInspection(name, entries, paint, nearest) {
      const mount=$(name),svg=mount.querySelector('svg'),tip=mount.querySelector('.simulation-tip');
      let current=0;
      const hide=()=>{tip.hidden=true;svg.querySelector('[data-inspection]')?.setAttribute('visibility','hidden');};
      const inspect=index=>{current=Math.max(0,Math.min(entries.length-1,index));paint(entries[current],svg,tip);tip.hidden=false;};
      const helpId='simulation-'+name+'-help';
      svg.setAttribute('aria-describedby',helpId);
      const help=document.createElement('span');help.id=helpId;help.className='sr-only';help.textContent='좌우 방향키로 관측 이동, Home과 End로 처음과 마지막 조회, Escape로 닫기';mount.appendChild(help);
      svg.addEventListener('pointermove',event=>{
        const rect=svg.getBoundingClientRect();if(!rect.width||!rect.height)return;
        const px=(event.clientX-rect.left)/rect.width*W,py=(event.clientY-rect.top)/rect.height*H;
        if(px<L||px>W-R||py<T||py>H-B){hide();return;}inspect(nearest(px,py));
      });
      svg.addEventListener('pointerleave',hide);svg.addEventListener('blur',hide);svg.addEventListener('focus',()=>inspect(current));
      svg.addEventListener('keydown',event=>{
        if(event.key==='Escape'){hide();return;}
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();inspect(event.key==='Home'?0:event.key==='End'?entries.length-1:current+(event.key==='ArrowRight'?1:-1));
      });
    }
    function frontier(r) {
      const valid=r.scenarios.map(s=>!s.error&&s.optimum&&s.frontier.length>0);
      const all=r.scenarios.flatMap((s,i)=>valid[i]?[...s.frontier,s.optimum].map(p=>({...p,scenario:i,x:p.annualVol*100,y:p.expectedReturn*100})):[]);
      if(!all.length){$('frontier').innerHTML='<div class="simulation-empty">효율적 투자선 미산출</div>';return;}
      legend('frontier-legend',r.scenarios.map(s=>s.label),valid);
      const xr=axisRange(all.map(p=>p.x),true),yr=axisRange(all.map(p=>p.y));
      const axes=grid(xr,yr,'변동성 · 연 (%)','기대수익률 · 연 (%)');let svg=axes.svg;
      const entries=[];
      r.scenarios.forEach((s,i)=>{
        if(!valid[i])return;
        const points=s.frontier.map(p=>({...p,scenario:i,x:p.annualVol*100,y:p.expectedReturn*100}));entries.push(...points);
        svg+='<path d="'+path(points,axes.x,axes.y,'x','y')+'" fill="none" stroke="'+colors[i]+'" stroke-width="1.7"'+(s.id==='custom'?' stroke-dasharray="5 3"':'')+' vector-effect="non-scaling-stroke"/>';
        const xx=axes.x(s.optimum.annualVol*100),yy=axes.y(s.optimum.expectedReturn*100);
        svg+='<path d="M'+xx+','+(yy-5)+' L'+(xx+5)+','+yy+' L'+xx+','+(yy+5)+' L'+(xx-5)+','+yy+' Z" fill="'+colors[i]+'" stroke="#0b111b" stroke-width="1"/>';
      });
      svg+='<path data-inspection d="" stroke="#eef4ff" stroke-width="1.2" visibility="hidden" pointer-events="none"/></svg><div class="simulation-tip" role="status" hidden></div>';
      $('frontier').innerHTML=svg;
      bindInspection('frontier',entries,(p,surface,tip)=>{
        const s=r.scenarios[p.scenario],xx=axes.x(p.x),yy=axes.y(p.y),marker=surface.querySelector('[data-inspection]');
        marker.setAttribute('d','M'+(xx-6)+','+yy+' H'+(xx+6)+' M'+xx+','+(yy-6)+' V'+(yy+6));marker.setAttribute('visibility','visible');
        tip.innerHTML='<strong>'+esc(s.label)+' · ρ '+fmt(s.rho)+'</strong><div>ACWI_TR '+pct(p.weight)+' · 국내채권 '+pct(1-p.weight)+'</div><div>기대수익률 '+pct(p.expectedReturn)+' · 변동성 '+pct(p.annualVol)+'</div>';
      },(px,py)=>{
        let nearest=0,distance=Infinity;entries.forEach((p,i)=>{const d=(axes.x(p.x)-px)**2+(axes.y(p.y)-py)**2;if(d<distance){distance=d;nearest=i;}});return nearest;
      });
      const columns=[...metaHead,'scenario','correlation','point_type','equity_weight','bond_weight','expected_return_annual','volatility_annual'];
      exportRows('frontier',[columns,...r.scenarios.flatMap(s=>s.error?[]:[...s.frontier.map(p=>[...metadata(r),s.id,s.rho,'efficient',p.weight,1-p.weight,p.expectedReturn,p.annualVol]),[...metadata(r),s.id,s.rho,'optimum',s.optimum.weight,1-s.optimum.weight,s.optimum.expectedReturn,s.optimum.annualVol]])],r);
    }
    function performance(r) {
      const p=r.performance;
      $('performance-mode').textContent=p.evaluation==='holdout'?'추정 이후 · 고정비중':'표본내 재구성';
      if(p.error || !p.points || p.points.length<2){$('performance').innerHTML='<div class="simulation-empty" role="status">'+esc(p.error||'성과 관측 부족')+'</div>';return;}
      $('performance-period').textContent=p.startDate+' – '+p.endDate;
      const selected=p.keys.map((_,i)=>p.points.some(point=>Number.isFinite(point.values[i])));
      legend('performance-legend',p.labels,selected);
      const times=p.points.map(point=>Date.parse(point.date)),all=p.points.flatMap(point=>point.values).filter(Number.isFinite);
      const ticks=[...new Set(Array.from({length:6},(_,i)=>Math.round(i*(times.length-1)/5)))].map(i=>({value:times[i],label:p.points[i].date.slice(2).replaceAll('-','.')}));
      const axes=grid([times[0],times.at(-1)],axisRange(all),'관측일','누적지수 · 시작 100',ticks);let svg=axes.svg;
      p.keys.forEach((key,i)=>{
        if(!selected[i])return;
        const points=p.points.map((point,j)=>({x:times[j],y:point.values[i]}));
        svg+='<path d="'+path(points,axes.x,axes.y,'x','y')+'" fill="none" stroke="'+colors[i]+'" stroke-width="'+(key==='benchmark'?1.1:1.7)+'"'+(['custom','benchmark'].includes(key)?' stroke-dasharray="5 3"':'')+' vector-effect="non-scaling-stroke"/>';
      });
      svg+='<line data-inspection x1="0" x2="0" y1="'+T+'" y2="'+(H-B)+'" stroke="#b9c7d8" stroke-dasharray="3 3" visibility="hidden"/></svg><div class="simulation-tip" role="status" hidden></div>';
      $('performance').innerHTML=svg;
      bindInspection('performance',p.points,(point,surface,tip)=>{
        const xx=axes.x(Date.parse(point.date)),cross=surface.querySelector('[data-inspection]');cross.setAttribute('x1',xx);cross.setAttribute('x2',xx);cross.setAttribute('visibility','visible');
        tip.innerHTML='<strong>'+esc(point.date)+'</strong>'+p.labels.map((name,i)=>selected[i]?'<div class="simulation-tip-line"><span>'+esc(name)+'</span><span>'+fmt(point.values[i])+' · '+pct(point.values[i]/100-1)+'</span></div>':'').join('');
      },px=>{
        let closest=0,distance=Infinity;times.forEach((time,i)=>{const d=Math.abs(axes.x(time)-px);if(d<distance){distance=d;closest=i;}});return closest;
      });
      if(Array.isArray(p.stats)) $('performance-stats').innerHTML='<table><thead><tr><th scope="col">포트폴리오</th><th scope="col">ACWI_TR</th><th scope="col">국내채권</th><th scope="col">누적수익률</th><th scope="col">CAGR</th><th scope="col">변동성 · 연</th><th scope="col">최대 낙폭</th></tr></thead><tbody>'+p.stats.map((stat,i)=>!stat?'':'<tr><th scope="row">'+label(p.labels[i],i)+'</th><td>'+pct(stat.weight)+'</td><td>'+pct(1-stat.weight)+'</td><td>'+pct(stat.totalReturn)+'</td><td>'+pct(stat.cagr)+'</td><td>'+pct(stat.annualVol)+'</td><td>'+pct(stat.maxDrawdown)+'</td></tr>').join('')+'</tbody></table>';
      exportRows('performance',[[...metaHead,'performance_start','performance_end','rebalance','date',...p.keys.map(key=>key+'_index_100'),...p.keys.map(key=>key+'_equity_weight'),...r.scenarios.map(s=>s.id+'_correlation')],...p.points.map(point=>[...metadata(r),p.startDate,p.endDate,'monthly',point.date,...point.values,...p.keys.map((key,i)=>key==='benchmark'?.6:r.scenarios[i]?.optimum?.weight),...r.scenarios.map(s=>s.rho)])],r);
    }
    function render() {
      clear();error('');if(!data)return;
      $('rf').disabled=$('objective').value!=='maxSharpe';
      $('performance-end').disabled=$('evaluation').value==='inSample';
      try {
        result=root.CollaboSimulation.calculate(data,options());
        comparison(result);frontier(result);performance(result);$('results').hidden=false;
      } catch(e) {clear();error(e.message||String(e));}
    }
    function lastWeekday(year,month) {
      const date=new Date(Date.UTC(year,month+1,0));
      while([0,6].includes(date.getUTCDay()))date.setUTCDate(date.getUTCDate()-1);
      return date.toISOString().slice(0,10);
    }
    function setDefaults() {
      const valid=data.observations.filter(row=>Number.isFinite(row[1])&&row[1]>0&&Number.isFinite(row[2])&&row[2]>0).map(row=>row[0]).sort();
      if(valid.length<2)throw new Error('ACWI_TR·국내채권의 공통 관측이 부족합니다.');
      const source=data.source.asOf, date=new Date(source+'T00:00:00Z');
      let month=date.getUTCMonth(),year=date.getUTCFullYear();
      if(source<lastWeekday(year,month)){month--;if(month<0){month=11;year--;}}
      const last=lastWeekday(year,month), end=lastWeekday(year-3,month), start=lastWeekday(year-13,month);
      $('start').value=valid[0]>start?valid[0]:start;$('end').value=end;$('performance-end').value=last;
      $('basis').value='local';$('mode').value='correlation';$('objective').value='minVol';$('rf').value='0';$('evaluation').value='holdout';$('rho').value='0';$('rho-value').value='0.00';
      ['start','end','performance-end'].forEach(name=>{$(name).min=valid[0];$(name).max=source;});
    }
    async function load() {
      fields.filter(name=>!['rho','rho-value'].includes(name)).forEach(name=>$(name).addEventListener('change',render));
      $('rho').addEventListener('input',()=>{$('rho-value').value=Number($('rho').value).toFixed(2);render();});
      ['input','change'].forEach(event=>$('rho-value').addEventListener(event,()=>{const n=Number($('rho-value').value);if(Number.isFinite(n)&&n>=-1&&n<=1)$('rho').value=n;render();}));
      $('reset').addEventListener('click',()=>{setDefaults();render();});
      error('원자료 불러오는 중…');
      try {
        const response=await fetch('platform/simulation-data.json');
        if(!response.ok)throw new Error('시뮬레이션 원자료 요청 실패 ('+response.status+')');
        data=await response.json();
        if(data.schemaVersion!==1||!Array.isArray(data.observations)||!data.source?.asOf)throw new Error('시뮬레이션 원자료 형식을 확인하십시오.');
        const status=data.source.quality?.status;
        quality=status==='provisional'?'KBPMABIN 원자료 검증 대기 · 잠정 시뮬레이션':status==='verified'?'원자료 검증 완료':'원자료 검증 상태 미확인';
        $('quality').textContent=quality;
        $('source').textContent='data_bb.xlsx · D · '+data.source.asOf;
        fields.forEach(name=>$(name).disabled=false);$('reset').disabled=false;
        setDefaults();render();
      } catch(e) {data=null;clear();fields.forEach(name=>$(name).disabled=true);$('reset').disabled=true;error(e.message||String(e));}
    }
    return {load,render};
  }
}(typeof globalThis!=='undefined'?globalThis:this));
