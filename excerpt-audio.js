const sourceFrames = 498723;
const sourceRate = 44100;

export const excerptStart = 5.370;
export const excerptEnd = excerptStart + sourceFrames / sourceRate;
export const excerptParts = Object.freeze(['vocal', 'bass', 'drums', 'instruments']);

const buffersByContext = new WeakMap();

async function readPart(context, part) {
  const url = new URL('./media/excerpt/' + part + '.flac', import.meta.url);
  const response = await fetch(url, {mode: 'same-origin'});
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  const expectedFrames = sourceFrames * buffer.sampleRate / sourceRate;
  if (buffer.numberOfChannels !== 2 || Math.abs(buffer.length - expectedFrames) > 1) {
    throw new Error('Unexpected excerpt format.');
  }
  return buffer;
}

export async function loadExcerpt(context) {
  let parts = buffersByContext.get(context);
  if (!parts) {
    parts = new Map();
    buffersByContext.set(context, parts);
  }
  const buffers = await Promise.all(excerptParts.map(part => {
    if (!parts.has(part)) {
      const loading = readPart(context, part).catch(cause => {
        parts.delete(part);
        throw new Error('Press Play to reload the ' + part + ' excerpt.', {cause});
      });
      parts.set(part, loading);
    }
    return parts.get(part);
  }));
  if (buffers.some(buffer => buffer.length !== buffers[0].length || buffer.sampleRate !== buffers[0].sampleRate)) {
    buffersByContext.delete(context);
    throw new Error('Press Play to reload the four synchronized stems.');
  }
  return buffers;
}
