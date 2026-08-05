/* ============================================================
   AudioFileWriter.js — Stream-based raw PCM audio writer
   One persistent WriteStream per client, auto-created on demand
   ============================================================ */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR   = path.join(__dirname, 'raw_audio');

/* Active write streams: clientId → fs.WriteStream */
const streams = new Map();

/* Get or create a write stream for a client */
function getStream(clientId) {
  if (streams.has(clientId)) return streams.get(clientId);

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const filePath = path.join(RAW_DIR, `${clientId}.raw`);
  const ws = fs.createWriteStream(filePath, { flags: 'a' });

  ws.on('error', (err) => console.error(`[Audio] Write error (${clientId}):`, err.message));

  streams.set(clientId, ws);
  return ws;
}

/* Write a PCM buffer chunk for a client */
export function saveAudioChunk(clientId, pcmBuffer) {
  getStream(clientId).write(pcmBuffer);
}

/* Call on session end to flush + close the stream */
export function closeAudioStream(clientId) {
  const ws = streams.get(clientId);
  if (!ws) return;
  ws.end();
  streams.delete(clientId);
}