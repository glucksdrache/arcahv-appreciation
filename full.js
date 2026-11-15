const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const names = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const labels = ['Mix', 'Vocal', 'Accompaniment', 'Vocal + bass', 'G1 → E♭1', 'Hold G1', 'Bass', 'Drums', 'Instruments'];
const isTrial = (i) => i === 4 || i === 5;
const chartX = 106, chartWidth = 826;
const cueStart = 9.65, cueEnd = 14.75;
const presets = { opening: [0, 27.4], phrase: [6.3, 14.85], turn: [9.65, 14.75], return: [76.65, 85.23] };

let data, start = 0, end = 0, position = 0, role = 0, selection = 'whole';
let context, active, pending = false, revision = 0, source = 'guide', referenceGeneration = 0;
let animationFrame, graphCursor, lastFrame = -1, loadingReference = false;
let dragging = false, previewTime = null, heatImage;
const decoded = new Map(), decoding = new Map();

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
  const text = (px, py, content, cls = 'v-axis', attr = {}) => add('text', { x: px, y: py, class: cls, ...attr }, content);
  const line = (x1, y1, x2, y2, color, dashed = false) => add('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': .8, 'stroke-dasharray': dashed ? '3 3' : 'none' });
  const lanes = [
    [53, 109, '#302637', 'Vocal pitch', 'Main contour'],
    [169, 48, '#302c32', 'Vocal RMS', 'dBFS'],
    [224, 42, '#203136', 'Bass', isTrial(role) ? 'Test pitch' : 'Pitch estimate'],
    [274, 86, '#2b283d', 'Instruments', 'Pitch class'],
    [369, 34, '#302a32', 'Percussion', 'RMS · dBFS']
  ];
  for (const [y, h, fill, title, desc] of lanes) {
    add('rect', { x: chartX, y, width: chartWidth, height: h, fill });
    text(11, y + 16, title, 'v-head');
    text(11, y + 30, desc);
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
    if (px < chartX + chartWidth - 22) text(px + 2, 44, span > 60 ? formatTime(t, false) : Number(t.toFixed(1)) + ' s');
  }
  const voiceY = m => 158 - (clamp(m, 47, 85) - 47) * 96 / 38;
  const dbY = d => 213 - clamp((d + 60) / 53, 0, 1) * 40;
  const bassY = m => 263 - clamp((m - 23) / 28, 0, 1) * 33;
  const drumY = d => 400 - clamp((d + 60) / 54, 0, 1) * 27;
  for (const m of [60, 67, 72, 79]) {
    line(chartX, voiceY(m), chartX + chartWidth, voiceY(m), '#4b4053');
    text(chartX - 4, voiceY(m) + 3, pitch(m), 'v-axis', { 'text-anchor': 'end' });
  }
  for (const d of [-45, -20]) text(chartX - 4, dbY(d) + 3, d, 'v-axis', { 'text-anchor': 'end' });
  for (const n of [0, 4, 7, 11]) text(chartX - 4, 277 + (11.5 - n) * 86 / 12, names[n], 'v-axis', { 'text-anchor': 'end' });

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
    if (right - left > 28) text(left + 3, bassY(m) - 3, pitch(m), 'v-label');
  }
  plot(h.drumDb, h.dt, drumY, '#d9a58e', 1.4);
  if (span < 36) {
    const markers = [[10.1, 'Phrase onset ≈10.1 s', 13], [11.653, 'Bass change 11.65 s', 29], [80.47, 'Phrase return', 13], [82.02, 'Bass change', 29]];
    for (const [t, caption, y] of markers) {
      if (t <= start || t >= end) continue;
      const px = x(t), nearEnd = px > chartX + chartWidth - 118;
      line(px, y + 4, px, 266, '#998769', true);
      text(px + (nearEnd ? -3 : 3), y, caption, 'v-label', { 'text-anchor': nearEnd ? 'end' : 'start' });
    }
  } else {
    data.sections.forEach((s, i) => {
      if (s.start <= start || s.start >= end) return;
      line(x(s.start), 20, x(s.start), 266, '#756f89', true);
      text(x(s.start) + 2, 17, i + 1);
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

function paint() {
  $('v-play').textContent = active ? 'Ⅱ Pause' : pending ? 'Loading…' : '▶ Play';
  $('v-play').setAttribute('aria-label', active ? 'Pause' : pending ? 'Cancel loading' : 'Play');
  $('v-listening').textContent = labels[active?.role ?? role];
  document.querySelectorAll('[data-vmode]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.vmode === role)));
}

function dispose(fadeAt) {
  const old = active;
  active = undefined;
  cancelAnimationFrame(animationFrame);
  if (!old) return;
  const cleanup = () => { old.node.disconnect(); old.gain.disconnect(); };
  old.node.onended = fadeAt === undefined ? null : cleanup;
  if (fadeAt !== undefined) {
    old.gain.gain.cancelScheduledValues(fadeAt);
    old.gain.gain.setValueAtTime(old.gain.gain.value, fadeAt);
    old.gain.gain.linearRampToValueAtTime(0, fadeAt + .012);
  }
  try { old.node.stop(fadeAt === undefined ? 0 : fadeAt + .014); } catch {}
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
  const id = ++revision;
  const kind = source;
  role = index;
  pending = true;
  $('v-status').textContent = '';
  paint();
  window.dispatchEvent(new Event('study:local-play'));
  try {
    if (!context) context = new AudioContext({sampleRate: 44100});
    await context.resume();
    if (id !== revision) return;
    const buffer = await bufferFor(index, kind);
    if (id !== revision) return;
    const when = context.currentTime + .02;
    let from = currentTime(when);
    if (matchPhrase && active) from = start + (from - active.start);
    if (from >= end - .002 || from < start) from = start;
    const origin = isTrial(index) ? cueStart : 0;
    const node = context.createBufferSource(), gain = context.createGain();
    node.buffer = buffer;
    node.loop = $('v-loop').checked;
    node.loopStart = Math.max(0, start - origin);
    node.loopEnd = Math.min(buffer.duration, end - origin);
    node.connect(gain); gain.connect(context.destination);
    const cross = Boolean(active);
    dispose(cross ? when : undefined);
    gain.gain.setValueAtTime(cross ? 0 : 1, when);
    if (cross) gain.gain.linearRampToValueAtTime(1, when + .012);
    active = { node, gain, from, when, start, end, loop: node.loop, role: index };
    position = from;
    pending = false;
    node.onended = () => {
      if (active?.node !== node) return;
      position = end;
      dispose();
      paint(); readout(true);
    };
    node.start(when, clamp(from - origin, 0, Math.max(0, buffer.duration - .001)));
    if (!node.loop) node.stop(when + end - from);
    paint(); drawChart(); animate();
  } catch (error) {
    if (id !== revision) return;
    pause();
    $('v-status').textContent = error?.message || 'Audio could not be loaded. Press Play to retry.';
  }
}

function setRange(a, b, key, run = false, loop = key !== 'whole', keepActive = false) {
  dragging = false;
  previewTime = null;
  if (keepActive) { revision++; pending = false; }
  else pause();
  start = a; end = b; position = a; selection = key;
  if (isTrial(role) && key !== 'trial') role = 0;
  $('v-loop').checked = loop;
  $('v-slider').min = a; $('v-slider').max = b;
  $('v-a').value = a.toFixed(2); $('v-b').value = b.toFixed(2);
  document.querySelectorAll('[data-seg]').forEach(n => n.setAttribute('aria-pressed', String(n.dataset.seg === key)));
  document.querySelectorAll('[data-natural]').forEach(n => n.setAttribute('aria-pressed', String('natural' + n.dataset.natural === key)));
  const s = data.sections.find((_, i) => key === 's' + i);
  const notes = {
    phrase: 'The vocal changes its articulation near 10.1 s. The bass moves from G1 to E♭1 near 11.65 s.',
    turn: 'The phrase onset precedes the bass change by about 1.55 seconds.',
    return: 'The opening vocal returns about 70.37 seconds later, or 56 bars at the opening tempo.',
    trial: 'The two bass versions share the same level envelope and upper line.',
    natural0: 'First phrase. B♭4 over E♭1 gives a perfect fifth by pitch class.',
    natural1: 'Return. B♭4 over E2 gives a tritone.'
  };
  $('v-section-note').textContent = s ? s.observation : notes[key] || '';
  const special = { trial: 'Controlled bass comparison', natural0: 'First vocal phrase', natural1: 'Vocal return', custom: 'Custom range' };
  const preset = Array.from($('v-presets').querySelectorAll('[data-seg]')).find(button => button.dataset.seg === key);
  const label = s?.name || preset?.textContent.trim() || special[key] || formatTime(a) + '–' + formatTime(b);
  window.dispatchEvent(new CustomEvent('study:range-change', { detail: { start: a, end: b, label } }));
  $('v-status').textContent = '';
  paint(); drawChart(); readout(true);
  if (run) play();
}

function seek(time) {
  const resume = Boolean(active || pending);
  pause(); position = clamp(time, start, end - .001); readout(true);
  if (resume) play();
}

async function refreshReference() {
  const option = $('source-choice').querySelector('[value=reference]');
  let available = false;
  try { available = await window.studyMedia.hasReference(); } catch {}
  option.disabled = !available;
  if (!available && source === 'reference') changeSource('guide');
  if (!loadingReference) $('ref-status').textContent = available ? 'Reference available on this device.' : '';
}

function changeSource(kind) {
  source = kind;
  $('source-choice').value = kind;
  if (active || pending) play();
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
    button.textContent = s.short;
    button.title = s.name + ' · ' + formatTime(s.start) + '–' + formatTime(s.end);
    button.style.flex = String(Math.max(7, s.end - s.start));
    button.onclick = () => setRange(s.start, s.end, key, Boolean(active || pending));
    $('v-map').appendChild(button);
    const entry = document.createElement('article');
    entry.className = 'v-entry';
    const playButton = document.createElement('button');
    playButton.textContent = '▶ ' + s.name;
    playButton.onclick = () => setRange(s.start, s.end, key, true);
    const time = document.createElement('small');
    time.textContent = formatTime(s.start) + '–' + formatTime(s.end);
    const text = document.createElement('p');
    text.textContent = s.observation;
    entry.append(playButton, time, text); $('v-index').appendChild(entry);
  });
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
      $('v-status').textContent = 'Choose a range of at least 0.10 s within the track.';
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
    if (!comparing) role = 3;
    play(role, aligned);
  });
  $('source-choice').onchange = event => changeSource(event.target.value);
  $('import-ref').onclick = () => $('ref-file').click();
  $('ref-file').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    loadingReference = true;
    $('import-ref').disabled = true;
    $('ref-status').textContent = 'Reading local reference…';
    try {
      const result = await window.studyMedia.importPage(file);
      referenceGeneration++;
      for (const key of decoded.keys()) if (key.startsWith('reference:')) decoded.delete(key);
      await refreshReference();
      changeSource('reference');
      $('ref-status').textContent = result.persistent ? 'Reference saved on this device.' : 'Reference available in this tab.';
    } catch (error) {
      $('ref-status').textContent = error.message || 'Reference could not be read.';
    } finally {
      loadingReference = false;
      $('import-ref').disabled = false;
      event.target.value = '';
    }
  };
  window.addEventListener('study:official-play', pause);
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', refreshReference);
  window.addEventListener('focus', refreshReference);
  await refreshReference();
  setRange(0, data.duration, 'whole', false, false);
}

init().catch(error => { $('v-status').textContent = error.message; });
