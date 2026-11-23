/**
 * 과거값보완.js 를 GAS 없이 돌려 보는 시험대.
 *   가짜 SpreadsheetApp · LockService · CacheService · PropertiesService · Session …
 * 을 만들어 스캔 → 적용 → 되돌리기 전체 흐름을 검증합니다.
 *
 *   실행: node review/pf_test.js
 */
const fs = require('fs');
const path = require('path');

/* ───────────────────────── 가짜 시트 ───────────────────────── */
class Range {
  constructor(sheet, row, col, nr, nc) {
    this.s = sheet; this.r = row; this.c = col; this.nr = nr; this.nc = nc;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const line = [];
      for (let j = 0; j < this.nc; j++) line.push(this.s._get(this.r + i, this.c + j));
      out.push(line);
    }
    return out;
  }
  getFormulas() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const line = [];
      for (let j = 0; j < this.nc; j++) line.push(this.s._fget(this.r + i, this.c + j));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.s._get(this.r, this.c); }
  setValues(v) {
    for (let i = 0; i < v.length; i++)
      for (let j = 0; j < v[i].length; j++) this.s._set(this.r + i, this.c + j, v[i][j]);
    return this;
  }
  setValue(v) { this.s._set(this.r, this.c, v); return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();   // "r,c" -> value  (1-based)
    this.formulas = new Map();
    this.writes = [];         // 쓰기 기록
    this._frozen = 0;
  }
  getName() { return this.name; }
  _key(r, c) { return r + ',' + c; }
  _get(r, c) { const v = this.cells.get(this._key(r, c)); return v === undefined ? '' : v; }
  _fget(r, c) { const v = this.formulas.get(this._key(r, c)); return v === undefined ? '' : v; }
  _set(r, c, v) { this.cells.set(this._key(r, c), v); this.writes.push({ r, c, v }); }
  setFormula(r, c, f) { this.formulas.set(this._key(r, c), f); }
  getLastRow() {
    let max = 0;
    for (const k of this.cells.keys()) { const r = Number(k.split(',')[0]); if (r > max) max = r; }
    return max;
  }
  getLastColumn() {
    let max = 0;
    for (const k of this.cells.keys()) { const c = Number(k.split(',')[1]); if (c > max) max = c; }
    return max;
  }
  getDataRange() { return new Range(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
  getRange(r, c, nr, nc) {
    if (nr === undefined) { nr = 1; nc = 1; }
    return new Range(this, r, c, nr, nc);
  }
  setFrozenRows() { return this; }
  setColumnWidth() { return this; }
  /** 시험용 — 표를 한 번에 채웁니다 */
  load(rows) {
    rows.forEach((row, i) => row.forEach((v, j) => {
      if (v !== '' && v !== null && v !== undefined) this.cells.set(this._key(i + 1, j + 1), v);
    }));
  }
}

class Spreadsheet {
  constructor(id) { this.id = id; this.sheets = []; }
  getSheetByName(n) { return this.sheets.find(s => s.getName() === n) || null; }
  getSheets() { return this.sheets; }
  getName() { return '점검데이터_모의'; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
}

/* ───────────────────────── 가짜 전역 ───────────────────────── */
const STORE = {};
const CACHE = {};
const SS = {};

function makeEnv() {
  const env = {
    SpreadsheetApp: {
      openById(id) {
        if (!SS[id]) SS[id] = new Spreadsheet(id);
        return SS[id];
      },
      flush() {}
    },
    LockService: {
      getScriptLock() {
        return {
          _held: false,
          tryLock() { if (env._locked) return false; env._locked = true; this._held = true; return true; },
          releaseLock() { if (this._held) { env._locked = false; this._held = false; } },
          waitLock() { return this.tryLock(); }
        };
      }
    },
    CacheService: {
      getScriptCache() {
        return {
          get(k) { const v = CACHE[k]; if (v === undefined) return null; return v; },
          put(k, v) { CACHE[k] = String(v); },
          remove(k) { delete CACHE[k]; }
        };
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(k) { return STORE[k] === undefined ? null : STORE[k]; } };
      }
    },
    Session: {
      getActiveUser() { return { getEmail() { return 'tester@example.com'; } }; }
    },
    ScriptApp: { getScriptId() { return 'SCRIPT_ID'; }, getProjectTriggers() { return []; } },
    DriveApp: {
      getFileById() {
        return { getOwner() { return { getEmail() { return 'tester@example.com'; } }; } };
      }
    },
    Utilities: {
      formatDate(d, tz, f) {
        const p = n => (n < 10 ? '0' : '') + n;
        if (f === 'yyyyMMdd-HHmmss') return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        if (f === 'yyyy-MM-dd HH:mm') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        if (f === 'yyyy-MM-dd HH:mm:ss') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        if (f === 'HH:mm') return `${p(d.getHours())}:${p(d.getMinutes())}`;
        if (f === 'yyyy-MM-dd') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        return d.toISOString();
      },
      getUuid() { return '0123456789abcdef0123456789abcdef'; },
      base64EncodeWebSafe(s) { return Buffer.from(String(s)).toString('base64'); },
      computeDigest(a, s) { return [1, 2, 3]; },
      DigestAlgorithm: { SHA_256: 'SHA_256' }
    },
    Logger: { log(m) { /* 조용히 */ } },
    HtmlService: { createHtmlOutput(h) { return { setWidth() { return this; }, setHeight() { return this; }, getContent() { return h; } }; } }
  };
  env._locked = false;
  return env;
}

/** 소스를 읽어 env 안에서 실행 */
function loadModule(env) {
  const src = fs.readFileSync(path.join(__dirname, '과거값보완.js'), 'utf8');
  const names = Object.keys(env);
  const fn = new Function(...names, src + '\nreturn {pfScan_, pfApply_, pfUndoRun_, pfRuns_, pfSelfTest_, PFILL, pfClassify_, pfBuildCtx_};');
  return fn(...names.map(n => env[n]));
}

/* ───────────────────── 시험용 데이터 만들기 ───────────────────── */
const HEAD = [
  '기록일시', '점검ID', '설비번호', '설비명칭', '점검일자', '점검시각', '점검유형', '점검구분', '점검자',
  '날씨', '기온', '전월송전전력', '현재송전전력', '인버터발전량', '점검회차현황',
  'M_EARTH', 'M_INS', 'R_ACB_V', 'R_ACB_A', 'No1', 'No2',
  'V_SITE', 'V_MODULE',
  '종합점검결과', '검토메모', '수정일시', '수정자', '조치구분', '조치내용', '요청업체', '완료여부'
];

function row(o) {
  const r = new Array(HEAD.length).fill('');
  HEAD.forEach((h, i) => { if (o[h] !== undefined) r[i] = o[h]; });
  return r;
}

function buildFixture(ym) {
  const ss = SS['DATA'] = new Spreadsheet('DATA');
  /* 관측 열: 설비번호 '1' 만 있으면 안 되므로 데이터 행 */
  const sh = new Sheet('점검기록표_' + ym);
  const rows = [HEAD];

  /* ── 발전소 A (0001) — 과거 2회 값이 있고, 3회차가 빈칸 ── */
  rows.push(row({ 점검ID: ym + '03-0001-01', 설비번호: '0001', 설비명칭: '에이발전소',
    점검일자: ym.slice(0, 4) + '-' + ym.slice(4, 6) + '-03', 점검시각: '09:10',
    점검유형: '정기', 점검구분: '월차점검', 점검자: '김점검',
    날씨: '맑음', 기온: 18.2, 전월송전전력: 1000, 현재송전전력: 1430,
    점검회차현황: '1회차/3회', M_EARTH: 3.1, M_INS: 500,
    R_ACB_V: '367.1/366.3/371.1', R_ACB_A: '120/121/119', No1: 12.1, No2: 12.2,
    V_SITE: 'O', V_MODULE: 'O', 조치구분: '없음', 완료여부: '미완료' }));

  rows.push(row({ 점검ID: ym + '17-0001-02', 설비번호: '0001', 설비명칭: '에이발전소',
    점검일자: ym.slice(0, 4) + '-' + ym.slice(4, 6) + '-17', 점검시각: '09:40',
    점검유형: '정기', 점검구분: '월차점검', 점검자: '김점검',
    날씨: '맑음', 기온: 19.1, 전월송전전력: 1000, 현재송전전력: 1510,
    점검회차현황: '2회차/3회', M_EARTH: 3.3, M_INS: 520,
    R_ACB_V: '368.0/367.2/370.5', R_ACB_A: '122/123/121', No1: 12.4, No2: 12.5,
    V_SITE: 'O', V_MODULE: 'O', 조치구분: '없음', 완료여부: '미완료' }));

  /* 3회차 — 빈칸 투성이. 점검회차현황·완료여부·M_EARTH·No1·No2·날씨·기온·점검시각·V_SITE */
  rows.push(row({ 점검ID: ym + '25-0001-03', 설비번호: '0001', 설비명칭: '에이발전소',
    점검일자: ym.slice(0, 4) + '-' + ym.slice(4, 6) + '-25',
    점검유형: '정기', 점검구분: '월차점검', 점검자: '김점검',
    전월송전전력: 1000, 현재송전전력: 1560,
    조치구분: '자체처리', 특이사항: '' }));

  /* ── 발전소 B (0002) — 한 번만 있고 대부분 빈칸 (표본 1개) ── */
  rows.push(row({ 점검ID: ym + '05-0002-01', 설비번호: '0002', 설비명칭: '비발전소',
    점검일자: ym.slice(0, 4) + '-' + ym.slice(4, 6) + '-05', 점검시각: '14:00',
    점검유형: '정기', 점검구분: '월차점검', 점검자: '박점검',
    현재송전전력: 800, V_SITE: 'X' }));

  sh.load(rows);
  /* 수식이 걸린 열 하나 — '현재송전전력' 에 수식이 있으면 건드리면 안 됨.
     (시험을 위해 M_INS 열에 수식을 심어 둡니다) */
  sh.setFormula(3, HEAD.indexOf('M_INS') + 1, '=A3*1');

  ss.sheets.push(sh);
  return { ss, sh };
}

/* ───────────────────────── 시험 실행 ───────────────────────── */

let ok = 0, bad = [];
function check(name, cond, detail) {
  if (cond) { ok++; console.log('  ✅ ' + name); }
  else { bad.push(name + (detail ? ' — ' + detail : '')); console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

function main() {
  const YM = '202609';
  const env = makeEnv();
  const { ss } = buildFixture(YM);
  STORE.PASTFILL_DATA_SS_ID = 'DATA';
  STORE.PASTFILL_MASTER_SS_ID = 'MASTER';

  /* 대장 (마스터) — 점검회차 3 */
  const ms = SS['MASTER'] = new Spreadsheet('MASTER');
  const msh = new Sheet('수용가관리대장');
  msh.load([
    ['설비번호', '설비명칭', '점검회차', '발전용량'],
    ['0001', '에이발전소', 3, '100'],
    ['0002', '비발전소', 3, '50']
  ]);
  ms.sheets.push(msh);

  const M = loadModule(env);

  console.log('\n[1] 자가시험');
  const st = M.pfSelfTest_();
  check('계산 자가시험', st.fail.length === 0, st.fail.join(' / '));

  console.log('\n[2] 스캔 (쓰기 없음)');
  const before = JSON.stringify(ss.sheets[0].cells);
  const r = M.pfScan_(YM, { groups: 'AB' });
  check('스캔이 시트를 안 건드림', JSON.stringify(ss.sheets[0].cells) === before);
  check('빈칸을 찾음', r.stats.blank > 0, 'blank=' + r.stats.blank);
  check('채울 후보가 있음', r.stats.fill > 0, 'fill=' + r.stats.fill);

  const byCol = {};
  r.cands.forEach(c => { (byCol[c.col] = byCol[c.col] || []).push(c); });
  console.log('    열별 후보: ' + Object.keys(byCol).map(k => k + '=' + byCol[k].length).join(', '));

  /* 3회차(0001, 03회차) 후보 확인 */
  const c3 = r.cands.filter(c => c.inspId === YM + '25-0001-03');
  const at = col => c3.find(x => x.col === col);

  check('점검회차현황 계산됨', at('점검회차현황') && at('점검회차현황').next === '3회차/3회',
        at('점검회차현황') && at('점검회차현황').next);
  check('점검회차현황은 A군', at('점검회차현황') && at('점검회차현황').group === 'A');
  check('완료여부는 자체처리→완료', at('완료여부') && at('완료여부').next === '완료',
        at('완료여부') && at('완료여부').next);
  check('M_EARTH 는 과거 중앙값 3.2', at('M_EARTH') && at('M_EARTH').next === '3.2',
        at('M_EARTH') && at('M_EARTH').next);
  check('No1 은 과거 중앙값 12.25', at('No1') && at('No1').next === '12.25',
        at('No1') && at('No1').next);
  check('점검시각 중앙값', at('점검시각') && at('점검시각').next === '09:25',
        at('점검시각') && at('점검시각').next);
  check('날씨는 최빈값', at('날씨') && at('날씨').next === '맑음', at('날씨') && at('날씨').next);
  check('판정값 V_SITE 는 O', at('V_SITE') && at('V_SITE').next === 'O', at('V_SITE') && at('V_SITE').next);

  /* 수식 열은 절대 후보가 되면 안 됨 */
  const fCol = r.cands.filter(c => c.col === 'M_INS');
  check('수식 열(M_INS)은 후보에서 제외', fCol.length === 0, 'found=' + fCol.length);

  /* 잠금 열은 후보가 되면 안 됨 */
  ['점검자', '점검구분', '점검일자', '점검ID', '설비번호'].forEach(k => {
    check('잠금 열 ' + k + ' 제외', !r.cands.some(c => c.col === k));
  });

  /* 자유기술 열 기본 제외 */
  check('특이사항 기본 제외', !r.cands.some(c => c.col === '특이사항'));

  console.log('\n[3] 적용');
  const items = r.cands.filter(c => c.next !== '');
  const keep = items.filter(c => c.inspId === YM + '25-0001-03');
  const ap = M.pfApply_({ ym: YM, items: keep, keys: keep.map(x => x.r + '|' + x.col) });
  check('적용된 칸 수', ap.written > 0, 'written=' + ap.written);

  const sh = ss.sheets[0];
  const get = (rowNum, colName) => sh._get(rowNum, HEAD.indexOf(colName) + 1);
  check('M_EARTH 값이 들어감', String(get(4, 'M_EARTH')) === '3.2', get(4, 'M_EARTH'));
  check('점검회차현황 값이 들어감', get(4, '점검회차현황') === '3회차/3회', get(4, '점검회차현황'));
  check('완료여부 값이 들어감', get(4, '완료여부') === '완료', get(4, '완료여부'));
  check('검토메모에 흔적', String(get(4, '검토메모')).indexOf('과거값보완') >= 0, get(4, '검토메모'));
  check('수정자 기록', String(get(4, '수정자')).length > 0, get(4, '수정자'));

  /* 1·2회차는 손대지 않았는지 */
  check('1회차 그대로', String(get(2, 'M_EARTH')) === '3.1', get(2, 'M_EARTH'));
  check('2회차 그대로', String(get(3, 'M_EARTH')) === '3.3', get(3, 'M_EARTH'));

  /* 이미 값 있는 칸은 덮지 않음 */
  check('이미 값 있는 현재송전전력 유지', String(get(4, '현재송전전력')) === '1560', get(4, '현재송전전력'));

  console.log('\n[4] 두 번 돌려도 안전');
  const r2 = M.pfScan_(YM, { groups: 'AB' });
  const again = r2.cands.filter(c => c.inspId === YM + '25-0001-03' && c.next !== '');
  check('채운 칸은 후보에서 사라짐', again.length === 0,
        'still=' + again.map(x => x.col).join(','));

  console.log('\n[5] 되돌리기');
  const undo = M.pfUndoRun_(ap.runId);
  check('되돌린 칸 수', undo.undone === ap.written, undo.undone + '/' + ap.written);
  check('M_EARTH 다시 빈칸', String(get(4, 'M_EARTH')) === '', '[' + get(4, 'M_EARTH') + ']');
  check('점검회차현황 다시 빈칸', String(get(4, '점검회차현황')) === '', '[' + get(4, '점검회차현황') + ']');

  const runs = M.pfRuns_(10);
  check('이력에 실행이 남음', runs.length > 0 && runs[0].undone > 0, JSON.stringify(runs[0] || {}));

  console.log('\n[6] 열이 없을 때 멈추는가');
  const ss2 = SS['DATA2'] = new Spreadsheet('DATA2');
  const sh2 = new Sheet('점검기록표_202608');
  sh2.load([['설비번호', '설명'], ['0001', '점검ID 열이 없음']]);
  ss2.sheets.push(sh2);
  STORE.PASTFILL_DATA_SS_ID = 'DATA2';
  const M2 = loadModule(env);
  let threw = false, msg = '';
  try { M2.pfScan_('202608', {}); } catch (e) { threw = true; msg = e.message; }
  check('점검ID 열이 없으면 멈춤', threw, msg);
  STORE.PASTFILL_DATA_SS_ID = 'DATA';

  console.log('\n[7] 없는 달');
  let threw2 = false, msg2 = '';
  try { M.pfScan_('209912', {}); } catch (e) { threw2 = true; msg2 = e.message; }
  check('없는 달은 분명히 알려줌', threw2 && msg2.indexOf('없습니다') >= 0, msg2);

  console.log('\n──────────────────────────────');
  console.log('통과 ' + ok + '건 · 실패 ' + bad.length + '건');
  if (bad.length) { bad.forEach(b => console.log('  ✗ ' + b)); process.exit(1); }
  console.log('전부 통과');
}

main();
