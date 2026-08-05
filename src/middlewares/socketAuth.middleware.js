import { User } from '../models/user.models.js';
import { Session } from '../models/session.models.js';
import { Project } from '../models/project.models.js';  // ✅ Add this
import jwt from 'jsonwebtoken';

export const socketAuth = async (socket, next) => {
    try {
        const { token, deviceFingerprint, sessionId, preferences, corporate } = socket.handshake.auth;  // ✅ Add corporate

        // 1. Corporate is required
        if (!corporate) {
            return next(new Error('Corporate identifier is required'));
        }

        // 2. Get project config
        const project = await Project.findOne({ corporate });
        if (!project) {
            return next(new Error('Invalid corporate configuration'));
        }
        
        // Attach project to socket for later use
        socket.project = project;

        // 3. Session ID is mandatory
        if (!sessionId) {
            return next(new Error('Session ID is required'));
        }

        // 4. Check existing session
        let session = await Session.findOne({ sessionId });

        // 5. Get WebRTC config from project
        const webrtcConfig = project.webrtc?.[0] || {};  // Get first webrtc config or empty object
        
        // 6. Case A: Authenticated user
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
                const user = await User.findById(decoded._id).select('-password -refreshToken');

                if (!user) {
                    return next(new Error('User not found'));
                }

                // Check for duplicate active session
                const activeSession = await Session.findOne({
                    userId: user._id,
                    status: 'active',
                    sessionId: { $ne: sessionId }
                });

                if (activeSession) {
                    return next(new Error('You already have an active session in another tab'));
                }

                socket.user = user;
                socket.sessionType = 'authenticated';
                
                // ✅ Set max duration from project config
                const maxDurationMinutes = webrtcConfig.timerConfig?.maxDuration?.authenticated || 10;
                socket.maxDurationSeconds = maxDurationMinutes * 60;

            } catch (error) {
                return next(new Error('Invalid token'));
            }
        }

        // 7. Case B: Anonymous user
        else if (deviceFingerprint) {
            // Calculate total anonymous usage
            const anonymousSessions = await Session.find({
                deviceFingerprint,
                status: 'ended'
            });

            const totalMinutes = anonymousSessions.reduce((sum, s) => {
                return sum + (s.duration || 0) / 60;
            }, 0);

            // Get max anonymous duration from project
            const maxAnonymousMinutes = webrtcConfig.timerConfig?.maxDuration?.anonymous || 5;
            
            if (totalMinutes >= maxAnonymousMinutes) {
                return next(new Error('Free trial expired. Please login to continue'));
            }
            
            const remainingForThisSession = (maxAnonymousMinutes - totalMinutes) * 60; // in seconds
            socket.remainingSeconds = remainingForThisSession;
            socket.deviceFingerprint = deviceFingerprint;
            socket.sessionType = 'anonymous';
            
            // ✅ Set max duration from project config
            socket.maxDurationSeconds = remainingForThisSession; // For anonymous, this is the remaining time
        }

        // 8. No valid auth
        else {
            return next(new Error('Authentication required'));
        }

        // 9. Create or update session
        if (!session) {
            session = new Session({
                sessionId,
                sessionType: socket.sessionType,
                userId: socket.user?._id,
                deviceFingerprint: socket.deviceFingerprint,
                preferences: preferences || {},
                status: 'created',
                // ✅ Store expiration info in session
                maxDurationSeconds: socket.maxDurationSeconds,
                expiresAt: new Date(Date.now() + (socket.maxDurationSeconds * 1000)),
                timerWarnings: {
                    warningThreshold: webrtcConfig.timerConfig?.warnings?.warningThreshold || 3,
                    dangerThreshold: webrtcConfig.timerConfig?.warnings?.dangerThreshold || 1
                }
            });
            await session.save();

        } else {
            // Update existing session with timer info if not set
            if (!session.maxDurationSeconds) {
                session.maxDurationSeconds = socket.maxDurationSeconds;
                session.expiresAt = new Date(Date.now() + (socket.maxDurationSeconds * 1000));
                session.timerWarnings = {
                    warningThreshold: webrtcConfig.timerConfig?.warnings?.warningThreshold || 3,
                    dangerThreshold: webrtcConfig.timerConfig?.warnings?.dangerThreshold || 1
                };
                await session.save();
            }
        }

        socket.session = session;
        next();

    } catch (error) {
        console.error('Socket auth error:', error);
        next(new Error('Authentication failed'));
    }
};