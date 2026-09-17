import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import FullDuplex from '../FullDuplexService/fullDuplex.js';
import logger from '../../utils/Logger.js';
import { saveAudioChunk, closeAudioStream } from '../../helper/Audiofilewriter.js';
import SessionTracker from '../sessionTracker/sessionTracker.js';

const maxCountSilenceTime = 3;
const noAnswerMessages = [
  'Whenever you are ready, I would be glad to hear your thoughts.',
  'Take your time; I am here whenever you feel ready to continue.',
  'There is no rush. Would you like to share what is on your mind?',
  'I would love to hear your perspective whenever you are ready.',
  'Please take a gentle moment; I am listening whenever you wish to continue.',
  'Whenever it feels comfortable, I would be happy to continue our conversation with you.',
  'I am still here with you. Would you like to add anything?',
  'Your thoughts matter; whenever you are ready, I am here to listen.'
];

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
    this.logger?.info(`[BasePhoneCall] Client connected: ${clientId}`);
    
    const session = {
      clientId,
      ws,
      closed: false,
      noAnswerTimeout: null,
      noAnswerTimeoutSeconds: null,
      silencePromptCount: 0,
      awaitingSilencePromptPlayback: false,
      isUserSpeaking: false,
      ignoreNextBotFinishedEvent: false,
      isEndingForNoAnswer: false
    };
    this.sessions.set(clientId, session);
    
    ws.on('message', (raw) => this._onMessage(clientId, raw));
    ws.on('close', () => {
      this.logger?.info(`[BasePhoneCall] Client disconnected: ${clientId}`);
      this._cleanup(clientId);
    });
    ws.on('error', (error) => {
      this.logger?.error(`[BasePhoneCall] WebSocket error for client ${clientId}:`, { 
        error: error.message,
        clientId 
      });
      this._cleanup(clientId);
    });
  }

  async _onMessage(clientId, raw) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Message received from unknown client: ${clientId}`);
      return;
    }

    let msg;
    try { 
      msg = JSON.parse(raw.toString()); 
    } catch (parseError) {
      this.logger?.warn(`[BasePhoneCall] Invalid JSON from client ${clientId}:`, parseError.message);
      return;
    }


    switch (msg.event) {
      case 'start':
        await this._handleStart(clientId, msg);
        break;
      case 'media':
        if (session?.fullDuplex && msg.media?.payload) {
          session.fullDuplex.processUserAudio(msg.media.payload);
        } else {
          // this.logger?.warn(`[BasePhoneCall] Media received but no active session for ${clientId}`);
        }
        break;
      case 'sync_timer':
        await this._handleSyncTimer(clientId);
        break;
      case 'session_timer_termination':
        await this._handleSessionTimerTermination(clientId, msg);
        break;
      case 'bot_finished_frontendside':
        await this._handleBotFinishedFrontendSide(clientId, msg);
        break;
      case 'stop':
        this.logger?.info(`[BasePhoneCall] Stop event received from ${clientId}`);
        await this._cleanup(clientId);
        break;
      default:
        this.logger?.warn(`[BasePhoneCall] Unknown event type: ${msg.event} from ${clientId}`);
    }
  }

  async _handleStart(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Start event for non-existent session: ${clientId}`);
      return;
    }

    const preferences = msg.start?.preferences || {};
    this.logger?.debug(`[BasePhoneCall] Initializing session ${clientId} with preferences:`, { 
      sessionType: preferences.sessionType || 'free' 
    });

    try {
      session.sessionTracker = new SessionTracker({
        preferences: preferences,
        basePhoneCall: this,
        clientId: clientId,
        logger: this.logger
      });

      const initialized = await session.sessionTracker.initialize();
      session.isInitialized = !!initialized;

      if (!session.isInitialized) {
        this.logger?.error(`[BasePhoneCall] Failed to initialize session ${clientId}`);
        this._send(session, {
          event: 'session_error',
          message: 'Unable to start session. Please try again.'
        });
        return;
      }

      session.sessionId = initialized?.session?.sessionId;
      session.projectConfig = initialized.projectConfig || {};

      const noAnswerTimeoutSeconds = Number(session.projectConfig.noAnswerTimeoutSeconds);
      session.noAnswerTimeoutSeconds = Number.isFinite(noAnswerTimeoutSeconds) && noAnswerTimeoutSeconds > 0
        ? noAnswerTimeoutSeconds
        : null;

      session.fullDuplex = new FullDuplex({
        basePhoneCall: this,
        clientId: clientId,
        preferences: preferences,
        projectConfig: session.projectConfig,
        openAIKey: process.env.OPENAI_API_KEY
      });

      this.logger?.info(`[BasePhoneCall] Session ${clientId} started successfully`);

    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Error starting session ${clientId}:`, {
        error: error.message,
        stack: error.stack
      });
      this._send(session, {
        event: 'session_error',
        message: 'Unable to start session. Please try again.'
      });
    }
  }

  async _handleSyncTimer(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || !session.sessionTracker) {
      this.logger?.warn(`[BasePhoneCall] Timer sync requested but no session tracker for ${clientId}`);
      return;
    }

    try {
      const timerPayload = session.sessionTracker.getTimerInfo();
      this._send(session, {
        event: 'timer_sync',
        payload: timerPayload
      });
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Timer sync failed for ${clientId}:`, error.message);
    }
  }

  async _handleSessionTimerTermination(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Timer termination for unknown client: ${clientId}`);
      return;
    }

    try {
      const { reason } = msg.payload || {};
      this.logger?.info(`[BasePhoneCall] Session timer terminating for ${clientId}`, { reason });

      const isAuthenticated = session.sessionTracker?.sessionDoc?.sessionType === 'authenticated';
      const message = isAuthenticated
        ? 'Your session time limit has been reached. You can start a new session.'
        : 'Your free trial session has ended. Please login to continue or start a new session.';

      this._send(session, {
        event: 'session_expired',
        message: message
      });

      // Clean up after sending expiration message
      await this._cleanup(clientId);
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Error handling timer termination for ${clientId}:`, error.message);
    }
  }

  // ─── Outbound to WebRTCProvider ────────────────────────────────────────────

  async _handleBotFinishedFrontendSide(clientId, msg) {
    const session = this.sessions.get(clientId);
    if (!session || session.closed || session.isEndingForNoAnswer) return;

    const eventSessionId = msg.payload?.sessionId;
    if (eventSessionId && session.sessionId && eventSessionId !== session.sessionId) {
      this.logger?.warn(`[BasePhoneCall] Ignoring bot-finished event with a mismatched session ID for ${clientId}`);
      return;
    }

    if (session.isUserSpeaking || session.ignoreNextBotFinishedEvent) {
      this.logger?.debug(`[BasePhoneCall] Ignoring bot-finished event while user speech is active for ${clientId}`);
      return;
    }

    if (session.awaitingSilencePromptPlayback) {
      session.awaitingSilencePromptPlayback = false;

      if (session.silencePromptCount >= maxCountSilenceTime) {
        await this._endForNoAnswer(clientId);
        return;
      }
    }

    this._startNoAnswerTimer(clientId);
  }

  handleUserStartedSpeaking(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || session.closed) return;

    const previousSilencePromptCount = session.silencePromptCount;
    session.isUserSpeaking = true;
    session.ignoreNextBotFinishedEvent = true;
    session.awaitingSilencePromptPlayback = false;
    session.silencePromptCount = 0;
    this._clearNoAnswerTimer(session, 'user_started_speaking');
    this.logger?.info(`[BasePhoneCall] User speech reset no-answer state for ${clientId}`, {
      previousSilencePromptCount,
      currentSilencePromptCount: session.silencePromptCount,
      maxCountSilenceTime
    });
  }

  handleUserStoppedSpeaking(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || session.closed) return;

    session.isUserSpeaking = false;
  }

  handleBotResponseStarted(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || session.closed) return;

    session.ignoreNextBotFinishedEvent = false;
    this._clearNoAnswerTimer(session, 'bot_response_started');
  }

  _startNoAnswerTimer(clientId) {
    const session = this.sessions.get(clientId);
    const timeoutSeconds = session?.noAnswerTimeoutSeconds;

    if (
      !session ||
      session.closed ||
      session.isEndingForNoAnswer ||
      session.isUserSpeaking ||
      session.awaitingSilencePromptPlayback ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0
    ) {
      return;
    }

    this._clearNoAnswerTimer(session, 'starting_no_answer_timer');
    session.noAnswerTimeout = setTimeout(() => {
      session.noAnswerTimeout = null;
      this.logger?.info(`[BasePhoneCall] No-answer timer expired for ${clientId}`, {
        currentSilencePromptCount: session.silencePromptCount,
        nextSilencePromptCount: session.silencePromptCount + 1,
        maxCountSilenceTime
      });
      this._sendNoAnswerPrompt(clientId).catch((error) => {
        this.logger?.error(`[BasePhoneCall] No-answer prompt failed for ${clientId}:`, error.message);
      });
    }, timeoutSeconds * 1000);

    this.logger?.info(`[BasePhoneCall] No-answer timer started for ${clientId}`, {
      timeoutSeconds,
      silencePromptCount: session.silencePromptCount
    });
  }

  async _sendNoAnswerPrompt(clientId) {
    const session = this.sessions.get(clientId);
    if (
      !session ||
      session.closed ||
      session.isEndingForNoAnswer ||
      session.isUserSpeaking ||
      session.awaitingSilencePromptPlayback
    ) {
      return;
    }

    const message = noAnswerMessages[session.silencePromptCount % noAnswerMessages.length];
    this.logger?.info(`[BasePhoneCall] Sending no-answer prompt to FullDuplex for ${clientId}`, {
      nextSilencePromptCount: session.silencePromptCount + 1,
      maxCountSilenceTime,
      messageIndex: session.silencePromptCount % noAnswerMessages.length
    });
    const started = session.fullDuplex?.speakSilenceMessage(message);

    if (!started) {
      this.logger?.warn(`[BasePhoneCall] Unable to send no-answer prompt for ${clientId}`);
      return;
    }

    session.silencePromptCount += 1;
    session.awaitingSilencePromptPlayback = true;
    this.logger?.info(`[BasePhoneCall] No-answer prompt ${session.silencePromptCount}/${maxCountSilenceTime} started for ${clientId}`);
  }

  async _endForNoAnswer(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || session.closed || session.isEndingForNoAnswer) return;

    session.isEndingForNoAnswer = true;
    this._clearNoAnswerTimer(session, 'maximum_silence_count_reached');
    this.logger?.info(`[BasePhoneCall] Ending session ${clientId} after ${maxCountSilenceTime} unanswered silence prompts`);
    this._send(session, {
      event: 'session_ended',
      reason: 'no_answer_timeout',
      message: 'We ended this session because we did not receive a response after several gentle reminders.'
    });
    await this._cleanup(clientId);
  }

  _clearNoAnswerTimer(session, reason) {
    if (session?.noAnswerTimeout) {
      clearTimeout(session.noAnswerTimeout);
      session.noAnswerTimeout = null;
      this.logger?.info(`[BasePhoneCall] No-answer timer cancelled for ${session.clientId}`, {
        reason,
        currentSilencePromptCount: session.silencePromptCount,
        maxCountSilenceTime
      });
    }
  }

  sendAudio(clientId, pcmBuffer, sampleRate = 24000) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Audio send attempt for unknown client: ${clientId}`);
      return;
    }

    try {
      this._send(session, {
        event: 'media',
        media: {
          payload: pcmBuffer.toString('base64'),
          sampleRate,
        },
      });
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Failed to send audio to ${clientId}:`, error.message);
    }
  }

  sendAudioEnd(clientId) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this._send(session, { event: 'media_end' });
  }

  clearAudio(clientId) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this._send(session, { event: 'media_clear' });
  }

  async sendBotReady(clientId) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Bot-ready send attempt for unknown client: ${clientId}`);
      return;
    }

    try {
      let activeSession;
      if (session.sessionTracker && session.isInitialized) {
        activeSession = await session.sessionTracker.activate();
      }

      if (!activeSession) {
        throw new Error('Session could not be activated');
      }
      
      this.logger?.info(`[BasePhoneCall] Bot ready for client ${clientId}`);
      this._send(session, { 
        event: 'bot-ready', 
        sessionId: activeSession.sessionId,
        status: activeSession.status,
        createdAt: activeSession.createdAt,
        topic: activeSession.topic,
        name: activeSession.name,
        preferences: activeSession.preferences
      });
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Failed to send bot-ready to ${clientId}:`, error.message);
      this._send(session, {
        event: 'session_error',
        message: 'Service temporarily unavailable. Please try again.'
      });
    }
  }

  sendError(clientId, message) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Error send attempt for unknown client: ${clientId}`);
      return;
    }

    this.logger?.warn(`[BasePhoneCall] Sending error to client ${clientId}:`, { message });
    this._send(session, { 
      event: 'session_error', 
      message: message || 'Service temporarily unavailable. Please try again.'
    });
  }

  async saveTranscript(clientId, sender, text) {
    if (!text || text.trim() === '') {
      this.logger?.debug(`[BasePhoneCall] Empty transcript from ${clientId}, skipping`);
      return;
    }

    const session = this.sessions.get(clientId);
    if (!session?.sessionTracker) {
      this.logger?.warn(`[BasePhoneCall] Transcript save attempt for ${clientId} without session tracker`);
      return;
    }

    try {
      await session.sessionTracker.recordMessage(sender, text);
      this.logger?.debug(`[BasePhoneCall] Transcript saved for ${clientId}, sender: ${sender}`);
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Failed to save transcript for ${clientId}:`, error.message);
    }
  }

  sendTranscriptStart(clientId, sender) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Transcript start send for unknown client: ${clientId}`);
      return;
    }

    this._send(session, {
      event: 'transcript_start',
      sender: sender
    });
  }

  sendTranscriptChunk(clientId, sender, text) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Transcript chunk send for unknown client: ${clientId}`);
      return;
    }

    this._send(session, {
      event: 'transcript_chunk',
      sender: sender,
      text: text
    });
  }

  sendTranscriptEnd(clientId, sender) {
    const session = this.sessions.get(clientId);
    if (!session) {
      this.logger?.warn(`[BasePhoneCall] Transcript end send for unknown client: ${clientId}`);
      return;
    }

    this._send(session, {
      event: 'transcript_end',
      sender: sender
    });
  }

  async updateSessionTokenUsage(clientId, tokenUsage) {
    const session = this.sessions.get(clientId);
    if (!session || !session.sessionTracker) {
      this.logger?.warn(`[BasePhoneCall] Token usage update for ${clientId} - session or tracker not found`);
      return;
    }

    try {
      await session.sessionTracker.updateTokenUsage(tokenUsage);
      this.logger?.debug(`[BasePhoneCall] Token usage updated for ${clientId}`);
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Failed to update token usage for ${clientId}:`, error.message);
    }
  }

  async _cleanup(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || session.closed) {
      this.logger?.debug(`[BasePhoneCall] Cleanup skipped - session ${clientId} already closed or not found`);
      return;
    }

    session.closed = true;
    this._clearNoAnswerTimer(session, 'session_cleanup');
    this.logger?.info(`[BasePhoneCall] Cleaning up session ${clientId}`);

    try {
      if (session.sessionTracker && session.isInitialized) {
        await session.sessionTracker.finalize();
      }

      closeAudioStream(session.clientId);
      
      if (session.ws.readyState === 1) {
        session.ws.close();
      }
      
      session.fullDuplex?._cleanupSession();
      this.sessions.delete(clientId);
      
      this.logger?.info(`[BasePhoneCall] Session ${clientId} cleaned up successfully`);
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Error during cleanup for ${clientId}:`, {
        error: error.message,
        stack: error.stack
      });
      // Ensure session is removed even if cleanup fails
      this.sessions.delete(clientId);
    }
  }

  _send(session, obj) {
    try {
      if (session?.ws?.readyState === 1) {
        session.ws.send(JSON.stringify(obj));
      } else {
        // this.logger?.warn(`[BasePhoneCall] Cannot send - WebSocket not ready for client ${session?.clientId}`);
      }
    } catch (error) {
      this.logger?.error(`[BasePhoneCall] Failed to send message to client ${session?.clientId}:`, error.message);
    }
  }
}

export default BasePhoneCall;
