/* Alternative-asset historical calibration. Annual moments use decimal simple returns. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CollaboAlternative = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var DAY = 86400000;
  var FACTORS = { daily: 252, monthly: 12, quarterly: 4 };
  function fail(message) { throw new Error(message); }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function blank(value) { return value === null || value === undefined || (typeof value === 'string' && value.trim() === ''); }
  function isoDate(value, date1904) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
      if (!Number.isFinite(value.getTime())) fail('날짜 형식을 확인하십시오.');
      return value.toISOString().slice(0, 10);
    }
    if (typeof value === 'number' && value >= 10000101 && value <= 99991231 && Number.isInteger(value)) value = String(value);
    if (typeof value === 'number') {
      if (!finite(value) || value < (date1904 ? 0 : 1) || value > 2958465) fail('엑셀 날짜 일련번호 범위를 확인하십시오.');
      var serial = Math.floor(value);
      if (!date1904 && serial === 60) fail('엑셀 날짜 1900-02-29는 유효하지 않습니다.');
      var epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
      var days = date1904 ? serial : serial - (serial > 60 ? 1 : 0);
      var converted = new Date(epoch + days * DAY);
      if (!finite(converted.getTime()) || converted.getUTCFullYear() > 9999) fail('엑셀 날짜 범위를 확인하십시오.');
      return converted.toISOString().slice(0, 10);
    }
    if (typeof value !== 'string') fail('날짜 형식을 확인하십시오.');
    var text = value.trim();
    var match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:T00:00:00(?:\.000)?Z)?$/.exec(text) || /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    if (!match) fail('날짜는 YYYY-MM-DD 또는 엑셀 날짜 형식이어야 합니다.');
    var normalized = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
    var date = new Date(normalized + 'T00:00:00.000Z');
    if (!finite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) fail('유효하지 않은 날짜: ' + text);
    return normalized;
  }
  function optionsFor(options) {
    options = options || {};
    var kind = options.kind || 'level', unit = options.unit || 'decimal', frequency = options.frequency || 'monthly';
    if (!['level', 'return'].includes(kind)) fail('시계열 유형을 확인하십시오.');
    if (!['decimal', 'percent'].includes(unit)) fail('수익률 단위를 확인하십시오.');
    if (!Object.prototype.hasOwnProperty.call(FACTORS, frequency)) fail('일간·월간·분기 중 빈도를 선택하십시오.');
    return { kind: kind, unit: unit, frequency: frequency };
  }
  function parseValue(value, options) {
    if (blank(value)) return null;
    var percent = false;
    if (typeof value === 'string') {
      value = value.trim();
      percent = value.endsWith('%');
      if (percent) value = value.slice(0, -1).trim();
      if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) fail('숫자 형식을 확인하십시오.');
      value = Number(value.replace(/,/g, ''));
    }
    if (!finite(value)) fail('유한한 숫자가 필요합니다.');
    if (percent && (options.kind !== 'return' || options.unit !== 'percent')) fail('% 표시는 수익률(%) 단위에서만 사용할 수 있습니다.');
    if (options.kind === 'level') {
      if (value <= 0) fail('가격·지수는 0보다 커야 합니다.');
    } else {
      if (options.unit === 'percent') value /= 100;
      if (value < -1) fail('단순수익률은 -100% 이상이어야 합니다.');
    }
    return value;
  }
  function parseRows(rows, options) {
    options = options || {};
    var settings = optionsFor(options);
    if (!Array.isArray(rows)) fail('시트 행 배열이 필요합니다.');
    var dateColumn = options.dateColumn === undefined ? 0 : options.dateColumn;
    var valueColumn = options.valueColumn === undefined ? 1 : options.valueColumn;
    if (!Number.isInteger(dateColumn) || !Number.isInteger(valueColumn) || dateColumn < 0 || valueColumn < 0 || dateColumn === valueColumn) fail('날짜 열과 값 열을 각각 선택하십시오.');
    var points = [], dates = new Set(), quality = { blankRows: 0, missingValues: 0 };
    rows.forEach(function (row, i) {
      if (i === 0 && options.header !== false) return;
      if (!Array.isArray(row)) fail((i + 1) + '행의 형식을 확인하십시오.');
      var d = row[dateColumn], v = row[valueColumn];
      if (blank(d) && blank(v)) { quality.blankRows++; return; }
      if (blank(d)) fail((i + 1) + '행: 값에 대응하는 날짜가 없습니다.');
      try {
        var date = isoDate(d, options.date1904 === true);
        if (dates.has(date)) fail('중복 날짜: ' + date);
        dates.add(date);
        var value = parseValue(v, settings);
        if (value === null) quality.missingValues++;
        points.push({ date: date, value: value });
      } catch (error) { fail((i + 1) + '행: ' + error.message); }
    });
    if (!points.some(function (p) { return finite(p.value); })) fail('사용 가능한 관측값이 없습니다.');
    points.sort(function (a, b) { return a.date.localeCompare(b.date); });
    return { points: points, kind: settings.kind, unit: 'decimal', frequency: settings.frequency, quality: quality };
  }
  function normalize(series, options) {
    if (Array.isArray(series)) series = { points: series };
    if (!series || !Array.isArray(series.points)) fail('날짜·값 시계열이 필요합니다.');
    var settings = Object.assign({}, series, options || {});
    var parsed = parseRows(series.points.map(function (p) { return [p.date, p.value]; }), Object.assign({}, settings, { dateColumn: 0, valueColumn: 1, header: false }));
    parsed.quality = Object.assign({}, parsed.quality, series.quality || {});
    return parsed;
  }
  function periodIndex(date, frequency) {
    if (frequency === 'daily') return Math.round(Date.parse(date + 'T00:00:00Z') / DAY);
    var y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) - 1;
    return frequency === 'monthly' ? y * 12 + m : y * 4 + Math.floor(m / 3);
  }
  function periodLabel(index, frequency) {
    if (frequency === 'daily') return new Date(index * DAY).toISOString().slice(0, 10);
    if (frequency === 'monthly') return String(Math.floor(index / 12)) + '-' + String(index % 12 + 1).padStart(2, '0');
    return String(Math.floor(index / 4)) + '-Q' + (index % 4 + 1);
  }
  function toReturns(series, options) {
    var s = normalize(series, options), frequency = s.frequency, sampled = new Map();
    s.points.forEach(function (p) {
      var index = periodIndex(p.date, frequency);
      if (s.kind === 'return' && sampled.has(index)) fail('같은 ' + ({daily:'일',monthly:'월',quarterly:'분기'}[frequency]) + '에 수익률이 두 개 이상 있습니다. 입력 빈도를 확인하십시오.');
      sampled.set(index, p);
    });
    var rows = Array.from(sampled, function (entry) { return { index: entry[0], date: entry[1].date, value: entry[1].value }; });
    var returns = [], skippedGaps = 0, skippedMissing = 0;
    rows.forEach(function (p, i) {
      var previous = rows[i - 1];
      if (s.kind === 'return') {
        if (p.value === null) { skippedMissing++; return; }
        // A supplied return is one complete declared period. Daily pairing also
        // requires a known preceding observation date, since calendars may differ.
        var prior = frequency === 'daily' ? (previous ? previous.date : null) : periodLabel(p.index - 1, frequency);
        var end = frequency === 'daily' ? p.date : periodLabel(p.index, frequency);
        var validInterval = frequency !== 'daily' || (previous && consecutiveDaily(previous, p));
        returns.push({ date: p.date, start: prior, value: p.value, key: validInterval ? prior + '/' + end : null });
        return;
      }
      if (!previous) return;
      if (p.value === null || previous.value === null) { skippedMissing++; return; }
      var difference = p.index - previous.index;
      if ((frequency === 'daily' && !consecutiveDaily(previous, p)) || (frequency !== 'daily' && difference !== 1)) { skippedGaps++; return; }
      var start = frequency === 'daily' ? previous.date : periodLabel(previous.index, frequency);
      var end = frequency === 'daily' ? p.date : periodLabel(p.index, frequency);
      var value = p.value / previous.value - 1;
      if (!finite(value)) fail('가격 변환 수익률이 유한하지 않습니다. 값의 크기를 확인하십시오.');
      returns.push({ date: p.date, start: start, value: value, key: start + '/' + end });
    });
    return { returns: returns, frequency: frequency, periodsPerYear: FACTORS[frequency], quality: Object.assign({}, s.quality, { skippedGaps: skippedGaps, skippedMissing: skippedMissing, sampledObservations: rows.length }) };
  }
  function consecutiveDaily(previous, current) {
    var difference = current.index - previous.index;
    return difference === 1 || (difference === 3 && new Date(previous.date + 'T00:00:00Z').getUTCDay() === 5);
  }
  function moments(values) {
    var mean = values.reduce(function (sum, v) { return sum + v; }, 0) / values.length;
    var squares = values.reduce(function (sum, v) { return sum + (v - mean) * (v - mean); }, 0);
    return { mean: mean, squares: squares, sd: Math.sqrt(squares / (values.length - 1)) };
  }
  function estimate(series, options) {
    var converted = toReturns(series, options), r = converted.returns;
    if (r.length < 3) fail('추정에는 유효한 기간 수익률이 3개 이상 필요합니다.');
    var m = moments(r.map(function (p) { return p.value; }));
    var mu = m.mean * converted.periodsPerYear, vol = m.sd * Math.sqrt(converted.periodsPerYear);
    if (!finite(mu) || !finite(vol)) fail('연율 추정값이 유한하지 않습니다.');
    return { mu: mu, vol: vol, count: r.length, start: r[0].date, end: r[r.length - 1].date, frequency: converted.frequency, periodsPerYear: converted.periodsPerYear, returns: r, quality: converted.quality };
  }
  function correlation(seriesA, seriesB, options) {
    var a = toReturns(seriesA, options), b = toReturns(seriesB, options);
    if (a.frequency !== b.frequency) fail('상관계수 추정 시 두 시계열의 빈도가 같아야 합니다.');
    var right = new Map(b.returns.filter(function (p) { return p.key !== null; }).map(function (p) { return [p.key, p]; }));
    var pairs = a.returns.filter(function (p) { return p.key !== null && right.has(p.key); }).map(function (p) { return [p, right.get(p.key)]; });
    var result = { value: null, count: pairs.length, start: pairs.length ? pairs[0][0].date : null, end: pairs.length ? pairs[pairs.length - 1][0].date : null, frequency: a.frequency, reason: null };
    if (pairs.length < 3) { result.reason = '공통 기간 수익률 3개 미만'; return result; }
    var x = pairs.map(function (p) { return p[0].value; }), y = pairs.map(function (p) { return p[1].value; }), mx = moments(x), my = moments(y);
    var scaleX = Math.max.apply(null, x.map(Math.abs)), scaleY = Math.max.apply(null, y.map(Math.abs));
    if (mx.sd <= Number.EPSILON * Math.max(scaleX, 1e-12) * 10 || my.sd <= Number.EPSILON * Math.max(scaleY, 1e-12) * 10) { result.reason = '공통 구간 변동성 0'; return result; }
    var cross = x.reduce(function (sum, value, i) { return sum + (value - mx.mean) * (y[i] - my.mean); }, 0);
    var value = cross / Math.sqrt(mx.squares * my.squares);
    if (!finite(value)) { result.reason = '상관계수 계산 범위 초과'; return result; }
    result.value = Math.max(-1, Math.min(1, value));
    return result;
  }
  function parseDelimited(text) {
    if (typeof text !== 'string') fail('CSV 텍스트가 필요합니다.');
    text = text.replace(/^\ufeff/, '');
    var first = text.split(/\r?\n/, 1)[0], delimiter = first.includes('\t') ? '\t' : ',';
    var rows = [], row = [], value = '', quoted = false, closed = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
        else value += c;
      } else if (c === '"') {
        if (value !== '' || closed) fail('CSV 따옴표 형식을 확인하십시오.');
        quoted = true;
      } else if (c === delimiter || c === '\n' || c === '\r') {
        row.push(value); value = ''; closed = false;
        if (c !== delimiter) { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
      } else { if (closed) fail('CSV 따옴표 뒤 구분자를 확인하십시오.'); value += c; }
    }
    if (quoted) fail('CSV 따옴표가 닫히지 않았습니다.');
    if (value !== '' || row.length || closed) { row.push(value); rows.push(row); }
    return rows;
  }
  return { parseRows: parseRows, normalize: normalize, toReturns: toReturns, estimate: estimate, correlation: correlation, parseDelimited: parseDelimited, isoDate: isoDate, periodsPerYear: Object.assign({}, FACTORS) };
}));
