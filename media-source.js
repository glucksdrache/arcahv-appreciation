(() => {
  'use strict';

  const base = new URL('.', document.currentScript.src);
  const publicFull = [
    'full-mix.ogg', 'voice.ogg', 'backing.ogg', 'voice-bass.ogg', 'trial-change.flac',
    'trial-hold.flac', 'bass.ogg', 'drums.ogg', 'instruments.ogg'
  ];
  const publicIntro = [
    'excerpt/drums.flac', 'excerpt/bass.flac', 'excerpt/instruments.flac',
    'intro/3.flac', 'intro/4.flac', 'intro/5.flac', 'intro/6.flac'
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

  async function write(key, value) {
    const db = await openDatabase();
    if (db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted.'));
          const store = tx.objectStore(storeName);
          if (value === null) store.delete(key);
          else store.put(value, key);
        });
        memory.delete(key);
        return {persistent: true};
      } catch (error) {
        // A failed transaction leaves the previous persistent import intact.
        const transient = ['QuotaExceededError', 'SecurityError', 'UnknownError'];
        if (!transient.includes(error.name) || value === null) throw error;
      }
    }
    memory.set(key, value);
    return {persistent: false};
  }

  function ascii(bytes, at, word) {
    if (at < 0 || at + word.length > bytes.length) return false;
    for (let i = 0; i < word.length; i++) if (bytes[at + i] !== word.charCodeAt(i)) return false;
    return true;
  }

  async function importStem(index, file) {
    if (!stemIndices.includes(index)) throw new Error('Choose a full-length listening part.');
    if (!(file instanceof Blob) || !file.size || file.size > 128 * 1024 * 1024) {
      throw new Error('Choose an audio file up to 128 MiB.');
    }
    const bytes = await file.arrayBuffer();
    // Keep an independent copy before the decoder takes ownership of the buffer.
    const blob = new Blob([bytes], {type: file.type});
    let seconds;
    try {
      const decoder = new OfflineAudioContext(1, 1, 44100);
      seconds = (await decoder.decodeAudioData(bytes)).duration;
    } catch {
      throw new Error('Choose a playable audio file, such as WAV or FLAC.');
    }
    // Allow a few extra codec frames at the ends of compressed files.
    if (Math.abs(seconds - duration) > 0.1) {
      throw new Error('This file is ' + seconds.toFixed(2) + ' s long. Choose a 172.99 s stem aligned to the start of Arcahv.');
    }
    return write('full/' + index, blob);
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
    return Array.from(publicFull.keys()).filter(i => keys.has('full/' + i));
  }

  async function audio(scope, index, options = {}) {
    if (!Number.isInteger(index) || index < 0 ||
        !(scope === 'full' && index < publicFull.length || scope === 'intro' && index < publicIntro.length)) {
      throw new Error('Unknown listening track.');
    }
    if (scope === 'full' && options.reference === true) {
      const blob = await read('full/' + index);
      if (!(blob instanceof Blob)) throw new Error('Load a local recording for this part.');
      return blob.arrayBuffer();
    }
    const asset = scope === 'full' ? 'media/guides/' + publicFull[index] : 'media/' + publicIntro[index];
    const url = new URL(asset, base);
    if (scope === 'full') url.searchParams.set('v', 'harmonic-resynthesis');
    const res = await fetch(url, {mode: 'same-origin', credentials: 'same-origin'});
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
    if (file === null) return write('scene', null);
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
    return write('scene', blob);
  }

  window.studyMedia = Object.freeze({
    audio,
    importStem,
    recordedRoles,
    setScene,
    getScene: async () => (await read('scene')) || null
  });
})();
