(() => {
  'use strict';
  const key = 'arcahv-appreciation.language';
  const explicit = new URL(location.href).searchParams.get('lang');
  const valid = value => value === 'zh' || value === 'en';
  let saved;
  try { saved = localStorage.getItem(key); } catch {}
  let lang = valid(explicit) ? explicit : valid(saved) ? saved : 'en';
  let chosen = valid(explicit) || valid(saved);
  const text = (en, zh) => lang === 'zh' ? zh : en;
  const originals = new WeakMap();
  const messages = {
    'Choose a full-length listening part.': '请先选择要导入的声部。',
    'Choose an audio file up to 128 MiB.': '请选择 128 MiB 以内的音频文件。',
    'Choose a playable audio file, such as WAV or FLAC.': '请选择浏览器支持的音频文件，如 WAV 或 FLAC。',
    'Load a local recording for this part.': '请先为这个声部导入本地录音。',
    'Unknown listening track.': '请选择一个试听声部。',
    'Local storage transaction aborted.': '保存中断，请再试一次。',
    'Choose a PNG, JPEG or WebP image.': '请选择 PNG、JPEG 或 WebP 图片。',
    'Choose an image smaller than 16 MiB.': '请选择 16 MiB 以内的图片。',
    'Choose an image within 8192 pixels per side and 32 megapixels.': '请选择边长在 8192 像素以内、总像素在 3200 万以内的图片。',
    'This image could not be decoded.': '图片读取失败，请换一张试试。',
    'Press Play to reload the four synchronized stems.': '请点击播放，重新载入四条分轨。',
    'The score data could not be loaded. Reload the page to retry.': '谱例数据加载失败，请刷新页面再试。',
  };
  function error(err, en = 'Please try again.', zh = '请再试一次。') {
    const message = typeof err === 'string' ? err : err?.message;
    if (lang === 'en') return message || en;
    if (Object.hasOwn(messages, message)) return messages[message];
    let m = /^This file is ([\d.]+) s long\. Choose a 172\.99 s stem aligned to the start of Arcahv\.$/.exec(message);
    if (m) return `文件时长为 ${m[1]} 秒。请选择与曲首对齐、时长为 172.99 秒的分轨。`;
    m = /^Press Play to reload the (vocal|bass|drums|instruments) excerpt\.$/.exec(message);
    if (m) return '请点击播放，重新载入' + ({vocal:'人声',bass:'贝斯',drums:'鼓组',instruments:'器乐与音效'})[m[1]] + '片段。';
    m = /^The listening track could not be loaded \((\d+)\)\.$/.exec(message);
    return m ? `音轨加载失败（HTTP ${m[1]}）。请再试一次。` : zh;
  }
  window.studyLanguage = Object.freeze({get zh(){return lang === 'zh';}, text, error});

  const attrs = ['aria-label', 'title', 'content', 'href', 'alt', 'placeholder'];
  function paint() {
    document.documentElement.lang = text('en', 'zh-CN');
    const selector = ['[data-zh]', ...attrs.map(a => '[data-zh-' + a + ']')].join(',');
    for (const el of document.querySelectorAll(selector)) {
      let original = originals.get(el);
      if (!original) {
        original = {};
        if (el.hasAttribute('data-zh')) original.contentText = el.textContent;
        for (const a of attrs) if (el.hasAttribute('data-zh-' + a)) original[a] = el.getAttribute(a);
        originals.set(el, original);
      }
      if ('contentText' in original) el.textContent = text(original.contentText, el.dataset.zh);
      for (const a of attrs) if (a in original) el.setAttribute(a, text(original[a], el.getAttribute('data-zh-' + a)));
    }
    const group = document.querySelector('[data-language-toggle]');
    if (group) {
      group.setAttribute('aria-label', text('Language', '语言'));
      for (const button of group.querySelectorAll('[data-lang]')) button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
    }
    if (chosen) for (const a of document.querySelectorAll('.site-nav a:not(.external)')) {
      const url = new URL(a.href);
      url.searchParams.set('lang', lang);
      a.href = url.href;
    }
  }
  function select(next) {
    if (!valid(next)) return;
    chosen = true;
    try { localStorage.setItem(key, next); } catch {}
    const url = new URL(location.href);
    url.searchParams.set('lang', next);
    try { history.replaceState(history.state, '', url); } catch {}
    if (lang === next) { paint(); return; }
    lang = next;
    paint();
    window.dispatchEvent(new Event('study-language-change'));
  }
  const placeholder = document.querySelector('[data-language-toggle]');
  if (placeholder) {
    const group = document.createElement('div');
    group.className = 'language-toggle';
    group.dataset.languageToggle = '';
    group.setAttribute('role', 'group');
    for (const [code, label] of [['en','English'],['zh','中文']]) {
      if (code === 'zh') {
        const slash = document.createElement('span');
        slash.textContent = '/';
        slash.setAttribute('aria-hidden','true');
        group.append(slash);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.lang = code;
      button.lang = code === 'zh' ? 'zh-CN' : 'en';
      button.textContent = label;
      button.addEventListener('click', () => select(code));
      group.append(button);
    }
    placeholder.replaceWith(group);
  }
  paint();
})();
