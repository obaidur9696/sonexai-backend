import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import wrtc from 'wrtc';
import { User } from '../../models/user.models.js';
import logger from '../../utils/Logger.js';
import { closeAudioStream } from '../../helper/Audiofilewriter.js';


const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc;
const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const OPENAI_OUTPUT_SAMPLE_RATE = 24000;
const WEBRTC_SAMPLE_RATE = 48000;
const WEBRTC_FRAME_SIZE = 480; // 10 ms at 48 kHz mono
const RESAMPLER_CONTEXT_SAMPLES = 8;

// The odd phase of a 2x, windowed-sinc interpolator. The even phase is the
// original source sample, so it remains bit-exact at the original sample times.
const UPSAMPLE_ODD_PHASE_COEFFICIENTS = (() => {
  const coefficients = [];

  for (let relativeSample = -7; relativeSample <= 8; relativeSample++) {
    const distance = 0.5 - relativeSample;
    const sinc = Math.sin(Math.PI * distance) / (Math.PI * distance);
    const normalizedDistance = Math.abs(distance) / 8.5;
    const window = 0.42 +
      (0.5 * Math.cos(Math.PI * normalizedDistance)) +
      (0.08 * Math.cos(2 * Math.PI * normalizedDistance));

    coefficients.push(sinc * window);
  }

  const gain = coefficients.reduce((sum, coefficient) => sum + coefficient, 0);
  return coefficients.map((coefficient) => coefficient / gain);
})();

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
        this._send(session.ws, {
          type: 'bot-ready',
          sessionId: msg.sessionId,
          status: msg.status,
          createdAt: msg.createdAt,
          topic: msg.topic,
          name: msg.name,
          preferences: msg.preferences
        });
      }

      if (msg.event === 'media') {
        this._handleBotAudioToClient(session, msg.media);
      }

      if (msg.event === 'media_end') {
        this._flushBotAudioToClient(session);
      }

      if (msg.event === 'media_clear') {
        this._clearBotAudioToClient(session);
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

    const inputBuffer = Buffer.from(media.payload, 'base64');
    if (inputBuffer.length % 2 !== 0) {
      this.logger?.warn('Discarding malformed bot PCM audio', { roomId: session.roomId });
      return;
    }

    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2
    );
    const inputSampleRate = Number(media.sampleRate) || OPENAI_OUTPUT_SAMPLE_RATE;
    const outputSamples = this._resampleBotAudio(session, inputSamples, inputSampleRate);

    if (outputSamples.length > 0) {
      this._pushToWebRTC(session, outputSamples);
    }
  }

  _pushToWebRTC(session, samples) {
    if (!session._audioBuffer) {
      session._audioBuffer = new Int16Array(0);
    }

    const combined = new Int16Array(session._audioBuffer.length + samples.length);
    combined.set(session._audioBuffer, 0);
    combined.set(samples, session._audioBuffer.length);

    let offset = 0;

    while (combined.length - offset >= WEBRTC_FRAME_SIZE) {
      this._sendWebRTCAudioFrame(
        session,
        combined.slice(offset, offset + WEBRTC_FRAME_SIZE)
      );
      offset += WEBRTC_FRAME_SIZE;
    }

    session._audioBuffer = combined.slice(offset);
  }

  _sendWebRTCAudioFrame(session, samples) {
    if (!session.audioSource) return;

    session.audioSource.onData({
      samples,
      sampleRate: WEBRTC_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: WEBRTC_FRAME_SIZE
    });
  }

  _resampleBotAudio(session, input, inputRate) {
    if (!input || input.length === 0) return new Int16Array(0);
    if (inputRate === WEBRTC_SAMPLE_RATE) return input;

    if (inputRate !== OPENAI_OUTPUT_SAMPLE_RATE) {
      this.logger?.warn('Discarding bot audio with an unsupported sample rate', {
        roomId: session.roomId,
        inputRate
      });
      return new Int16Array(0);
    }

    return this._upsample24kTo48k(session, input);
  }

  _upsample24kTo48k(session, input) {
    const state = this._getOutputResamplerState(session);
    const combined = new Int16Array(state.pending.length + input.length);
    combined.set(state.pending, 0);
    combined.set(input, state.pending.length);

    const output = [];
    let offset = 0;

    // Wait for eight source samples of look-ahead. This removes chunk-boundary
    // artifacts while adding less than 0.4 ms of resampler latency.
    while (combined.length - offset > RESAMPLER_CONTEXT_SAMPLES) {
      const current = combined[offset];
      let interpolated = 0;

      for (let coefficientIndex = 0; coefficientIndex < UPSAMPLE_ODD_PHASE_COEFFICIENTS.length; coefficientIndex++) {
        const relativeSample = coefficientIndex - 7;
        const sourceSample = relativeSample < 0
          ? state.history[state.history.length + relativeSample]
          : combined[offset + relativeSample];

        interpolated += (sourceSample || 0) * UPSAMPLE_ODD_PHASE_COEFFICIENTS[coefficientIndex];
      }

      output.push(current, this._toPcm16(interpolated));
      state.history.copyWithin(0, 1);
      state.history[state.history.length - 1] = current;
      offset++;
    }

    state.pending = combined.slice(offset);
    state.hasAudio = state.hasAudio || input.length > 0;
    return Int16Array.from(output);
  }

  _getOutputResamplerState(session) {
    if (!session._outputResampler) {
      session._outputResampler = {
        history: new Int16Array(RESAMPLER_CONTEXT_SAMPLES),
        pending: new Int16Array(0),
        hasAudio: false
      };
    }

    return session._outputResampler;
  }

  _flushBotAudioToClient(session) {
    const state = session._outputResampler;
    if (state?.hasAudio && state.pending.length > 0) {
      const tail = this._upsample24kTo48k(
        session,
        new Int16Array(RESAMPLER_CONTEXT_SAMPLES)
      );
      this._pushToWebRTC(session, tail);
    }

    if (session._audioBuffer?.length > 0) {
      const finalFrame = new Int16Array(WEBRTC_FRAME_SIZE);
      finalFrame.set(session._audioBuffer);
      this._sendWebRTCAudioFrame(session, finalFrame);
    }

    this._clearBotAudioToClient(session);
  }

  _clearBotAudioToClient(session) {
    session._audioBuffer = new Int16Array(0);
    session._outputResampler = null;
  }

  _toPcm16(sample) {
    return Math.max(-32768, Math.min(32767, Math.round(sample)));
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

  _teardownPeer(session) {
    try { session.audioSink?.stop(); } catch { }
    try { session.audioTrack?.stop(); } catch { }
    try { session.pc?.close(); } catch { }

    this._clearBotAudioToClient(session);

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
