import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import FullDuplex from '../FullDuplexService/fullDuplex.js';
import logger from '../../utils/Logger.js';
import { saveAudioChunk, closeAudioStream } from '../../helper/Audiofilewriter.js';
import SessionTracker from '../sessionTracker/SessionTracker.js';

class BasePhoneCall {
  constructor() {
    this.sessions = new Map();
    this.wss = new WebSocketServer({ noServer: true });
    this.logger = logger;
    this.wss.on('connection', (ws) => this._onConnection(ws));
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  _onConnection(ws) {
    const clientId = uuidv4();
    this.logger?.info('New client connected', { clientId });
    const session = { clientId, ws, closed: false };
    this.sessions.set(clientId, session);
    ws.on('message', (raw) => this._onMessage(clientId, raw));
    ws.on('close', () => {
      this.logger?.info('[Basephonecall] Client disconnected close event from webrtcProvider', { clientId });
      this._cleanup(clientId)

    });
    ws.on('error', () => {
      this.logger?.error('WebSocket error', { clientId });
      this._cleanup(clientId);
    });
  }

  async _onMessage(clientId, raw) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case 'start':
        await this._handleStart(clientId, msg);
        break;

      case 'media':
        if (session?.fullDuplex && msg.media?.payload) {
          session.fullDuplex.processUserAudio(msg.media.payload);
        }
        break;
      case 'sync_timer':
        await this._handleSyncTimer(clientId);
        break;
      case 'session_timer_termination':
        await this._handleSessionTimerTermination(clientId, msg);
        break;
      case 'stop':
        this._cleanup(clientId);
        break;
    }
  }

  // Add this method to BasePhoneCall class
  async _handleStart(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    // Get preferences from start event (with safety check)
    const preferences = msg.start?.preferences || {};
    session.sessionTracker = new SessionTracker({
      preferences: preferences,
      basePhoneCall: this,
      logger: this.logger
    });

    const initialized = await session.sessionTracker.initialize();
    session.isInitialized = !!initialized;
    // If initialize failed (returned null), stop here
    if (!session.isInitialized) {
      this.logger.error(`[BasePhoneCall] Session initialization failed for ${clientId}`);
      return;
    }
    session.sessionId = initialized?.session?.sessionId
    session.fullDuplex = new FullDuplex({
      basePhoneCall: this,
      clientId: clientId,
      preferences: preferences,
      projectConfig: initialized.projectConfig,
      openAIKey: process.env.OPENAI_API_KEY
    });

  }

  async _handleSyncTimer(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || !session.sessionTracker) return;

    const timerPayload = session.sessionTracker.getTimerInfo();
    this._send(session, {
      event: 'timer_sync',
      payload: timerPayload
    });
  }

  async _handleSessionTimerTermination(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    const { reason } = msg.payload || {};

    let message = '';
    if (session.sessionTracker?.sessionDoc?.sessionType === 'authenticated') {
      message = 'Your session time limit has been reached. You can start a new session.';
    } else {
      message = 'Your free trial session has ended. Please login to continue or start a new session.';
    }
    // ✅ Send session_expired event to WebRTCProvider
    this._send(session, {
      event: 'session_expired',
      message: message
    });
  }

  // ─── Outbound to WebRTCProvider ────────────────────────────────────────────

  sendAudio(clientId, pcmBuffer, sampleRate = 24000) {
    const session = this.sessions.get(clientId);
    if (!session) return;
    // saveAudioChunk(session.clientId, pcmBuffer);
    this._send(session, {
      event: 'media',
      media: {
        payload: pcmBuffer.toString('base64'),
        sampleRate,
      },
    });
  }

  sendBotReady(clientId) {
    const session = this.sessions.get(clientId);
    if (!session) return;
    // ✅ Activate the session in database
    if (session.sessionTracker && session.isInitialized) {
      session.sessionTracker.activate();
    }
    this.logger?.info(`[BasePhoneCall] Sending bot-ready to client ${clientId}`);
    this._send(session, { event: 'bot-ready', sessionId: session.sessionId });
  }

  /**
     * Send a session_error event upstream to WebRTCProvider, which forwards it
     * to the client UI. The client is then responsible for closing the WebSocket,
     * which triggers the full cleanup chain.
     */
  sendError(clientId, message) {
    const session = this.sessions.get(clientId);
    if (!session) return;
    this.logger.warn('Sending session error to client', { clientId, message });
    this._send(session, { event: 'session_error', message });
  }

  // Add this method to BasePhoneCall class to save user and bot transcription into database
  async saveTranscript(clientId, sender, text) {
    if (!text || text.trim() === '') return;
    const session = this.sessions.get(clientId);
    if (!session?.sessionTracker) return;
    await session.sessionTracker.recordMessage(sender, text);
  }


  sendTranscriptStart(clientId, sender) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this._send(session, {
      event: 'transcript_start',   // ✅ use 'event', not 'type'
      sender: sender
    });
  }

  sendTranscriptChunk(clientId, sender, text) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this._send(session, {
      event: 'transcript_chunk',
      sender: sender,
      text: text  // Changed from 'word' to 'text'
    });
  }

  sendTranscriptEnd(clientId, sender) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this._send(session, {
      event: 'transcript_end',     // ✅ use 'event', not 'type'
      sender: sender
    });
  }

  /**
 * Update token usage for a session
 * @param {string} clientId - The client/session identifier
 * @param {Object} tokenUsage - { input_tokens, output_tokens, total_tokens }
 */
  async updateSessionTokenUsage(clientId, tokenUsage) {
    const session = this.sessions.get(clientId);
    if (!session || !session.sessionTracker) {
      this.logger?.warn(`[BasePhoneCall] SessionTracker not found for client ${clientId}`);
      return;
    }

    try {
      await session.sessionTracker.updateTokenUsage(tokenUsage);
      this.logger?.info(`[BasePhoneCall] Token usage updated for client ${clientId}`);
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Failed to update token usage for client ${clientId}:`, error.message);
    }
  }

  /**
 * Update a field in the session document
 * @param {string} clientId - The client identifier
 * @param {string} fieldName - The field to update (e.g., 'title')
 * @param {any} value - The value to set
 */
  async updateSessionField(clientId, fieldName, value) {
    const session = this.sessions.get(clientId);
    if (!session || !session.sessionTracker) {
      this.logger?.warn(`[BasePhoneCall] SessionTracker not found for client ${clientId}`);
      return false;
    }

    return await session.sessionTracker.updateField(fieldName, value);
  }

  _cleanup(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || session.closed) return;
    session.closed = true;
    // ✅ Finalize session before cleanup
    this.logger.info('Cleaning up client session in Basephonecall', { clientId });

    if (session.sessionTracker && session.isInitialized) {
      session.sessionTracker.finalize(); // fire-and-forget async
    }
    closeAudioStream(session.clientId);
    try { session.ws.close(); } catch { }

    session.fullDuplex?._cleanupSession();
    this.sessions.delete(clientId);
  }

  _send(session, obj) {
    if (session.ws.readyState === 1) {
      session.ws.send(JSON.stringify(obj));
    }
  }
}

export default BasePhoneCall;