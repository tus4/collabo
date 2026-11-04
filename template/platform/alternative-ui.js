/* Alternative asset editor. Workbook contents stay in this browser session. */
(function (root) {
  'use strict';
  root.CollaboAlternativeUI = {mount};
  function mount(api) {
    const $ = id => document.getElementById(id), E = root.CollaboAlternative;
    const esc = api.esc, fmt = api.number;
    let book = null, fileName = '', selected = 'new', provenance = null, uploadSequence = 0, estimatedDraft = false, estimateDirty = false;
    const isAlternative = a => a.id === 'asset-6' || a.kind === 'alternative';
    const error = message => { $('alternative-error').textContent = message || ''; $('alternative-error').hidden = !message; };
    const others = () => api.getState().assets.filter(a => a.id !== selected);
    const sheet = () => book?.sheets[Number($('alternative-sheet').value) || 0];
    const inputNumber = (id, scale=100) => {
      const v = $(id).value.trim();
      if (!v || !Number.isFinite(Number(v))) throw new Error('기대수익률·변동성·상관계수에 숫자를 입력하십시오.');
      return Number(v) / scale;
    };
    const sourceLabel = p => p?.method === 'history' ? '시계열 추정' : p?.method === 'mixed' ? '시계열 추정 · 수동 조정' : '직접 입력';
    function clearPreview() { $('alternative-preview').innerHTML = ''; }
    function invalidateEstimate() {
      clearPreview();
      if(estimatedDraft){estimateDirty=true;$('alternative-apply').disabled=true;$('alternative-source').textContent='추정 설정 변경 · 재계산 필요';}
    }
    function refresh() {
      estimatedDraft=false;estimateDirty=false;
      const s = api.getState(), alternatives = s.assets.filter(isAlternative);
      if (selected !== 'new' && !alternatives.some(a => a.id === selected)) selected = 'new';
      $('alternative-count').textContent = '대체자산 '+alternatives.length+'개 · CMA '+s.assets.length+'/10';
      $('alternative-select').innerHTML = '<option value="new">새 대체자산</option>'+alternatives.map(a => '<option value="'+esc(a.id)+'">'+esc(a.name)+'</option>').join('');
      $('alternative-select').value = selected;
      $('alternative-list').innerHTML = '<table><thead><tr><th>자산명</th><th>기대수익률</th><th>변동성</th><th>입력 기준</th><th></th></tr></thead><tbody>'+alternatives.map(a => '<tr><td>'+esc(a.name)+'</td><td>'+fmt(a.mu*100)+'%</td><td>'+fmt(a.vol*100)+'%</td><td>'+sourceLabel(a.provenance)+'</td><td><button class="button small" data-alternative-edit="'+esc(a.id)+'">편집</button></td></tr>').join('')+'</tbody></table>';
      const a = s.assets.find(a => a.id === selected), i = s.assets.indexOf(a);
      provenance = a?.provenance ? JSON.parse(JSON.stringify(a.provenance)) : null;
      $('alternative-name').value = a?.name || '';
      $('alternative-mu').value = a ? String(Number((a.mu*100).toFixed(8))) : '';
      $('alternative-vol').value = a ? String(Number((a.vol*100).toFixed(8))) : '';
      $('alternative-source').textContent = sourceLabel(provenance);
      $('alternative-correlations').innerHTML = '<table class="editable-table"><thead><tr><th>CMA 자산</th><th>상관계수</th><th>입력 기준</th></tr></thead><tbody>'+others().map(b => {
        const j = s.assets.indexOf(b), value = a ? s.corr[i][j] : 0;
        return '<tr><td>'+esc(b.name)+'</td><td><input id="alt-corr-'+esc(b.id)+'" data-alternative-corr="'+esc(b.id)+'" type="number" min="-1" max="1" step="0.01" value="'+value+'" aria-label="'+esc(b.name)+' 상관계수"></td><td id="alt-origin-'+esc(b.id)+'">직접 가정</td></tr>';
      }).join('')+'</tbody></table>';
      if (provenance?.compared) provenance.compared.forEach(c => { const el = $('alt-origin-'+c.id); if (el) el.textContent = sourceLabel(provenance)+' · '+c.count+'개'; });
      $('alternative-apply').textContent = a ? 'CMA에 적용' : 'CMA에 추가';
      $('alternative-apply').disabled = !a && s.assets.length >= 10;
      $('alternative-remove').hidden = !a || a.id === 'asset-6';
      $('alternative-status').textContent = !a ? '신규 비중 0% · 상한 50%' : provenance?.file ? provenance.file+' · '+provenance.start+'–'+provenance.end+' · '+provenance.count+'개' : '';
      clearPreview(); renderMapping();
    }
    function columnOptions(includeEmpty=false) {
      const header = sheet()?.rows[0] || [];
      return (includeEmpty ? '<option value="">직접 입력 유지</option>' : '')+header.map((name,i) => '<option value="'+i+'">'+esc(String(name || '열 '+(i+1)))+'</option>').join('');
    }
    function renderMapping() {
      const header = sheet()?.rows[0] || [], date = Number($('alternative-date').value), value = Number($('alternative-value').value);
      $('alternative-mapping').innerHTML = '<table><thead><tr><th>CMA 자산</th><th>파일 비교 열</th></tr></thead><tbody>'+others().map(a => '<tr><td>'+esc(a.name)+'</td><td><select data-alternative-map="'+esc(a.id)+'" aria-label="'+esc(a.name)+' 비교 열" '+(!book?'disabled':'')+'>'+columnOptions(true)+'</select></td></tr>').join('')+'</tbody></table>';
      document.querySelectorAll('[data-alternative-map]').forEach(el => {
        const a = others().find(a => a.id === el.dataset.alternativeMap);
        const column = header.findIndex((h,i) => i !== date && i !== value && [a.name,a.id].includes(String(h).trim()));
        el.value = column < 0 ? '' : String(column);
      });
    }
    function selectSheet() {
      invalidateEstimate();
      for (const id of ['alternative-date','alternative-value']) { $(id).innerHTML = columnOptions(); $(id).disabled = !book; }
      const headers = sheet()?.rows[0] || [];
      const dateIndex = headers.findIndex(h => /^(date|날짜|일자|기준일)$/i.test(String(h).trim()));
      $('alternative-date').value = String(Math.max(0,dateIndex));
      $('alternative-value').value = String(headers.findIndex((_,i)=>i!==Math.max(0,dateIndex)));
      $('alternative-estimate').disabled = !book;
      renderMapping();
    }
    function markManual(event) {
      if (provenance?.method === 'history') provenance.method = 'mixed';
      if (event?.target.dataset.alternativeCorr) {
        const id = event.target.dataset.alternativeCorr;
        provenance?.compared && (provenance.compared = provenance.compared.filter(c=>c.id!==id));
        $('alt-origin-'+id).textContent = '직접 가정';
      }
      $('alternative-source').textContent = estimateDirty ? '추정 설정 변경 · 재계산 필요' : sourceLabel(provenance);
    }
    $('alternative-select').addEventListener('change',() => { selected = $('alternative-select').value; error(''); refresh(); });
    $('alternative-list').addEventListener('click',event => { const b=event.target.closest('[data-alternative-edit]'); if(b){selected=b.dataset.alternativeEdit;error('');refresh();} });
    ['alternative-mu','alternative-vol','alternative-correlations'].forEach(id => $(id).addEventListener('input',markManual));
    $('alternative-apply').addEventListener('click',() => {
      try {
        if(estimateDirty)throw new Error('시계열 설정이 변경되었습니다. 추정값을 다시 계산하십시오.');
        const next = JSON.parse(JSON.stringify(api.getState())), name = $('alternative-name').value.trim();
        if (!name || name.length > 60) throw new Error('자산명은 1~60자로 입력하십시오.');
        if (next.assets.some(a=>a.id!==selected && a.name===name)) throw new Error('이미 사용 중인 자산명입니다.');
        let index = next.assets.findIndex(a=>a.id===selected);
        if (index < 0) {
          if (next.assets.length >= 10) throw new Error('CMA는 최대 10개 자산을 지원합니다.');
          index = next.assets.length;
          const ids = new Set(next.assets.map(a=>a.id)); let n = 1; while(ids.has('alternative-'+n)) n++;
          next.assets.push({id:'alternative-'+n,kind:'alternative',name,mu:0,vol:0,min:0,max:.5,current:0,saa:0});
          next.corr.forEach(row=>row.push(0)); next.corr.push(Array(index+1).fill(0)); next.corr[index][index]=1;
        }
        Object.assign(next.assets[index],{name,mu:inputNumber('alternative-mu'),vol:inputNumber('alternative-vol'),provenance:provenance || {method:'manual'}});
        document.querySelectorAll('[data-alternative-corr]').forEach(el => {
          const j = next.assets.findIndex(a=>a.id===el.dataset.alternativeCorr), v = inputNumber(el.id,1);
          next.corr[index][j]=v;next.corr[j][index]=v;
        });
        api.validate(next);
        selected = next.assets[index].id;
        api.apply(next); error(''); $('alternative-status').textContent='CMA · Optimizer 반영 완료';
      } catch(e) { error(e.message); }
    });
    $('alternative-remove').addEventListener('click',() => {
      try {
        const next=JSON.parse(JSON.stringify(api.getState())), index=next.assets.findIndex(a=>a.id===selected), a=next.assets[index];
        if (!a || !isAlternative(a) || a.id==='asset-6') throw new Error('추가한 대체자산만 삭제할 수 있습니다.');
        if (a.current!==0 || a.saa!==0) throw new Error('CMA에서 해당 자산의 현재·SAA 비중을 0%로 조정한 뒤 삭제하십시오.');
        next.assets.splice(index,1);next.corr.splice(index,1);next.corr.forEach(row=>row.splice(index,1));
        next.assets.forEach(asset=>{if(asset.provenance?.compared)asset.provenance.compared=asset.provenance.compared.filter(c=>c.id!==a.id);});
        api.validate(next);selected='new';api.apply(next);error('');$('alternative-status').textContent='삭제 완료';
      } catch(e) { error(e.message); }
    });
    $('alternative-file').addEventListener('change',async event => {
      const file=event.target.files[0], sequence=++uploadSequence;
      invalidateEstimate();
      book=null;fileName='';$('alternative-sheet').innerHTML='';$('alternative-sheet').disabled=true;selectSheet();error('');
      if(!file)return;
      $('alternative-file-info').textContent='파일 읽는 중…';
      try {
        if(file.size>10*1024*1024)throw new Error('파일 크기는 10 MB 이하여야 합니다.');
        const extension=file.name.split('.').pop().toLowerCase();let parsed;
        if(['csv','tsv'].includes(extension)) parsed={sheets:[{name:'Data',rows:E.parseDelimited(await file.text())}]};
        else if(['xlsx','xls'].includes(extension)) parsed=await root.CollaboWorkbook.read(await file.arrayBuffer());
        else throw new Error('XLSX, XLS, CSV, TSV 파일을 선택하십시오.');
        if(sequence!==uploadSequence)return;
        if(!parsed.sheets.length)throw new Error('읽을 수 있는 시트가 없습니다.');
        if(parsed.sheets.some(s=>s.rows.length>20000 || s.rows.some(r=>r.length>100)))throw new Error('최대 20,000행 · 100열까지 지원합니다.');
        book=parsed;fileName=file.name;
        $('alternative-sheet').innerHTML=book.sheets.map((s,i)=>'<option value="'+i+'">'+esc(s.name)+'</option>').join('');
        $('alternative-sheet').disabled=false;
        $('alternative-file-info').textContent=fileName+' · '+book.sheets.length+'개 시트 · 첫 행: 열 이름';selectSheet();
      } catch(e) { if(sequence===uploadSequence){error(e.message);$('alternative-file-info').textContent='파일 읽기 실패';} }
    });
    $('alternative-sheet').addEventListener('change',selectSheet);
    ['alternative-date','alternative-value'].forEach(id=>$(id).addEventListener('change',()=>{invalidateEstimate();renderMapping();}));
    ['alternative-kind','alternative-unit','alternative-frequency','alternative-basis','alternative-mapping'].forEach(id=>$(id).addEventListener('change',()=>{invalidateEstimate();$('alternative-unit').disabled=$('alternative-kind').value!=='return';}));
    $('alternative-estimate').addEventListener('click',() => {
      try {
        if(!book)throw new Error('시계열 파일을 선택하십시오.');
        if(!$('alternative-basis').value)throw new Error('원화·현지통화·가격수익 기준을 선택하십시오. 비교 열도 동일 기준이어야 합니다.');
        const options={dateColumn:Number($('alternative-date').value),valueColumn:Number($('alternative-value').value),kind:$('alternative-kind').value,unit:$('alternative-unit').value,frequency:$('alternative-frequency').value,date1904:book.date1904===true};
        if(options.dateColumn===options.valueColumn)throw new Error('날짜 열과 대체자산 열을 다르게 선택하십시오.');
        const data=E.parseRows(sheet().rows,options), stats=E.estimate(data), compared=[];
        document.querySelectorAll('[data-alternative-map]').forEach(el=>{
          if(el.value==='')return;
          const valueColumn=Number(el.value), asset=others().find(a=>a.id===el.dataset.alternativeMap);
          if(valueColumn===options.dateColumn || valueColumn===options.valueColumn)throw new Error(asset.name+': 날짜·대체자산 열과 다른 비교 열을 선택하십시오.');
          const match=E.correlation(data,E.parseRows(sheet().rows,{...options,valueColumn}));
          if(!Number.isFinite(match.value))throw new Error(asset.name+': 상관계수 산출 불가 ('+(match.reason||'공통 표본 부족')+'). 비교 열을 해제하고 직접 입력하십시오.');
          compared.push({id:asset.id,...match});
        });
        if(stats.mu < -1 || stats.mu > 1 || stats.vol > 1)throw new Error('연율 추정값이 CMA 입력 범위(수익률 −100~100%, 변동성 0~100%) 밖입니다. 유형·단위·주기를 확인하십시오.');
        $('alternative-mu').value=String(Number((stats.mu*100).toFixed(8)));$('alternative-vol').value=String(Number((stats.vol*100).toFixed(8)));
        if(!$('alternative-name').value.trim())$('alternative-name').value=String(sheet().rows[0][options.valueColumn]||'대체자산').slice(0,60);
        compared.forEach(c=>{$('alt-corr-'+c.id).value=String(Number(c.value.toFixed(10)));$('alt-origin-'+c.id).textContent='시계열 · '+c.count+'개 · '+c.start+'–'+c.end;});
        provenance={method:'history',file:fileName,sheet:sheet().name,frequency:stats.frequency,basis:$('alternative-basis').value,count:stats.count,start:stats.start,end:stats.end,compared:compared.map(({id,count,start,end})=>({id,count,start,end}))};
        estimatedDraft=true;estimateDirty=false;$('alternative-apply').disabled=selected==='new'&&api.getState().assets.length>=10;
        $('alternative-source').textContent='시계열 추정 · 적용 전';
        const quality={...data.quality,...stats.quality};
        $('alternative-preview').innerHTML='<div class="alternative-preview-stats"><span>기대수익률<strong>'+fmt(stats.mu*100)+'%</strong></span><span>변동성<strong>'+fmt(stats.vol*100)+'%</strong></span><span>수익률 표본<strong>'+stats.count+'개</strong></span><span>추정 구간<strong>'+esc(stats.start)+'–'+esc(stats.end)+'</strong></span></div><div class="subtle-tag">CMA 적용 전 · '+esc(Object.entries(quality).map(([key,value])=>({blankRows:'빈 행',missingValues:'결측값',skippedGaps:'누락 구간',skippedMissing:'결측 제외',sampledObservations:'기간 관측',droppedPeriods:'제외 기간'}[key]||key)+': '+value).join(' · '))+'</div>';
        error('');
      } catch(e) { clearPreview();error(e.message); }
    });
    refresh();return {refresh};
  }
}(typeof globalThis!=='undefined'?globalThis:this));
