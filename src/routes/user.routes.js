import express from 'express';
import { registerUser, loginUser, logoutUser, refreshAccessToken, getCurrentUser, updateAccountDetails } from '../controllers/user.controllers.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Public routes
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/refresh-token', refreshAccessToken);

// Protected routes (require authentication)
router.post('/logout', verifyJWT, logoutUser);
router.get('/current-user', verifyJWT, getCurrentUser);
router.patch('/update-account', verifyJWT, updateAccountDetails); 

export default router;