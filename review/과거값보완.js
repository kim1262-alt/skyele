/**
 * ============================================================================
 * 과거값보완.js — 점검데이터(점검기록표_YYYYMM) 빈칸을 「과거 기록과의 비교」로 채웁니다
 * ============================================================================
 *
 * 【이 파일은 완전히 독립입니다】
 *   · 기존 파일(Code.js · ReportData.js …)을 한 줄도 고치지 않습니다.
 *   · 기존 전역 함수를 부르지 않습니다.
 *     (CONFIG 가 이미 있으면 스프레드시트 ID 만 빌려 씁니다 — 없어도 동작합니다)
 *   · 새 전역 이름은 전부 `pf…` / `PFILL` / `과거값보완_…` 로 시작합니다.
 *
 * 【쓰는 법】
 *   ① Apps Script 편집기 → 파일 [+ ] → 스크립트 → 이름 `과거값보완`
 *   ② 이 파일 전체를 붙여넣고 저장
 *   ③ `과거값보완_설치` 한 번 실행 → 수용가리스트에 자기 메뉴가 하나 생깁니다
 *      (설치 함수가 **자기 onOpen 트리거**를 따로 만듭니다 — 기존 onOpen 은 그대로 둡니다)
 *   ④ 메뉴 → 🧹 점검데이터 보완 → 🔍 과거값 비교 · 빈칸 찾기
 *
 * 【동작 원칙】
 *   · 이미 값이 있는 칸은 절대 건드리지 않습니다 (빈칸만)
 *   · 수식이 걸린 열은 통째로 건너뜁니다
 *   · 식별 열(점검ID·설비번호·점검일자·제출키 등)은 손대지 않습니다
 *   · 채운 칸마다 「무엇을 · 왜 · 어디서 가져왔는지」 를 검토메모와 이력 시트에 남깁니다
 *   · 한 번 실행분을 통째로 되돌릴 수 있습니다
 *
 * 【값을 정하는 순서 — 신뢰도 높은 것부터】
 *   A  같은 달 안에서 이미 나온 값 (다른 회차·같은 날 다른 발전소·같은 행에서 계산)
 *   B  그 발전소의 최근 이력 (최근 6회 중앙값 · 작년 동월)
 *   C  비슷한 규모의 다른 발전소 (표본 3곳 이상일 때만)
 *   화면에서 A / B / C 를 골라 켤 수 있습니다. 기본은 A+B.
 * ============================================================================
 */

/** ── 설정 ──────────────────────────────────────────────────────────── */
var PFILL = {
  VERSION: 'v1.0 (2026-11-23)',
  HIST_SHEET: '과거값보완이력',
  MENU_NAME: '🧹 점검데이터 보완',

  RECENT_N: 6,          // 최근 몇 회를 중앙값 표본으로 볼지
  CV_WARN: 0.25,        // 변동계수(표준편차/평균)가 이보다 크면 「변동 큼」 표시
  MAX_WRITE: 3000,      // 한 번에 쓸 최대 칸 수 (GAS 6분 제한 대비)
  PEER_MIN: 3,          // 비슷한 규모 다른 발전소 표본 최소

  /* 손대지 않는 열 — 식별자·시스템 열, 그리고 「사람이 한 사실」을 적는 열
     (점검자·점검유형·점검구분은 누가·언제·무엇으로 했는지라 과거 값으로 채우면 거짓이 됩니다) */
  LOCKED: ['기록일시', '점검ID', '설비번호', '제출키', '수정일시', '수정자',
           '검토메모', '사진폴더URL', '보고서URL', '점검일자',
           '점검자', '점검유형', '점검구분'],

  /* 빈칸이 정상인 자유기술 열 — 기본은 건너뜁니다 */
  FREE: ['특이사항', '조치내용', '요청업체', '종합점검결과', '비고', '조치구분'],

  /* 같은 행의 다른 값으로 계산되는 열 */
  DERIVED: ['점검회차현황', '완료여부', 'M_ROOM_TEMP'],

  /* 같은 달 안에서 값이 하나로 정해지는 열 */
  CARRY: ['전월송전전력'],

  /* CONFIG 가 없는 환경에서 쓸 대체 ID (비워 두면 스크립트 속성에서 읽습니다) */
  FALLBACK: { MASTER_SS_ID: '', DATA_SS_ID: '' }
};

/** ── 아주 작은 도구들 ──────────────────────────────────────────────── */

function pfProp_(key, dflt) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    return (v === null || v === undefined || v === '') ? dflt : v;
  } catch (e) { return dflt; }
}

function pfTz_() { return pfProp_('PASTFILL_TZ', 'Asia/Seoul'); }

function pfS_(v) { return (v === null || v === undefined) ? '' : String(v); }

/** 앞뒤 공백·줄바꿈·nbsp·BOM 을 한 칸 공백으로 */
function pfTrim_(v) {
  return pfS_(v).replace(/[\s\u00a0\u200b\ufeff]+/g, ' ').trim();
}

/** 머리글 비교용 — 공백을 모두 뺀 글자 */
function pfKey_(v) {
  return pfS_(v).replace(/[\s\u00a0\u200b\ufeff]/g, '');
}

/** 숫자로 읽히면 숫자, 아니면 null (0 은 정상 값으로 살립니다) */
function pfNumOrNull_(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  if (v instanceof Date) return null;
  var s = String(v).replace(/[\s,]/g, '');
  if (s === '' || s === '-' || s === '.' || s === '+') return null;
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

function pfRound_(n, d) {
  var m = Math.pow(10, (d === undefined || d === null) ? 2 : d);
  return Math.round(n * m) / m;
}

/** 가운데 값 (짝수면 가운데 둘의 평균) */
function pfMedian_(arr) {
  var a = (arr || []).filter(function (x) { return typeof x === 'number' && isFinite(x); })
                     .slice().sort(function (x, y) { return x - y; });
  if (!a.length) return null;
  var m = Math.floor(a.length / 2);
  return (a.length % 2) ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 가장 많이 나온 값 → {v, n, total, rate} / 없으면 null */
function pfMode_(arr) {
  var 셈 = {}, 최다 = null, 최다n = 0, 총 = 0;
  (arr || []).forEach(function (x) {
    var k = pfTrim_(x);
    if (k === '') return;
    총++;
    셈[k] = (셈[k] || 0) + 1;
    if (셈[k] > 최다n) { 최다n = 셈[k]; 최다 = k; }
  });
  if (!최다) return null;
  return { v: 최다, n: 최다n, total: 총, rate: 총 ? 최다n / 총 : 0 };
}

/** 변동계수 (표준편차 / |평균|) — 값이 흩어진 정도 */
function pfCV_(arr) {
  var a = (arr || []).filter(function (x) { return typeof x === 'number' && isFinite(x); });
  if (a.length < 2) return null;
  var 합 = 0;
  for (var i = 0; i < a.length; i++) 합 += a[i];
  var 평 = 합 / a.length;
  if (!평) return null;
  var 분 = 0;
  for (var j = 0; j < a.length; j++) 분 += Math.pow(a[j] - 평, 2);
  var 표 = Math.sqrt(분 / (a.length - 1));
  return Math.abs(표 / 평);
}

/** 숫자를 보기 좋게 (정수면 정수로, 아니면 소수 3자리까지 — 원본 정밀도를 깎지 않음) */
function pfFmt_(n) {
  if (n === null || n === undefined || !isFinite(n)) return '';
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return String(Math.round(n * 1000) / 1000);
}

/** 시트에 쓸 때 — 수식으로 풀리거나 날짜로 굳는 글자를 막습니다 */
function pfSafe_(v) {
  if (typeof v !== 'string') return v;
  if (/^\s*\d{1,2}\s*\/\s*\d{1,2}(\s*\/\s*\d{1,2})?\s*$/.test(v)) return "'" + v;
  if (!/^[=+\-@]/.test(v)) return v;
  if (v.trim() !== '' && !isNaN(Number(v))) return v;
  return "'" + v;
}

/** 화면에 넣기 전 글자 막기 */
function pfEsc_(v) {
  return pfS_(v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** 날짜/시각 셀을 글자로 */
function pfDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, pfTz_(), 'yyyy-MM-dd');
  return pfTrim_(v);
}
function pfTimeStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, pfTz_(), 'HH:mm');
  return pfTrim_(v);
}

/** 점검ID → 연월 / 회차 */
function pfYmOf_(inspId) {
  var m = pfS_(inspId).match(/^(\d{4})(\d{2})\d{2}-/);
  return m ? (m[1] + m[2]) : '';
}
function pfSeqOf_(inspId) {
  var parts = pfS_(inspId).split('-');
  var n = Number(parts[parts.length - 1]);
  return isFinite(n) ? n : 0;
}

/**
 * 복합 측정값을 뜯어봅니다.
 *   "220/221/219"            → [{sep:'/', vals:[220,221,219]}]
 *   "225/224/225 | 220/221"  → [{sep:'/', vals:[...]}, {sep:'/', vals:[...]}]
 *   "429.8"                  → [{sep:'/', vals:[429.8]}]
 *   "2026-09-04"             → null   (숫자 묶음이 아님)
 */
function pfParseComposite_(v) {
  var s = pfTrim_(v);
  if (!s) return null;
  var groups = s.split('|');
  var out = [];
  for (var i = 0; i < groups.length; i++) {
    var g = pfTrim_(groups[i]);
    if (!g) return null;
    var sep = g.indexOf('/') >= 0 ? '/' : (g.indexOf(',') >= 0 ? ',' : '/');
    var 조각 = g.split(sep);
    var vals = [];
    for (var j = 0; j < 조각.length; j++) {
      var n = pfNumOrNull_(조각[j]);
      if (n === null) return null;      // 하나라도 숫자가 아니면 복합 측정값이 아님
      vals.push(n);
    }
    out.push({ sep: sep, vals: vals });
  }
  return out;
}

/** 뜯어본 모양을 다시 글자로 */
function pfJoinComposite_(shape, values) {
  var parts = [];
  for (var i = 0; i < shape.length; i++) {
    var g = shape[i], buf = [];
    for (var j = 0; j < g.vals.length; j++) {
      var v = (values && values[i] && values[i][j] !== undefined) ? values[i][j] : g.vals[j];
      buf.push(pfFmt_(v));
    }
    parts.push(buf.join(g.sep));
  }
  return parts.join(' | ');
}

/** 두 복합값의 모양이 같은가 (묶음 수 · 조각 수) */
function pfSameShape_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i].vals.length !== b[i].vals.length) return false;
  }
  return true;
}

/** 값이 숫자 하나인지 */
function pfSingleNum_(v) { var n = pfNumOrNull_(v); return n !== null; }

/** 시각 글자 → 분 */
function pfMinOf_(s) {
  var m = pfS_(s).match(/(\d{1,2})\s*[:시]\s*(\d{1,2})?/);
  if (!m) return null;
  var h = Number(m[1]), mi = Number(m[2] || 0);
  if (!isFinite(h) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
/** 분 → "HH:mm" */
function pfHHMM_(min) {
  if (min === null || !isFinite(min)) return '';
  var m = Math.round(min);
  var h = Math.floor(m / 60), mm = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}

/** 스프레드시트 열려 있는 곳 */
function pfDataSs_() {
  var id = pfProp_('PASTFILL_DATA_SS_ID', '');
  if (!id) id = PFILL.FALLBACK.DATA_SS_ID || '';
  if (!id && typeof CONFIG !== 'undefined' && CONFIG && CONFIG.DATA_SS_ID) id = CONFIG.DATA_SS_ID;
  if (!id) throw new Error('점검데이터 스프레드시트 ID 를 찾지 못했습니다.\n'
    + '스크립트 속성 PASTFILL_DATA_SS_ID 에 넣거나 이 파일 PFILL.FALLBACK 에 적어 주세요.');
  return SpreadsheetApp.openById(id);
}
function pfMasterSs_() {
  var id = pfProp_('PASTFILL_MASTER_SS_ID', '');
  if (!id) id = PFILL.FALLBACK.MASTER_SS_ID || '';
  if (!id && typeof CONFIG !== 'undefined' && CONFIG && CONFIG.MASTER_SS_ID) id = CONFIG.MASTER_SS_ID;
  if (!id) return null;                 // 없어도 동작합니다 (기능만 줄어듦)
  try { return SpreadsheetApp.openById(id); } catch (e) { return null; }
}

/**
 * 열 종류 가르기 — 이 표가 이 도구의 뼈대입니다.
 *   locked   손대지 않음 (식별자)
 *   skip     빈칸이 정상 (자유기술)
 *   derived  같은 행 값으로 계산
 *   carry    같은 달 안에서 하나로 정해짐
 *   verdict  판정값 (V_…)
 *   measure  측정값 (M_ R_ vcb_ tr_temp_ No1~No25)
 *   weather  날씨 / 기온
 *   time     점검시각
 *   number   그 밖의 숫자 열
 *   text     그 밖의 글자 열
 */
function pfClassify_(열) {
  var k = pfTrim_(열);
  if (!k) return { kind: 'locked', why: '열 이름 없음' };
  if (PFILL.LOCKED.indexOf(k) >= 0) return { kind: 'locked', why: '식별·시스템 열' };
  if (PFILL.FREE.indexOf(k) >= 0) return { kind: 'skip', why: '빈칸이 정상인 열' };
  if (PFILL.DERIVED.indexOf(k) >= 0) return { kind: 'derived', why: '같은 행에서 계산' };
  if (PFILL.CARRY.indexOf(k) >= 0) return { kind: 'carry', why: '같은 달 동일 값' };
  if (/^V_/.test(k)) return { kind: 'verdict', why: '판정값' };
  if (k === '날씨') return { kind: 'weather_text', why: '날씨' };
  if (k === '기온') return { kind: 'weather_num', why: '기온' };
  if (k === '점검시각') return { kind: 'time', why: '점검시각' };
  if (/^(M_|R_|vcb_|tr_temp_|No\d+$)/.test(k)) return { kind: 'measure', why: '측정값' };
  return { kind: 'auto', why: '이력으로 판단' };
}

/* ══════════════════════════════════════════════════════════════════
   2. 시트 읽기
   ══════════════════════════════════════════════════════════════════ */

/** 점검기록표_YYYYMM */
function pfSheetOf_(ss, ym) {
  return ss.getSheetByName('점검기록표_' + ym);
}

/**
 * 시트 하나를 통째로 읽습니다.
 *   h   머리글(1행)
 *   rows 데이터(2행~)   ← rows[0] 이 시트 2행
 *   fml 수식 배열 (실패하면 [])
 *   fcol 열별 「수식이 하나라도 있나」
 */
function pfGrid_(sh) {
  if (!sh) return { h: [], rows: [], fml: [], fcol: [], lr: 0, lc: 0 };
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 1 || lc < 1) return { h: [], rows: [], fml: [], fcol: [], lr: 0, lc: 0 };
  var rng = sh.getRange(1, 1, lr, lc);
  var vals = rng.getValues();
  var fml = [];
  try { fml = rng.getFormulas() || []; } catch (e) { fml = []; }
  var fcol = [];
  for (var c = 0; c < lc; c++) {
    var 있나 = false;
    for (var r = 0; r < fml.length; r++) { if (fml[r] && fml[r][c]) { 있나 = true; break; } }
    fcol.push(있나);
  }
  return { h: vals[0] || [], rows: vals.slice(1), fml: fml, fcol: fcol, lr: lr, lc: lc };
}

/**
 * 과거 기록을 모읍니다 — 필요한 열만, 필요한 발전소만.
 *   @return { bySite: { 설비번호: { 열이름: [ {ym, inspId, seq, v} ] } } }
 */
function pfHistPull_(ss, yms, needCols, needNos) {
  var bySite = {};
  needNos.forEach(function (no) {
    bySite[no] = {};
    needCols.forEach(function (c) { bySite[no][c] = []; });
  });
  var want = {};
  needCols.forEach(function (c) { want[pfKey_(c)] = c; });

  yms.forEach(function (ym) {
    var sh = pfSheetOf_(ss, ym);
    if (!sh) return;
    var lr = sh.getLastRow(), lc = sh.getLastColumn();
    if (lr < 2 || lc < 1) return;

    var h = sh.getRange(1, 1, 1, lc).getValues()[0];
    var cId = -1, cNo = -1, map = {};
    for (var c = 0; c < lc; c++) {
      var k = pfKey_(h[c]);
      if (k === '점검ID') cId = c;
      else if (k === '설비번호') cNo = c;
      if (want[k] !== undefined) map[want[k]] = c;
    }
    if (cId < 0 || cNo < 0) return;
    var names = Object.keys(map);
    if (!names.length) return;

    /* 필요한 열만, 붙어 있는 것끼리 한 번에 읽습니다 (호출 수를 줄임) */
    var idx = {};
    idx[cId] = 1; idx[cNo] = 1;
    names.forEach(function (n) { idx[map[n]] = 1; });
    var list = Object.keys(idx).map(Number).sort(function (a, b) { return a - b; });
    var runs = [], cur = null;
    list.forEach(function (c) {
      if (cur && c === cur.s + cur.n) cur.n++;
      else { cur = { s: c, n: 1 }; runs.push(cur); }
    });
    var data = {};
    runs.forEach(function (r) {
      var v = sh.getRange(1, r.s + 1, lr, r.n).getValues();
      for (var i = 0; i < r.n; i++) {
        var col = r.s + i;
        data[col] = v.map(function (rowArr) { return rowArr[i]; });
      }
    });

    for (var r2 = 1; r2 < lr; r2++) {
      var no = pfTrim_(data[cNo] && data[cNo][r2]);
      if (!no || !bySite[no]) continue;
      var id = pfS_(data[cId] && data[cId][r2]).trim();
      if (!id) continue;
      var seq = pfSeqOf_(id);
      for (var n2 = 0; n2 < names.length; n2++) {
        var nm = names[n2], ci = map[nm];
        var val = data[ci] && data[ci][r2];
        if (pfTrim_(val) === '') continue;
        bySite[no][nm].push({ ym: ym, inspId: id, seq: seq, v: val });
      }
    }
  });

  /* 최근 → 옛날 순으로 */
  Object.keys(bySite).forEach(function (no) {
    Object.keys(bySite[no]).forEach(function (c) {
      bySite[no][c].sort(function (a, b) {
        return (Number(b.ym) - Number(a.ym)) || (b.seq - a.seq);
      });
    });
  });
  return { bySite: bySite };
}

/** 최근 n 달 목록 (이번 달 포함) */
function pfRecentMonths_(ym, n) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6));
  var out = [];
  for (var i = 0; i < n; i++) {
    var mm = m - i, yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    out.push('' + yy + (mm < 10 ? '0' : '') + mm);
  }
  return out;
}

/** 작년 같은 달 */
function pfLastYear_(ym) {
  return '' + (Number(ym.slice(0, 4)) - 1) + ym.slice(4, 6);
}

/** 그 달의 회차 총수 = max(대장 점검회차, 그 달 행 수, 1) */
function pfRoundTotal_(ctx, no) {
  var 대장 = Number((ctx.master[no] || {}).점검회차) || 1;
  var 실제 = (ctx.nByNo[no] || 0);
  return Math.max(대장, 실제, 1);
}

/* ══════════════════════════════════════════════════════════════════
   3. 값 제안 규칙
   ══════════════════════════════════════════════════════════════════ */

/** 표본에서 소수 자릿수를 짐작합니다 (정수면 0, 최대 3자리) */
function pfDecimalsOf_(nums) {
  var d = 0;
  (nums || []).forEach(function (n) {
    if (typeof n !== 'number' || !isFinite(n)) return;
    var s = String(n);
    var i = s.indexOf('.');
    if (i < 0) return;
    var k = s.length - i - 1;
    if (s.indexOf('e') >= 0) return;          // 1e-7 같은 표기는 세지 않음
    d = Math.max(d, Math.min(3, k));
  });
  return d;
}

/**
 * 중앙값의 소수 자릿수.
 *   · 표본의 소수 자릿수를 지킵니다.
 *   · 표본이 짝수면 가운데 둘을 평균하므로 한 자리가 늘어날 수 있습니다.
 *       예) 12.1 · 12.4 → 12.25     (12.3 으로 깎으면 「중앙값」 이 아니게 됩니다)
 *           3.1  · 3.3  → 3.2
 *           500 · 520   → 510
 */
function pfMedNum_(med, nums) {
  if (med === null || med === undefined || !isFinite(med)) return null;
  var list = nums || [];
  var d = pfDecimalsOf_(list);
  if (list.length >= 2 && list.length % 2 === 0) d = Math.min(d + 1, 6);
  return pfRound_(med, d);
}

/** 위 값을 시트에 적을 글자로 (복합값 경로와 같은 규칙) */
function pfMedText_(med, nums) {
  var n = pfMedNum_(med, nums);
  return (n === null) ? '' : pfFmt_(n);
}

/** 신뢰도 판정 */
function pfConf_(n, cv) {
  if (n >= 3 && (cv === null || cv <= PFILL.CV_WARN)) return 'high';
  if (n >= 2) return 'medium';
  if (n >= 1) return 'low';
  return null;
}

/**
 * 측정값 — 과거 같은 발전소 기록의 중앙값.
 *   3상·복수 접속반처럼 「/」·「|」 로 이어진 값은 자리마다 따로 중앙값을 냅니다.
 */
function pfPropMeasure_(col, row, hist, ctx, opts) {
  var list = ((hist.bySite[row.no] || {})[col] || []).filter(function (x) {
    return x.inspId !== row.inspId;                    // 자기 자신은 표본에서 뺌
  });
  if (!list.length) return null;

  var recent = list.slice(0, Math.max(3, opts.recentN || PFILL.RECENT_N));
  var parsed = [];
  recent.forEach(function (x) {
    var s = pfParseComposite_(x.v);
    if (s) parsed.push({ x: x, s: s });
  });
  if (!parsed.length) return null;

  var shape = parsed[0].s;
  var 단일 = (shape.length === 1 && shape[0].vals.length === 1);

  /* 같은 모양만 표본으로 (3상 ↔ 단상 이 섞이면 계산하지 않음) */
  var same = parsed.filter(function (p) { return pfSameShape_(p.s, shape); });
  var n = same.length;
  if (!n) return null;

  if (단일) {
    var nums = same.map(function (p) { return p.s[0].vals[0]; });
    var med = pfMedian_(nums);
    if (med === null) return null;
    var cv = pfCV_(nums);
    var mn = Math.min.apply(null, nums), mx = Math.max.apply(null, nums);
    return {
      next: pfMedText_(med, nums),
      from: '이 발전소 최근 ' + n + '회 중앙값 (' + same[n - 1].x.ym + '~' + same[0].x.ym + ')',
      conf: pfConf_(n, cv),
      n: n,
      cv: cv,
      note: (mn === mx) ? '과거 값이 모두 같음'
                        : '과거 범위 ' + pfFmt_(mn) + '~' + pfFmt_(mx)
                          + (cv !== null && cv > PFILL.CV_WARN ? ' · 변동 큼' : '')
    };
  }

  /* 복합값 — 자리마다 중앙값 (자리별 중앙값을 그대로 — 소수 자릿수를 깎지 않습니다) */
  var meds = [];
  for (var g = 0; g < shape.length; g++) {
    var rowMed = [];
    for (var j = 0; j < shape[g].vals.length; j++) {
      var colNums = same.map(function (p) { return p.s[g].vals[j]; });
      rowMed.push(pfMedian_(colNums));
    }
    meds.push(rowMed);
  }
  var cv0 = pfCV_(same.map(function (p) { return p.s[0].vals[0]; }));
  return {
    next: pfJoinComposite_(shape, meds),
    from: '이 발전소 최근 ' + n + '회 자리별 중앙값 (' + same[n - 1].x.ym + '~' + same[0].x.ym + ')',
    conf: pfConf_(n, cv0),
    n: n,
    cv: cv0,
    note: '자리 ' + shape.map(function (s2) { return s2.vals.length; }).join('/') + '개 유지'
  };
}

/** 판정값 V_x — 그 발전소의 과거 다수값 */
function pfPropVerdict_(col, row, hist, ctx, opts) {
  var list = ((hist.bySite[row.no] || {})[col] || []).filter(function (x) {
    return x.inspId !== row.inspId;
  });
  if (!list.length) return null;
  var m = pfMode_(list.slice(0, 24).map(function (x) { return x.v; }));
  if (!m) return null;
  if (m.n < 2) return null;
  return {
    next: m.v,
    from: '이 발전소 과거 ' + m.total + '회 중 ' + m.n + '회와 같음',
    conf: m.rate >= 0.85 ? 'high' : (m.rate >= 0.6 ? 'medium' : 'low'),
    n: m.n,
    cv: null,
    note: '일치율 ' + Math.round(m.rate * 100) + '%'
  };
}

/** 날씨 글자 — 작년 같은 달 · 같은 달 과거 */
function pfPropWeatherText_(col, row, hist, ctx, opts) {
  var list = ((hist.bySite[row.no] || {})[col] || []).filter(function (x) {
    return x.inspId !== row.inspId;
  });
  if (!list.length) return null;
  var 같은달 = list.filter(function (x) { return x.ym.slice(4, 6) === ctx.ym.slice(4, 6); });
  var src = 같은달.length ? 같은달 : list;
  var m = pfMode_(src.map(function (x) { return x.v; }));
  if (!m || m.n < 1) return null;
  return {
    next: m.v,
    from: (같은달.length ? '작년 같은 달 포함 ' : '') + '이 발전소 과거 ' + m.total + '회 중 ' + m.n + '회',
    conf: m.rate >= 0.7 ? 'medium' : 'low',
    n: m.n, cv: null,
    note: '날씨는 날마다 다릅니다 — 참고만'
  };
}

/** 기온 — 같은 달 과거의 중앙값 */
function pfPropWeatherNum_(col, row, hist, ctx, opts) {
  var list = ((hist.bySite[row.no] || {})[col] || []).filter(function (x) { return x.inspId !== row.inspId; });
  var nums = list.map(function (x) { return pfNumOrNull_(x.v); }).filter(function (n) { return n !== null; });
  if (!nums.length) return null;
  var 같은달 = list.filter(function (x) { return x.ym.slice(4, 6) === ctx.ym.slice(4, 6); })
                  .map(function (x) { return pfNumOrNull_(x.v); }).filter(function (n) { return n !== null; });
  var src = 같은달.length ? 같은달 : nums;
  var med = pfMedian_(src);
  if (med === null) return null;
  return {
    next: pfFmt_(pfRound_(med, 1)),
    from: '이 발전소 과거 기온 중앙값 (n=' + src.length + ')',
    conf: 'low', n: src.length, cv: pfCV_(src),
    note: '기온은 그날 날씨입니다 — 참고만'
  };
}

/** 점검시각 — 과거 방문 시각의 중앙값 */
function pfPropTime_(col, row, hist, ctx, opts) {
  var list = ((hist.bySite[row.no] || {})[col] || []).filter(function (x) { return x.inspId !== row.inspId; });
  var mins = list.map(function (x) { return pfMinOf_(x.v); }).filter(function (n) { return n !== null; });
  if (!mins.length) return null;
  var med = pfMedian_(mins);
  return {
    next: pfHHMM_(med),
    from: '이 발전소 과거 방문 시각 중앙값 (n=' + mins.length + ')',
    conf: 'low', n: mins.length, cv: null,
    note: '방문 시각은 매번 다릅니다 — 참고만'
  };
}

/** 전월송전전력 — 같은 달 다른 회차 → 지난달 마지막 회차의 「현재송전전력」 */
function pfPropCarry_(col, row, hist, ctx, opts) {
  var list = ((hist.bySite[row.no] || {})[col] || []).filter(function (x) { return x.inspId !== row.inspId; });

  var 같은달 = list.filter(function (x) { return x.ym === ctx.ym; });
  if (같은달.length) {
    var s0 = 같은달.slice().sort(function (a, b) { return a.seq - b.seq; })[0];
    return {
      next: pfTrim_(s0.v),
      from: '같은 달 ' + s0.seq + '회차 값 (' + s0.inspId + ')',
      conf: 'high', n: 같은달.length, cv: null,
      note: '같은 달은 같은 값이 원칙'
    };
  }

  var 지난달 = pfRecentMonths_(ctx.ym, 2)[1];
  var cur = ((hist.bySite[row.no] || {})['현재송전전력'] || []).filter(function (x) { return x.ym === 지난달; });
  if (cur.length) {
    var c0 = cur.slice().sort(function (a, b) { return b.seq - a.seq; })[0];
    return {
      next: pfTrim_(c0.v),
      from: 지난달 + ' 마지막 회차의 「현재송전전력」 (' + c0.inspId + ')',
      conf: 'medium', n: cur.length, cv: null,
      note: '검침일과 다르면 실제와 어긋날 수 있음'
    };
  }
  return null;
}

/** 같은 행의 다른 값으로 계산되는 열 */
function pfPropDerived_(col, row, hist, ctx, opts) {
  if (col === '점검회차현황') {
    var N = pfRoundTotal_(ctx, row.no);
    var seq = row.seq || 1;
    if (seq > N) N = seq;
    return {
      next: seq + '회차/' + N + '회',
      from: '점검ID 끝자리 ' + seq + ' · 회차총수 ' + N + ' (대장 ' + ((ctx.master[row.no] || {}).점검회차 || '-') + ')',
      conf: 'high', n: 1, cv: null, note: '계산값'
    };
  }
  if (col === '완료여부') {
    var 구분 = pfTrim_(row.v['조치구분']);
    /* 조치구분이 비어 있으면 「미완료」 라고 단정하지 않습니다 —
       제출 때는 빈칸이 「없음」 으로 저장되므로, 빈칸은 아직 안 채워진 것입니다. */
    if (!구분) return null;
    return {
      next: (구분 === '자체처리') ? '완료' : '미완료',
      from: '조치구분「' + 구분 + '」',
      conf: 'high', n: 1, cv: null, note: '조치구분에서 계산'
    };
  }
  if (col === 'M_ROOM_TEMP') {
    var temps = [];
    for (var t = 1; t <= 5; t++) {
      var n1 = pfNumOrNull_(row.v['tr_temp_' + t]);
      if (n1 !== null) temps.push(n1);
    }
    var 기온 = pfNumOrNull_(row.v['기온']);
    if (!temps.length || 기온 === null) return null;
    var trAvg = temps.reduce(function (a, b) { return a + b; }, 0) / temps.length;
    return {
      next: pfFmt_(pfRound_((trAvg + 기온) / 2, 1)),
      from: '(변압기온도 평균 ' + pfFmt_(pfRound_(trAvg, 1)) + ' + 기온 ' + pfFmt_(기온) + ') / 2',
      conf: 'medium', n: temps.length, cv: null, note: '추정값'
    };
  }
  return null;
}

/** 이력만 보고 숫자/글자를 가리는 열 */
function pfPropAuto_(col, row, hist, ctx, opts) {
  var list = ((hist.bySite[row.no] || {})[col] || []).filter(function (x) { return x.inspId !== row.inspId; });
  if (!list.length) return null;

  var nums = list.map(function (x) { return pfNumOrNull_(x.v); }).filter(function (n) { return n !== null; });
  if (nums.length >= Math.max(1, Math.floor(list.length * 0.8))) {
    return pfPropMeasure_(col, row, hist, ctx, opts);
  }
  var m = pfMode_(list.slice(0, 12).map(function (x) { return x.v; }));
  if (!m || m.rate < 0.9 || m.n < 2) return null;
  return {
    next: m.v,
    from: '이 발전소 과거 ' + m.total + '회 중 ' + m.n + '회와 같음',
    conf: 'medium', n: m.n, cv: null,
    note: '글자 열 — 일치율 ' + Math.round(m.rate * 100) + '%'
  };
}

/** 그 밖의 발전소(같은 달) 중앙값 — 표본이 적을 때만 */
function pfPropPeer_(col, row, ctx, opts) {
  if (!opts.includeC) return null;
  var 같은달 = (ctx.peerVals[col] || []).filter(function (o) { return o.no !== row.no; });
  if (같은달.length < PFILL.PEER_MIN) return null;
  var nums = [];
  같은달.forEach(function (o) {
    var s = pfParseComposite_(o.v);
    if (s && s.length === 1 && s[0].vals.length === 1) nums.push(s[0].vals[0]);
  });
  if (nums.length < PFILL.PEER_MIN) return null;
  var med = pfMedian_(nums);
  if (med === null) return null;
  return {
    next: pfFmt_(pfRound_(med, pfDecimalsOf_(nums))),
    from: '같은 달 다른 발전소 ' + nums.length + '곳의 중앙값',
    conf: 'low', n: nums.length, cv: pfCV_(nums),
    note: '규모가 비슷한지 확인하세요'
  };
}

/** 한 칸의 제안을 고릅니다 — 규칙 → (없으면) 비슷한 발전소 */
function pfPropose_(cls, col, row, hist, ctx, opts) {
  var p = null;
  try {
    if (cls.kind === 'measure')      p = pfPropMeasure_(col, row, hist, ctx, opts);
    else if (cls.kind === 'verdict') p = pfPropVerdict_(col, row, hist, ctx, opts);
    else if (cls.kind === 'weather_text') p = pfPropWeatherText_(col, row, hist, ctx, opts);
    else if (cls.kind === 'weather_num')  p = pfPropWeatherNum_(col, row, hist, ctx, opts);
    else if (cls.kind === 'time')         p = pfPropTime_(col, row, hist, ctx, opts);
    else if (cls.kind === 'carry')        p = pfPropCarry_(col, row, hist, ctx, opts);
    else if (cls.kind === 'derived')      p = pfPropDerived_(col, row, hist, ctx, opts);
    else if (cls.kind === 'auto')         p = pfPropAuto_(col, row, hist, ctx, opts);
    if (!p && (cls.kind === 'measure' || cls.kind === 'auto')) p = pfPropPeer_(col, row, ctx, opts);
  } catch (e) {
    return { next: '', from: '계산 실패: ' + e.message, conf: 'low', n: 0, cv: null, note: '', fail: true };
  }
  return p;
}

/* ══════════════════════════════════════════════════════════════════
   4. 문맥 만들기 — 대장 · 그 달 행 · 다른 발전소 값
   ══════════════════════════════════════════════════════════════════ */

/** 대장(수용가관리대장)에서 설비번호 → { 설비명칭, 점검회차, 발전용량 … } */
function pfMasterMap_(ss) {
  var out = {};
  if (!ss) return out;
  var sh = ss.getSheetByName('수용가관리대장');
  if (!sh) return out;
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 2 || lc < 1) return out;

  var vals = sh.getRange(1, 1, lr, lc).getValues();
  /* 머리글 행을 앞 3줄 안에서 찾습니다 (1행 머리글·2행 머리글 둘 다 대응) */
  var hRow = -1;
  for (var i = 0; i < Math.min(3, vals.length); i++) {
    var keys = (vals[i] || []).map(pfKey_);
    if (keys.indexOf('설비번호') >= 0 && keys.indexOf('설비명칭') >= 0) { hRow = i; break; }
  }
  if (hRow < 0) return out;

  var h = vals[hRow], col = {};
  for (var c = 0; c < h.length; c++) {
    var k = pfKey_(h[c]);
    if (k && col[k] === undefined) col[k] = c;
  }
  var cNo = col['설비번호'], cNm = col['설비명칭'], cRnd = col['점검회차'], cCap = col['발전용량'];

  for (var r = hRow + 1; r < vals.length; r++) {
    var no = pfTrim_(vals[r][cNo]);
    if (!no || out[no]) continue;
    out[no] = {
      설비번호: no,
      설비명칭: cNm !== undefined ? pfTrim_(vals[r][cNm]) : '',
      점검회차: cRnd !== undefined ? pfTrim_(vals[r][cRnd]) : '',
      발전용량: cCap !== undefined ? pfTrim_(vals[r][cCap]) : ''
    };
  }
  return out;
}

/**
 * 스캔에 필요한 문맥을 만듭니다.
 *   grid   그 달 시트 (h · rows · fcol …)
 *   colOf  열이름 → 열번호  (중복 이름은 dup 로 따로 보고 건너뜀)
 *   rows   [{ rowNum, inspId, no, seq, v:{열이름:값} }]
 *   nByNo  { 설비번호: 그 달 행 수 }
 *   peerVals { 열이름: [같은 달 「다른 발전소」 값들] }
 */
function pfBuildCtx_(ss, ym) {
  var sh = pfSheetOf_(ss, ym);
  if (!sh) throw new Error('「점검기록표_' + ym + '」 탭이 없습니다.');

  var grid = pfGrid_(sh);
  if (!grid.h.length) throw new Error('「점검기록표_' + ym + '」 에 머리글이 없습니다.');

  /* 열 이름 → 열번호. 같은 이름이 둘 이상이면 그 이름은 건너뜁니다(엉뚱한 열에 쓰지 않기 위해) */
  var colOf = {}, dup = {};
  for (var c = 0; c < grid.h.length; c++) {
    var k = pfTrim_(grid.h[c]);
    if (!k) continue;
    if (colOf[k] === undefined) colOf[k] = c;
    else dup[k] = true;
  }
  Object.keys(dup).forEach(function (k) { delete colOf[k]; });

  var cId = colOf['점검ID'], cNo = colOf['설비번호'];
  if (cId === undefined || cNo === undefined) {
    throw new Error('「점검ID」 또는 「설비번호」 열이 없습니다 — 머리글을 확인해 주세요.');
  }

  var rows = [], nByNo = {}, peerVals = {};
  var names = Object.keys(colOf);

  for (var r = 0; r < grid.rows.length; r++) {
    var raw = grid.rows[r];
    var id = pfS_(raw[cId]).trim();
    var no = pfTrim_(raw[cNo]);
    if (!no) continue;
    if (!id) continue;                       // 점검ID 없는 줄(빈 줄·메모 줄)은 건너뜀
    var v = {};
    for (var i = 0; i < names.length; i++) {
      v[names[i]] = raw[colOf[names[i]]];
    }
    rows.push({ rowNum: r + 2, inspId: id, no: no, seq: pfSeqOf_(id), v: v });
    nByNo[no] = (nByNo[no] || 0) + 1;
  }

  /* 같은 달 다른 발전소의 값 — 발전용량 단위가 제각각이라
     「다른 발전소」 라는 이름값을 하려면 자기 자신은 빼야 합니다.
     그래서 어느 발전소 것인지 함께 담아 둡니다. */
  rows.forEach(function (row) {
    names.forEach(function (nm) {
      var val = row.v[nm];
      if (pfTrim_(val) === '') return;
      (peerVals[nm] = peerVals[nm] || []).push({ no: row.no, v: val });
    });
  });

  return {
    ym: ym, sh: sh, grid: grid, colOf: colOf, dup: Object.keys(dup),
    rows: rows, nByNo: nByNo, peerVals: peerVals,
    master: pfMasterMap_(pfMasterSs_())
  };
}

/* ══════════════════════════════════════════════════════════════════
   5. 스캔 — 빈칸을 찾고 「무엇으로 채울 수 있는지」 를 정합니다
   ══════════════════════════════════════════════════════════════════ */

/**
 * @param {string} ym     'yyyyMM'
 * @param {Object} o      { onlyNo, groups:'AB', includeC, recentN, freeText, limit }
 * @return {Object}       { ym, cands:[…], stats:{…}, skipped:[…] }
 */
function pfScan_(ym, o) {
  o = o || {};
  var opts = {
    onlyNo: pfTrim_(o.onlyNo || ''),
    groups: pfS_(o.groups || 'AB').toUpperCase(),
    includeC: !!o.includeC || pfS_(o.groups || '').toUpperCase().indexOf('C') >= 0,
    recentN: Number(o.recentN) || PFILL.RECENT_N,
    freeText: !!o.freeText,
    limit: Number(o.limit) || 800
  };

  var ss = pfDataSs_();
  var ctx = pfBuildCtx_(ss, ym);

  /* ① 빈칸 후보를 먼저 뽑습니다 (열 분류 포함) */
  var blanks = [], needCols = {}, skipped = [];
  var skipSet = {};
  var names = Object.keys(ctx.colOf);

  ctx.rows.forEach(function (row) {
    if (opts.onlyNo && row.no !== opts.onlyNo) return;
    names.forEach(function (nm) {
      var c = ctx.colOf[nm];
      if (pfTrim_(row.v[nm]) !== '') return;                 // 이미 값이 있음
      if (ctx.grid.fcol[c]) {                                // 수식 열
        if (!skipSet['수식:' + nm]) { skipSet['수식:' + nm] = 1; skipped.push({ 열: nm, 이유: '수식이 걸린 열' }); }
        return;
      }
      var cls = pfClassify_(nm);
      if (cls.kind === 'locked') { return; }                  // 식별 열 — 조용히 건너뜀
      if (cls.kind === 'skip') {
        if (!opts.freeText) {
          if (!skipSet['자유:' + nm]) { skipSet['자유:' + nm] = 1; skipped.push({ 열: nm, 이유: cls.why + ' — 기본 제외' }); }
          return;
        }
      }
      blanks.push({ row: row, col: nm, colIdx: c, cls: cls });
      needCols[nm] = 1;
    });
  });

  if (!blanks.length) {
    return { ym: ym, cands: [], stats: { blank: 0, fill: 0, none: 0, written: 0 }, skipped: skipped, ctx: ctx, opts: opts };
  }

  /* ② 이력 모으기 — 채울 열만, 대상 발전소만, 최근 13개월 + 작년 같은 달 */
  var needNos = {};
  blanks.forEach(function (b) { needNos[b.row.no] = 1; });
  var yms = pfRecentMonths_(ym, 13);
  var ly = pfLastYear_(ym);
  if (yms.indexOf(ly) < 0) yms.push(ly);
  /* 「현재송전전력」 은 전월송전전력 계산에 늘 필요합니다 */
  var histCols = Object.keys(needCols);
  if (histCols.indexOf('전월송전전력') >= 0 && histCols.indexOf('현재송전전력') < 0) histCols.push('현재송전전력');
  if (histCols.indexOf('tr_temp_1') < 0 && needCols['M_ROOM_TEMP']) {
    for (var t = 1; t <= 5; t++) histCols.push('tr_temp_' + t);
  }

  var hist = pfHistPull_(ss, yms, histCols, Object.keys(needNos));

  /* ③ 칸마다 제안 */
  var cands = [], stats = { blank: blanks.length, fill: 0, none: 0, gated: 0 };
  blanks.forEach(function (b) {
    var p = pfPropose_(b.cls, b.col, b.row, hist, ctx, opts);
    if (!p || pfTrim_(p.next) === '') {
      stats.none++;
      cands.push({
        r: b.row.rowNum, inspId: b.row.inspId, no: b.row.no,
        name: (ctx.master[b.row.no] || {}).설비명칭 || '',
        col: b.col, kind: b.cls.kind, group: '?',
        next: '', from: p && p.from || '과거 기록 없음', conf: '', n: 0, note: ''
      });
      return;
    }
    /* 군 판정 — A 같은 달 안 / B 이 발전소 이력 / C 다른 발전소
       ⚠️ 「다른 발전소」 를 먼저 봅니다. 그 문구는 「같은 달 다른 발전소 …」 라서
          「같은 달」 을 먼저 보면 C 가 A 로 잘못 분류됩니다. */
    var g = 'B';
    if (b.cls.kind === 'derived') g = 'A';
    else if (p.from.indexOf('다른 발전소') >= 0) g = 'C';
    else if (/^같은 달/.test(p.from)) g = 'A';

    var 허용 = opts.groups.indexOf(g) >= 0;
    if (!허용) { stats.gated++; return; }

    stats.fill++;
    cands.push({
      r: b.row.rowNum, inspId: b.row.inspId, no: b.row.no,
      name: (ctx.master[b.row.no] || {}).설비명칭 || '',
      col: b.col, kind: b.cls.kind, group: g,
      next: pfS_(p.next), from: pfS_(p.from), conf: p.conf || '',
      n: p.n || 0, cv: p.cv, note: pfS_(p.note)
    });
  });

  /* ④ 셀 수 있는 상한 — 넘으면 신뢰도 높은 것부터 자릅니다 */
  var picked = cands.filter(function (x) { return pfTrim_(x.next) !== ''; });
  if (picked.length > opts.limit) {
    var score = { high: 0, medium: 1, low: 2 };
    picked.sort(function (a, b) { return (score[a.conf] || 3) - (score[b.conf] || 3); });
    var keep = {};
    picked.slice(0, opts.limit).forEach(function (x) { keep[x.r + '|' + x.col] = 1; });
    cands = cands.filter(function (x) {
      return pfTrim_(x.next) === '' || keep[x.r + '|' + x.col];
    });
    stats.trimmed = picked.length - opts.limit;
  }

  stats.written = 0;
  return { ym: ym, cands: cands, stats: stats, skipped: skipped, opts: opts };
}

/* ══════════════════════════════════════════════════════════════════
   6. 이력 시트 — 무엇을 채웠는지 남기고 되돌릴 수 있게
   ══════════════════════════════════════════════════════════════════ */

var PF_HIST_HEAD = ['실행ID', '일시', '실행자', '시트', '행', '점검ID', '열', '열번호',
                    '이전값', '새값', '출처', '군', '되돌림'];

function pfWho_() {
  var e = '';
  try { e = Session.getActiveUser().getEmail() || ''; } catch (_) { e = ''; }
  return e || '(알 수 없음)';
}

function pfNewRunId_() {
  var t = Utilities.formatDate(new Date(), pfTz_(), 'yyyyMMdd-HHmmss');
  var r = Math.floor(Math.random() * 46656).toString(36);
  while (r.length < 4) r = '0' + r;
  return t + '-' + r;
}

function pfHistSheet_(ss) {
  var sh = ss.getSheetByName(PFILL.HIST_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PFILL.HIST_SHEET);
    var rng = sh.getRange(1, 1, 1, PF_HIST_HEAD.length);
    rng.setValues([PF_HIST_HEAD]).setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
    sh.setColumnWidth(9, 160);
    sh.setColumnWidth(10, 160);
    sh.setColumnWidth(11, 260);
  } else if (sh.getLastColumn() < PF_HIST_HEAD.length) {
    sh.getRange(1, 1, 1, PF_HIST_HEAD.length).setValues([PF_HIST_HEAD])
      .setFontWeight('bold').setBackground('#e8f0fe');
  }
  return sh;
}

function pfHistWrite_(ss, runId, ym, rows) {
  if (!rows.length) return;
  var sh = pfHistSheet_(ss);
  var now = Utilities.formatDate(new Date(), pfTz_(), 'yyyy-MM-dd HH:mm:ss');
  var who = pfWho_();
  var out = rows.map(function (x) {
    return [runId, now, who, '점검기록표_' + ym, x.r, x.inspId, x.col, x.colIdx + 1,
            pfS_(x.prev), pfS_(x.next), pfS_(x.from), pfS_(x.group), ''];
  });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, PF_HIST_HEAD.length).setValues(out);
}

/** 되돌리기 — 실행ID 하나를 통째로 되돌립니다 */
function pfUndoRun_(runId) {
  var ss = pfDataSs_();
  var sh = ss.getSheetByName(PFILL.HIST_SHEET);
  if (!sh) throw new Error('이력 시트가 없습니다 — 되돌릴 것이 없습니다.');

  var v = sh.getDataRange().getValues();
  if (v.length < 2) throw new Error('이력이 비어 있습니다.');

  var cRun = 0, cSheet = 3, cRow = 4, cCol = 6, cColIdx = 7, cPrev = 8, cUndo = 12;
  var targets = [];
  for (var i = 1; i < v.length; i++) {
    if (pfTrim_(v[i][cRun]) !== runId) continue;
    if (pfTrim_(v[i][cUndo])) continue;                  // 이미 되돌림
    targets.push({ i: i + 1, sheet: pfTrim_(v[i][cSheet]), row: Number(v[i][cRow]),
                   col: pfTrim_(v[i][cCol]), colIdx: Number(v[i][cColIdx]), prev: v[i][cPrev] });
  }
  if (!targets.length) throw new Error('되돌릴 것이 없습니다 (이미 되돌렸거나 실행ID 가 다릅니다).');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 작업이 진행 중입니다. 잠시 뒤 다시 하세요.');
  var n = 0;
  try {
    /* 시트별로 모아서 처리 */
    var bySheet = {};
    targets.forEach(function (t) { (bySheet[t.sheet] = bySheet[t.sheet] || []).push(t); });

    Object.keys(bySheet).forEach(function (nm) {
      var tsh = ss.getSheetByName(nm);
      if (!tsh) return;
      /* 열 이름으로 다시 찾습니다 — 그 사이 열이 움직였을 수 있어서 */
      var h = tsh.getRange(1, 1, 1, tsh.getLastColumn()).getValues()[0];
      bySheet[nm].forEach(function (t) {
        var c = -1;
        for (var k = 0; k < h.length; k++) { if (pfTrim_(h[k]) === t.col) { c = k; break; } }
        if (c < 0) c = t.colIdx - 1;
        if (!(c >= 0)) return;
        tsh.getRange(t.row, c + 1).setValue(pfSafe_(pfS_(t.prev)));
        sh.getRange(t.i, cUndo + 1).setValue('되돌림 ' + Utilities.formatDate(new Date(), pfTz_(), 'yyyy-MM-dd HH:mm'));
        n++;
      });
    });
    SpreadsheetApp.flush();
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
  return { runId: runId, undone: n };
}

/** 최근 실행 목록 (되돌리기 화면용) */
function pfRuns_(limit) {
  var ss = pfDataSs_();
  var sh = ss.getSheetByName(PFILL.HIST_SHEET);
  if (!sh) return [];
  var v = sh.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < v.length; i++) {
    var id = pfTrim_(v[i][0]);
    if (!id) continue;
    var o = map[id] = map[id] || { id: id, at: pfTrim_(v[i][1]), who: pfTrim_(v[i][2]),
                                   n: 0, undone: 0, sheets: {} };
    o.n++;
    if (pfTrim_(v[i][12])) o.undone++;
    var sn = pfTrim_(v[i][3]);
    if (sn) o.sheets[sn] = 1;
  }
  var list = Object.keys(map).map(function (k) {
    var o = map[k];
    o.sheetName = Object.keys(o.sheets).join(', ');
    delete o.sheets;
    return o;
  });
  list.sort(function (a, b) { return String(b.id).localeCompare(String(a.id)); });
  return list.slice(0, Number(limit) || 12);
}

/* ══════════════════════════════════════════════════════════════════
   7. 적용 — 확인한 후보만 시트에 씁니다
   ══════════════════════════════════════════════════════════════════ */

/**
 * @param {Object} o { ym, items:[{r, col, next}], keys:['r|col', …] }
 */
function pfApply_(o) {
  o = o || {};
  var ym = pfS_(o.ym).replace(/[^0-9]/g, '');
  var items = o.items || [];
  var keys = o.keys || null;

  if (!ym || ym.length !== 6) throw new Error('연월이 올바르지 않습니다. 예) 2026-09');
  var sel = items.filter(function (x) { return pfTrim_(x.next) !== ''; });
  if (keys && keys.length) {
    var K = {};
    keys.forEach(function (k) { K[String(k)] = 1; });
    sel = sel.filter(function (x) { return K[x.r + '|' + x.col]; });
  }
  if (!sel.length) throw new Error('쓸 것이 없습니다.');
  if (sel.length > PFILL.MAX_WRITE) {
    throw new Error('한 번에 ' + PFILL.MAX_WRITE + '칸까지만 씁니다 (지금 ' + sel.length + '칸).\n'
                  + '발전소를 나눠서 하거나, 미리보기에서 일부만 고르세요.');
  }

  var ss = pfDataSs_();
  var sh = pfSheetOf_(ss, ym);
  if (!sh) throw new Error('「점검기록표_' + ym + '」 탭이 없습니다.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 작업이 진행 중입니다. 잠시 뒤 다시 하세요.');

  var runId = pfNewRunId_(), done = [], skipped = [];
  try {
    /* ── 잠금 안에서 「지금 이 순간」 의 머리글·수식·값을 다시 읽습니다 ──
         미리보기와 그 사이에 누가 값을 넣었을 수 있기 때문입니다. */
    var grid = pfGrid_(sh);
    var colOf = {};
    for (var c = 0; c < grid.h.length; c++) {
      var k = pfTrim_(grid.h[c]);
      if (k && colOf[k] === undefined) colOf[k] = c;
    }
    var cMemo = colOf['검토메모'];
    var cEdit = colOf['수정일시'];
    var cWho  = colOf['수정자'];
    var now = Utilities.formatDate(new Date(), pfTz_(), 'yyyy-MM-dd HH:mm');
    var who = pfWho_();

    /* 행별로 묶어서 씁니다 */
    var byRow = {};
    sel.forEach(function (x) {
      var cn = colOf[x.col];
      if (cn === undefined) { skipped.push({ r: x.r, col: x.col, why: '그 사이 열이 사라짐' }); return; }
      if (grid.fcol[cn]) { skipped.push({ r: x.r, col: x.col, why: '수식 열' }); return; }
      var cur = grid.rows[x.r - 2] ? grid.rows[x.r - 2][cn] : '';
      if (pfTrim_(cur) !== '') { skipped.push({ r: x.r, col: x.col, why: '이미 값이 있음' }); return; }
      (byRow[x.r] = byRow[x.r] || []).push({ col: x.col, colIdx: cn, next: x.next,
        from: x.from || '', group: x.group || '' });
    });

    Object.keys(byRow).forEach(function (rStr) {
      var r = Number(rStr);
      var list = byRow[rStr].slice().sort(function (a, b) { return a.colIdx - b.colIdx; });

      /* 붙어 있는 칸끼리 한 번에 씁니다 */
      var i = 0;
      while (i < list.length) {
        var j = i;
        while (j + 1 < list.length && list[j + 1].colIdx === list[j].colIdx + 1) j++;
        var vals = [];
        for (var q = i; q <= j; q++) vals.push(pfSafe_(list[q].next));
        sh.getRange(r, list[i].colIdx + 1, 1, vals.length).setValues([vals]);
        for (var q2 = i; q2 <= j; q2++) {
          done.push({ r: r, inspId: pfTrim_(grid.rows[r - 2][colOf['점검ID']]), col: list[q2].col,
                      colIdx: list[q2].colIdx, prev: '', next: list[q2].next,
                      from: list[q2].from, group: list[q2].group || pfGroupOf_(list[q2].col) });
        }
        i = j + 1;
      }

      /* 흔적 — 검토메모에 무엇을 왜 채웠는지 */
      if (cMemo !== undefined) {
        var 전 = pfS_(sh.getRange(r, cMemo + 1).getValue());
        var 줄 = list.map(function (x) { return x.col + '=' + x.next; }).join(', ');
        var 흔적 = '[' + now + '] 과거값보완: ' + 줄 + ' (과거 기록 비교 · ' + who + ')';
        sh.getRange(r, cMemo + 1).setValue(pfSafe_(전 ? 전 + '\n' + 흔적 : 흔적));
      }
      if (cEdit !== undefined) sh.getRange(r, cEdit + 1).setValue(new Date());
      if (cWho !== undefined)  sh.getRange(r, cWho + 1).setValue(who);
    });

    SpreadsheetApp.flush();
  } catch (e) {
    /* 실패해도 이미 쓴 것은 이력에 남깁니다 — 어디까지 했는지 알 수 있게 */
    try { pfHistWrite_(ss, runId, ym, done); } catch (_) {}
    try { lock.releaseLock(); } catch (_) {}
    throw new Error('적용 중 멈췄습니다: ' + e.message
      + '\n\n이미 쓴 ' + done.length + '칸은 이력에 남겼습니다. 「되돌리기」 로 되돌릴 수 있습니다.');
  }

  /* 이력 — 적용이 끝난 뒤 기록 */
  try { pfHistWrite_(ss, runId, ym, done); }
  catch (e) { Logger.log('과거값보완 이력 기록 실패: ' + e.message); }

  try { lock.releaseLock(); } catch (_) {}

  return { runId: runId, written: done.length, skipped: skipped, ym: ym };
}

function pfGroupOf_(col) {
  var cls = pfClassify_(col);
  if (cls.kind === 'derived') return 'A';
  if (cls.kind === 'carry') return 'A';
  return 'B';
}

/* ══════════════════════════════════════════════════════════════════
   8. 문지기 — 메뉴에서만 열리고, 화면에서 부를 때는 열쇠를 확인합니다
   ══════════════════════════════════════════════════════════════════ */

/**
 * 웹앱으로 배포된 스크립트에서는 google.script.run 이 「밑줄 없는 전역함수」 를
 * 누구나 부를 수 있습니다. 그래서 화면에서 부르는 함수는 전부 열쇠를 요구합니다.
 *   메뉴 → 미리보기 를 열 때 한 번만 만들어 CacheService 에 15분 담아 둡니다.
 *   익명 접속자는 메뉴를 열 수 없으므로 열쇠를 얻을 길이 없습니다.
 */
function pfNewSession_() {
  var t = Utilities.getUuid().replace(/-/g, '');
  var who = pfWho_();
  try {
    CacheService.getScriptCache().put('pfsess_' + t, who, 900);   // 15분
  } catch (_) {}
  return { token: t, who: who };
}

function pfCheckSession_(token) {
  var t = pfTrim_(token);
  if (!t || !/^[a-f0-9]{32}$/i.test(t)) throw new Error('열쇠가 없습니다. 메뉴에서 다시 열어 주세요.');
  var who = null;
  try { who = CacheService.getScriptCache().get('pfsess_' + t); } catch (_) {}
  if (!who) throw new Error('화면이 만료되었습니다. 메뉴에서 다시 열어 주세요.');
  return who;
}

/** 소유자이거나 직원관리 시트의 「관리자」 일 때만 통과 (설치·메뉴용) */
function pfOwnerOrAdmin_(throwIt) {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (_) { email = ''; }
  if (!email) {
    if (throwIt) throw new Error('구글 계정을 확인할 수 없습니다. 시트에서 메뉴로 실행해 주세요.');
    return false;
  }
  /* 소유자 */
  try {
    var owner = DriveApp.getFileById(ScriptApp.getScriptId()).getOwner().getEmail();
    if (owner && owner.toLowerCase() === email.toLowerCase()) return true;
  } catch (_) {}
  /* 직원관리 시트 */
  try {
    var mss = pfMasterSs_();
    if (mss) {
      var sh = mss.getSheetByName('직원관리');
      if (sh) {
        var v = sh.getDataRange().getValues();
        var hRow = -1;
        for (var i = 0; i < Math.min(3, v.length); i++) {
          var keys = (v[i] || []).map(pfKey_);
          if (keys.indexOf('이메일') >= 0 && keys.indexOf('역할') >= 0) { hRow = i; break; }
        }
        if (hRow >= 0) {
          var h = v[hRow].map(pfKey_);
          var cE = h.indexOf('이메일'), cR = h.indexOf('역할');
          for (var r = hRow + 1; r < v.length; r++) {
            if (pfTrim_(v[r][cE]).toLowerCase() !== email.toLowerCase()) continue;
            if (pfTrim_(v[r][cR]) === '관리자') return true;
            break;
          }
        }
      }
    }
  } catch (_) {}
  if (throwIt) throw new Error('관리자만 쓸 수 있습니다: ' + email);
  return false;
}

/* ══════════════════════════════════════════════════════════════════
   9. 화면에서 부르는 함수 (열쇠 필요)
   ══════════════════════════════════════════════════════════════════ */

/** 연월 목록 — 그 달 탭이 있는 것만 */
function pfMonthsUi(token) {
  pfCheckSession_(token);
  var ss = pfDataSs_();
  var out = [];
  ss.getSheets().forEach(function (sh) {
    var nm = sh.getName();
    var m = nm.match(/^점검기록표_(\d{6})$/);
    if (m) out.push(m[1]);
  });
  out.sort().reverse();
  return out;
}

/** 발전소 목록 — 그 달에 기록이 있는 곳 */
function pfSitesUi(token, ym) {
  pfCheckSession_(token);
  var ss = pfDataSs_();
  var sh = pfSheetOf_(ss, pfS_(ym).replace(/[^0-9]/g, ''));
  if (!sh) return [];
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 2) return [];
  var h = sh.getRange(1, 1, 1, lc).getValues()[0].map(pfTrim_);
  var cNo = h.indexOf('설비번호'), cNm = h.indexOf('설비명칭');
  if (cNo < 0) return [];
  var v = sh.getRange(2, 1, lr - 1, lc).getValues();
  var seen = {}, out = [];
  v.forEach(function (row) {
    var no = pfTrim_(row[cNo]);
    if (!no || seen[no]) return;
    seen[no] = 1;
    out.push({ no: no, name: cNm >= 0 ? pfTrim_(row[cNm]) : '' });
  });
  out.sort(function (a, b) { return a.no.localeCompare(b.no); });
  return out;
}

/** 미리보기 (읽기만 함) */
function pfScanUi(token, opt) {
  pfCheckSession_(token);
  var o = opt || {};
  var r = pfScan_(pfS_(o.ym).replace(/[^0-9]/g, ''), {
    onlyNo: o.onlyNo, groups: o.groups || 'AB', includeC: !!o.includeC,
    recentN: o.recentN, freeText: !!o.freeText, limit: o.limit
  });
  /* 화면으로 보낼 것만 추립니다 (ctx 는 무겁습니다) */
  return {
    ym: r.ym,
    stats: r.stats,
    skipped: r.skipped,
    dupCols: (r.ctx && r.ctx.dup) || [],
    cands: r.cands
  };
}

/** 적용 */
function pfApplyUi(token, p) {
  var who = pfCheckSession_(token);
  p = p || {};
  var r = pfApply_({ ym: p.ym, items: p.items || [], keys: p.keys || null });
  r.who = who;
  return r;
}

/** 실행 이력 */
function pfRunsUi(token, n) {
  pfCheckSession_(token);
  return pfRuns_(n);
}

/** 되돌리기 */
function pfUndoUi(token, runId) {
  pfCheckSession_(token);
  return pfUndoRun_(pfTrim_(runId));
}

/* ══════════════════════════════════════════════════════════════════
   10. 미리보기 창 — 메뉴에서 엽니다
   ══════════════════════════════════════════════════════════════════ */

function 과거값보완_미리보기() {
  if (!pfOwnerOrAdmin_(false)) {
    try { SpreadsheetApp.getUi().alert('관리자만 쓸 수 있습니다.'); } catch (_) {}
    return;
  }
  var s = pfNewSession_();
  var html = pfHtml_(s.token, s.who);
  var ui = SpreadsheetApp.getUi();
  try {
    ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(1150).setHeight(760),
                       '과거값 보완 — ' + PFILL.VERSION);
  } catch (e) {
    /* 모달을 못 열면 스프레드시트에 붙은 문서에서 열린 것이 아닙니다 */
    ui.alert('시트에서 다시 실행해 주세요.\n\n' + e.message);
  }
}

function pfHtml_(token, who) {
  var TK = JSON.stringify(String(token));
  var WHO = pfEsc_(who || '');

  /* 화면 뼈대 — 가독성을 위해 템플릿 문자열 한 덩이로 씁니다.
     ⚠️ 안쪽 스크립트에서는 ${ } 를 쓰지 않습니다 (GAS 가 먼저 해석합니다). */
  var CSS = `
*{box-sizing:border-box}
body{font-family:-apple-system,"Malgun Gothic",sans-serif;margin:0;font-size:13px;color:#202124;background:#f8f9fa}
.bar{padding:10px 14px;background:#fff;border-bottom:1px solid #dadce0;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bar label{display:flex;align-items:center;gap:4px;font-size:12px;color:#444}
select,input[type=text]{padding:4px 6px;border:1px solid #dadce0;border-radius:6px;font-size:12px}
button{padding:6px 12px;border:1px solid #dadce0;background:#fff;border-radius:6px;cursor:pointer;font-size:12px}
button.p{background:#1a73e8;border-color:#1a73e8;color:#fff;font-weight:600}
button.p:disabled{background:#b8c9e8;border-color:#b8c9e8;cursor:not-allowed}
button.d{color:#b3261e}
.wrap{padding:10px 14px;height:calc(100% - 96px);overflow:auto}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border-bottom:1px solid #eee;padding:5px 6px;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:#eef3fb;font-size:12px;z-index:2;border-bottom:1px solid #d2dff1}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.g{display:inline-block;min-width:16px;text-align:center;border-radius:4px;font-size:11px;padding:0 4px;font-weight:700}
.gA{background:#e6f4ea;color:#137333}.gB{background:#fef7e0;color:#b06000}.gC{background:#fce8e6;color:#b3261e}.gN{background:#f1f3f4;color:#5f6368}
.c-h{color:#137333;font-weight:700}.c-m{color:#b06000}.c-l{color:#80868b}
.src{color:#5f6368;font-size:11px}.note{color:#80868b;font-size:11px}
.kpi{display:flex;gap:14px;padding:8px 14px;background:#fff;border-bottom:1px solid #dadce0;font-size:12px;flex-wrap:wrap}
.kpi b{font-size:14px}
.msg{padding:8px 14px;font-size:12px;white-space:pre-wrap}
.msg.e{background:#fce8e6;color:#b3261e}.msg.o{background:#e6f4ea;color:#137333}.msg.w{background:#fef7e0;color:#8a5a00}
.empty{padding:40px;text-align:center;color:#80868b}
`;

  var BODY = `
<div class="bar">
  <label>연월 <select id="ym"></select></label>
  <label>발전소 <select id="site"><option value="">전체</option></select></label>
  <label><input type="checkbox" id="free"> 자유기술 열까지</label>
  <label title="규모가 비슷한 다른 발전소의 중앙값 — 참고용"><input type="checkbox" id="c"> 다른 발전소도 참고</label>
  <button class="p" id="scan">🔍 비교 · 빈칸 찾기</button>
  <button id="all">전체 선택</button>
  <button id="none">선택 해제</button>
  <button class="p" id="apply" disabled>✅ 선택한 칸 채우기</button>
  <button class="d" id="hist">🕘 되돌리기</button>
</div>
<div class="kpi">
  <span>실행자 <b>${WHO}</b></span>
  <span>빈칸 <b id="k1">-</b></span>
  <span>채울 수 있음 <b id="k2">-</b></span>
  <span>근거 없음 <b id="k3">-</b></span>
  <span>선택 <b id="k4">0</b></span>
</div>
<div class="msg" id="msg" style="display:none"></div>
<div class="wrap" id="wrap"><div class="empty">연월을 고르고 「🔍 비교 · 빈칸 찾기」 를 누르세요.<br>읽기만 합니다 — 이 단계에서는 시트를 건드리지 않습니다.</div></div>`;

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><style>'
       + CSS + '</style></head><body>' + BODY
       + '<script>' + pfClient_(TK) + '</script></body></html>';
}

/**
 * 화면 안에서 도는 자바스크립트.
 *   따옴표가 겹치지 않도록 「문자열 한 덩이」 로 만들고, 열쇠만 앞에 붙입니다.
 */
function pfClient_(tkJson) {
  return 'var TK=' + tkJson + ';\n' + `
var CAND=[];
function $(i){return document.getElementById(i);}
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':'&#39;';
  });
}
function say(m,cls){
  var e=$('msg');
  if(!m){e.style.display='none';return;}
  e.className='msg '+(cls||'');e.textContent=m;e.style.display='block';
}
function busy(b,t){
  $('scan').disabled=b;$('apply').disabled=b?true:$('apply').disabled;
  if(b){$('scan').textContent=t||'...';}else{$('scan').textContent='🔍 비교 · 빈칸 찾기';upd();}
}
function opt(){return {ym:$('ym').value,onlyNo:$('site').value,groups:'AB',includeC:$('c').checked,freeText:$('free').checked};}

function boot(){
  google.script.run.withSuccessHandler(function(list){
    var s=$('ym');s.innerHTML='';
    (list||[]).forEach(function(y){
      var o=document.createElement('option');
      o.value=y;o.textContent=y.slice(0,4)+'-'+y.slice(4,6);s.appendChild(o);
    });
    if(list&&list.length)loadSites();
  }).withFailureHandler(function(e){say('연월 목록을 못 읽었습니다: '+e.message,'e');}).pfMonthsUi(TK);
}
function loadSites(){
  google.script.run.withSuccessHandler(function(list){
    var s=$('site');s.innerHTML='<option value="">전체</option>';
    (list||[]).forEach(function(x){
      var o=document.createElement('option');
      o.value=x.no;o.textContent=x.no+'  '+(x.name||'');s.appendChild(o);
    });
  }).withFailureHandler(function(e){say('발전소 목록 실패: '+e.message,'e');}).pfSitesUi(TK,$('ym').value);
}

function cls(g){return 'g '+(g==='A'?'gA':g==='B'?'gB':g==='C'?'gC':'gN');}
function confC(c){return c==='high'?'c-h':c==='medium'?'c-m':'c-l';}
function confTxt(c){return c==='high'?'높음':c==='medium'?'보통':c==='low'?'참고':'';}

function draw(r){
  CAND=(r.cands||[]).slice();
  $('k1').textContent=(r.stats&&r.stats.blank)||0;
  $('k2').textContent=(r.stats&&r.stats.fill)||0;
  $('k3').textContent=(r.stats&&r.stats.none)||0;
  if(!CAND.length){
    $('wrap').innerHTML='<div class="empty">이 달은 채울 빈칸이 없습니다.</div>';
    upd();return;
  }
  var h=[];
  h.push('<table><thead><tr>');
  h.push('<th style="width:26px"><input type="checkbox" id="ca"></th>');
  h.push('<th style="width:46px">행</th><th style="width:150px">점검ID</th>');
  h.push('<th style="width:130px">발전소</th><th style="width:110px">열</th>');
  h.push('<th>넣을 값</th><th>어디서 가져왔나</th><th style="width:56px">근거</th>');
  h.push('</tr></thead><tbody>');
  CAND.forEach(function(x,i){
    var can=String(x.next||'').trim()!=='';
    h.push('<tr><td>'+(can?'<input type="checkbox" class="ck" data-i="'+i+'">':'')+'</td>');
    h.push('<td class="n">'+x.r+'</td>');
    h.push('<td style="font-size:11px">'+esc(x.inspId)+'</td>');
    h.push('<td>'+esc(x.name||'')+'</td>');
    h.push('<td><b>'+esc(x.col)+'</b></td>');
    h.push('<td>'+(can?'<b>'+esc(x.next)+'</b>':'<span class="c-l">근거 없음</span>')+'</td>');
    h.push('<td><span class="src">'+esc(x.from||'')+'</span>'
      + (x.note?'<br><span class="note">'+esc(x.note)+'</span>':'')+'</td>');
    h.push('<td><span class="'+confC(x.conf)+'">'+confTxt(x.conf)+'</span> '
      + '<span class="'+cls(x.group)+'">'+esc(x.group||'?')+'</span></td></tr>');
  });
  h.push('</tbody></table>');
  $('wrap').innerHTML=h.join('');
  var ca=$('ca');
  if(ca)ca.onchange=function(){
    var on=ca.checked;
    document.querySelectorAll('.ck').forEach(function(e){e.checked=on;});
    upd();
  };
  document.querySelectorAll('.ck').forEach(function(e){e.onchange=upd;});
  upd();
}

function picked(){
  var o=[];
  document.querySelectorAll('.ck').forEach(function(e){if(e.checked)o.push(Number(e.dataset.i));});
  return o;
}
function upd(){$('k4').textContent=picked().length;$('apply').disabled=picked().length===0;}

function doScan(){
  if(!$('ym').value){say('연월을 고르세요.','e');return;}
  busy(true,'비교 중...');say('');
  google.script.run.withSuccessHandler(function(r){
    busy(false);
    draw(r);
    if(r.stats&&r.stats.trimmed){
      say('후보가 많아 근거가 확실한 칸만 보여 줍니다. 발전소를 하나씩 골라 하세요.','w');
    }else if(r.skipped&&r.skipped.length){
      say('건너뛴 열: '+r.skipped.map(function(s){return s.열+'('+s.이유+')';}).join(', '),'w');
    }
  }).withFailureHandler(function(e){busy(false);say(e.message,'e');}).pfScanUi(TK,opt());
}

function doApply(){
  var idx=picked();
  if(!idx.length)return;
  if(!confirm('선택한 '+idx.length+'칸을 채웁니다.\\n\\n'
    +'· 이미 값이 있는 칸은 건드리지 않습니다\\n'
    +'· 검토메모에 흔적을 남깁니다\\n'
    +'· 되돌리기로 취소할 수 있습니다\\n\\n진행할까요?'))return;
  var items=idx.map(function(i){return CAND[i];});
  var keys=items.map(function(x){return x.r+'|'+x.col;});
  busy(true,'쓰는 중...');say('');
  google.script.run.withSuccessHandler(function(r){
    busy(false);
    var m='✅ '+r.written+'칸을 채웠습니다. (실행ID '+r.runId+')';
    if(r.skipped&&r.skipped.length){
      m+='\\n건너뜀 '+r.skipped.length+'칸: '+r.skipped.slice(0,5).map(function(s){
        return '행'+s.r+' '+s.col+'('+s.why+')';}).join(', ');
    }
    say(m,'o');doScan();
  }).withFailureHandler(function(e){busy(false);say(e.message,'e');})
   .pfApplyUi(TK,{ym:$('ym').value,items:items,keys:keys});
}

function doHist(){
  google.script.run.withSuccessHandler(function(list){
    if(!list||!list.length){alert('되돌릴 실행이 없습니다.');return;}
    var t=list.map(function(x,i){
      return (i+1)+') '+x.id+'  '+x.who+'  '+x.n+'칸'+(x.undone?' (되돌림 '+x.undone+')':'');
    }).join('\\n');
    var n=prompt('되돌릴 실행 번호를 적으세요.\\n\\n'+t,'1');
    if(!n)return;
    var pick=list[Number(n)-1];
    if(!pick){alert('번호가 올바르지 않습니다.');return;}
    if(!confirm(pick.id+' 를 되돌립니다.\\n'+pick.n+'칸을 채우기 전 값으로 돌립니다.\\n\\n진행할까요?'))return;
    google.script.run.withSuccessHandler(function(r){
      say('↩ '+r.undone+'칸을 되돌렸습니다.','o');doScan();
    }).withFailureHandler(function(e){say(e.message,'e');}).pfUndoUi(TK,pick.id);
  }).withFailureHandler(function(e){say('이력 실패: '+e.message,'e');}).pfRunsUi(TK,12);
}

$('ym').onchange=loadSites;
$('scan').onclick=doScan;
$('apply').onclick=doApply;
$('hist').onclick=doHist;
$('all').onclick=function(){
  document.querySelectorAll('.ck').forEach(function(e){e.checked=true;});upd();
};
$('none').onclick=function(){
  document.querySelectorAll('.ck').forEach(function(e){e.checked=false;});upd();
};
boot();
`;
}

/* ══════════════════════════════════════════════════════════════════
   11. 설치 — 자기 메뉴만 따로 만듭니다 (기존 onOpen 은 건드리지 않음)
   ══════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ `onOpen` 이라는 이름을 쓰면 기존 Code.js 의 onOpen 과 겹쳐
 *    「전역 이름 중복」 으로 **스크립트 전체가 죽습니다** (2026-08-14 사고).
 *    그래서 이름을 따로 두고, 설치할 때 **전용 열기 트리거**를 하나 만듭니다.
 */
function 과거값보완_onOpen(e) {
  var ui = null;
  try {
    ui = SpreadsheetApp.getUi();
    ui.createMenu(PFILL.MENU_NAME)
      .addItem('🔍 과거값 비교 · 빈칸 찾기', '과거값보완_미리보기')
      .addSeparator()
      .addItem('🕘 되돌리기 (최근 실행)', '과거값보완_되돌리기')
      .addItem('🧪 자가시험', '과거값보완_자가시험')
      .addSeparator()
      .addItem('🗑 자동 메뉴 없애기', '과거값보완_설치해제')
      .addToUi();
  } catch (err) {
    /* onOpen 은 조용히 실패해야 합니다 — 알림을 띄우면 시트를 열 때마다 뜹니다 */
    Logger.log('과거값보완_onOpen: ' + err.message);
  }
}

/** 한 번만 실행 — 전용 열기 트리거를 만듭니다. 여러 번 실행해도 하나만 남습니다. */
function 과거값보완_설치() {
  pfOwnerOrAdmin_(true);

  /* 이미 있으면 지우고 하나만 */
  var dup = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === '과거값보완_onOpen') { ScriptApp.deleteTrigger(t); dup++; }
  });

  var ss = pfMasterSs_() || pfDataSs_();
  if (!ss) throw new Error('스프레드시트를 찾지 못했습니다.');

  ScriptApp.newTrigger('과거값보완_onOpen').forSpreadsheet(ss).onOpen().create();

  var msg = '✅ 과거값 보완 메뉴를 설치했습니다.\n\n'
    + '· 시트: ' + ss.getName() + '\n'
    + '· 메뉴: 「' + PFILL.MENU_NAME + '」 (맨 위 메뉴 막대 맨 오른쪽)\n\n'
    + '시트를 새로 고치거나 다시 열면 메뉴가 보입니다.\n'
    + '기존 메뉴는 그대로 있습니다 — 이 도구는 따로 붙습니다.';
  if (dup) msg += '\n\n(이전 트리거 ' + dup + '개를 정리했습니다)';

  try { SpreadsheetApp.getUi().alert(PFILL.VERSION + ' 설치', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (_) { Logger.log(msg); }
  return msg;
}

/** 자동 메뉴를 없앱니다 (파일은 그대로 — 직접 실행은 계속 됩니다) */
function 과거값보완_설치해제() {
  pfOwnerOrAdmin_(true);
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === '과거값보완_onOpen') { ScriptApp.deleteTrigger(t); n++; }
  });
  var msg = n ? ('🗑 자동 메뉴를 없앴습니다 (트리거 ' + n + '개).\n\n'
              + '이 파일은 그대로 남아 있습니다. 다시 쓰려면 「과거값보완_설치」 를 실행하세요.')
              : '설치된 자동 메뉴가 없습니다.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (_) { Logger.log(msg); }
  return msg;
}

/** 메뉴에서 바로 하는 되돌리기 */
function 과거값보완_되돌리기() {
  pfOwnerOrAdmin_(true);
  var ui = SpreadsheetApp.getUi();
  try {
    var list = pfRuns_(12);
    if (!list.length) { ui.alert('되돌릴 실행이 없습니다.'); return; }
    var t = list.map(function (x, i) {
      return (i + 1) + ') ' + x.id + ' · ' + x.who + ' · ' + x.n + '칸'
        + (x.undone ? ' (' + x.undone + '칸 이미 되돌림)' : '');
    }).join('\n');
    var r = ui.prompt('되돌리기', '되돌릴 실행 번호를 적으세요.\n\n' + t + '\n\n번호:', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var pick = list[Number(pfTrim_(r.getResponseText())) - 1];
    if (!pick) { ui.alert('번호가 올바르지 않습니다.'); return; }

    var c = ui.alert('확인', pick.id + '\n' + pick.n + '칸을 「채우기 전 값」 으로 돌립니다.\n\n진행할까요?',
                     ui.ButtonSet.YES_NO);
    if (c !== ui.Button.YES) return;

    var res = pfUndoRun_(pick.id);
    ui.alert('↩ ' + res.undone + '칸을 되돌렸습니다.');
  } catch (e) {
    ui.alert('되돌리기 실패', e.message, ui.ButtonSet.OK);
  }
}

/* ══════════════════════════════════════════════════════════════════
   12. 자가시험 — 시트를 건드리지 않고 계산 부분만 확인합니다
   ══════════════════════════════════════════════════════════════════ */

function 과거값보완_자가시험() {
  var r = pfSelfTest_();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (_) {}
  var text = r.fail.length
    ? ('❌ ' + r.fail.length + '건 실패 / ' + r.pass + '건 통과\n\n' + r.fail.join('\n'))
    : ('✅ 모두 통과 (' + r.pass + '건)\n\n계산 부분이 정상입니다.\n스프레드시트는 건드리지 않았습니다.');
  Logger.log(text);
  if (ui) ui.alert(PFILL.VERSION + ' 자가시험', text, ui.ButtonSet.OK);
  return r;
}

/** 순수 계산만 시험합니다 (SpreadsheetApp 을 쓰지 않습니다) */
function pfSelfTest_() {
  var pass = 0, fail = [];
  function eq(무엇, 실제, 기대) {
    var a = JSON.stringify(실제), b = JSON.stringify(기대);
    if (a === b) pass++;
    else fail.push('· ' + 무엇 + '\n    기대 ' + b + '\n    실제 ' + a);
  }

  /* 숫자 읽기 */
  eq('숫자 0 은 값', pfNumOrNull_(0), 0);
  eq('문자 "0" 은 값', pfNumOrNull_('0'), 0);
  eq('빈칸은 null', pfNumOrNull_('   '), null);
  eq('"-3.2" 는 숫자', pfNumOrNull_('-3.2'), -3.2);
  eq('날짜글자는 null', pfNumOrNull_('2026-09-04'), null);
  eq('"12.892" 는 숫자', pfNumOrNull_('12.892'), 12.892);

  /* 복합값 뜯기 */
  var a1 = pfParseComposite_('220/221/219');
  eq('3상 조각 수', a1 && a1.length, 1);
  eq('3상 값', a1 && a1[0].vals, [220, 221, 219]);
  var a2 = pfParseComposite_('225/224/225 | 220/221/219');
  eq('복수 접속반 묶음 수', a2 && a2.length, 2);
  eq('복수 접속반 2번째', a2 && a2[1].vals, [220, 221, 219]);
  eq('날짜는 복합값 아님', pfParseComposite_('2026-09-04'), null);
  eq('글자는 복합값 아님', pfParseComposite_('맑음'), null);
  eq('한 숫자', pfParseComposite_('429.8')[0].vals, [429.8]);

  /* 다시 붙이기 */
  eq('복합값 되붙이기', pfJoinComposite_(a2, [[226, 225, 224], [221, 222, 220]]),
     '226/225/224 | 221/222/220');

  /* 모양 비교 */
  eq('같은 모양', pfSameShape_(a1, pfParseComposite_('230/231/229')), true);
  eq('다른 모양', pfSameShape_(a1, a2), false);

  /* 중앙값 */
  eq('홀수 중앙값', pfMedian_([1, 5, 3]), 3);
  eq('짝수 중앙값', pfMedian_([1, 2, 3, 4]), 2.5);
  eq('빈 표본', pfMedian_([]), null);
  eq('0 이 섞인 중앙값', pfMedian_([0, 0, 10]), 0);
  eq('null 은 빼고', pfMedian_([null, 2, 4]), 3);

  /* 최빈값 */
  var m = pfMode_(['O', 'O', 'X', 'O']);
  eq('최빈값', m && m.v, 'O');
  eq('최빈값 횟수', m && m.n, 3);
  eq('최빈값 비율', m && Math.round(m.rate * 100), 75);

  /* 변동계수 */
  eq('모두 같으면 CV 0', pfCV_([5, 5, 5]), 0);
  eq('표본 1개는 CV 없음', pfCV_([5]), null);

  /* 글자 보호 */
  eq('= 시작 막기', pfSafe_('=1+1'), "'=1+1");
  eq('음수는 그대로', pfSafe_('-3.2'), '-3.2');
  eq('3상 날짜막기', pfSafe_('12/11/12'), "'12/11/12");
  eq('큰 3상은 그대로', pfSafe_('225/224/225'), '225/224/225');

  /* 점검ID 해석 */
  eq('연월 뽑기', pfYmOf_('20260903-0000-0001-02'), '202609');
  eq('회차 뽑기', pfSeqOf_('20260903-0000-0001-02'), 2);
  eq('회차 없으면 0', pfSeqOf_('이상한값'), 0);

  /* 시각 */
  eq('시각 → 분', pfMinOf_('09:30'), 570);
  eq('분 → 시각', pfHHMM_(570), '09:30');
  eq('시각 형식 깨짐', pfMinOf_('없음'), null);

  /* 열 분류 */
  eq('점검ID 잠금', pfClassify_('점검ID').kind, 'locked');
  eq('점검자 잠금', pfClassify_('점검자').kind, 'locked');
  eq('특이사항 건너뜀', pfClassify_('특이사항').kind, 'skip');
  eq('판정값', pfClassify_('V_SITE').kind, 'verdict');
  eq('측정값 M_', pfClassify_('M_EARTH').kind, 'measure');
  eq('측정값 R_', pfClassify_('R_ACB_V').kind, 'measure');
  eq('채널', pfClassify_('No7').kind, 'measure');
  eq('변압기온도', pfClassify_('tr_temp_2').kind, 'measure');
  eq('회차현황', pfClassify_('점검회차현황').kind, 'derived');
  eq('전월송전전력', pfClassify_('전월송전전력').kind, 'carry');
  eq('날씨', pfClassify_('날씨').kind, 'weather_text');
  eq('기온', pfClassify_('기온').kind, 'weather_num');
  eq('점검시각', pfClassify_('점검시각').kind, 'time');
  eq('모르는 열', pfClassify_('새로운열').kind, 'auto');

  /* 신뢰도 */
  eq('3개·안정', pfConf_(3, 0.05), 'high');
  eq('3개·변동큼', pfConf_(3, 0.9), 'medium');
  eq('2개', pfConf_(2, 0.1), 'medium');
  eq('1개', pfConf_(1, 0.1), 'low');

  /* 연월 계산 */
  eq('최근 3달', pfRecentMonths_('202601', 3), ['202601', '202512', '202511']);
  eq('작년 같은 달', pfLastYear_('202609'), '202509');

  /* 글자 막기 */
  eq('HTML 막기', pfEsc_('<b>&"'), '&lt;b&gt;&amp;&quot;');

  return { pass: pass, fail: fail };
}

/* ══════════════════════════════════════════════════════════════════
   13. 직접 실행용 — 시트 없이도 계산만 확인
   ══════════════════════════════════════════════════════════════════ */

/** 편집기에서 실행하면 로그에 자가시험 결과를 남깁니다 */
function 과거값보완_계산시험() {
  var r = pfSelfTest_();
  var text = r.fail.length ? ('❌ ' + r.fail.length + '건\n' + r.fail.join('\n'))
                           : ('✅ 전부 통과 (' + r.pass + '건)');
  Logger.log(PFILL.VERSION + '\n' + text);
  return text;
}
