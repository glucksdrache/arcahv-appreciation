import { excerptStart, excerptEnd, excerptParts, loadExcerpt } from './excerpt-audio.js';
import { sectionText } from './data/full.zh.js';

const $ = (id) => document.getElementById(id);
const { text, error: errorText } = window.studyLanguage;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const names = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const labels = [
  ['Mix', '混音'], ['Vocal', '人声'], ['Accompaniment', '伴奏'], ['Vocal + bass', '人声与贝斯'],
  ['G1 → E♭1', 'G1 → E♭1'], ['Hold G1', '保持 G1'], ['Bass', '贝斯'], ['Drums', '鼓组'], ['Instruments', '器乐']
];
const excerptNames = { vocal: '人声', bass: '贝斯', drums: '鼓组', instruments: '器乐' };
const isTrial = (i) => i === 4 || i === 5;
const chartX = 106, chartWidth = 826;
const cueStart = 9.65, cueEnd = 14.75;
const presets = { opening: [0, 27.4], phrase: [6.3, 14.85], turn: [9.65, 14.75], return: [76.65, 85.23] };

let data, start = 0, end = 0, position = 0, role = 0, selection = 'whole';
let context, active, pending = false, revision = 0, source = 'guide', referenceGeneration = 0;
let animationFrame, graphCursor, lastFrame = -1, loadingReference = false;
let dragging = false, previewTime = null, heatImage;
let recordedRoles = new Set(), libraryRevision = 0;
let previousFullRange;
const audibleExcerptParts = new Set(excerptParts);
const decoded = new Map(), decoding = new Map();
const sectionViews = [];
const statusMessages = new Map();

function showStatus(id, message) {
  if (message) statusMessages.set(id, message);
  else statusMessages.delete(id);
  $(id).textContent = message ? message() : '';
}

function sectionCopy(section) {
  return window.studyLanguage.zh ? sectionText[section.short] : section;
}

function formatTime(time, decimal = true) {
  const cents = Math.round(Math.max(time, 0) * 100);
  const seconds = String(Math.floor(cents / 100) % 60).padStart(2, '0');
  return Math.floor(cents / 6000) + ':' + seconds + (decimal ? '.' + String(cents % 100).padStart(2, '0') : '');
}

function pitch(value) {
  if (!Number.isFinite(value)) return '—';
  const note = Math.round(value);
  return names[note % 12] + (Math.floor(note / 12) - 1);
}

function bassAt(t, index) {
  if (isTrial(role)) return role === 4 && t >= 11.653 ? 27 : 31;
  for (const [a, b, m] of data.confirmedBass) if (t >= a && t < b) return m;
  return data.curves.bassMidi[index];
}

function svg(tag, attrs = {}, content) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (content !== undefined) node.textContent = content;
  return node;
}

function drawChart() {
  const chart = $('v-chart');
  chart.replaceChildren();
  const span = end - start, x = t => chartX + chartWidth * (t - start) / span;
  const add = (tag, attrs, content) => chart.appendChild(svg(tag, attrs, content));
  const drawText = (px, py, content, cls = 'v-axis', attr = {}) => add('text', { x: px, y: py, class: cls, ...attr }, content);
  const line = (x1, y1, x2, y2, color, dashed = false) => add('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': .8, 'stroke-dasharray': dashed ? '3 3' : 'none' });
  const lanes = [
    [53, 109, '#302637', text('Vocal pitch', '人声音高'), text('Main contour', '主旋律线')],
    [169, 48, '#302c32', text('Vocal RMS', '人声电平'), 'dBFS'],
    [224, 42, '#203136', text('Bass', '贝斯'), isTrial(role) ? text('Test pitch', '实验音高') : text('Pitch estimate', '估计音高')],
    [274, 86, '#2b283d', text('Instruments', '器乐'), text('Pitch class', '音级')],
    [369, 34, '#302a32', text('Percussion', '打击乐'), 'RMS · dBFS']
  ];
  for (const [y, h, fill, title, desc] of lanes) {
    add('rect', { x: chartX, y, width: chartWidth, height: h, fill });
    drawText(11, y + 16, title, 'v-head');
    drawText(11, y + 30, desc);
  }
  const defs = add('defs', {});
  const clip = svg('clipPath', { id: 'chroma-window' });
  clip.appendChild(svg('rect', { x: chartX, y: 274, width: chartWidth, height: 86 }));
  defs.appendChild(clip);
  const heat = add('g', { 'clip-path': 'url(#chroma-window)' });
  heat.appendChild(svg('image', { href: heatImage || data.harmonics.heat, x: x(0), y: 274, width: chartWidth * data.harmonics.peaks.length * data.harmonics.dt / span, height: 86, preserveAspectRatio: 'none' }));

  const grid = span > 100 ? 20 : span > 50 ? 10 : span > 25 ? 5 : span > 13 ? 2 : span > 6 ? 1 : span > 2 ? .5 : .1;
  for (let t = Math.ceil((start - .00001) / grid) * grid; t < end - .01; t += grid) {
    const px = x(t);
    line(px, 47, px, 403, '#5a5564', true);
    if (px < chartX + chartWidth - 22) drawText(px + 2, 44, span > 60 ? formatTime(t, false) : Number(t.toFixed(1)) + text(' s', ' 秒'));
  }
  const voiceY = m => 158 - (clamp(m, 47, 85) - 47) * 96 / 38;
  const dbY = d => 213 - clamp((d + 60) / 53, 0, 1) * 40;
  const bassY = m => 263 - clamp((m - 23) / 28, 0, 1) * 33;
  const drumY = d => 400 - clamp((d + 60) / 54, 0, 1) * 27;
  for (const m of [60, 67, 72, 79]) {
    line(chartX, voiceY(m), chartX + chartWidth, voiceY(m), '#4b4053');
    drawText(chartX - 4, voiceY(m) + 3, pitch(m), 'v-axis', { 'text-anchor': 'end' });
  }
  for (const d of [-45, -20]) drawText(chartX - 4, dbY(d) + 3, d, 'v-axis', { 'text-anchor': 'end' });
  for (const n of [0, 4, 7, 11]) drawText(chartX - 4, 277 + (11.5 - n) * 86 / 12, names[n], 'v-axis', { 'text-anchor': 'end' });

  function plot(values, dt, project, stroke, width, jump = Infinity) {
    const first = Math.max(0, Math.floor(start / dt)), last = Math.min(values.length - 1, Math.ceil(end / dt));
    let path = '', previous = null;
    for (let i = first; i <= last; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) { previous = null; continue; }
      const move = previous === null || Math.abs(previous - value) > jump;
      path += (move ? 'M' : 'L') + x(clamp(i * dt, start, end)).toFixed(2) + ' ' + project(value).toFixed(2);
      previous = value;
    }
    add('path', { d: path, fill: 'none', stroke, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  }
  const c = data.curves, h = data.harmonics;
  plot(c.vocalMidi, c.dt, voiceY, '#efb2d0', span > 60 ? 1.4 : 2, 4.5);
  plot(c.vocalDb, c.dt, dbY, '#f0ca88', 1.5);
  if (!isTrial(role)) plot(c.bassMidi, c.dt, bassY, '#a4dacf', 1.35, 3);
  const bassSpans = role === 4 ? [[cueStart, 11.653, 31], [11.653, cueEnd, 27]]
    : role === 5 ? [[cueStart, cueEnd, 31]] : data.confirmedBass;
  for (const [a, b, m] of bassSpans) {
    const left = x(Math.max(start, a)), right = x(Math.min(end, b));
    if (right <= left) continue;
    add('line', { x1: left, x2: right, y1: bassY(m), y2: bassY(m), stroke: '#a4dacf', 'stroke-width': 2.7 });
    if (right - left > 28) drawText(left + 3, bassY(m) - 3, pitch(m), 'v-label');
  }
  plot(h.drumDb, h.dt, drumY, '#d9a58e', 1.4);
  if (span < 36) {
    const markers = [
      [10.1, text('Phrase onset ≈10.1 s', '乐句起点 ≈10.1 秒'), 13],
      [11.653, text('Bass change 11.65 s', '低音转换 11.65 秒'), 29],
      [80.47, text('Phrase return', '乐句再现'), 13],
      [82.02, text('Bass change', '低音转换'), 29]
    ];
    for (const [t, caption, y] of markers) {
      if (t <= start || t >= end) continue;
      const px = x(t), nearEnd = px > chartX + chartWidth - 118;
      line(px, y + 4, px, 266, '#998769', true);
      drawText(px + (nearEnd ? -3 : 3), y, caption, 'v-label', { 'text-anchor': nearEnd ? 'end' : 'start' });
    }
  } else {
    data.sections.forEach((s, i) => {
      if (s.start <= start || s.start >= end) return;
      line(x(s.start), 20, x(s.start), 266, '#756f89', true);
      drawText(x(s.start) + 2, 17, i + 1);
    });
  }
  graphCursor = add('line', { x1: x(position), x2: x(position), y1: 45, y2: 404, stroke: '#fcf7ff', 'stroke-width': 1.6, 'pointer-events': 'none' });
  lastFrame = -1;
}

function currentTime(at = context?.currentTime || 0) {
  if (!active) return position;
  const raw = active.from + Math.max(0, at - active.when);
  return active.loop ? active.start + (raw - active.start) % (active.end - active.start) : Math.min(active.end, raw);
}

function readout(force = false) {
  if (!data) return;
  const t = dragging && previewTime !== null ? previewTime : currentTime();
  const frame = Math.round(t * 40);
  if (!force && frame === lastFrame) return;
  lastFrame = frame;
  const idx = clamp(Math.round(t / data.curves.dt), 0, data.curves.vocalMidi.length - 1);
  const col = clamp(Math.round(t / data.harmonics.dt), 0, data.harmonics.peaks.length - 1);
  const px = chartX + chartWidth * clamp((t - start) / (end - start), 0, 1);
  if (source === 'excerpt') {
    $('excerpt-controls').style.setProperty('--excerpt-progress', (100 * clamp((t - start) / (end - start), 0, 1)) + '%');
  }
  if (graphCursor) { graphCursor.setAttribute('x1', px); graphCursor.setAttribute('x2', px); }
  if (!dragging) $('v-slider').value = t;
  $('v-clock').textContent = formatTime(t) + ' / ' + formatTime(end);
  $('v-current-pitch').textContent = pitch(data.curves.vocalMidi[idx]);
  const db = data.curves.vocalDb[idx];
  $('v-current-db').textContent = db < -70 ? '< −70 dBFS' : db.toFixed(1) + ' dBFS';
  $('v-current-bass').textContent = pitch(bassAt(t, idx));
  $('v-current-harm').textContent = data.harmonics.peaks[col].map(n => names[n]).join(' · ') || '—';
}

function animate() {
  readout();
  if (active) animationFrame = requestAnimationFrame(animate);
}

function canPlay(index) {
  if (source === 'excerpt') return index === 0;
  return source === 'guide' || recordedRoles.has(index);
}

function availablePart(preferred) {
  if (canPlay(preferred)) return preferred;
  return [...recordedRoles].find(index => !isTrial(index)) ?? 0;
}

function paint() {
  const available = canPlay(role);
  const excerpt = source === 'excerpt';
  $('v-play').textContent = active ? text('Ⅱ Pause', 'Ⅱ 暂停') : pending ? text('Loading…', '载入中…') : text('▶ Play', '▶ 播放');
  $('v-play').setAttribute('aria-label', active ? text('Pause', '暂停') : pending ? text('Cancel loading', '取消载入') : text('Play', '播放'));
  $('v-play').disabled = !available;
  $('v-listening').textContent = available ? text(...labels[active?.role ?? role]) : '—';
  if (excerpt) {
    const parts = [];
    document.querySelectorAll('[data-excerpt-part]').forEach(button => {
      const on = audibleExcerptParts.has(button.dataset.excerptPart);
      button.setAttribute('aria-pressed', String(on));
      if (on) parts.push(text(button.dataset.excerptPart, excerptNames[button.dataset.excerptPart]));
    });
    $('v-listening').textContent = parts.length === excerptParts.length ? text(...labels[0]) : parts.join(' + ') || text('Muted', '静音');
  }
  document.querySelectorAll('[data-vmode]').forEach(button => {
    const index = Number(button.dataset.vmode);
    button.disabled = !canPlay(index);
    button.setAttribute('aria-pressed', String(!button.disabled && index === role));
  });
  document.querySelectorAll('[data-natural], #v-index button').forEach(button => { button.disabled = excerpt || !available; });
}

function dispose(fadeAt) {
  const old = active;
  active = undefined;
  cancelAnimationFrame(animationFrame);
  if (!old) return;
  const cleanup = () => {
    for (const {node, trim} of old.tracks) { node.disconnect(); trim?.disconnect(); }
    old.gain.disconnect();
  };
  old.tracks[0].node.onended = fadeAt === undefined ? null : cleanup;
  if (fadeAt !== undefined) {
    old.gain.gain.cancelScheduledValues(fadeAt);
    old.gain.gain.setValueAtTime(old.gain.gain.value, fadeAt);
    old.gain.gain.linearRampToValueAtTime(0, fadeAt + .012);
  }
  for (const {node} of old.tracks) {
    try { node.stop(fadeAt === undefined ? 0 : fadeAt + .014); } catch {}
  }
  if (fadeAt === undefined) cleanup();
}

function pause() {
  position = currentTime();
  revision++;
  pending = false;
  dispose();
  paint();
  readout(true);
}

async function bufferFor(index, kind) {
  const key = kind + ':' + (kind === 'reference' ? referenceGeneration : 0) + ':' + index;
  if (decoded.has(key)) {
    const hit = decoded.get(key);
    decoded.delete(key); decoded.set(key, hit);
    return hit;
  }
  if (decoding.has(key)) return decoding.get(key);
  const generation = referenceGeneration;
  const job = (async () => {
    const bytes = await window.studyMedia.audio('full', index, {reference: kind === 'reference'});
    const buffer = await context.decodeAudioData(bytes);
    if (kind !== 'reference' || generation === referenceGeneration) {
      decoded.set(key, buffer);
      while (decoded.size > 3) decoded.delete(decoded.keys().next().value);
    }
    return buffer;
  })();
  decoding.set(key, job);
  try { return await job; } finally { decoding.delete(key); }
}

async function play(index = role, matchPhrase = false) {
  if (!canPlay(index)) return;
  const id = ++revision;
  const kind = source;
  role = index;
  pending = true;
  showStatus('v-status');
  paint();
  window.dispatchEvent(new Event('study:local-play'));
  try {
    if (!context) context = new AudioContext({sampleRate: 44100});
    await context.resume();
    if (id !== revision) return;
    const excerpt = kind === 'excerpt';
    const buffers = excerpt ? await loadExcerpt(context) : [await bufferFor(index, kind)];
    if (id !== revision) return;
    const when = context.currentTime + .02;
    let from = currentTime(when);
    if (matchPhrase && active) from = start + (from - active.start);
    if (from >= end - .002 || from < start) from = start;
    const origin = excerpt ? excerptStart : isTrial(index) ? cueStart : 0;
    const loop = $('v-loop').checked;
    const gain = context.createGain();
    gain.connect(context.destination);
    const tracks = buffers.map((buffer, i) => {
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.loop = loop;
      node.loopStart = Math.max(0, start - origin);
      node.loopEnd = Math.min(buffer.duration, end - origin);
      const part = excerpt ? excerptParts[i] : null;
      const trim = excerpt ? context.createGain() : null;
      if (trim) {
        trim.gain.value = Number(audibleExcerptParts.has(part));
        trim.connect(gain);
      }
      node.connect(trim || gain);
      return {node, trim, part};
    });
    const cross = Boolean(active);
    dispose(cross ? when : undefined);
    gain.gain.setValueAtTime(cross ? 0 : 1, when);
    if (cross) gain.gain.linearRampToValueAtTime(1, when + .012);
    const playing = { tracks, gain, from, when, start, end, loop, role: index };
    active = playing;
    position = from;
    pending = false;
    tracks[0].node.onended = () => {
      if (active !== playing) return;
      position = end;
      dispose();
      paint(); readout(true);
    };
    for (const {node} of tracks) {
      node.start(when, clamp(from - origin, 0, Math.max(0, node.buffer.duration - .001)));
      if (!loop) node.stop(when + end - from);
    }
    paint(); drawChart(); animate();
  } catch (error) {
    if (id !== revision) return;
    pause();
    showStatus('v-status', () => errorText(error, 'Press Play to reload the audio.', '点「播放」重新载入音频。'));
  }
}

function setRange(a, b, key, run = false, loop = key !== 'whole', keepActive = false) {
  dragging = false;
  previewTime = null;
  if (keepActive) { revision++; pending = false; }
  else pause();
  start = a; end = b; position = a; selection = key;
  if (isTrial(role) && key !== 'trial') role = availablePart(0);
  $('v-loop').checked = loop;
  $('v-slider').min = a; $('v-slider').max = b;
  $('v-a').value = a.toFixed(2); $('v-b').value = b.toFixed(2);
  document.querySelectorAll('[data-seg]').forEach(n => n.setAttribute('aria-pressed', String(n.dataset.seg === key)));
  document.querySelectorAll('[data-natural]').forEach(n => n.setAttribute('aria-pressed', String('natural' + n.dataset.natural === key)));
  describeRange();
  showStatus('v-status');
  paint(); drawChart(); readout(true);
  if (run) play();
}

function describeRange() {
  const section = data.sections.find((_, i) => selection === 's' + i);
  const copy = section && sectionCopy(section);
  const notes = {
    phrase: ['The vocal changes its articulation near 10.1 s. The bass moves from G1 to E♭1 near 11.65 s.', '约 10.1 秒，人声的咬字有了变化。约 11.65 秒，贝斯从 G1 降至 E♭1。'],
    turn: ['The phrase onset precedes the bass change by about 1.55 seconds.', '新乐句先响起，大约 1.55 秒后低音才转到 E♭1。'],
    return: ['The opening vocal returns about 70.37 seconds later, or 56 bars at the opening tempo.', '开头的人声在约 70.37 秒后再现，按开头的速度算，正好相隔 56 小节。'],
    trial: ['The two bass versions share the same level envelope and upper line.', '两段的上方旋律相同，贝斯的强弱变化也一致，只有低音的音高不同。'],
    natural0: ['First phrase. B♭4 over E♭1 gives a perfect fifth by pitch class.', '首次出现时，人声 B♭4 位于低音 E♭1 上方。折合到一个八度内，两音相距纯五度。'],
    natural1: ['Return. B♭4 over E2 gives a tritone.', '乐句再现时，人声仍是 B♭4，低音换成 E2。折合到一个八度内，两音构成三全音。']
  };
  $('v-section-note').textContent = copy?.observation || (notes[selection] ? text(...notes[selection]) : '');
  const special = {
    excerpt: ['Opening nine bars', '开头九小节'], trial: ['Controlled bass comparison', '低音对照'],
    natural0: ['First vocal phrase', '首次吟唱'], natural1: ['Vocal return', '人声再现'], custom: ['Custom range', '自选片段']
  };
  const preset = Array.from($('v-presets').querySelectorAll('[data-seg]')).find(button => button.dataset.seg === selection);
  const label = copy?.name || preset?.textContent.trim() || (special[selection] ? text(...special[selection]) : formatTime(start) + '–' + formatTime(end));
  window.dispatchEvent(new CustomEvent('study:range-change', { detail: { start, end, label } }));
}

function seek(time) {
  const resume = Boolean(active || pending);
  pause(); position = clamp(time, start, end - .001); readout(true);
  if (resume) play();
}

function invalidateRecordings() {
  referenceGeneration++;
  for (const key of decoded.keys()) if (key.startsWith('reference:')) decoded.delete(key);
}

async function refreshReference() {
  const request = ++libraryRevision;
  const indices = await window.studyMedia.recordedRoles();
  if (request !== libraryRevision) return;
  recordedRoles = new Set(indices);
  if (!canPlay(role)) changeSource(source);
  else paint();
}

function changeSource(kind, preferred) {
  const resume = Boolean(active || pending);
  const time = currentTime(), wasExcerpt = source === 'excerpt';
  if (kind === 'excerpt' && !wasExcerpt) {
    previousFullRange = {start, end, time, role, selection, loop: $('v-loop').checked};
  }
  source = kind;
  const excerpt = kind === 'excerpt';
  $('source-choice').value = kind === 'guide' ? 'guide' : 'reference';
  $('recording-range').value = excerpt ? 'excerpt' : 'full';
  $('stem-controls').hidden = kind === 'guide';
  $('excerpt-controls').hidden = !excerpt;
  $('import-controls').hidden = kind !== 'reference';
  for (const id of ['v-map', 'v-presets', 'v-custom', 'v-modes']) $(id).hidden = excerpt;
  if (excerpt) {
    role = 0;
    setRange(excerptStart, excerptEnd, 'excerpt', false, false);
    if (time >= start && time < end) position = time;
  } else if (wasExcerpt) {
    const saved = previousFullRange;
    role = availablePart(preferred ?? saved.role);
    const key = saved.selection === 'trial' && !isTrial(role) ? 'turn' : saved.selection;
    setRange(saved.start, saved.end, key, false, saved.loop);
    position = time >= start && time < end ? time : saved.time;
    previousFullRange = undefined;
  } else {
    role = availablePart(preferred ?? role);
  }
  if (!canPlay(role)) pause();
  if (selection === 'trial' && !isTrial(role)) {
    setRange(cueStart, cueEnd, 'turn', false, $('v-loop').checked);
    position = time;
  }
  paint(); drawChart(); readout(true);
  if (resume && canPlay(role)) play();
}

async function importStem(event) {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file || loadingReference) return;
  const index = Number($('stem-role').value);
  loadingReference = true;
  $('import-stem').disabled = true;
  $('stem-role').disabled = true;
  showStatus('ref-status', () => text('Reading audio file…', '正在读取音频…'));
  try {
    const result = await window.studyMedia.importStem(index, file);
    invalidateRecordings();
    await refreshReference();
    if (source === 'reference') changeSource('reference', index);
    showStatus('ref-status', () => {
      const [english, chinese] = labels[index];
      return result.persistent
        ? text(english + ' saved on this device.', chinese + '音轨已保存在本机。')
        : text(english + ' loaded for this tab.', chinese + '音轨已载入当前标签页。');
    });
  } catch (error) {
    showStatus('ref-status', () => errorText(error, 'Choose a local file and try again.', '请重新选择本地音频文件。'));
  } finally {
    loadingReference = false;
    $('import-stem').disabled = false;
    $('stem-role').disabled = false;
    input.value = '';
  }
}

function chooseRole(index) {
  if (isTrial(index) && selection !== 'trial') {
    setRange(cueStart, cueEnd, 'trial');
    play(index);
  } else if (active || pending || isTrial(index)) {
    play(index);
  } else {
    role = index;
    paint(); drawChart(); readout(true);
  }
}

async function init() {
  if (new URLSearchParams(location.search).get('source') === 'recorded') $('source-choice').value = 'reference';
  const response = await fetch('data/full.json');
  if (!response.ok) throw new Error('The score data could not be loaded. Reload the page to retry.');
  data = await response.json();
  // Recolor the small source image once so tightly zoomed views avoid large SVG filter surfaces.
  const image = new Image();
  image.src = data.harmonics.heat;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const raster = canvas.getContext('2d');
  raster.drawImage(image, 0, 0);
  const imageData = raster.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const intensity = clamp((245 - pixels[i]) / 135, 0, 1);
    pixels[i] = 37 + intensity * 150;
    pixels[i + 1] = 34 + intensity * 101;
    pixels[i + 2] = 56 + intensity * 153;
  }
  raster.putImageData(imageData, 0, 0);
  heatImage = canvas.toDataURL();
  presets.whole = [0, data.duration];
  const selectPreset = (button) => {
    const key = button.dataset.seg;
    setRange(...presets[key], key, Boolean(active || pending));
  };
  $('v-presets').querySelectorAll('[data-seg]').forEach(b => b.onclick = () => selectPreset(b));
  data.sections.forEach((s, i) => {
    const key = 's' + i;
    const button = document.createElement('button');
    button.dataset.seg = key;
    button.style.flex = String(Math.max(7, s.end - s.start));
    button.onclick = () => setRange(s.start, s.end, key, Boolean(active || pending));
    $('v-map').appendChild(button);
    const entry = document.createElement('article');
    entry.className = 'v-entry';
    const playButton = document.createElement('button');
    playButton.onclick = () => setRange(s.start, s.end, key, true);
    const time = document.createElement('small');
    time.textContent = formatTime(s.start) + '–' + formatTime(s.end);
    const observation = document.createElement('p');
    entry.append(playButton, time, observation); $('v-index').appendChild(entry);
    sectionViews.push({ section: s, button, playButton, observation });
  });
  translateSections();
  $('v-play').onclick = () => active || pending ? pause() : play();
  $('v-loop').onchange = () => { if (active || pending) play(); };
  const slider = $('v-slider');
  const commitSlider = () => {
    const t = Number(slider.value);
    dragging = false;
    previewTime = null;
    seek(t);
  };
  slider.onpointerdown = () => { dragging = true; previewTime = Number(slider.value); };
  slider.oninput = () => { dragging = true; previewTime = Number(slider.value); readout(true); };
  slider.onchange = commitSlider;
  slider.onpointerup = () => setTimeout(() => { if (dragging) commitSlider(); }, 0);
  slider.onpointercancel = () => { dragging = false; previewTime = null; readout(true); };
  $('v-chart').onclick = event => {
    const rect = $('v-chart').getBoundingClientRect();
    const ratio = ((event.clientX - rect.left) * 960 / rect.width - chartX) / chartWidth;
    if (ratio >= 0 && ratio <= 1) seek(start + ratio * (end - start));
  };
  $('v-apply').onclick = () => {
    const a = $('v-a').valueAsNumber, b = $('v-b').valueAsNumber;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > data.duration + .005 || b - a < .1) {
      showStatus('v-status', () => text('Choose a range of at least 0.10 s within the track.', '请在曲目范围内选择至少 0.10 秒的片段。'));
      return;
    }
    setRange(a, Math.min(b, data.duration), 'custom', Boolean(active || pending));
    $('v-custom').open = false;
  };
  document.querySelectorAll('[data-vmode]').forEach(b => b.onclick = () => chooseRole(+b.dataset.vmode));
  document.querySelectorAll('[data-natural]').forEach(b => b.onclick = () => {
    const which = +b.dataset.natural, comparing = selection.startsWith('natural');
    const offset = comparing ? currentTime() - start : 0;
    const a = 12.48 + which * 70.3665;
    const aligned = comparing && !!active;
    setRange(a, a + 1.86, 'natural' + which, false, true, aligned);
    position = a + clamp(offset, 0, 1.858);
    if (!comparing) role = canPlay(3) ? 3 : role;
    play(role, aligned);
  });
  $('source-choice').onchange = event => {
    if (!loadingReference) showStatus('ref-status');
    changeSource(event.target.value === 'reference' ? 'excerpt' : 'guide');
  };
  $('recording-range').onchange = event => {
    if (!loadingReference) showStatus('ref-status');
    changeSource(event.target.value === 'excerpt' ? 'excerpt' : 'reference');
  };
  for (const button of document.querySelectorAll('[data-excerpt-part]')) {
    button.onclick = () => {
      const part = button.dataset.excerptPart;
      const enabled = !audibleExcerptParts.has(part);
      if (enabled) audibleExcerptParts.add(part);
      else audibleExcerptParts.delete(part);
      const track = active?.tracks.find(track => track.part === part);
      if (track) track.trim.gain.setTargetAtTime(Number(enabled), context.currentTime, .006);
      paint();
    };
  }
  for (const cue of document.querySelectorAll('[data-excerpt-cue]')) {
    cue.onclick = () => seek(Number(cue.dataset.excerptCue));
  }
  $('import-stem').onclick = () => $('stem-file').click();
  $('stem-file').onchange = importStem;
  const refreshOnReturn = () => {
    if (loadingReference) return;
    invalidateRecordings();
    refreshReference().catch(reportLibraryError);
  };
  window.addEventListener('study:official-play', pause);
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', refreshOnReturn);
  window.addEventListener('focus', refreshOnReturn);
  setRange(0, data.duration, 'whole', false, false);
  if ($('source-choice').value === 'reference') changeSource('excerpt');
  await refreshReference().catch(reportLibraryError);
}

function reportLibraryError(error) {
  showStatus('ref-status', () => errorText(error, 'Reopen the page to read your saved audio.', '请重新打开页面，载入已保存的音频。'));
}

function translateSections() {
  for (const { section, button, playButton, observation } of sectionViews) {
    const copy = sectionCopy(section);
    button.textContent = copy.short;
    button.title = copy.name + ' · ' + formatTime(section.start) + '–' + formatTime(section.end);
    playButton.textContent = '▶ ' + copy.name;
    observation.textContent = copy.observation;
  }
}

window.addEventListener('study-language-change', () => {
  for (const [id, message] of statusMessages) $(id).textContent = message();
  if (!end) return;
  translateSections();
  describeRange();
  paint(); drawChart(); readout(true);
});

init().catch(error => {
  showStatus('v-status', () => errorText(error, 'The score data could not be loaded. Reload the page to retry.', '请刷新页面，重新载入乐谱数据。'));
});
