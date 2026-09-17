import { Session } from '../models/session.models.js';
import { User } from '../models/user.models.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import logger from '../utils/Logger.js';

/**
 * @desc    Get all sessions for authenticated user (lightweight)
 * @route   GET /api/v1/sessions
 * @access  Private
 */
export const getUserSessions = asyncHandler(async (req, res) => {
    try {
        const userId = req.user._id;
        const { limit = 20, page = 1, status = 'ended' } = req.query;

        logger?.info('[Sessions] Fetching user sessions:', {
            userId: userId.toString(),
            limit,
            page,
            status
        });

        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        const query = {
            userId,
            sessionType: 'authenticated',
            status
        };

        const totalSessions = await Session.countDocuments(query);

        const sessions = await Session.find(query)
            .select('sessionId title preferences.topic preferences.language preferences.depth createdAt duration endedAt')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNumber)
            .lean();

        // ✅ Deduplicate by sessionId
        const uniqueSessions = sessions.filter((s, index, self) =>
            index === self.findIndex((t) => t.sessionId === s.sessionId)
        );

        const formattedSessions = uniqueSessions.map(session => ({
            id: session.sessionId,
            title: session.title || `${session.preferences?.topic || 'New Conversation'}`,
            topic: session.preferences?.topic || 'General',
            language: session.preferences?.language || 'en',
            depth: session.preferences?.depth || 'medium',
            date: session.createdAt,
            duration: session.duration,
            endedAt: session.endedAt
        }));

        logger?.info('[Sessions] User sessions fetched successfully:', {
            userId: userId.toString(),
            returnedSessions: formattedSessions.length,
            totalSessions
        });

        return res.status(200).json(
            new ApiResponse(200, {
                sessions: formattedSessions,
                pagination: {
                    page: pageNumber,
                    limit: limitNumber,
                    total: totalSessions,
                    pages: Math.ceil(totalSessions / limitNumber)
                }
            }, 'Sessions fetched successfully')
        );
    } catch (error) {
        logger?.error('[Sessions] Failed to fetch user sessions:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?._id?.toString()
        });
        throw error;
    }
});

/**
 * @desc    Get single session by ID with full details
 * @route   GET /api/v1/sessions/:sessionId
 * @access  Private
 */
export const getSessionById = asyncHandler(async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.user._id;

        logger?.info('[Sessions] Fetching session by ID:', {
            userId: userId.toString(),
            sessionId
        });

        // Find session
        const session = await Session.findOne({
            sessionId,
            userId,
            sessionType: 'authenticated'
        }).lean();

        if (!session) {
            logger?.warn('[Sessions] Session not found:', {
                userId: userId.toString(),
                sessionId
            });
            throw new ApiError(404, 'Session not found');
        }

        // Format messages
        const formattedMessages = session.messages?.map(msg => ({
            sender: msg.sender,
            text: msg.text,
            timestamp: msg.timestamp
        })) || [];

        // Determine title
        let title;
        const insightsCompleted = session.insights?.analysisStatus?.completed === true;

        if (session.title) {
            title = session.title
        } else if (insightsCompleted && session.insights?.conversationTitle?.status && session.insights?.conversationTitle?.value) {
            title = session.insights.conversationTitle.value;
        }
        else {
            const topic = session.preferences?.topic || 'New Conversation';
            title = `${topic}`;
        }

        const insights = insightsCompleted
            ? session.insights
            : {
                analysisStatus: {
                    completed: false,
                    reason: session.insights?.analysisStatus?.reason || 'Insufficient conversation for analysis'
                }
            };

        // Build response
        const responseData = {
            id: session.sessionId,
            title: title,
            sessionType: session.sessionType,
            status: session.status,
            preferences: session.preferences,
            messages: formattedMessages,
            duration: session.totalTalkTimeSeconds || 0,
            totalMessages: session.totalMessages || 0,
            totalWords: session.totalWords || 0,
            createdAt: session.createdAt,
            endedAt: session.endedAt,
            // Insights - only if completed
            insights: insights
        };

        logger?.info('[Sessions] Session fetched successfully:', {
            userId: userId.toString(),
            sessionId
        });

        return res.status(200).json(
            new ApiResponse(200, responseData, 'Session fetched successfully')
        );
    } catch (error) {
        logger?.error('[Sessions] Failed to fetch session:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?._id?.toString(),
            sessionId: req.params.sessionId
        });
        throw error;
    }
});

/**
 * @desc    Rename session title
 * @route   PATCH /api/v1/sessions/:sessionId/rename
 * @access  Private
 */
export const renameSession = asyncHandler(async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { title } = req.body;
        const userId = req.user._id;

        logger?.info('[Sessions] Rename session attempt:', {
            userId: userId.toString(),
            sessionId,
            newTitle: title
        });

        if (!title || title.trim().length === 0) {
            throw new ApiError(400, 'Title is required');
        }

        if (title.length > 100) {
            throw new ApiError(400, 'Title must be less than 100 characters');
        }

        const session = await Session.findOneAndUpdate(
            {
                sessionId,
                userId,
                sessionType: 'authenticated'
            },
            {
                $set: { title: title.trim() } // ✅ Only update title
            },
            {
                returnDocument: 'after',
                runValidators: true
            }
        ).select('sessionId title');

        if (!session) {
            logger?.warn('[Sessions] Session not found for rename:', {
                userId: userId.toString(),
                sessionId
            });
            throw new ApiError(404, 'Session not found');
        }

        logger?.info('[Sessions] Session renamed successfully:', {
            userId: userId.toString(),
            sessionId,
            newTitle: session.title
        });

        return res.status(200).json(
            new ApiResponse(200, {
                id: session.sessionId,
                title: session.title
            }, 'Session renamed successfully')
        );
    } catch (error) {
        logger?.error('[Sessions] Failed to rename session:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?._id?.toString(),
            sessionId: req.params.sessionId,
            attemptedTitle: req.body?.title
        });
        throw error;
    }
});

/**
 * @desc    Delete session
 * @route   DELETE /api/v1/sessions/:sessionId
 * @access  Private
 */
export const deleteSession = asyncHandler(async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.user._id;

        logger?.info('[Sessions] Delete session attempt:', {
            userId: userId.toString(),
            sessionId
        });

        // Find the session first to get its ObjectId
        const session = await Session.findOne({
            sessionId,
            userId,
            sessionType: 'authenticated'
        });

        if (!session) {
            logger?.warn('[Sessions] Session not found for deletion:', {
                userId: userId.toString(),
                sessionId
            });
            throw new ApiError(404, 'Session not found');
        }

        // Delete the session
        await Session.findOneAndDelete({
            sessionId,
            userId,
            sessionType: 'authenticated'
        });

        // User totals are lifetime counters, so deleting a conversation does
        // not alter totalSessions or totalTalkTimeSeconds. The session itself
        // is the sole record of the User-to-Session relationship.

        logger?.info('[Sessions] Session deleted successfully:', {
            userId: userId.toString(),
            sessionId
        });

        return res.status(200).json(
            new ApiResponse(200, null, 'Session deleted successfully')
        );
    } catch (error) {
        logger?.error('[Sessions] Failed to delete session:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?._id?.toString(),
            sessionId: req.params.sessionId
        });
        throw error;
    }
});

/**
 * @desc    Get global session stats (all sessions across all users)
 * @route   GET /api/v1/sessions/stats/global
 * @access  Private
 */
/**
 * @desc    Get global session stats (all users + anonymous sessions)
 * @route   GET /api/v1/sessions/stats/global
 * @access  Private
 */
export const getGlobalSessionStats = asyncHandler(async (req, res) => {
    try {
        logger?.info('[Sessions] Fetching global session stats');

        // Step 1: Get stats from all authenticated users
        const userStats = await User.aggregate([
            {
                $group: {
                    _id: null,
                    totalSessions: { $sum: '$totalSessions' },
                    totalTalkTimeSeconds: { $sum: '$totalTalkTimeSeconds' }
                }
            }
        ]);

        // Step 2: Get stats from anonymous sessions (userId: null)
        const anonymousStats = await Session.aggregate([
            {
                $match: {
                    userId: null,
                    status: 'ended',
                    sessionType: 'anonymous'
                }
            },
            {
                $group: {
                    _id: null,
                    totalSessions: { $sum: 1 },
                    totalTalkTimeSeconds: { $sum: '$totalTalkTimeSeconds' }
                }
            }
        ]);

        // Step 3: Combine both results
        const userResult = userStats.length > 0 ? userStats[0] : { totalSessions: 0, totalTalkTimeSeconds: 0 };
        const anonymousResult = anonymousStats.length > 0 ? anonymousStats[0] : { totalSessions: 0, totalTalkTimeSeconds: 0 };

        const combinedResult = {
            totalSessions: userResult.totalSessions + anonymousResult.totalSessions,
            totalTalkTimeSeconds: userResult.totalTalkTimeSeconds + anonymousResult.totalTalkTimeSeconds
        };

        logger?.info('[Sessions] Global session stats fetched successfully:', combinedResult);

        return res.status(200).json(
            new ApiResponse(200, combinedResult, 'Global session stats fetched successfully')
        );
    } catch (error) {
        logger?.error('[Sessions] Failed to fetch global session statistics:', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
});
