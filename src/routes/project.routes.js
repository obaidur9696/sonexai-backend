import express from 'express';
import { getProjectConfiguration, getLogs } from '../controllers/project.controllers.js';

import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.get('/configuration', getProjectConfiguration);

// for logs
router.get('/logs', verifyJWT, getLogs);
router.get('/logs/:date', verifyJWT, getLogs);

export default router;