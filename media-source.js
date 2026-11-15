(() => {
  'use strict';

  const base = new URL('.', document.currentScript.src);
  const publicFull = [
    'full-mix.ogg', 'voice.ogg', 'backing.ogg', 'voice-bass.ogg', 'trial-change.flac',
    'trial-hold.flac', 'bass.ogg', 'drums.ogg', 'instruments.ogg'
  ];
  const originalNames = [
    'original', 'vocal', 'accompaniment', 'vocal_bass', 'trial_change',
    'trial_hold', 'bass', 'drums', 'instrument'
  ];
  const duration = 7628800 / 44100;
  const stemIndices = [0, 1, 2, 3, 6, 7, 8];
  const storeName = 'assets';
  const memory = new Map();
  let connection;

  function openDatabase() {
    if (connection) return connection;
    connection = new Promise(resolve => {
      let request;
      try {
        request = indexedDB.open('arcahv-listening-study-media', 1);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onerror = () => resolve(null);
      // A blocked upgrade can finish later, after this page falls back to memory.
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        resolve(null);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
    });
    return connection;
  }

  async function read(key) {
    if (memory.has(key)) return memory.get(key);
    const db = await openDatabase();
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function write(entries) {
    const db = await openDatabase();
    if (db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted.'));
          const store = tx.objectStore(storeName);
          try {
            for (const [key, value] of entries) {
              if (value === null) store.delete(key);
              else store.put(value, key);
            }
          } catch (error) {
            tx.abort();
            reject(error);
          }
        });
        for (const [key] of entries) memory.delete(key);
        return {persistent: true};
      } catch (error) {
        // A failed transaction leaves the previous persistent import intact.
        const transient = ['QuotaExceededError', 'SecurityError', 'UnknownError'];
        if (!transient.includes(error.name) || entries.some(([, value]) => value === null)) throw error;
      }
    }
    for (const [key, value] of entries) memory.set(key, value);
    return {persistent: false};
  }

  function jsonBlock(html, id) {
    // Read text between this known pair of tags. Never create a DOM from the imported page.
    const tags = /<script\b([^>]{0,1024})>/gi;
    const idAttr = new RegExp('(?:^|\\s)id\\s*=\\s*(["\x27])' + id + '\\1(?:\\s|$)', 'i');
    const typeAttr = /(?:^|\s)type\s*=\s*(["'])application\/json\1(?:\s|$)/i;
    for (let tag; (tag = tags.exec(html));) {
      if (!idAttr.test(tag[1]) || !typeAttr.test(tag[1])) continue;
      const stop = html.indexOf('</script>', tags.lastIndex);
      if (stop < 0) break;
      try { return JSON.parse(html.slice(tags.lastIndex, stop)); }
      catch { throw new Error('The local study contains an unreadable data block.'); }
    }
    throw new Error('Choose the original self-contained Arcahv listening study HTML.');
  }

  function decodeBase64(value) {
    if (typeof value !== 'string' || !value.length || value.length > 18 * 1024 * 1024) {
      throw new Error('An embedded audio track is missing or too large.');
    }
    try {
      if (Uint8Array.fromBase64) return Uint8Array.fromBase64(value);
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch { throw new Error('An embedded audio track has invalid base64 data.'); }
  }

  function ascii(bytes, at, word) {
    if (at < 0 || at + word.length > bytes.length) return false;
    for (let i = 0; i < word.length; i++) if (bytes[at + i] !== word.charCodeAt(i)) return false;
    return true;
  }

  function validateFlac(bytes, expectedSeconds) {
    if (bytes.length < 44 || !ascii(bytes, 0, 'fLaC') || (bytes[4] & 127) !== 0 ||
        bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 34) return false;
    const rate = bytes[18] * 4096 + bytes[19] * 16 + (bytes[20] >> 4);
    const channels = ((bytes[20] >> 1) & 7) + 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames = (bytes[21] & 15) * 4294967296 + view.getUint32(22);
    let offset = 4;
    while (offset + 4 <= bytes.length) {
      const final = !!(bytes[offset] & 128);
      const length = bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
      offset += 4 + length;
      if (final) break;
    }
    return rate === 44100 && channels === 2 && Math.abs(frames / rate - expectedSeconds) < .002 &&
      offset + 2 < bytes.length && bytes[offset] === 255 && (bytes[offset + 1] & 254) === 248;
  }

  function validateOpus(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0, preSkip = -1, serial, sequence = 0;
    while (offset + 27 < bytes.length && ascii(bytes, offset, 'OggS') && bytes[offset + 4] === 0) {
      const flags = bytes[offset + 5], count = bytes[offset + 26], data = offset + 27 + count;
      if (data > bytes.length) return false;
      let next = data;
      for (let j = offset + 27; j < data; j++) next += bytes[j];
      if (next <= offset || next > bytes.length) return false;
      if (sequence === 0) {
        if (!(flags & 2) || next - data < 19 || !ascii(bytes, data, 'OpusHead') ||
            bytes[data + 8] !== 1 || bytes[data + 9] !== 2) return false;
        preSkip = v.getUint16(data + 10, true);
        serial = v.getUint32(offset + 14, true);
      }
      if (v.getUint32(offset + 14, true) !== serial || v.getUint32(offset + 18, true) !== sequence++) return false;
      if (flags & 4) {
        const frames = v.getUint32(offset + 6, true) + 4294967296 * v.getUint32(offset + 10, true);
        return next === bytes.length && Math.abs((frames - preSkip) / 48000 - duration) < .005;
      }
      offset = next;
    }
    return false;
  }

  function audioBlob(data, isFlac, seconds) {
    const bytes = decodeBase64(data);
    if (!(isFlac ? validateFlac(bytes, seconds) : validateOpus(bytes))) {
      throw new Error('The embedded recording has an unexpected audio format or duration.');
    }
    return new Blob([bytes], {type: isFlac ? 'audio/flac' : 'audio/ogg'});
  }

  async function importPage(file) {
    if (!(file instanceof Blob) || !file.size || file.size > 128 * 1024 * 1024) {
      throw new Error('Choose a local study HTML smaller than 128 MiB.');
    }
    const html = await file.text();
    const full = jsonBlock(html, 'v-payload'), intro = jsonBlock(html, 'payload');
    if (!Array.isArray(full.audio) || full.audio.length !== 9 || !Number.isFinite(full.duration) ||
        Math.abs(full.duration - duration) > .01 || !Array.isArray(intro.sounds) || intro.sounds.length !== 7) {
      throw new Error('The file does not contain the full Arcahv reference and nine-bar study.');
    }
    const entries = [];
    for (let i = 0; i < full.audio.length; i++) {
      const item = full.audio[i], trial = i === 4 || i === 5;
      if (!item || item.name !== originalNames[i] || item.origin !== (trial ? 9.65 : 0)) {
        throw new Error('The embedded reference tracks are missing their expected labels or timing.');
      }
      entries.push(['full/' + i, audioBlob(item.data, trial, trial ? 5.1 : duration)]);
    }
    for (let i = 0; i < intro.sounds.length; i++) {
      const blob = audioBlob(intro.sounds[i], true, i === 6 ? 4.8 : 498723 / 44100);
      if (i < 3) entries.push(['intro/' + i, blob]);
    }
    entries.push(['reference', 1]);
    return write(entries);
  }

  async function importStem(index, file) {
    if (!stemIndices.includes(index)) throw new Error('Choose a full-length listening part.');
    if (!(file instanceof Blob) || !file.size || file.size > 128 * 1024 * 1024) {
      throw new Error('Choose a nonempty audio file up to 128 MiB.');
    }
    const bytes = await file.arrayBuffer();
    // Keep an independent copy before the decoder takes ownership of the buffer.
    const blob = new Blob([bytes], {type: file.type});
    let seconds;
    try {
      const decoder = new OfflineAudioContext(1, 1, 44100);
      seconds = (await decoder.decodeAudioData(bytes)).duration;
    } catch {
      throw new Error('This browser could not decode the selected audio file.');
    }
    // Allow a few extra codec frames at the ends of compressed files.
    if (Math.abs(seconds - duration) > 0.1) {
      throw new Error('This file is ' + seconds.toFixed(2) + ' s long. Choose a 172.99 s stem aligned to the start of Arcahv.');
    }
    return write([['full/' + index, blob]]);
  }

  async function recordedRoles() {
    const db = await openDatabase();
    const keys = new Set(db ? await new Promise((resolve, reject) => {
      const store = db.transaction(storeName).objectStore(storeName);
      const request = store.getAllKeys(IDBKeyRange.bound('full/', 'full/\uffff'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }) : []);
    for (const [key, value] of memory) {
      if (value === null) keys.delete(key);
      else keys.add(key);
    }
    return originalNames.map((_, i) => i).filter(i => keys.has('full/' + i));
  }

  async function removeReference() {
    const keys = ['reference', ...originalNames.map((_, i) => 'full/' + i), 'intro/0', 'intro/1', 'intro/2'];
    return write(keys.map(key => [key, null]));
  }

  async function audio(scope, index, options = {}) {
    if (!Number.isInteger(index) || index < 0 ||
        !(scope === 'full' && index < 9 || scope === 'intro' && index < 7)) {
      throw new Error('Unknown listening track.');
    }
    if (scope === 'full' ? options.reference === true : index < 3) {
      const blob = await read(scope + '/' + index);
      if (!(blob instanceof Blob)) throw new Error(scope === 'full'
        ? 'Load a local recording for this part.'
        : 'Import your local study HTML to hear this reference track.');
      return blob.arrayBuffer();
    }
    const asset = scope === 'full' ? 'media/guides/' + publicFull[index] : 'media/intro/' + index + '.flac';
    const res = await fetch(new URL(asset, base), {mode: 'same-origin', credentials: 'same-origin'});
    if (!res.ok) throw new Error('The listening track could not be loaded (' + res.status + ').');
    return res.arrayBuffer();
  }

  function imageDimensions(a) {
    const v = new DataView(a.buffer, a.byteOffset, a.byteLength);
    if (a.length >= 24 && a[0] === 137 && ascii(a, 1, 'PNG\r\n\x1a\n') && ascii(a, 12, 'IHDR')) {
      return ['image/png', v.getUint32(16), v.getUint32(20)];
    }
    if (a.length >= 30 && ascii(a, 0, 'RIFF') && ascii(a, 8, 'WEBP')) {
      if (ascii(a, 12, 'VP8X')) return ['image/webp', 1 + a[24] + 256*a[25] + 65536*a[26], 1 + a[27] + 256*a[28] + 65536*a[29]];
      if (ascii(a, 12, 'VP8L') && a[20] === 0x2f) {
        return ['image/webp', 1 + a[21] + ((a[22] & 63) << 8), 1 + (a[22] >> 6) + (a[23] << 2) + ((a[24] & 15) << 10)];
      }
      if (ascii(a, 12, 'VP8 ') && a[23] === 157 && a[24] === 1 && a[25] === 42) {
        return ['image/webp', v.getUint16(26, true) & 16383, v.getUint16(28, true) & 16383];
      }
    }
    if (a.length >= 4 && a[0] === 255 && a[1] === 216) {
      let pos = 2;
      while (pos + 9 <= a.length && a[pos] === 255) {
        while (a[pos] === 255) pos++;
        const marker = a[pos++];
        if (marker === 0xda || marker === 0xd9 || pos + 7 > a.length) break;
        const size = v.getUint16(pos);
        if (size < 2 || pos + size > a.length) break;
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          return ['image/jpeg', v.getUint16(pos + 5), v.getUint16(pos + 3)];
        }
        pos += size;
      }
    }
    throw new Error('Choose a PNG, JPEG or WebP image.');
  }

  async function setScene(file) {
    if (file === null) return write([['scene', null]]);
    if (!(file instanceof Blob) || !file.size || file.size > 16 * 1024 * 1024) throw new Error('Choose an image smaller than 16 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const [type, width, height] = imageDimensions(bytes);
    if (!width || !height || Math.max(width,height) > 8192 || width * height > 32000000) {
      throw new Error('Choose an image within 8192 pixels per side and 32 megapixels.');
    }
    const blob = new Blob([bytes], {type});
    if (typeof createImageBitmap === 'function') {
      let bitmap;
      try { bitmap = await createImageBitmap(blob); }
      catch { throw new Error('This image could not be decoded.'); }
      bitmap.close();
    } else {
      const url = URL.createObjectURL(blob), img = new Image();
      try { img.src = url; await img.decode(); }
      catch { throw new Error('This image could not be decoded.'); }
      finally { URL.revokeObjectURL(url); }
    }
    return write([['scene', blob]]);
  }

  window.studyMedia = Object.freeze({
    audio,
    importPage,
    importStem,
    recordedRoles,
    removeReference,
    hasReference: async () => (await read('reference')) === 1,
    setScene,
    getScene: async () => (await read('scene')) || null
  });
})();
