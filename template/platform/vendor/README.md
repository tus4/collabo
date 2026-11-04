# SheetJS Community Edition

- Version: 0.20.3
- Source: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
- Official distribution guidance: https://docs.sheetjs.com/docs/getting-started/installation/standalone/
- License source: https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE
- SHA-256 (`xlsx.full.min.js`): `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`

The unmodified standalone bundle is checked in so Excel imports work without a runtime CDN connection. The wrapper only reads locally selected workbooks; it does not evaluate formulas, follow workbook links, or send data over the network. Cached formula results must be present.
