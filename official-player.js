(() => {
  'use strict';

  const section = document.getElementById('release-player');
  if (!section) return;
  const tr = window.studyLanguage?.text || (en => en);

  const videoId = 'eNnL750ViLY';
  const duration = 172.98866213151928;
  let selectedRange = { name: 'Full track', zh: '全曲', start: 0, end: duration };
  const phrases = [
    { name: 'First phrase', zh: '首次', start: 10.10, end: 14.80, linkTime: 12, stamp: '0:12' },
    { name: 'Return', zh: '再现', start: 80.47, end: 85.17, linkTime: 83, stamp: '1:23' },
  ];

  function element(tag, content = '') {
    const node = document.createElement(tag);
    node.textContent = content;
    return node;
  }

  const heading = element('h2', 'Original recording');
  const links = element('div');
  const loadButton = element('button', 'Load YouTube player');
  const controls = element('div');
  const status = element('p');
  const viewport = element('div');
  const buttons = [];
  const phraseLinks = [];
  const rangeLink = element('a');
  const rangeButton = element('button');
  for (const row of [links, controls]) {
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:.65rem 1.25rem;margin:.6rem 0';
  }
  controls.hidden = true;
  controls.style.display = 'none';
  loadButton.type = 'button';
  status.setAttribute('role', 'status');
  status.hidden = true;
  viewport.style.maxWidth = '48rem';
  section.append(heading, links, loadButton, controls, status, viewport);

  function videoUrl(seconds) {
    return 'https://www.youtube.com/watch?v=' + videoId + '&t=' + Math.round(seconds) + 's';
  }

  function timestamp(seconds) {
    const whole = Math.round(seconds);
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }

  const phraseName = phrase => tr(phrase.name, phrase.zh || phrase.name);
  const linkLabel = (name, time) => tr(name + ' · ' + time + ' on YouTube ↗', name + ' · YouTube ' + time + ' ↗');
  function showRange() {
    const { start, end } = selectedRange;
    const name = phraseName(selectedRange);
    rangeLink.textContent = linkLabel(name, timestamp(start));
    rangeLink.href = videoUrl(start);
    rangeButton.textContent = tr('Play range · ' + name, '播放选段 · ' + name);
    rangeButton.title = timestamp(start) + '–' + timestamp(end);
    rangeButton.setAttribute('aria-pressed', String(activePhrase === selectedRange));
  }

  rangeLink.target = '_blank';
  rangeLink.rel = 'noopener noreferrer';
  rangeButton.type = 'button';
  rangeButton.addEventListener('click', () => playPhrase(selectedRange));
  links.append(rangeLink);
  controls.append(rangeButton);

  for (const phrase of phrases) {
    const link = element('a', phrase.name + ' · ' + phrase.stamp + ' on YouTube ↗');
    link.href = videoUrl(phrase.linkTime);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    links.append(link);
    phraseLinks.push(link);

    const button = element('button', phrase.name);
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => playPhrase(phrase));
    controls.append(button);
    buttons.push(button);
  }

  let apiRequest;
  let player;
  let activePhrase;
  let requestedOffset = 0;
  let playRequested = false;
  let localHasPriority = false;
  let attempt = 0;
  let expiry;
  let retry = false;
  let statusLabel;
  function translate() {
    heading.textContent = tr('Original recording', '原曲录音');
    loadButton.textContent = retry ? tr('Retry YouTube player','重新加载 YouTube 播放器') : tr('Load YouTube player','加载 YouTube 播放器');
    for (const [i, phrase] of phrases.entries()) {
      buttons[i].textContent = phraseName(phrase);
      phraseLinks[i].textContent = linkLabel(phraseName(phrase), phrase.stamp);
    }
    const frame = viewport.querySelector('iframe');
    if (frame) frame.title = tr('Feryquitous – Arcahv, original recording', 'Feryquitous《Arcahv》原曲录音');
    showRange();
    if (statusLabel) status.textContent = statusLabel();
  }
  translate();
  window.addEventListener('study-language-change', translate);
  window.addEventListener('study:range-change', event => {
    const { start, end, label } = event.detail || {};
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= duration ||
        end <= start || end > duration + 0.05 || typeof label !== 'string' || !label.trim()) return;
    if (selectedRange.start === start && selectedRange.end === Math.min(end, duration)) {
      selectedRange.name = label.trim();
      delete selectedRange.zh;
    } else selectedRange = { name: label.trim(), start, end: Math.min(end, duration) };
    showRange();
    if (statusLabel) status.textContent = statusLabel();
  });

  function say(label) {
    statusLabel = label;
    status.textContent = label();
    status.hidden = false;
  }

  function selectPhrase(phrase) {
    activePhrase = phrase;
    rangeButton.setAttribute('aria-pressed', String(phrase === selectedRange));
    buttons.forEach((button, i) => {
      button.setAttribute('aria-pressed', String(phrases[i] === phrase));
    });
  }

  function playPhrase(phrase) {
    let offset = 0;
    if (phrases.includes(activePhrase) && phrases.includes(phrase) && activePhrase !== phrase) {
      const position = player.getCurrentTime();
      if (position >= activePhrase.start && position < activePhrase.end) {
        offset = position - activePhrase.start;
      } else if (playRequested) {
        // A second click can arrive while the first seek is still buffering.
        offset = requestedOffset;
      }
    }
    requestedOffset = Math.max(0, Math.min(offset, phrase.end - phrase.start - 0.05));
    localHasPriority = false;
    playRequested = true;
    selectPhrase(phrase);
    window.dispatchEvent(new Event('study:official-play'));
    player.loadVideoById({
      videoId,
      startSeconds: phrase.start + requestedOffset,
      endSeconds: phrase.end,
    });
    say(() => tr(phraseName(phrase) + ' · approximate video timing.', phraseName(phrase) + ' · 视频时间为近似值。'));
  }

  function loadApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (apiRequest) return apiRequest;
    apiRequest = new Promise((resolve, reject) => {
      const script = element('script');
      const previous = window.onYouTubeIframeAPIReady;
      function finish(error) {
        window.clearTimeout(deadline);
        script.onerror = null;
        if (window.onYouTubeIframeAPIReady === onReady) window.onYouTubeIframeAPIReady = previous;
        if (error) {
          script.remove();
          apiRequest = undefined;
          reject(error);
        } else {
          resolve(window.YT);
        }
      }
      function onReady() {
        try {
          if (typeof previous === 'function') previous();
        } finally {
          finish(window.YT?.Player ? null : new Error('YouTube API unavailable'));
        }
      }
      const deadline = window.setTimeout(() => finish(new Error('YouTube API timed out')), 18000);
      window.onYouTubeIframeAPIReady = onReady;
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => finish(new Error('YouTube API unavailable'));
      document.head.append(script);
    });
    return apiRequest;
  }

  function fallback(id) {
    if (id !== attempt) return;
    attempt++;
    window.clearTimeout(expiry);
    if (player) player.destroy();
    player = undefined;
    viewport.replaceChildren();
    selectPhrase(undefined);
    controls.hidden = true;
    controls.style.display = 'none';
    playRequested = false;
    loadButton.hidden = false;
    loadButton.disabled = false;
    retry = true;
    translate();
    say(() => tr('The embedded player is unavailable. The links above open the recording on YouTube.', '播放器加载失败，可用上方链接前往 YouTube 收听原曲。'));
  }

  async function mount() {
    const id = ++attempt;
    loadButton.disabled = true;
    say(() => tr('Loading YouTube…', '正在加载 YouTube…'));
    try {
      const yt = await loadApi();
      if (id !== attempt) return;
      const url = new URL('https://www.youtube-nocookie.com/embed/' + videoId);
      url.searchParams.set('enablejsapi', '1');
      url.searchParams.set('playsinline', '1');
      url.searchParams.set('rel', '0');
      if (/^https?:$/.test(window.location.protocol)) url.searchParams.set('origin', window.location.origin);
      const frame = element('iframe');
      frame.title = tr('Feryquitous – Arcahv, original recording', 'Feryquitous《Arcahv》原曲录音');
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      frame.style.cssText = 'display:block;width:100%;aspect-ratio:16/9;min-height:200px;border:0';
      frame.src = url.href;
      viewport.replaceChildren(frame);
      expiry = window.setTimeout(() => fallback(id), 15000);
      player = new yt.Player(frame, { events: {
        onReady() {
          if (id !== attempt) return;
          window.clearTimeout(expiry);
          loadButton.hidden = true;
          controls.hidden = false;
          controls.style.display = 'flex';
          say(() => tr('Switching between First phrase and Return keeps the same offset. Video timing is approximate.', '在「首次」与「再现」之间切换，播放会接在乐句的同一位置。视频时间为近似值。'));
        },
        onStateChange(event) {
          if (id !== attempt) return;
          if (event.data === yt.PlayerState.PLAYING) {
            if (localHasPriority) {
              event.target.pauseVideo();
              return;
            }
            playRequested = false;
            window.dispatchEvent(new Event('study:official-play'));
          } else if (event.data === yt.PlayerState.PAUSED) {
            localHasPriority = false;
            playRequested = false;
          } else if (event.data === yt.PlayerState.ENDED) {
            localHasPriority = false;
            playRequested = false;
            selectPhrase(undefined);
            say(() => tr('Passage ended.', '选段播放完毕。'));
          }
        },
        onError() { fallback(id); },
        onAutoplayBlocked() {
          if (id === attempt) say(() => tr('Press Play in the video to hear the selected passage.', '请点击视频内的播放按钮，收听当前选段。'));
        },
      } });
    } catch {
      fallback(id);
    }
  }

  loadButton.addEventListener('click', mount);
  window.addEventListener('study:local-play', () => {
    if (typeof player?.getPlayerState !== 'function') return;
    const state = player.getPlayerState();
    if (playRequested || state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.BUFFERING) {
      localHasPriority = true;
      player.pauseVideo();
    }
  });
})();
