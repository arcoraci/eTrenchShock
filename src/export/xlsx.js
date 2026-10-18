const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function concat(parts) {
  const size = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, part) => n + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  return concat([...locals, ...centrals, end]);
}

function xmlText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .slice(0, 32000)
    .replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

function xmlAttr(value) {
  return xmlText(value).replace(/"/g, "&quot;");
}

function columnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetTitle(name) {
  const clean = String(name || "Sheet").replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return clean || "Sheet";
}

function cellXml(col, rowNumber, value, style) {
  if (value == null || value === "") return "";
  const addr = `${columnName(col)}${rowNumber}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    const styled = style ? ` s="${style}"` : "";
    return `<c r="${addr}"${styled}><v>${value}</v></c>`;
  }
  if (typeof value === "object" && value.percent != null && Number.isFinite(Number(value.percent))) {
    return `<c r="${addr}" s="2"><v>${Number(value.percent)}</v></c>`;
  }
  const text = xmlText(value);
  if (!text) return "";
  const styled = style ? ` s="${style}"` : "";
  const space = /^\s|\s$/.test(text) ? ` xml:space="preserve"` : "";
  return `<c r="${addr}"${styled} t="inlineStr"><is><t${space}>${text}</t></is></c>`;
}

function usedRange(rows) {
  const height = Math.max(rows.length, 1);
  let width = 1;
  for (const row of rows) if (row?.length > width) width = row.length;
  return `A1:${columnName(width - 1)}${height}`;
}

function worksheetXml(sheet, selected) {
  const rows = sheet.rows?.length ? sheet.rows : [[""]];
  const headerRow = sheet.headerRow ?? 0;
  const rowXml = rows.map((row, index) => {
    const cells = [];
    const values = row || [];
    for (let col = 0; col < values.length; col += 1) {
      const style = index === headerRow ? 1 : undefined;
      const cell = cellXml(col, index + 1, values[col], style);
      if (cell) cells.push(cell);
    }
    return `<row r="${index + 1}">${cells.join("")}</row>`;
  }).join("");
  const widths = (sheet.widths || []).map((width, index) => (
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  )).join("");
  const cols = widths ? `<cols>${widths}</cols>` : "";
  const pane = sheet.freeze
    ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
    : "";
  const views = `<sheetViews><sheetView workbookViewId="0"${selected ? ` tabSelected="1"` : ""}>${pane}</sheetView></sheetViews>`;
  const filter = sheet.filter ? `<autoFilter ref="${usedRange(rows)}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${usedRange(rows)}"/>
  ${views}
  ${cols}
  <sheetData>${rowXml}</sheetData>
  ${filter}
</worksheet>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="0.0%"/>
  </numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
}

function contentTypes(count) {
  const sheets = [];
  for (let i = 1; i <= count; i += 1) {
    sheets.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheets.join("\n  ")}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

function workbookXml(sheets) {
  const list = sheets.map((sheet, index) => (
    `<sheet name="${xmlAttr(sheetTitle(sheet.name))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookViews><workbookView activeTab="0"/></workbookViews>
  <sheets>${list}</sheets>
</workbook>`;
}

function workbookRels(count) {
  const rels = [];
  for (let i = 1; i <= count; i += 1) {
    rels.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`);
  }
  rels.push(`<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join("\n  ")}
</Relationships>`;
}

function rootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

export function buildXlsx(sheets) {
  const list = sheets.length ? sheets : [{ name: "Sheet1", rows: [[""]], headerRow: -1 }];
  const files = [
    { name: "[Content_Types].xml", data: utf8(contentTypes(list.length)) },
    { name: "_rels/.rels", data: utf8(rootRels()) },
    { name: "xl/workbook.xml", data: utf8(workbookXml(list)) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(workbookRels(list.length)) },
    { name: "xl/styles.xml", data: utf8(stylesXml()) },
  ];
  list.forEach((sheet, index) => {
    files.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: utf8(worksheetXml(sheet, index === 0)),
    });
  });
  return zipStore(files);
}
