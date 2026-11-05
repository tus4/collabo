/* Historical comparisons stay separate from editable CMA assumptions. */
(function (root) {
  'use strict';
  root.CollaboCorrelationUI = {create};
  function create({document, chartExport, fetch}) {
    const $ = id => document.getElementById(id);
    const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmt = value => Number.isFinite(value) ? value.toLocaleString('ko-KR', {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';
    const ids = ['correlation-series-chart', 'correlation-rolling-chart'];
    const colors = ['#759ee9', '#61cdb8'];
    let data = null, result = null;
    function clear() {
      result = null;
      ids.forEach(id => { chartExport.clear(id); $(id).innerHTML = ''; });
      $('correlation-stats').textContent = '';
      $('correlation-legend').textContent = '';
      $('correlation-rolling-status').textContent = '';
    }
    function error(message) {
      $('correlation-series-error').textContent = message;
      $('correlation-series-error').hidden = !message;
    }
    function chart(id, rows, keys, labels, palette, fixedRange) {
      const W = 960, H = fixedRange ? 225 : 285, L = 62, R = 26, T = 20, B = 34;
      const values = rows.flatMap(row => keys.map(key => row[key])).filter(Number.isFinite);
      if (!values.length) { $(id).textContent = '이동상관 미산출 · 표본 부족 또는 수익률 분산 0'; return; }
      let lo = fixedRange ? -1 : Math.min(...values), hi = fixedRange ? 1 : Math.max(...values);
      if (!fixedRange) { const pad = Math.max((hi-lo)*.07, 1); lo -= pad; hi += pad; }
      const times = rows.map(row => Date.parse(row.date)), first = times[0], span = times.at(-1)-first || 1;
      const x = i => L+(times[i]-first)/span*(W-L-R), y = value => H-B-(value-lo)/(hi-lo)*(H-T-B);
      let svg = '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(labels.join(' · '))+'"><title>'+esc(labels.join(' · '))+'</title>';
      for (let i=0;i<=4;i++) {
        const value=lo+i*(hi-lo)/4, yy=y(value);
        svg += '<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#27374a" stroke-dasharray="3 4"/><text x="'+(L-10)+'" y="'+(yy+4)+'" text-anchor="end">'+fmt(value)+'</text>';
      }
      const ticks = [...new Set(Array.from({length:6}, (_,i)=>Math.round(i*(rows.length-1)/5)))];
      ticks.forEach(i => { const xx=x(i); svg += '<line x1="'+xx+'" x2="'+xx+'" y1="'+T+'" y2="'+(H-B)+'" stroke="#27374a" stroke-dasharray="3 4"/><text x="'+xx+'" y="'+(H-9)+'" text-anchor="middle">'+rows[i].date.slice(2).replaceAll('-','.')+'</text>'; });
      keys.forEach((key,j) => {
        let connected=false;
        const path=rows.map((row,i)=>{
          if (!Number.isFinite(row[key])) { connected=false; return ''; }
          const cmd=connected&&!row.gapBefore?'L':'M'; connected=true;
          return cmd+x(i).toFixed(2)+','+y(row[key]).toFixed(2);
        }).join(' ');
        svg += '<path d="'+path+'" fill="none" stroke="'+palette[j]+'" stroke-width="1.6" vector-effect="non-scaling-stroke"/>';
      });
      svg += '<line class="correlation-crosshair" x1="0" x2="0" y1="'+T+'" y2="'+(H-B)+'" stroke="#a9bacd" stroke-dasharray="3 4" visibility="hidden"/></svg><div class="correlation-tooltip" hidden></div>';
      $(id).innerHTML=svg;
      const surface=$(id).querySelector('svg'), cross=surface.querySelector('.correlation-crosshair'), tip=$(id).querySelector('.correlation-tooltip');
      function inspect(event) {
        const bounds=surface.getBoundingClientRect(), px=(event.clientX-bounds.left)/bounds.width*W;
        if(px<L||px>W-R)return;
        const time=first+(px-L)/(W-L-R)*span;
        let low=0,high=times.length-1;
        while(low<high){const middle=Math.floor((low+high)/2);if(times[middle]<time)low=middle+1;else high=middle;}
        const index=low>0&&time-times[low-1]<times[low]-time?low-1:low, row=rows[index];
        cross.setAttribute('x1',x(index));cross.setAttribute('x2',x(index));cross.setAttribute('visibility','visible');
        tip.textContent=row.date+' · '+keys.map((key,j)=>labels[j]+' '+fmt(row[key])).join(' · ');tip.hidden=false;
      }
      surface.addEventListener('pointermove',inspect);
      surface.addEventListener('pointerleave',()=>{cross.setAttribute('visibility','hidden');tip.hidden=true;});
    }
    function render() {
      clear();error('');
      if(!data)return;
      try {
        result=root.CollaboCorrelation.calculate(data,{first:$('correlation-first').value,second:$('correlation-second').value,start:$('correlation-start').value,end:$('correlation-end').value,window:Number($('correlation-window').value)});
        const r=result, labels=[r.first.id,r.second.id];
        $('correlation-stats').innerHTML='<span>기간 상관계수 <strong>'+fmt(r.correlation)+'</strong></span><span>공통 수익률 <strong>'+r.observations.toLocaleString('ko-KR')+'</strong></span><span>'+esc(r.startDate)+' – '+esc(r.endDate)+'</span>'+(r.missingCount?'<span>결측·단절 '+r.missingCount+'</span>':'');
        $('correlation-legend').innerHTML=[r.first,r.second].map((series,i)=>'<span><i style="background:'+colors[i]+'"></i>'+esc(series.id)+' · '+esc(series.currency)+'</span>').join('');
        $('correlation-rolling-status').textContent=r.window+'개 관측치 · 수익률';
        chart(ids[0],r.rows,['first100','second100'],labels,colors,false);
        chart(ids[1],r.rows,['rolling'],['이동상관계수'],['#e8bf71'],true);
        const meta=['source_asof','series_1','currency_1','series_2','currency_2','sample_start','sample_end','rolling_window','date'];
        const prefix=row=>[r.sourceAsOf,r.first.id,r.first.currency,r.second.id,r.second.currency,r.startDate,r.endDate,r.window,row.date];
        chartExport.set(ids[0],{label:'두 지수 시계열',mount:$('correlation-series-head'),filename:'collabo-timeseries-'+r.endDate+'.csv',rows:[[...meta,'series_1_level','series_2_level','series_1_index_100','series_2_index_100','gap_before'],...r.rows.map(row=>[...prefix(row),row.first,row.second,row.first100,row.second100,Boolean(row.gapBefore)])]});
        chartExport.set(ids[1],{label:'수익률 이동상관계수',mount:$('correlation-rolling-head'),filename:'collabo-rolling-correlation-'+r.endDate+'.csv',rows:[[...meta,'series_1_return','series_2_return','rolling_correlation','period_correlation','gap_before'],...r.rows.map(row=>[...prefix(row),row.firstReturn,row.secondReturn,row.rolling,r.correlation,Boolean(row.gapBefore)])]});
      } catch(e) {clear();error(e.message||String(e));}
    }
    async function load() {
      ['first','second','start','end','window'].forEach(name=>$('correlation-'+name).addEventListener('change',render));
      $('correlation-reset').addEventListener('click',()=>{setDefaults();render();});
      error('원자료 불러오는 중…');
      try {
        const response=await fetch('platform/correlation-data.json');
        if(!response.ok)throw new Error('시계열 원자료 요청 실패 ('+response.status+')');
        data=await response.json();
        if(data.schemaVersion!==1||!Array.isArray(data.series)||data.series.length<2)throw new Error('시계열 원자료 형식을 확인하십시오.');
        ['first','second'].forEach(name=>{$('correlation-'+name).innerHTML=data.series.map(s=>'<option value="'+esc(s.id)+'" title="'+esc(s.label)+'">'+esc(s.id)+' · '+esc(s.currency)+'</option>').join('');});
        const dates=data.series.flatMap(s=>s.observations.map(row=>row[0])).sort();
        ['start','end'].forEach(name=>{$('correlation-'+name).min=dates[0];$('correlation-'+name).max=dates.at(-1);});
        $('correlation-source').textContent='data_bb.xlsx · D · '+data.source.asOf+' · 원자료 통화';
        setDefaults();render();
        ['first','second','start','end','window','reset'].forEach(name=>$('correlation-'+name).disabled=false);
      } catch(e) {clear();error(e.message||String(e));}
    }
    function setDefaults() {
      if(!data)return;
      $('correlation-first').value='ACWI_TR';$('correlation-second').value='LEGATRUU';
      const a=data.series.find(s=>s.id==='ACWI_TR'),b=data.series.find(s=>s.id==='LEGATRUU');
      if(!a||!b)throw new Error('ACWI_TR·LEGATRUU 원자료가 없습니다.');
      const dates=new Set(a.observations.filter(row=>Number.isFinite(row[1])&&row[1]>0).map(row=>row[0]));
      const common=b.observations.filter(row=>dates.has(row[0])&&Number.isFinite(row[1])&&row[1]>0).map(row=>row[0]).sort();
      if(common.length<2)throw new Error('기본 지수의 공통 관측이 부족합니다.');
      $('correlation-start').value=common[0];$('correlation-end').value=common.at(-1);$('correlation-window').value='60';
    }
    return {load};
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
