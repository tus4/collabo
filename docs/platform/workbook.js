/* Local Excel import. SheetJS CE is vendored; workbook bytes never leave the browser. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/xlsx.full.min.js'));
  else root.CollaboWorkbook = factory(root.XLSX);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (XLSX) {
  'use strict';
  const LIMITS = Object.freeze({bytes: 10 * 1024 * 1024, expandedBytes: 40 * 1024 * 1024, rows: 20000, columns: 100, sheets: 20, cells: 1000000});
  function fail(message) { throw new Error(message); }
  function bytesOf(input) {
    if (Object.prototype.toString.call(input) === '[object ArrayBuffer]') return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    fail('엑셀 파일을 다시 선택하십시오.');
  }
  // Read directory metadata only, before SheetJS expands any XML entries.
  function checkZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0) fail('손상된 XLSX 압축 구조입니다.');
    const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || count === 65535 || size === 0xffffffff || offset === 0xffffffff) fail('분할 또는 ZIP64 엑셀 파일은 지원하지 않습니다.');
    if (count > 2000 || offset + size !== end) fail('엑셀 압축 항목 또는 크기 제한을 초과했습니다.');
    let cursor = offset, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail('손상된 XLSX 압축 항목입니다.');
      const flags = view.getUint16(cursor + 8, true), compression = view.getUint16(cursor + 10, true);
      if (flags & 1) fail('암호화된 엑셀 파일은 지원하지 않습니다.');
      if (![0, 8].includes(compression)) fail('지원하지 않는 엑셀 압축 방식입니다.');
      expanded += view.getUint32(cursor + 24, true);
      if (expanded > LIMITS.expandedBytes) fail('압축 해제 후 40MB 이하의 엑셀 파일을 선택하십시오.');
      cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
      if (cursor > end) fail('손상된 XLSX 압축 항목입니다.');
    }
    if (cursor !== end) fail('손상된 XLSX 압축 구조입니다.');
  }
  function dateString(serial, date1904) {
    const date = XLSX.SSF.parse_date_code(serial, {date1904});
    if (!date || date.y < 1900 || date.y > 9999 || date.m < 1 || date.d < 1 || (!date1904 && serial >= 60 && serial < 61)) fail('유효하지 않은 엑셀 날짜입니다.');
    return String(date.y).padStart(4, '0') + '-' + String(date.m).padStart(2, '0') + '-' + String(date.d).padStart(2, '0');
  }
  async function read(input) {
    if (!XLSX || XLSX.version !== '0.20.3') fail('엑셀 읽기 모듈을 불러오지 못했습니다.');
    const bytes = bytesOf(input);
    if (!bytes.length || bytes.length > LIMITS.bytes) fail('0바이트 초과, 10MB 이하의 엑셀 파일을 선택하십시오.');
    const zip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
    const ole = bytes.length >= 8 && [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((value, i) => bytes[i] === value);
    if (!zip && !ole) fail('XLSX 또는 XLS 형식의 엑셀 파일을 선택하십시오.');
    if (zip) checkZip(bytes);
    let workbook;
    try {
      workbook = XLSX.read(bytes, {type: 'array', cellDates: false, cellNF: true, cellText: false, cellHTML: false, cellFormula: true, sheetStubs: true, sheetRows: LIMITS.rows + 1, bookVBA: false, bookDeps: false, raw: true});
    } catch (_) { fail('엑셀 파일을 읽지 못했습니다. 암호·손상 여부와 파일 형식을 확인하십시오.'); }
    if (!workbook.SheetNames || !workbook.SheetNames.length || workbook.SheetNames.length > LIMITS.sheets) fail('워크시트는 1~20개까지 지원합니다.');
    const date1904 = Boolean(workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904);
    let totalCells = 0;
    const sheets = workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      if (!sheet || !sheet['!ref']) return {name, rows: []};
      const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
      if (range.e.r >= LIMITS.rows || range.e.c >= LIMITS.columns) fail(name + ': 최대 20,000행·100열까지 지원합니다.');
      totalCells += (range.e.r + 1) * (range.e.c + 1);
      if (totalCells > LIMITS.cells) fail('엑셀 전체 범위는 1,000,000셀 이하여야 합니다.');
      const rows = Array.from({length: range.e.r + 1}, () => Array(range.e.c + 1).fill(null));
      Object.keys(sheet).filter(key => key[0] !== '!').forEach(address => {
        const cell = sheet[address], position = XLSX.utils.decode_cell(address);
        if (position.r > range.e.r || position.c > range.e.c) return;
        if (cell.f && (cell.v === undefined || cell.v === null || cell.t === 'z')) fail(name + '!' + address + ': 수식 계산 결과가 없습니다. Excel에서 계산 후 저장하십시오.');
        if (cell.t === 'e') fail(name + '!' + address + ': 엑셀 오류값을 수정하십시오.');
        if (cell.t === 'z' || cell.v === undefined || cell.v === null) return;
        if (cell.t === 'n' && !Number.isFinite(cell.v)) fail(name + '!' + address + ': 유한한 숫자가 필요합니다.');
        let value = cell.v;
        if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) value = dateString(cell.v, date1904);
        if (typeof value === 'string' && value.length > 10000) fail(name + '!' + address + ': 셀 텍스트가 너무 깁니다.');
        rows[position.r][position.c] = value;
      });
      return {name, rows};
    });
    if (!sheets.some(sheet => sheet.rows.length)) fail('데이터가 있는 워크시트가 없습니다.');
    return {sheets, date1904};
  }
  return {read, limits: LIMITS};
}));
