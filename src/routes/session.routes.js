import express from 'express';
import {
    getUserSessions,
    getSessionById,
    renameSession,
    deleteSession,
    getGlobalSessionStats
} from '../controllers/session.controllers.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = express.Router();


// GET /api/v1/sessions/stats/global - Get global session stats
router.get('/stats/global', getGlobalSessionStats);
// All session routes require authentication
router.use(verifyJWT);

// GET /api/v1/sessions - Get all sessions for logged in user
router.get('/', getUserSessions);

// GET /api/v1/sessions/:sessionId - Get single session details
router.get('/:sessionId', getSessionById);



// PATCH /api/v1/sessions/:sessionId/rename - Rename session title
router.patch('/:sessionId/rename', renameSession);

// DELETE /api/v1/sessions/:sessionId - Delete session
router.delete('/:sessionId', deleteSession);

export default router;