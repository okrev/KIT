const LmsAdapter = require('../LmsAdapter');
const { BrowserWindow } = require('electron');

class KnuLms extends LmsAdapter {
  constructor() {
    super('https://canvas.knu.ac.kr');
  }

  async executeInBrowser(code) {
    if (!this.crawlWin || this.crawlWin.isDestroyed()) {
      throw new Error('Crawler window goes offline');
    }
    return await this.crawlWin.webContents.executeJavaScript(code);
  }

  async login(credentials) {
    this.logProgress('경북대학교(KNU) Canvas 로그인 시도 중...');

    return new Promise((resolve) => {
      let resolved = false;
      let loginAttempted = false;

      const loginWin = new BrowserWindow({
        width: 1100,
        height: 800,
        show: true,
        title: '경북대학교 - 로그인 및 인증 진행 중',
        autoHideMenuBar: true,
      });

      const done = (success) => {
        if (resolved) return;
        resolved = true;
        try { loginWin.close(); } catch (_) {}
        resolve(success);
      };

      loginWin.loadURL('https://canvas.knu.ac.kr/');

      loginWin.webContents.on('did-finish-load', async () => {
        const url = loginWin.webContents.getURL();

        if (url.includes('sso.knu.ac.kr') || url.includes('login')) {
          if (!loginAttempted) {
            loginAttempted = true;
            this.logProgress('SSO 로그인 창입니다. 로그인 정보를 자동 입력합니다...');
            try {
              await loginWin.webContents.executeJavaScript(`
                var idEl = document.querySelector('input[type="text"]');
                var pwEl = document.querySelector('input[type="password"]');
                if (idEl && pwEl) {
                  idEl.value = ${JSON.stringify(credentials.id)};
                  idEl.dispatchEvent(new Event('input', {bubbles:true}));
                  pwEl.value = ${JSON.stringify(credentials.pw)};
                  pwEl.dispatchEvent(new Event('input', {bubbles:true}));
                  
                  var btn = document.querySelector('button[type="submit"]') || document.querySelector('.btn_login') || document.querySelector('#login_btn') || document.querySelector('input[type="submit"]');
                  if (btn) {
                     setTimeout(() => btn.click(), 500);
                  }
                }
              `);
            } catch(e) {
              console.error('KNU Login auto-fill error:', e);
            }
          } else {
            try {
              const errMsg = await loginWin.webContents.executeJavaScript(`
                (function() {
                  var idEl = document.querySelector('input[type="text"]');
                  if (!idEl) return 'PROCESSING'; // 로그인 폼이 없으면 중간 리다이렉트 중
                  
                  var msgs = Array.from(document.querySelectorAll('span, div, p, .alert, .error')).filter(e => e.innerText && (e.innerText.includes('일치') || e.innerText.includes('권한') || e.innerText.includes('실패') || e.innerText.includes('오류')));
                  return msgs.length > 0 ? msgs[0].innerText.trim() : '아이디 또는 비밀번호가 올바르지 않거나 2차 인증이 필요합니다.';
                })();
              `);
              
              if (errMsg === 'PROCESSING') return; // 리다이렉트 통과
              
              this.logProgress('❌ ' + errMsg);
            } catch(e) {}
            done(false);
          }
        }
      });

      loginWin.webContents.on('did-navigate', (_e, url) => {
        if (url.includes('canvas.knu.ac.kr') && (url.includes('login_success') || url === 'https://canvas.knu.ac.kr/')) {
          done(true);
        }
      });

      loginWin.on('closed', () => { done(false); });

      setTimeout(() => { if (!resolved) { this.logProgress('⏰ 로그인 시간 초과'); done(false); } }, 180000);
    });
  }

  async fetchCanvasApi(apiPath) {
    const script = `
      new Promise(function(resolve) {
        fetch('${apiPath}', { headers: { 'Accept': 'application/json' } })
        .then(r => r.json())
        .then(data => resolve({ success: true, data: data }))
        .catch(err => resolve({ success: false, error: err.toString() }));
      });
    `;
    try {
       const res = await this.executeInBrowser(script);
       if (res && res.success) return res.data;
       console.error('[fetchCanvasApi error]:', res.error);
       return null;
    } catch(e) {
       console.error('[fetchCanvasApi exec error]:', e);
       return null;
    }
  }

  async crawlMainPage() {
    this.logProgress('사용자 및 수강 과목 정보를 가져오는 중...');
    const data = { userInfo: {}, courses: [], timetable: [] };

    await this.crawlWin.loadURL('https://canvas.knu.ac.kr/');

    const profile = await this.fetchCanvasApi('/api/v1/users/self/profile');
    if (profile) {
      data.userInfo.name = profile.name;
      data.userInfo.studentId = profile.login_id;
    }

    const courseRes = await this.fetchCanvasApi('/api/v1/courses?per_page=100&enrollment_state=active&include[]=term');
    if (courseRes && Array.isArray(courseRes)) {
       courseRes.forEach(c => {
         if (!c.name) return;
         data.courses.push({
           name: c.name,
           code: c.course_code,
           kjKey: c.id,
           title: c.name,
           schedule: '',
           term: c.term ? c.term.name : ''
         });
       });
    }
    return data;
  }

  async crawlCourseDetail(course, index, total) {
    const label = course.name || `과목 ${index + 1}`;
    this.logProgress(`과목 상세 (${index + 1}/${total}): ${label}`);

    const detail = {
      name: course.name, code: course.code, kjKey: course.kjKey, schedule: course.schedule, term: course.term,
      plan: [], notices: [], qna: [], materials: [], projects: [], tests: [], discuss: [], clicker: [], survey: []
    };

    const notices = await this.fetchCanvasApi(`/api/v1/announcements?context_codes[]=course_${course.kjKey}&per_page=50`);
    if (notices && Array.isArray(notices)) {
       detail.notices = notices.map(n => {
         return {
           title: n.title, link: n.html_url,
           cells: [`<span class="subjt_top">${n.title}</span>`, n.user_name || '관리자', new Date(n.posted_at).toLocaleDateString()]
         };
       });
    }

    const assignments = await this.fetchCanvasApi(`/api/v1/courses/${course.kjKey}/assignments?per_page=50`);
    if (assignments && Array.isArray(assignments)) {
       assignments.forEach(a => {
         const item = {
           title: a.name, link: a.html_url,
           cells: [`<span class="subjt_top">${a.name}</span>`, a.due_at ? new Date(a.due_at).toLocaleString() : '-', a.points_possible !== null ? `${a.points_possible}점` : '-']
         };
         if (a.is_quiz_assignment || (a.submission_types && a.submission_types.includes('online_quiz'))) {
            detail.tests.push(item);
         } else {
            detail.projects.push(item);
         }
       });
    }

    const modules = await this.fetchCanvasApi(`/api/v1/courses/${course.kjKey}/modules?include[]=items&per_page=50`);
    if (modules && Array.isArray(modules)) {
       modules.forEach(m => {
          if (m.items && m.items.length > 0) {
             m.items.forEach(item => {
               detail.materials.push({
                 title: item.title, link: item.html_url,
                 cells: [m.name, `<span class="subjt_top">${item.title}</span>`, item.type]
               });
             });
          } else {
             detail.materials.push({ title: m.name, link: '', cells: [`<span class="subjt_top">${m.name}</span>`, '-', '-'] });
          }
       });
    }

    const discussions = await this.fetchCanvasApi(`/api/v1/courses/${course.kjKey}/discussion_topics?per_page=50`);
    if (discussions && Array.isArray(discussions)) {
       detail.discuss = discussions.map(d => {
         return { title: d.title, link: d.html_url, cells: [`<span class="subjt_top">${d.title}</span>`, d.user_name, new Date(d.posted_at).toLocaleDateString()] };
       });
    }

    return detail;
  }

  async fetchDetailContent(url, courseKey) {
    if (!url) return '<p style="padding:20px;text-align:center;">상세 링크가 존재하지 않습니다.</p>';
    const script = `
      new Promise(function(resolve) {
        fetch('${url}')
        .then(r => r.text())
        .then(html => {
           var parser = new DOMParser();
           var doc = parser.parseFromString(html, 'text/html');
           var content = doc.querySelector('#content') || doc.querySelector('.user_content');
           resolve({ success: true, data: content ? content.innerHTML : '<p style="padding:20px;text-align:center;">페이지 요소가 복잡하여 본문을 직접 렌더링할 수 없습니다. 원본 링크를 이용해주세요.</p>' });
        })
        .catch(err => resolve({ success: false, error: err.toString() }));
      });
    `;
    try {
      const res = await this.executeInBrowser(script);
      if (res && res.success) {
         return res.data + `<br/><br/><hr/><p style="padding:20px;text-align:center;"><a href="${url}" target="_blank" style="color:#007BFF; text-decoration: underline;">👉 원본 Canvas 화면 열기</a></p>`;
      }
    } catch (e) {}

    return `<p style="padding:20px;text-align:center;"><a href="${url}" target="_blank" style="color:#007BFF; text-decoration: underline;">👉 원본 Canvas 화면 열기</a></p>`;
  }
}

module.exports = KnuLms;