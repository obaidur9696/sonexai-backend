import './config/env.js';

import http from 'http';
import connectDB from './db/index.js';
import { app } from './app.js';
import WebRTCProvider from './service/webRTCPhoneCall/webrtcProvider.js';
import BasePhoneCall from './service/basePhoneCall/basePhoneCall.js';

const server = http.createServer(app);

const basePhone = new BasePhoneCall();
const webrtc = new WebRTCProvider({
  botWsUrl: () => process.env.INTERNAL_WS_URL || `ws://localhost:${process.env.PORT}/internal`
});

server.on('upgrade', (req, socket, head) => {
  const path = req.url?.split('?')[0];

  if (path === '/bot') {
    // ✅ Client WebSocket goes to WebRTCProvider
    webrtc.handleUpgrade(req, socket, head);
  }
  else if (path === '/internal') {
    // ✅ Internal WebSocket between WebRTC and BasePhoneCall
    basePhone.handleUpgrade(req, socket, head);
  }
  else {
    // Socket.io fallback
    io.engine.handleUpgrade(req, socket, head);
  }
});

connectDB()
  .then(() => {
    server.listen(process.env.PORT, () => {
      console.log(`🚀 Server running on port: ${process.env.PORT}`);
    });
  })
  .catch((err) => {
    console.log("❌ MongoDB connection failed", err);
    process.exit(1);
  });
