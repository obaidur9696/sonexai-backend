import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import wrtc from 'wrtc';
import { User } from '../../models/user.models.js';
import logger from '../../utils/Logger.js';
import { saveAudioChunk, closeAudioStream } from '../../helper/Audiofilewriter.js';


const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc;
const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

class WebRTCProvider {
  constructor({ botWsUrl } = {}) {
    if (!botWsUrl) throw new Error('botWsUrl required');

    this.botWsUrl = typeof botWsUrl === 'function' ? botWsUrl() : botWsUrl;
    this.wss = new WebSocketServer({ noServer: true });
    this.sessions = new Map();
    this.logger = logger

    this._bindWSS();
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  _bindWSS() {
    this.wss.on('connection', (ws, req) => {
      const cookieHeader = req.headers.cookie || '';
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map(cookie => {
          const [name, ...rest] = cookie.trim().split('=');
          return [name, rest.join('=')];
        })
      );
      const deviceFingerprint = cookies.deviceFingerprint || null;
      // ✅ Store in session
      const session = this._createSession(ws);
      session.deviceFingerprint = deviceFingerprint; // Add to session
      this.sessions.set(ws, session);
      ws.on('message', async (raw) => {
        const session = this.sessions.get(ws);
        if (!session) return;

        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        switch (msg.type) {
          case 'join':
            this._handleJoin(session, msg);
            break;
          case 'signal':
            await this._handleSignal(session, msg);
            break;
          case 'leave':
            this._handleLeave(session);
            break;
          case 'sync_timer':
            this._handleSyncTimer(session);
            break;
          case 'session_timer_termination':
            this._handleSessionTimerTermination(session, msg);
            break;




        }
      });

      ws.on('close', () => {
        const session = this.sessions.get(ws);
        this.logger?.info('websocket closed from client side', { roomId: session?.roomId });
        if (session) this._cleanup(session);
      });

      ws.on('error', () => {
        const session = this.sessions.get(ws);
        this.logger?.error('WebSocket error', { roomId: session?.roomId });
        if (session) this._cleanup(session);
      });
    });
  }

  _createSession(ws) {
    return {
      ws,
      roomId: null,
      pc: null,
      audioSink: null,
      audioSource: null,
      audioTrack: null,

      botWs: null,

      closed: false,
    };
  }

  // all handle function event coming from client side

  async _handleJoin(session, msg) {
    this.logger?.info('Client joining room', { roomId: msg.roomId });
    session.roomId = msg.roomId ?? msg.room ?? 'default';
    let preferences = { ...msg.data };

    // ✅ Check if device fingerprint exists in session (from cookie)
    if (session.deviceFingerprint) {
      // ✅ Override device fingerprint in preferences with cookie value
      preferences.deviceFingerprint = session.deviceFingerprint;
      this.logger.info('Device fingerprint overridden from cookie:', {
        cookieFingerprint: session.deviceFingerprint
      });
    }

    // If userId exists, fetch user from database
    if (preferences.userId) {
      await this._fetchAndMergeUserData(preferences);
    }

    session.preferences = preferences;
    // console.log(`[WebRTCProvider] Preferences prepared: `, session.preferences);
    this.logger.info('Preferences prepared for session', { preferences: session.preferences });

    this._send(session.ws, { type: 'joined', room: session.roomId });
    this._connectBot(session);
  }

  async _handleSignal(session, msg) {
    const data = msg.payload?.data;
    if (!data) return;

    if (data.description?.type === 'offer') {
      await this._handleOffer(session, data.description);
      return;
    }

    if (data.candidate) {
      if (!session.pc) return;
      try {
        await session.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch { }
    }
  }

  _handleLeave(session) {
    this.logger?.info('Client leaving room', { roomId: session.roomId });
    this._cleanup(session);
  }

  async _handleOffer(session, offer) {
    this._teardownPeer(session);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    session.pc = pc;

    session.audioSource = new RTCAudioSource();
    session.audioTrack = session.audioSource.createTrack();
    pc.addTrack(session.audioTrack);

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;

      this._send(session.ws, {
        type: 'signal',
        room: session.roomId,
        payload: { data: { candidate } },
      });
    };

    pc.ontrack = ({ track }) => {
      if (track.kind === 'audio') this._attachInboundAudio(session, track);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this._send(session.ws, {
      type: 'signal',
      room: session.roomId,
      payload: { data: { description: { type: 'answer', sdp: answer.sdp } } },
    });
  }

  _handleSyncTimer(session) {
    if (session.botWs && session.botWs.readyState === WebSocket.OPEN) {
      session.botWs.send(JSON.stringify({
        event: 'sync_timer'
      }));
    }
  }

  _handleSessionTimerTermination(session, msg) {
    if (session.botWs && session.botWs.readyState === WebSocket.OPEN) {
      session.botWs.send(JSON.stringify({
        event: 'session_timer_termination',
        payload: msg.payload
      }));
    }
  }

  _attachInboundAudio(session, track) {
    session.audioSink = new RTCAudioSink(track);

    session.audioSink.ondata = ({ samples }) => {
      if (session.botWs?.readyState !== WebSocket.OPEN) return;

      // 🎯 Downsample 48k → 24k
      const downsampled = this._downsampleBuffer(samples, 48000, 24000);
      // convert to base64
      const payload = Buffer.from(downsampled.buffer).toString('base64');

      session.botWs.send(JSON.stringify({
        event: 'media',
        media: {
          payload,
          sampleRate: 24000
        }
      }));
    };
  }

  _connectBot(session) {
    if (
      session.botWs?.readyState === WebSocket.OPEN ||
      session.botWs?.readyState === WebSocket.CONNECTING
    ) return;


    const botWs = new WebSocket(this.botWsUrl);
    session.botWs = botWs;

    botWs.on('open', () => {
      botWs.send(JSON.stringify({
        event: 'start',
        start: {
          preferences: session.preferences  // Send the user preferences
        }
      }));
      this.logger?.info('Connected to bot WebSocket', { botWsUrl: this.botWsUrl });
    });

    botWs.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.event === 'bot-ready') {
        this.logger?.info('Bot is ready', { roomId: session.roomId });
        this._send(session.ws, { type: 'bot-ready', sessionId: msg?.sessionId });
      }

      if (msg.event === 'media') {
        this._handleBotAudioToClient(session, msg.media);
      }

      if (msg.event === 'transcript_start') {
        this._send(session.ws, {
          type: 'transcript_start',
          sender: msg.sender
        });
      } else if (msg.event === 'transcript_chunk') {
        this._send(session.ws, {
          type: 'transcript_chunk',
          sender: msg.sender,
          text: msg.text  // ← Changed to 'text'
        });
      } else if (msg.event === 'transcript_end') {
        this._send(session.ws, {
          type: 'transcript_end',
          sender: msg.sender
        });
      }

      if (msg.event === 'timer_sync') {
        this._send(session.ws, {
          type: 'timer_sync',
          payload: msg.payload
        });
      }

      if (msg.event === 'session_error') {
        this.logger?.warn('Session the session_error to client side from webrtc Provider', { message: msg.message, roomId: session.roomId });
        this._send(session.ws, { type: 'session_error', message: msg.message });
      }

      if (msg.event === 'session_expired') {
        this.logger?.warn('Session expired message received from bot, forwarding to client', { message: msg.message, roomId: session.roomId });
        this._send(session.ws, {
          type: 'session_expired',
          message: msg.message
        });
      }
    });

    botWs.on('close', () => this._cleanup(session));
    botWs.on('error', () => this._cleanup(session));
  }

  // Fetch user data from database and merge it into preferences
  async _fetchAndMergeUserData(preferences) {
    try {
      const user = await User.findById(preferences.userId).select('firstName lastName gender age');

      if (user) {
        // Merge user data into preferences
        preferences.firstName = user.firstName;
        preferences.lastName = user.lastName;
        preferences.gender = user.gender;
        preferences.age = user.age;
      }
    } catch (error) {
      this.logger.error('Error fetching user:', error.message);
    }
  }

  //handle bot audio and send to client
  _handleBotAudioToClient(session, media) {
    if (!session.audioSource || !media?.payload) return;

    // 1. Base64 → Buffer
    const inputBuffer = Buffer.from(media.payload, 'base64');

    // 2. Validate PCM16
    if (inputBuffer.length % 2 !== 0) {
      // console.log('Invalid PCM buffer length');
      return;
    }

    // 3. Buffer → Int16Array (24kHz mono)
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2
    );

    // 4. Upsample 24k → 48k
    const upsampled = this._upsampleBuffer(inputSamples, 24000, 48000);

    // 5. Convert safely to Node Buffer
    const pcmBuffer = Buffer.from(
      upsampled.buffer,
      upsampled.byteOffset,
      upsampled.byteLength
    );

    // 6. Save as WAV (debugging)
    // saveAudioChunk(session.roomId, pcmBuffer);

    // 7. Send in proper 10ms frames (VERY IMPORTANT)
    this._pushToWebRTC(session, upsampled);
  }

  _pushToWebRTC(session, samples) {
    const FRAME_SIZE = 480; // 10ms @ 48kHz mono

    if (!session._audioBuffer) {
      session._audioBuffer = new Int16Array(0);
    }

    const combined = new Int16Array(session._audioBuffer.length + samples.length);
    combined.set(session._audioBuffer, 0);
    combined.set(samples, session._audioBuffer.length);

    let offset = 0;

    while (combined.length - offset >= FRAME_SIZE) {
      const frame = combined.slice(offset, offset + FRAME_SIZE);
      session.audioSource.onData({
        samples: frame,
        sampleRate: 48000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: FRAME_SIZE  // ← ADD THIS
      });

      offset += FRAME_SIZE;
    }

    session._audioBuffer = combined.slice(offset);
  }
  // High-quality downsampling (PCM16)
  _downsampleBuffer(input, inputRate = 48000, outputRate = 24000) {
    if (!input || input.length === 0) return new Int16Array(0);
    if (inputRate === outputRate) return input;

    const ratio = inputRate / outputRate;
    const outputLength = Math.round(input.length / ratio);
    const output = new Int16Array(outputLength);

    let inputIndex = 0;

    for (let i = 0; i < outputLength; i++) {
      const nextInputIndex = Math.round((i + 1) * ratio);

      let sum = 0;
      let count = 0;

      // average samples → smooth + no data loss feeling
      for (let j = inputIndex; j < nextInputIndex && j < input.length; j++) {
        sum += input[j];
        count++;
      }

      output[i] = count > 0 ? (sum / count) : 0;
      inputIndex = nextInputIndex;
    }

    return output;
  }

  // High-quality upsampling (linear interpolation)
  _upsampleBuffer(input, inputRate = 24000, outputRate = 48000) {
    if (!input || input.length === 0) return new Int16Array(0);
    if (inputRate === outputRate) return input;

    const ratio = outputRate / inputRate;
    const outputLength = Math.round(input.length * ratio);
    const output = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const index = i / ratio;
      const i0 = Math.floor(index);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const t = index - i0;

      output[i] = (1 - t) * input[i0] + t * input[i1];
    }

    return output;
  }

  _teardownPeer(session) {
    try { session.audioSink?.stop(); } catch { }
    try { session.audioTrack?.stop(); } catch { }
    try { session.pc?.close(); } catch { }

    session.audioSink = null;
    session.audioSource = null;
    session.audioTrack = null
    session.pc = null;
  }

  _cleanup(session) {
    if (session.closed) return;
    session.closed = true;

    this.logger?.info('Cleaning up WebRTC session', { roomId: session.roomId });

    closeAudioStream(session.roomId);
    this._teardownPeer(session);

    try { session.botWs?.close(); } catch { }
    session.botWs = null;

    this.sessions.delete(session.ws);
  }

  _send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }
}

export default WebRTCProvider;