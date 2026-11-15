const $ = (id) => document.getElementById(id);
const barDuration = 4 * 60 / 191;
const duration = 498723 / 44100;
const sourceStart = 5.370;
const pitchNames = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const palette = { bass: '#8ed8d6', harmony: '#b5b5ea', drums: '#f4c087', fx: '#de9ec9' };
const chartLeft = 128;
const chartWidth = 810;

let data;
let context;
let selectedBar = 0;
let mode = 1;
let role = -1;
let cursor = 0;
let draggingSeek = false;
let playback;
let example;
let pending = false;
let examplePending = false;
let revision = 0;
let exampleRevision = 0;
const audioFiles = new Map();

function bounds() {
  return selectedBar
    ? [(selectedBar - 1) * barDuration, Math.min(selectedBar * barDuration, duration)]
    : [0, duration];
}

function pitch(note) {
  return pitchNames[note % 12] + (Math.floor(note / 12) - 1);
}

function svgElement(name, attributes, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function drawScore() {
  if (!data) return;
  const chart = $('score');
  chart.replaceChildren();
  $('score-detail').textContent = '';
  const events = [];
  let selectedMark;
  const [start, end] = bounds();
  const x = (time) => chartLeft + (time - start) * chartWidth / (end - start);
  const add = (name, attributes, text) => chart.appendChild(svgElement(name, attributes, text));
  const label = (x, y, text, className = 'axis') => add('text', { x, y, class: className }, text);

  const lanes = [
    [37, 51, 'Bass', 'Pedal tones', palette.bass],
    [95, 135, 'Instruments', 'Selected pitches', palette.harmony],
    [237, 63, 'Percussion', 'Attack candidates', palette.drums],
    [307, 43, 'Swell', 'Spectral peak', palette.fx]
  ];
  for (const [y, height, name, subtitle, fill] of lanes) {
    add('rect', { x: chartLeft, y, width: chartWidth, height, fill, 'fill-opacity': .085 });
    label(14, y + 20, name, 'lane-name');
    label(14, y + 36, subtitle);
  }

  const step = selectedBar ? barDuration / 12 : barDuration / 4;
  for (let i = Math.round(start / step); i <= Math.round(end / step); i++) {
    const time = i * step;
    const major = i % (selectedBar ? 3 : 4) === 0;
    const tickX = x(Math.min(end, time));
    add('line', { x1: tickX, x2: tickX, y1: 29, y2: 350, class: major ? 'grid' : 'grid minor' });
    if (major && time < end - .001) {
      const text = selectedBar ? 'Beat ' + ((i / 3) % 4 + 1) : 'Bar ' + (i / 4 + 1);
      label(tickX + 3, 21, text);
    }
  }

  function registerMark(mark, event, name) {
    const description = name + ' · onset ' + event.t.toFixed(3) + ' s in excerpt / ' +
      (event.t + sourceStart).toFixed(3) + ' s in source · duration ' + event.duration.toFixed(3) + ' s';
    events.push({ mark, time: event.t });
    mark.setAttribute('class', 'arr-event');
    mark.setAttribute('role', 'button');
    mark.setAttribute('tabindex', '-1');
    mark.setAttribute('aria-label', description);
    mark.appendChild(svgElement('title', {}, description));
    mark.onfocus = () => {
      if (selectedMark) {
        selectedMark.removeAttribute('aria-current');
        selectedMark.setAttribute('tabindex', '-1');
      }
      selectedMark = mark;
      mark.setAttribute('aria-current', 'true');
      mark.setAttribute('tabindex', '0');
      $('score-detail').textContent = description;
    };
    mark.onclick = (input) => {
      mark.focus({ preventScroll: true });
      // A pointer click bubbles to the chart's existing exact-position seek.
      if (input.detail === 0) {
        input.stopPropagation();
        seek(event.t);
      }
    };
    mark.onkeydown = (input) => {
      if (input.key === 'Enter' || input.key === ' ') {
        input.preventDefault();
        seek(event.t);
        return;
      }
      const i = events.findIndex(entry => entry.mark === mark);
      const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: events.length - 1 }[input.key];
      if (next === undefined) return;
      input.preventDefault();
      events[Math.max(0, Math.min(events.length - 1, next))].mark.focus();
    };
  }

  function noteBlock(event, y, height, fill, name, description) {
    if (event.t >= end || event.t + event.duration <= start) return;
    const left = x(Math.max(start, event.t));
    const width = Math.max(2, x(Math.min(end, event.t + event.duration)) - left);
    const block = add('rect', { x: left, y: y - height / 2, width, height, fill, rx: 1.5 });
    registerMark(block, event, description);
    if (width >= name.length * 7 + 8) label(left + 4, y + 3.4, name, 'note-label');
  }
  const { bass, harmony, drums, fx } = data.score;
  const pitches = harmony.map((event) => event.midi);
  const low = Math.min(...pitches);
  const range = Math.max(1, Math.max(...pitches) - low);
  for (const event of bass) {
    const name = pitch(event.midi);
    noteBlock(event, event.midi === 31 ? 52 : 73, 15, palette.bass, name, 'Bass · ' + name);
  }
  for (const event of harmony) {
    const y = 217 - (event.midi - low) * 109 / range;
    const name = pitch(event.midi);
    noteBlock(event, y, 11, palette.harmony, name, 'Instruments · ' + name);
  }
  for (const event of drums) {
    // The first bright transient precedes the bar-2 downbeat by about 4 ms.
    if (event.t < start - .009 || event.t >= end) continue;
    const y = [35, 36, 41].includes(event.midi) ? 281 : 258;
    const hit = add('circle', { cx: x(Math.max(start, event.t)), cy: y, r: 2 + event.velocity / 30, fill: palette.drums });
    registerMark(hit, event, 'Percussion · ' + event.kind);
  }
  for (const event of fx) noteBlock(event, 328, 14, palette.fx, '≈424 Hz', event.kind + ' · ≈424 Hz');
  events.sort((a, b) => a.time - b.time);
  if (events.length) {
    selectedMark = events[0].mark;
    selectedMark.setAttribute('tabindex', '0');
  }
  add('line', { id: 'playhead', class: 'head', y1: 28, y2: 350, x1: x(cursor), x2: x(cursor) });
  $('bar-title').textContent = selectedBar ? 'Bar ' + selectedBar : 'Bars 1–9';
  $('bar-note').textContent = data.notes[selectedBar];
}

function setPressed(container, attribute, value) {
  for (const button of container.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset[attribute]) === value));
  }
}

function timeNow(at = context?.currentTime) {
  if (!playback) return cursor;
  const time = playback.from + Math.max(0, at - playback.when);
  const [start, end] = bounds();
  return playback.loop ? start + (time - start) % (end - start) : Math.min(end, time);
}

function updateReadout() {
  const [start, end] = bounds();
  const time = timeNow();
  $('clock').textContent = time.toFixed(2) + ' / ' + end.toFixed(2) + ' s';
  if (!draggingSeek) $('seek').value = time;
  const head = $('playhead');
  if (head) {
    const x = chartLeft + (time - start) * chartWidth / (end - start);
    head.setAttribute('x1', x);
    head.setAttribute('x2', x);
  }
}

function updateTransport() {
  $('play').textContent = playback ? 'Ⅱ Pause' : pending ? 'Loading…' : '▶ Play';
  $('play').setAttribute('aria-label', playback ? 'Pause arrangement' : pending ? 'Cancel loading' : 'Play arrangement');
  $('common-tones').textContent = example ? '■ Stop common tones' : examplePending ? 'Loading…' : '▶ Play common tones';
  $('common-tones').setAttribute('aria-pressed', String(Boolean(example)));
}

async function audioContext() {
  if (!context) context = new AudioContext();
  await context.resume();
  return context;
}

function audioBuffer(index) {
  if (!audioFiles.has(index)) {
    const request = window.studyMedia.audio('intro', index)
      .then((bytes) => context.decodeAudioData(bytes))
      .catch((error) => { audioFiles.delete(index); throw error; });
    audioFiles.set(index, request);
  }
  return audioFiles.get(index);
}

function stopTracks(tracks, when) {
  for (const { source, gain } of tracks) {
    const disconnect = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.onended = when === undefined ? null : disconnect;
    try { source.stop(when); } catch {}
    if (when === undefined) disconnect();
  }
}

function stopPlayback() {
  cursor = timeNow();
  revision++;
  pending = false;
  if (playback) {
    stopTracks(playback.tracks);
    playback = undefined;
  }
  updateTransport();
}

function stopExample() {
  exampleRevision++;
  examplePending = false;
  if (example) {
    example.onended = null;
    try { example.stop(); } catch {}
    example.disconnect();
    example = undefined;
  }
  updateTransport();
}

function adjustGains(immediate = false) {
  if (!playback) return;
  playback.tracks.forEach(({ gain, index }) => {
    const enabled = role < 0 || index === role;
    const level = enabled ? .85 : 0;
    if (immediate) gain.gain.value = level;
    else gain.gain.setTargetAtTime(level, context.currentTime, .008);
  });
}

function animate(playing) {
  if (playing !== playback) return;
  updateReadout();
  requestAnimationFrame(() => animate(playing));
}

async function startPlayback() {
  stopExample();
  const id = ++revision;
  pending = true;
  $('error').textContent = '';
  updateTransport();
  try {
    await audioContext();
    if (id !== revision) return;
    const indices = mode === 0 ? [0, 1, 2] : [3, 4, 5];
    const buffers = await Promise.all(indices.map(audioBuffer));
    if (id !== revision) return;
    const [start, end] = bounds();
    const loop = $('loop').checked;
    const when = context.currentTime + .025;
    cursor = timeNow(when);
    if (cursor < start || cursor >= end - .001) cursor = start;
    const tracks = buffers.map((buffer, index) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      source.loop = loop;
      source.loopStart = start;
      source.loopEnd = end;
      source.connect(gain);
      gain.connect(context.destination);
      return { source, gain, index };
    });
    if (playback) stopTracks(playback.tracks, when);
    const playing = { tracks, when, from: cursor, loop };
    playback = playing;
    pending = false;
    adjustGains(true);
    if (!loop) tracks[0].source.onended = () => {
      if (playback !== playing) return;
      stopPlayback();
      cursor = end;
      updateReadout();
    };
    for (const { source } of tracks) {
      source.start(when, cursor);
      if (!loop) source.stop(when + end - cursor);
    }
    updateTransport();
    animate(playing);
  } catch {
    if (id !== revision) return;
    stopPlayback();
    $('error').textContent = 'Audio could not be loaded. Check the connection and press Play to retry.';
  }
}

async function playExample() {
  if (example || examplePending) { stopExample(); return; }
  stopPlayback();
  const id = ++exampleRevision;
  $('error').textContent = '';
  examplePending = true;
  updateTransport();
  try {
    await audioContext();
    const buffer = await audioBuffer(6);
    if (id !== exampleRevision) return;
    example = context.createBufferSource();
    example.buffer = buffer;
    example.connect(context.destination);
    example.onended = stopExample;
    examplePending = false;
    example.start();
    updateTransport();
  } catch {
    if (id !== exampleRevision) return;
    stopExample();
    $('error').textContent = 'The common-tone example could not be loaded. Press Play common tones to retry.';
  }
}

function seek(time) {
  const resume = Boolean(playback || pending);
  stopPlayback();
  stopExample();
  const [start, end] = bounds();
  cursor = Math.max(start, Math.min(end - .001, time));
  updateReadout();
  if (resume) startPlayback();
}

function selectBar(number) {
  const resume = Boolean(playback || pending);
  stopPlayback();
  stopExample();
  selectedBar = number;
  const [start, end] = bounds();
  cursor = start;
  $('seek').min = start;
  $('seek').max = end;
  $('loop').checked = selectedBar !== 0;
  setPressed($('bars'), 'bar', number);
  drawScore();
  updateReadout();
  if (resume) startPlayback();
}

for (let bar = 1; bar <= 9; bar++) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.bar = bar;
  button.textContent = bar;
  button.setAttribute('aria-label', 'Bar ' + bar);
  $('bars').appendChild(button);
}
for (const button of $('bars').querySelectorAll('button')) {
  button.onclick = () => selectBar(Number(button.dataset.bar));
}
for (const button of $('modes').querySelectorAll('button')) {
  button.onclick = () => {
    const next = Number(button.dataset.mode);
    if (next === mode) return;
    mode = next;
    setPressed($('modes'), 'mode', mode);
    if (playback || pending) startPlayback();
  };
}
for (const button of $('roles').querySelectorAll('button')) {
  button.onclick = () => {
    role = Number(button.dataset.role);
    setPressed($('roles'), 'role', role);
    adjustGains();
  };
}
$('play').onclick = () => playback || pending ? stopPlayback() : startPlayback();
$('common-tones').onclick = playExample;
$('loop').onchange = () => {
  if (playback || pending) { stopPlayback(); startPlayback(); }
};
$('seek').onpointerdown = () => { draggingSeek = true; };
window.addEventListener('pointerup', () => { draggingSeek = false; });
window.addEventListener('pointercancel', () => { draggingSeek = false; });
$('seek').onchange = (event) => {
  draggingSeek = false;
  seek(Number(event.target.value));
};
$('score').onclick = (event) => {
  const rect = $('score').getBoundingClientRect();
  const fraction = ((event.clientX - rect.left) * 960 / rect.width - chartLeft) / chartWidth;
  if (fraction >= 0 && fraction <= 1) {
    const [start, end] = bounds();
    seek(start + fraction * (end - start));
  }
};
window.addEventListener('pagehide', () => { stopPlayback(); stopExample(); });

try {
  const response = await fetch('data/intro.json');
  if (!response.ok) throw new Error();
  data = await response.json();
  $('method').textContent = data.method;
  selectBar(0);
} catch {
  $('error').textContent = 'The score data could not be loaded. Reload the page to retry.';
}
