/* Tes pengaman tampilan: menangkap kelas dari bug v0.4.0 (ikon hitam solid,
 * layout terdorong 260px di HP, badge tanpa gaya). Tanpa dependensi, tanpa browser. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const www = path.join(__dirname, '..', 'www');
const css = fs.readFileSync(path.join(www, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(www, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');

/* Isi blok @media (...) { ... } pertama yang cocok, dengan pencocokan kurung. */
function mediaBlocks(query) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf('@media ' + query, from);
    if (at < 0) break;
    const open = css.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    blocks.push(css.slice(open + 1, i));
    from = i;
  }
  return blocks;
}

test('semua variabel CSS yang dipakai terdefinisi', () => {
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const used = new Set([...(css + js + html).matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  assert.deepStrictEqual(missing, [], 'variabel tidak terdefinisi: ' + missing.join(', '));
});

test('ikon sprite punya aturan stroke lewat elemen <use>', () => {
  const rule = css.match(/(?:^|\n)use\s*\{([^}]*)\}/);
  assert.ok(rule, 'aturan "use { ... }" tidak ditemukan; ikon akan tampil hitam solid');
  assert.match(rule[1], /fill:\s*none/);
  assert.match(rule[1], /stroke:\s*currentColor/);
});

test('svg tanpa atribut ukuran dibatasi lewat CSS', () => {
  // satu-satunya <svg> tanpa width/height di app.js ada di kartu statistik
  assert.match(css, /\.stat-card-icon\s+svg\s*\{[^}]*width:\s*\d+px/);
});

test('di layar <=1024px grid hanya satu kolom dan sidebar overlay', () => {
  const block = mediaBlocks('(max-width: 1024px)').find((b) => /\.app-shell/.test(b));
  assert.ok(block, 'blok responsif untuk .app-shell tidak ada');
  assert.match(block, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(block, /\.main[\s\S]*grid-column:\s*1/);
  assert.match(block, /\.sidebar\s*\{[^}]*translateX\(-100%\)/);
});

test('kelas badge/btn yang dipakai app.js punya gaya', () => {
  const used = new Set((js + html).match(/\b(?:badge|btn)-[a-z]+\b/g) || []);
  const missing = [...used].filter((c) => !new RegExp('\\.' + c + '\\b').test(css));
  assert.deepStrictEqual(missing, [], 'kelas tanpa gaya: ' + missing.join(', '));
});

test('grid konten tidak melebar mengikuti isi (minmax(0, 1fr))', () => {
  for (const sel of ['.dashboard-grid', '.device-list', '.detail-grid', '.settings-grid']) {
    const m = css.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*grid-template-columns:\\s*([^;]+);'));
    assert.ok(m, sel + ' tidak ditemukan');
    assert.match(m[1], /minmax\(0,\s*1fr\)/, sel + ' memakai 1fr polos');
  }
});
