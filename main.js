/* =========================================================
 *  대구대학교 스마트 LMS 크롤러 – Electron Main Process
 *  (실제 LMS HTML 구조 기반 – 2026-04 기준)
 * ========================================================= */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

/* ── URL 상수 ─────────────────────────────────────────── */
const SSO_LOGIN_URL =
  'https://sso.daegu.ac.kr/dgusso/ext/lms/login_form.do?Return_Url=https://lms.daegu.ac.kr/ilos/lo/login_sso.acl';
const LMS_BASE = 'https://lms.daegu.ac.kr';
const LMS_MAIN = LMS_BASE + '/ilos/main/main_form.acl';

/* ── 상태 ──────────────────────────────────────────────── */
let mainWin = null;
let loginWin = null;
let crawlWin = null;
let allCrawledData = null;

/* ──────────────────────────────────────────────────────────
 *  윈도우 생성
 * ────────────────────────────────────────────────────────── */
function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

function getOrCreateCrawlWindow() {
  if (crawlWin && !crawlWin.isDestroyed()) return crawlWin;
  crawlWin = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  return crawlWin;
}

/* ──────────────────────────────────────────────────────────
 *  유틸리티
 * ────────────────────────────────────────────────────────── */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sendProgress(message) {
  console.log('[PROGRESS]', message);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('crawl-progress', message);
  }
}

/**
 * 크롤링 윈도우에서 URL을 로드하고 JS를 실행하여 데이터 추출
 * 같은 윈도우를 재사용하여 세션/쿠키 유지
 */
async function navigateAndExtract(url, extractScript, options = {}) {
  const { waitMs = 2500, timeout = 20000 } = options;
  const win = getOrCreateCrawlWindow();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${url}`));
    }, timeout);

    win.webContents.once('did-finish-load', async () => {
      try {
        await delay(waitMs);
        const data = await win.webContents.executeJavaScript(extractScript);
        clearTimeout(timer);
        resolve(data);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    win.loadURL(url);
  });
}

/**
 * 크롤링 윈도우에서 현재 페이지의 context에서 JS 실행
 * (페이지를 다시 로드하지 않고 실행)
 */
async function executeInCrawlWindow(script) {
  const win = getOrCreateCrawlWindow();
  return win.webContents.executeJavaScript(script);
}

/* ──────────────────────────────────────────────────────────
 *  SSO 로그인 + 2차 인증
 * ────────────────────────────────────────────────────────── */
async function performLogin(credentials) {
  return new Promise((resolve) => {
    loginWin = new BrowserWindow({
      width: 1100,
      height: 800,
      show: true,
      title: '대구대학교 LMS 로그인 – 2차 인증을 완료해 주세요',
      autoHideMenuBar: true,
    });

    let resolved = false;
    const done = (success) => {
      if (resolved) return;
      resolved = true;
      try { loginWin.close(); } catch (_) {}
      resolve({ success });
    };

    loginWin.loadURL(SSO_LOGIN_URL);

    loginWin.webContents.on('did-finish-load', async () => {
      const url = loginWin.webContents.getURL();

      if (url.includes('sso.daegu.ac.kr') && url.includes('login_form')) {
        sendProgress('아이디/비밀번호 입력 중...');
        try {
          await loginWin.webContents.executeJavaScript(`
            (function() {
              var idEl = document.getElementById('usr_id');
              var pwEl = document.getElementById('usr_pw');
              if (idEl) { idEl.value = ${JSON.stringify(credentials.id)}; idEl.dispatchEvent(new Event('input', {bubbles:true})); }
              if (pwEl) { pwEl.value = ${JSON.stringify(credentials.pw)}; pwEl.dispatchEvent(new Event('input', {bubbles:true})); }
            })();
          `);
          await delay(500);
          await loginWin.webContents.executeJavaScript(`
            (function() {
              var btn = document.querySelector('.btn_login') || document.querySelector('button[type="submit"]');
              if (btn) btn.click();
            })();
          `);
          sendProgress('🔐 2차 인증을 완료해 주세요...');
        } catch (e) {
          console.error('Login auto-fill error:', e);
        }
      }

      if (url.includes('lms.daegu.ac.kr') && !url.includes('login')) {
        done(true);
      }
    });

    loginWin.webContents.on('did-navigate', (_e, url) => {
      if (url.includes('lms.daegu.ac.kr') && !url.includes('login')) {
        done(true);
      }
    });

    loginWin.on('closed', () => { loginWin = null; done(false); });
    setTimeout(() => { if (!resolved) { sendProgress('⏰ 로그인 시간 초과'); done(false); } }, 180000);
  });
}

/* ──────────────────────────────────────────────────────────
 *  크롤링 – 수강 과목 리스트
 * ────────────────────────────────────────────────────────── */
async function crawlMainPage() {
  sendProgress('메인 페이지에서 정보를 가져오는 중...');

  const result = await navigateAndExtract(LMS_MAIN, `
    (function() {
      var doc = document;
      var data = { userInfo: {}, courses: [], timetable: [] };

      /* ── 사용자 이름 (strong#user) ── */
      var userEl = doc.getElementById('user');
      if (userEl) data.userInfo.name = userEl.innerText.trim();

      /* ── 수강 과목 리스트 (em.sub_open[kj]) ── */
      var subOpens = doc.querySelectorAll('em.sub_open[kj]');
      var currentTerm = '';
      subOpens.forEach(function(em) {
        /* 학기 분류 (이전 li.term_info의 텍스트) */
        var li = em.closest('li');
        if (li) {
          var prev = li.previousElementSibling;
          while (prev) {
            if (prev.classList && prev.classList.contains('term_info')) {
              currentTerm = prev.innerText.trim();
              break;
            }
            prev = prev.previousElementSibling;
          }
        }

        var kjKey = em.getAttribute('kj') || '';
        var title = em.getAttribute('title') || '';
        var nameText = em.innerText.trim();
        /* "과목명\\n(코드-분반)" 형태에서 분리 */
        var parts = nameText.split('\\n');
        var courseName = parts[0] ? parts[0].trim() : nameText;
        var courseCode = parts[1] ? parts[1].trim().replace(/[()]/g, '') : '';

        /* 시간 정보 (다음 span) */
        var schedSpan = em.nextElementSibling;
        var schedule = schedSpan ? schedSpan.innerText.trim() : '';

        data.courses.push({
          name: courseName,
          code: courseCode,
          kjKey: kjKey,
          title: title,
          schedule: schedule,
          term: currentTerm,
        });
      });

      /* ── 오늘 시간표 ── */
      var ttRows = doc.querySelectorAll('.m-box2 table tbody tr, .timetable-area table tbody tr');
      ttRows.forEach(function(tr) {
        var tds = tr.querySelectorAll('td');
        if (tds.length >= 4) {
          data.timetable.push({
            time: tds[0].innerText.trim(),
            subject: tds[1].innerText.trim(),
            professor: tds[2].innerText.trim(),
            room: tds[3].innerText.trim(),
          });
        }
      });

      return data;
    })();
  `, { waitMs: 3000 });

  return result;
}

/* ──────────────────────────────────────────────────────────
 *  과목 진입 및 세션 설정
 * ────────────────────────────────────────────────────────── */
async function enterCourse(kjKey) {
  /* Vanilla JS fetch를 사용하여 서버 세션 설정 유지 (빠름) */
  const result = await executeInCrawlWindow(`
    new Promise(function(resolve) {
      fetch('/ilos/st/course/eclass_room2.acl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'KJKEY=' + encodeURIComponent('${kjKey}') + '&returnData=json&returnURI=%2Filos%2Fst%2Fcourse%2Fsubmain_form.acl&encoding=utf-8'
      })
      .then(r => r.json())
      .then(data => resolve({ success: true, data: data }))
      .catch(err => resolve({ success: false, error: err.toString() }));
    });
  `);

  if (!result || !result.success) {
    console.error('Failed to enter course ' + kjKey, result ? result.error : '');
    return false;
  }
  return true;
}

/* ──────────────────────────────────────────────────────────
 *  크롤링 – 과목 상세
 * ────────────────────────────────────────────────────────── */
async function crawlCourseDetail(course, index, total) {
  const label = course.name || `과목 ${index + 1}`;
  sendProgress(`과목 상세 (${index + 1}/${total}): ${label}`);

  const detail = {
    name: course.name,
    code: course.code,
    kjKey: course.kjKey,
    schedule: course.schedule,
    term: course.term,
    plan: [],
    notices: [],
    qna: [],
    materials: [],
    projects: [],
    tests: [],
    discuss: [],
    clicker: [],
    survey: [],
  };

  /* 1. 과목 진입 */
  const entered = await enterCourse(course.kjKey);
  if (!entered) {
    console.log(`Could not enter course: ${label}`);
    return detail;
  }

  const menus = [
    { key: 'plan', url: '/ilos/st/course/plan_form.acl' },
    { key: 'notices', url: '/ilos/st/course/notice_list.acl' },
    { key: 'qna', url: '/ilos/st/course/qna2_faq_list.acl' },
    { key: 'materials', url: '/ilos/st/course/lecture_material_list.acl' },
    { key: 'projects', url: '/ilos/st/course/project_list.acl' },
    { key: 'tests', url: '/ilos/st/course/test_list.acl' },
    { key: 'discuss', url: '/ilos/st/course/discuss_list.acl' },
    { key: 'clicker', url: '/ilos/st/course/clicker_list.acl' },
    { key: 'survey', url: '/ilos/st/course/survey2_list.acl' },
  ];

  /* 2. 9개 탭 범용 파싱 연동 */
  for (const m of menus) {
    detail[m.key] = await fetchAndExtract(
      m.url,
      { start: '', display: '1', SCH_VALUE: '', ud: process.env.LMS_ID, ky: course.kjKey, KJKEY: course.kjKey },
      `(function(doc) {
        var items = [];
        doc.querySelectorAll('table tbody tr').forEach(function(row) {
          var tds = row.querySelectorAll('td, th');
          if (tds.length === 0 || (tds.length === 1 && tds[0].colSpan > 1 && tds[0].innerText.includes('없습니다'))) return;
          var link = '';
          var titleMatch = false;
          var title = '';
          
          var cells = Array.from(tds).map((td) => {
             var clickAttr = td.getAttribute('onclick') || row.getAttribute('onclick') || '';
             var match = clickAttr.match(/pageMove\\('([^']+)'/);
             if (!match) match = clickAttr.match(/pageGo\\('([^']+)'/);
             if (match) link = match[1];
             
             if (td.querySelector('.subjt_top, div:first-child')) {
               var titleEl = td.querySelector('.subjt_top') || td.querySelector('div:first-child');
               var txt = titleEl.innerText.split('\\n')[0].trim();
               if (txt && !titleMatch) {
                 title = txt;
                 titleMatch = true;
               }
               return txt;
             }
             return td.innerText.trim().replace(/\\n/g, ' ');
          });
          
          if (!title) title = cells[1] || cells[0] || '상세 정보';
          
          items.push({
            cells: cells,
            link: link,
            title: title
          });
        });
        return items;
      })()`,
      label + ' - ' + m.key
    );
  }

  return detail;
}

/** fetch 기반 브라우저 내부 크롤링: 브라우저 네비게이션으로 인한 Timeout 방지 */
async function fetchAndExtract(urlPath, postDataStr, scriptFnText, courseLabel) {
  const postBody = new URLSearchParams(postDataStr).toString();
  const script = `
    new Promise((resolve) => {
      fetch('${urlPath}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: '${postBody}'
      })
        .then(res => res.text())
        .then(html => {
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');
          var result = (${scriptFnText})(doc);
          resolve({ success: true, data: result, html: html });
        })
        .catch(err => {
          resolve({ success: false, error: err.toString() });
        });
    });
  `;
  try {
    const res = await executeInCrawlWindow(script);
    if (!res.success) throw new Error(res.error);
    
    /* 디버그 폴더에 HTML 저장 (과목 레이블 + URL 파트) */
    const safeName = (courseLabel || 'unknown').replace(/[^a-z0-9가-힣_-]/gi, '_');
    const safeUrl = urlPath.split('/').pop().replace('.acl', '');
    try {
      fs.writeFileSync(path.join(__dirname, 'debug', `06_${safeName}_${safeUrl}.html`), res.html, 'utf8');
    } catch (_) {}

    return res.data;
  } catch (e) {
    console.error(`[${urlPath}] Error for ${courseLabel}:`, e.message);
    return [];
  }
}

/* ──────────────────────────────────────────────────────────
 *  전체 크롤링 오케스트레이션
 * ────────────────────────────────────────────────────────── */
async function crawlAllData() {
  const data = { crawledAt: new Date().toISOString(), userInfo: {}, courses: [], timetable: [] };

  try {
    /* 1. 메인 페이지에서 사용자 정보 + 과목 리스트 + 시간표 */
    const mainData = await crawlMainPage();
    data.userInfo = mainData.userInfo || {};
    data.timetable = mainData.timetable || [];
    const courseList = mainData.courses || [];

    mainWin.webContents.send('user-info', data.userInfo);
    mainWin.webContents.send('course-list', courseList);
    sendProgress(`${courseList.length}개 과목 발견, 상세 정보 크롤링 시작...`);

    /* 2. 각 과목 상세 */
    for (let i = 0; i < courseList.length; i++) {
      const detail = await crawlCourseDetail(courseList[i], i, courseList.length);
      data.courses.push(detail);
      mainWin.webContents.send('course-detail', { index: i, detail });
    }

    sendProgress('✅ 모든 데이터 크롤링 완료!');
    mainWin.webContents.send('crawl-complete', data);
  } catch (e) {
    console.error('Crawl error:', e);
    mainWin.webContents.send('crawl-error', e.message);
  }

  /* 세션 유지를 위해 crawlWin.close() 제거 */
  // try { if (crawlWin && !crawlWin.isDestroyed()) crawlWin.close(); } catch (_) {}
  // crawlWin = null;
  return data;
}

/* ──────────────────────────────────────────────────────────
 *  앱 라이프사이클 & IPC
 * ────────────────────────────────────────────────────────── */
app.whenReady().then(() => {
  mainWin = createMainWindow();

  mainWin.webContents.on('did-finish-load', () => {
    const savedId = process.env.LMS_ID || '';
    const savedPw = process.env.LMS_PW || '';
    if (savedId) mainWin.webContents.send('saved-login-info', { id: savedId, pw: savedPw });
  });

  ipcMain.on('login', async (_event, credentials) => {
    sendProgress('로그인 시도 중...');
    const result = await performLogin(credentials);
    if (result.success) {
      mainWin.webContents.send('login-success');
      sendProgress('로그인 성공! 크롤링을 시작합니다...');
      allCrawledData = await crawlAllData();
    } else {
      mainWin.webContents.send('login-fail');
    }
  });

  ipcMain.on('minimize-window', () => mainWin.minimize());
  ipcMain.on('maximize-window', () => { mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); });
  ipcMain.on('close-window', () => mainWin.close());
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('fetch-detail', async (event, { url, courseKey }) => {
  if (!crawlWin) crawlWin = getOrCreateCrawlWindow();
  try {
    const detailHtml = await fetchAndExtract(
      url,
      { ky: courseKey, encoding: 'utf-8' },
      `(function(doc) {
        var top = doc.querySelector('.subjt_top') || '';
        var mid = doc.querySelector('.subjt_middle') || '';
        var view = doc.querySelector('#content_text');
        if (!view) return '<p style="padding:20px;text-align:center;">내용을 찾을 수 없습니다.</p>';
        var topHtml = top ? '<div style="margin-bottom:10px;">' + top.outerHTML + '</div>' : '';
        var midHtml = mid ? '<div style="margin-bottom:20px;border-bottom:1px solid #333;padding-bottom:10px;">' + mid.outerHTML + '</div>' : '';
        view.querySelectorAll('script, form, .progShowHideBtn, .header_logout, #gnb, #header, #footerWrap02').forEach(e => e.remove());
        return topHtml + midHtml + view.innerHTML;
      })()`,
      '상세 내용 로드'
    );
    return detailHtml;
  } catch (err) {
    console.error('Fetch detail error:', err);
    return '<p style="padding:20px;text-align:center;">불러오기 에러가 발생했습니다.</p>';
  }
});
