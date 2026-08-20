import './config/env.js';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { errorMiddleware } from './middlewares/error.middleware.js';
import userRouter from './routes/user.routes.js';
import sessionRouter from './routes/session.routes.js'
import projectRouter from './routes/project.routes.js';

const app = express();

const allowedOrigins = [...new Set(
    process.env.CORS_ORIGIN
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean)
)];

// Credentialed CORS must use an explicit origin. Never use `*` here: browsers
// will reject it when fetch/axios sends credentials.
app.use(cors({
    origin(origin, callback) {
        // Requests without Origin are typically server-to-server, curl, or
        // same-origin requests and do not need a CORS response header.
        const requestOrigin = origin?.replace(/\/+$/, '');

        if (!origin || allowedOrigins.includes(requestOrigin)) {
            return callback(null, true);
        }

        const corsError = new Error('Origin is not allowed by CORS');
        corsError.statusCode = 403;
        return callback(corsError);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-fingerprint']
}));

// Body parser middleware
app.use(express.json({ limit: '20mb' })); // Increased for audio data
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static('public')); // For static files

// Cookie parser middleware
app.use(cookieParser());
// Route declarations
app.use('/api/v1/users', userRouter);


//session route
app.use('/api/v1/sessions', sessionRouter)

//project route
app.use('/api/v1/projects', projectRouter);

// Basic health check route
app.get('/api/v1/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'VoiceAI Server is running',
        timestamp: new Date().toISOString()
    });
});



// Global error handler (should be last)
app.use(errorMiddleware);



export { app };
