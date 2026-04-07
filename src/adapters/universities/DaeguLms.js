const HelloLmsAdapter = require('../HelloLmsAdapter');
const { BrowserWindow } = require('electron');

class DaeguLms extends HelloLmsAdapter {
  constructor() {
    super('https://lms.daegu.ac.kr');
  }

  async login(credentials) {
    this.logProgress('로그인 시도 중...');
    
    return new Promise((resolve) => {
      let resolved = false;
      let loginAttempted = false;
      const loginWin = new BrowserWindow({
        width: 1100,
        height: 800,
        show: true,
        title: '대구대학교 LMS 로그인 – 2차 인증을 완료해 주세요',
        autoHideMenuBar: true,
      });

      const done = (success) => {
        if (resolved) return;
        resolved = true;
        try { loginWin.close(); } catch (_) {}
        resolve(success);
      };

      const ssoUrl = 'https://sso.daegu.ac.kr/dgusso/ext/lms/login_form.do?Return_Url=https://lms.daegu.ac.kr/ilos/lo/login_sso.acl';
      loginWin.loadURL(ssoUrl);

      loginWin.webContents.on('did-finish-load', async () => {
        const url = loginWin.webContents.getURL();
        
        if (url.includes('sso.daegu.ac.kr') && url.includes('login')) {
          if (!loginAttempted) {
            loginAttempted = true;
            this.logProgress('아이디/비밀번호 입력 중...');
            try {
              await loginWin.webContents.executeJavaScript(`
                var idEl = document.getElementById('usr_id');
                var pwEl = document.getElementById('usr_pw');
                if (idEl) { idEl.value = ${JSON.stringify(credentials.id)}; idEl.dispatchEvent(new Event('input', {bubbles:true})); }
                if (pwEl) { pwEl.value = ${JSON.stringify(credentials.pw)}; pwEl.dispatchEvent(new Event('input', {bubbles:true})); }
              `);
              // Delay a bit
              await new Promise(r => setTimeout(r, 500));
              await loginWin.webContents.executeJavaScript(`
                var btn = document.querySelector('.btn_login') || document.querySelector('button[type="submit"]');
                if (btn) btn.click();
              `);
              this.logProgress('🔐 2차 인증을 완료해 주세요...');
            } catch (e) {
              console.error('Login auto-fill error:', e);
            }
          } else {
            // 이미 시도했으나 다시 로그인 창이라면 실패로 간주
            try {
              const errMsg = await loginWin.webContents.executeJavaScript(`
                (function() {
                  var idEl = document.getElementById('usr_id');
                  if (!idEl) return 'PROCESSING'; // 로그인 폼이 없으면 중간 리다이렉트 중
                  
                  var msgs = Array.from(document.querySelectorAll('span, div, p, .error')).filter(e => e.innerText && (e.innerText.includes('일치하지') || e.innerText.includes('실패')));
                  return msgs.length > 0 ? msgs[0].innerText.trim() : '비밀번호 또는 아이디가 올바르지 않습니다.';
                })();
              `);
              
              if (errMsg === 'PROCESSING') return; // 아직 리다이렉트 중이므로 패스
              
              this.logProgress('❌ ' + errMsg);
            } catch(e) {}
            done(false);
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

      loginWin.on('closed', () => { done(false); });

      // Timeout 3 mins
      setTimeout(() => { if (!resolved) { this.logProgress('⏰ 로그인 시간 초과'); done(false); } }, 180000);
    });
  }
}

module.exports = DaeguLms;
