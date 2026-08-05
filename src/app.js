import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { errorMiddleware } from './middlewares/error.middleware.js';
import userRouter from './routes/user.routes.js';
import sessionRouter from './routes/session.routes.js'
import projectRouter from './routes/project.routes.js';

const app = express();

// CORS configuration - allow your frontend
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173', // Your React frontend port
    credentials: true, // Allow cookies to be sent
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