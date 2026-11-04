/* CSV snapshots follow the rendered chart's data and current controls. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CollaboChartExport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create({document, download, csv}) {
    const snapshots = new Map();
    function findButton(id) {
      return [...document.querySelectorAll('[data-chart-csv]')].find(button=>button.dataset.chartCsv===id);
    }
    function clear(id) {
      snapshots.delete(id);
      const button=findButton(id);
      if(button)button.disabled=true;
    }
    function set(id, {rows, label, filename, mount}) {
      const element=document.getElementById(id);
      if(!element)return;
      let button=findButton(id);
      if(!button){
        button=document.createElement('button');
        button.type='button';button.className='button small chart-csv-button';
        button.dataset.chartCsv=id;button.textContent='CSV 다운로드';
        const header=mount||element.closest('.panel')?.querySelector('.panel-head')||element;
        header.appendChild(button);
        button.addEventListener('click',()=>{
          const snapshot=snapshots.get(id);
          if(snapshot)download(snapshot.filename,csv(snapshot.rows),'text/csv;charset=utf-8');
        });
      }
      button.setAttribute('aria-label',label+' CSV 다운로드');
      if(!Array.isArray(rows)||rows.length<2){clear(id);return;}
      // Copy both dimensions so a later render cannot mutate a prior snapshot.
      snapshots.set(id,{filename:filename||'collabo-'+id+'.csv',rows:rows.map(row=>row.slice())});
      button.disabled=false;
    }
    return {set,clear};
  }
  function timeSeriesRows(lines, unit) {
    const dates=[...new Set(lines.flatMap(line=>line.points.map(point=>point.date)))].sort();
    const values=lines.map(line=>new Map(line.points.map(point=>[point.date,point.value])));
    return [['date',...lines.map(line=>line.name+'_'+unit)],...dates.map(date=>[date,...values.map(series=>series.get(date)??'')])];
  }
  return {create,timeSeriesRows};
}));
