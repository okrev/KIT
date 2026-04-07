const LmsAdapter = require('./LmsAdapter');

class HelloLmsAdapter extends LmsAdapter {
  constructor(baseUrl) {
    super(baseUrl);
  }

  // --- Helpers for execution within crawlWin ---
  async executeInBrowser(code) {
    if (!this.crawlWin || this.crawlWin.isDestroyed()) {
      throw new Error('Crawler window goes offline');
    }
    return await this.crawlWin.webContents.executeJavaScript(code);
  }

  async navigateAndExtract(url, scriptFnText) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (data) => {
        if (!resolved) { resolved = true; resolve(data); }
      };

      const handler = async () => {
        try {
          const result = await this.executeInBrowser(scriptFnText);
          done(result);
        } catch (e) {
          console.error('[navigateAndExtract] Error:', e);
          done(null);
        }
      };

      this.crawlWin.webContents.once('did-finish-load', handler);
      this.crawlWin.loadURL(url);
      setTimeout(() => done(null), 15000); // 15s timeout
    });
  }

  async fetchAndExtract(urlPath, postData, scriptFnText) {
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const postBody = Object.keys(postData)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(postData[k] == null ? '' : String(postData[k])))
      .join('&');
    const script = `
      new Promise(function(resolve) {
        fetch('${esc(urlPath)}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: '${esc(postBody)}'
        })
        .then(r => r.text())
        .then(html => {
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');
          var result = (${scriptFnText})(doc);
          resolve({ success: true, data: result });
        })
        .catch(err => resolve({ success: false, error: err.toString() }));
      });
    `;
    try {
      const res = await this.executeInBrowser(script);
      if (!res.success) throw new Error(res.error);
      return res.data;
    } catch (e) {
      console.error(`[${urlPath}] Error:`, e.message);
      return [];
    }
  }
  // ---------------------------------------------

  async crawlMainPage() {
    this.logProgress('메인 페이지에서 과목을 가져오는 중...');
    const mainUrl = this.baseUrl + '/ilos/main/main_form.acl';
    
    return await this.navigateAndExtract(mainUrl, `
      (function() {
        var doc = document;
        var data = { userInfo: {}, courses: [], timetable: [] };

        var userEl = doc.getElementById('user');
        if (userEl) data.userInfo.name = userEl.innerText.trim();

        var subOpens = doc.querySelectorAll('em.sub_open[kj]');
        var currentTerm = '';
        subOpens.forEach(function(em) {
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
          var parts = nameText.split('\\n');
          var courseName = parts[0] ? parts[0].trim() : nameText;
          var courseCode = parts[1] ? parts[1].trim().replace(/[()]/g, '') : '';
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
    `);
  }

  async enterCourse(kjKey) {
    const result = await this.executeInBrowser(`
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
    return result && result.success;
  }

  /**
   * 상세 페이지 URL에서 pathname / 쿼리를 분리하고 Hello LMS에 맞는 POST 필드로 병합합니다.
   */
  parseDetailUrl(relativeUrl) {
    let raw = (relativeUrl || '').trim();
    if (!raw.startsWith('/')) raw = '/' + raw;
    const q = raw.indexOf('?');
    const pathname = q === -1 ? raw : raw.slice(0, q);
    const search = q === -1 ? '' : raw.slice(q + 1);
    const params = {};
    if (search) {
      new URLSearchParams(search).forEach((v, k) => {
        params[k] = v;
      });
    }
    return { pathname, params };
  }

  /** DOMParser 문서 또는 live document에서 본문·첨부를 추출하는 스크립트 본문 (지역 변수 doc 사용) */
  _detailExtractScriptInner() {
    return `
      function stripScripts(el) {
        if (!el) return;
        el.querySelectorAll('script, form, .progShowHideBtn, .header_logout, #gnb, #header, #footerWrap02, nav.skip, .accessibility').forEach(function(e) { e.remove(); });
      }
      function textLen(el) { return (el && el.innerText) ? el.innerText.trim().length : 0; }
      function pickBody(root) {
        var selectors = [
          '#content_text', '#bbs_contents', '#article_cnt', '#articleCnt', '#article_content',
          '.bbs_view_cont', '.bbs_cnt', '#contents_view', '.content_area', '#viewContent',
          '.board_view', '#board_view', '.article_view', '.post_view', '#post_view',
          '.inner_content', '.text-area', '.view_cont', '[id*="content_text"]', '[class*="view_cont"]',
          'td.bbs_contents', 'div.bbs_contents', '.cnt_area', '#cnt_area', '.board_cnt'
        ];
        var best = null, bestScore = 0, i, el, score;
        for (i = 0; i < selectors.length; i++) {
          el = root.querySelector(selectors[i]);
          if (!el) continue;
          score = textLen(el);
          if (score > bestScore) { bestScore = score; best = el; }
        }
        if (best && bestScore > 12) return best;
        el = root.querySelector('article');
        if (el && textLen(el) > 12) return el;
        el = root.querySelector('main');
        if (el && textLen(el) > 12) return el;
        el = root.querySelector('.subjt_middle');
        if (el && textLen(el) > 5) return el;
        return best || root.querySelector('#content_text') || root.querySelector('.subjt_middle');
      }
      function collectAttachments(root) {
        var out = [], seen = {};
        root.querySelectorAll('a[href]').forEach(function(a) {
          var h = (a.getAttribute('href') || '').trim();
          if (!h || h === '#' || h.indexOf('javascript:') === 0) return;
          var low = h.toLowerCase();
          var looksFile = /\\.(pdf|zip|hwp|hwpx|doc|docx|ppt|pptx|xls|xlsx|txt|csv|mp4|mp3)(\\?|$)/i.test(h);
          var looksDl = /download|file_down|attach|upload|material|lecture_file|blob/i.test(low) ||
            (/\\.acl/i.test(h) && /file|down|material|attach|lecture|download/i.test(low));
          if (!looksFile && !looksDl) return;
          var name = (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ') || (h.split('?')[0].split('/').pop() || '첨부파일');
          if (seen[h]) return;
          seen[h] = 1;
          out.push({ name: name.substring(0, 240), url: h });
        });
        return out;
      }
      var top = doc.querySelector('.subjt_top');
      var mid = doc.querySelector('.subjt_middle');
      var bodyEl = pickBody(doc);
      var attachments = collectAttachments(doc);
      if (!bodyEl || (textLen(bodyEl) < 4 && (!bodyEl.innerHTML || bodyEl.innerHTML.replace(/\\s/g, '').length < 40))) {
        return { html: '<p style="padding:20px;text-align:center;">내용을 찾을 수 없습니다.</p>', attachments: attachments };
      }
      var clone = bodyEl.cloneNode(true);
      stripScripts(clone);
      var topHtml = top ? '<div style="margin-bottom:10px;">' + top.outerHTML + '</div>' : '';
      var midHtml = '';
      if (mid && mid !== bodyEl && !bodyEl.contains(mid)) {
        var midClone = mid.cloneNode(true);
        stripScripts(midClone);
        midHtml = '<div style="margin-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.12);padding-bottom:10px;">' + midClone.outerHTML + '</div>';
      }
      var html = topHtml + midHtml + clone.innerHTML;
      return { html: html, attachments: attachments };
    `;
  }

  _detailExtractScriptFn() {
    return `function(doc) { ${this._detailExtractScriptInner()} }`;
  }

  _isLikelyEmptyDetail(html) {
    if (!html || typeof html !== 'string') return true;
    if (html.indexOf('내용을 찾을 수 없습니다') !== -1) return true;
    const t = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length < 20;
  }

  async navigateAndExtractDetail(fullUrl) {
    const extractOnce = `(function() { var doc = document; ${this._detailExtractScriptInner()} })()`;
    return new Promise((resolve) => {
      let resolved = false;
      const done = (data) => {
        if (!resolved) {
          resolved = true;
          resolve(data);
        }
      };
      const handler = async () => {
        try {
          const result = await this.executeInBrowser(extractOnce);
          done(result);
        } catch (e) {
          console.error('[navigateAndExtractDetail]', e);
          done(null);
        }
      };
      this.crawlWin.webContents.once('did-finish-load', handler);
      this.crawlWin.loadURL(fullUrl);
      setTimeout(() => done(null), 22000);
    });
  }

  async crawlCourseDetail(course, index, total) {
    const label = course.name || `과목 ${index + 1}`;
    this.logProgress(`과목 상세 (${index + 1}/${total}): ${label}`);
    
    const detail = {
      name: course.name, code: course.code, kjKey: course.kjKey, schedule: course.schedule, term: course.term,
      plan: [], notices: [], qna: [], materials: [], projects: [], tests: [], discuss: [], clicker: [], survey: []
    };

    const entered = await this.enterCourse(course.kjKey);
    if (!entered) return detail;

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

    for (const m of menus) {
      detail[m.key] = await this.fetchAndExtract(
        this.baseUrl + m.url, // absolute or relative based on fetch behavior in browser. Browser is on lms domain so relative is fine! But we'll use relative.
        { start: '', display: '1', SCH_VALUE: '', ud: this.lmsUserId || process.env.LMS_ID || '', ky: course.kjKey, KJKEY: course.kjKey },
        `function(doc) {
          var items = [];
          doc.querySelectorAll('table tbody tr').forEach(function(row) {
            var tds = row.querySelectorAll('td, th');
            if (tds.length === 0 || (tds.length === 1 && tds[0].colSpan > 1 && tds[0].innerText.includes('없습니다'))) return;
            var link = '';
            var titleMatch = false;
            var title = '';
            var cells = Array.from(tds).map((td) => {
               var clickAttr = td.getAttribute('onclick') || row.getAttribute('onclick') || '';
               var match = clickAttr.match(/pageMove\\s*\\(\\s*['"]([^'"]+)['"]/);
               if (!match) match = clickAttr.match(/pageGo\\s*\\(\\s*['"]([^'"]+)['"]/);
               if (!match) match = clickAttr.match(/fnPageMove\\s*\\(\\s*['"]([^'"]+)['"]/);
               if (!match) match = clickAttr.match(/pageMove\\('([^']+)'/);
               if (!match) match = clickAttr.match(/pageGo\\('([^']+)'/);
               if (match) link = match[1];
               if (td.querySelector('.subjt_top, div:first-child')) {
                 var titleEl = td.querySelector('.subjt_top') || td.querySelector('div:first-child');
                 var txt = titleEl.innerText.split('\\n')[0].trim();
                 if (txt && !titleMatch) { title = txt; titleMatch = true; }
                 return txt;
               }
               return td.innerText.trim().replace(/\\n/g, ' ');
            });
            if (!title) title = cells[1] || cells[0] || '상세 정보';
            items.push({ cells: cells, link: link, title: title });
          });
          return items;
        }`
      );
    }
    return detail;
  }

  async fetchDetailContent(url, courseKey) {
    const empty = (msg) => ({ html: `<p style="padding:20px;text-align:center;">${msg}</p>`, attachments: [] });
    if (!url || !courseKey) return empty('링크 또는 과목 정보가 없습니다.');

    let pathUrl = String(url).trim();
    if (!pathUrl.startsWith('/')) pathUrl = '/' + pathUrl;

    await this.enterCourse(courseKey);
    await new Promise((r) => setTimeout(r, 200));

    const { pathname, params: queryParams } = this.parseDetailUrl(pathUrl);
    const postData = Object.assign(
      { encoding: 'utf-8' },
      queryParams,
      { ky: courseKey, KJKEY: courseKey }
    );
    const uid = this.lmsUserId || process.env.LMS_ID;
    if (uid) postData.ud = uid;

    const extractFn = this._detailExtractScriptFn();
    let pack = await this.fetchAndExtract(this.baseUrl + pathname, postData, extractFn);

    if (!pack || typeof pack !== 'object' || typeof pack.html !== 'string') {
      pack = empty('데이터를 불러오지 못했습니다.');
    }

    if (this._isLikelyEmptyDetail(pack.html)) {
      const navUrl = this.baseUrl.replace(/\/$/, '') + pathUrl;
      const nav = await this.navigateAndExtractDetail(navUrl);
      if (nav && typeof nav.html === 'string' && !this._isLikelyEmptyDetail(nav.html)) {
        const seen = new Set((pack.attachments || []).map((a) => a.url));
        const merged = [...(pack.attachments || [])];
        (nav.attachments || []).forEach((a) => {
          if (a && a.url && !seen.has(a.url)) {
            seen.add(a.url);
            merged.push(a);
          }
        });
        pack = { html: nav.html, attachments: merged };
      }
    }

    return {
      html: pack.html,
      attachments: Array.isArray(pack.attachments) ? pack.attachments : [],
    };
  }
}

module.exports = HelloLmsAdapter;
