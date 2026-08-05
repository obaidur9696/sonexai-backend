import { Session } from '../models/session.models.js';
import { User } from '../models/user.models.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';

/**
 * @desc    Get all sessions for authenticated user (lightweight)
 * @route   GET /api/v1/sessions
 * @access  Private
 */
export const getUserSessions = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { limit = 20, page = 1, status = 'ended' } = req.query;

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
});

/**
 * @desc    Get single session by ID with full details
 * @route   GET /api/v1/sessions/:sessionId
 * @access  Private
 */
export const getSessionById = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const userId = req.user._id;

    // Find session
    const session = await Session.findOne({
        sessionId,
        userId,
        sessionType: 'authenticated'
    }).lean();

    if (!session) {
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
    return res.status(200).json(
        new ApiResponse(200, responseData, 'Session fetched successfully')
    );
});

/**
 * @desc    Rename session title
 * @route   PATCH /api/v1/sessions/:sessionId/rename
 * @access  Private
 */
export const renameSession = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { title } = req.body;
    const userId = req.user._id;

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
        throw new ApiError(404, 'Session not found');
    }

    return res.status(200).json(
        new ApiResponse(200, {
            id: session.sessionId,
            title: session.title
        }, 'Session renamed successfully')
    );
});

/**
 * @desc    Delete session
 * @route   DELETE /api/v1/sessions/:sessionId
 * @access  Private
 */
export const deleteSession = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const userId = req.user._id;

    // Find the session first to get its ObjectId
    const session = await Session.findOne({
        sessionId,
        userId,
        sessionType: 'authenticated'
    });

    if (!session) {
        throw new ApiError(404, 'Session not found');
    }

    // Store session ObjectId
    const sessionObjectId = session._id;

    // Delete the session
    await Session.findOneAndDelete({
        sessionId,
        userId,
        sessionType: 'authenticated'
    });

    // ✅ ONLY remove session ID from user's sessions array
    // ✅ DO NOT change totalSessions or totalTalkTimeSeconds
    await User.findByIdAndUpdate(userId, {
        $pull: { sessions: sessionObjectId }
        // ❌ Remove $inc for totalSessions and totalTalkTimeSeconds
    });

    return res.status(200).json(
        new ApiResponse(200, null, 'Session deleted successfully')
    );
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

    return res.status(200).json(
        new ApiResponse(200, combinedResult, 'Global session stats fetched successfully')
    );
});