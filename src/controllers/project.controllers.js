import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Project } from '../models/project.models.js';
import logger from '../utils/Logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getProjectConfiguration = asyncHandler(async (req, res) => {
    try {
        const { corporate, webrtcId } = req.query;
        const projectCorporate = corporate || process.env.DEFAULT_PROJECT_CORPORATE || 'A2plus';

        const deviceFingerprint = req.headers['x-device-fingerprint'] || req.headers['X-Device-Fingerprint'] || req.cookies?.deviceFingerprint || null;

        if (deviceFingerprint) {
            const isProduction = process.env.NODE_ENV === 'production';
            res.cookie('deviceFingerprint', deviceFingerprint, {
                httpOnly: true,
                secure: isProduction,
                sameSite: isProduction ? 'none' : 'lax',
                path: '/',
                maxAge: 30 * 24 * 60 * 60 * 1000,
            });
        }

        const project = await Project.findOne({ corporate: projectCorporate }).lean();

        if (!project) {
            logger?.warn(`[ProjectConfig] Project not found for corporate: ${projectCorporate}`);
            throw new ApiError(404, 'Project configuration not found');
        }

        if (webrtcId) {
            const webrtcConfig = project.webrtc?.find(
                (config) => config.webrtcId === webrtcId
            );

            if (!webrtcConfig) {
                logger?.warn(`[ProjectConfig] WebRTC config not found for ${webrtcId} in corporate ${projectCorporate}`);
                throw new ApiError(404, `WebRTC configuration with ID '${webrtcId}' not found`);
            }

            logger?.info(`[ProjectConfig] WebRTC config fetched successfully`, { 
                corporate: projectCorporate, 
                webrtcId 
            });
            
            return res.status(200).json(
                new ApiResponse(200, webrtcConfig, 'WebRTC configuration fetched successfully')
            );
        }

        logger?.warn(`[ProjectConfig] Missing webrtcId parameter for corporate ${projectCorporate}`);
        throw new ApiError(400, 'webrtcId query parameter is required');

    } catch (error) {
        logger?.error(`[ProjectConfig] Failed to fetch configuration:`, {
            error: error.message,
            stack: error.stack,
            corporate: req.query.corporate || process.env.DEFAULT_PROJECT_CORPORATE || 'A2plus',
            webrtcId: req.query.webrtcId
        });
        
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, 'Unable to fetch configuration. Please try again.');
    }
});

/**
 * @desc    Get logs from a specific date file or latest file
 * @route   GET /api/v1/projects/logs
 * @route   GET /api/v1/projects/logs/:date
 * @access  Private (requires JWT)
 */
const getLogs = asyncHandler(async (req, res) => {
    try {
        // Get date from params
        const date = req.params.date;
        let logFileName;

        // Get the logs directory path
        const logsDir = path.join(__dirname, '../../logs/log');

        // Check if logs directory exists
        try {
            await fs.access(logsDir);
        } catch (error) {
            logger?.error('[Logs] Logs directory not found:', {
                error: error.message,
                path: logsDir
            });
            throw new ApiError(404, 'Logs directory not found');
        }

        // Get all log files
        const files = await fs.readdir(logsDir);
        
        // Filter only .log files
        const logFiles = files
            .filter(file => file.startsWith('log-') && file.endsWith('.log'))
            .sort((a, b) => b.localeCompare(a));

        if (logFiles.length === 0) {
            logger?.warn('[Logs] No log files found');
            return res.status(200).json(
                new ApiResponse(200, {
                    entries: [],
                    total: 0,
                    date: date || 'latest',
                    file: null
                }, 'No log files found')
            );
        }

        // If date is provided, find matching log file
        if (date) {
            const filePattern = `log-${date}.log`;
            const matchingFile = logFiles.find(file => file === filePattern);
            
            if (!matchingFile) {
                logger?.warn(`[Logs] Log file not found for date: ${date}`);
                return res.status(200).json(
                    new ApiResponse(200, {
                        entries: [],
                        total: 0,
                        date: date,
                        file: null,
                        availableFiles: logFiles.slice(0, 10)
                    }, `No log file found for date: ${date}`)
                );
            }
            logFileName = matchingFile;
        } else {
            logFileName = logFiles[0];
        }

        const filePath = path.join(logsDir, logFileName);
        const fileDate = logFileName.replace('log-', '').replace('.log', '');

        logger?.info(`[Logs] Reading log file: ${logFileName}`);

        // Read the entire file content
        const fileContent = await fs.readFile(filePath, 'utf-8');
        
        // Split by lines
        const lines = fileContent.split('\n');
        
        // Group lines into complete log entries
        const logEntries = [];
        let currentEntry = '';
        let hasTimestamp = false;

        for (const line of lines) {
            // Check if line starts with timestamp pattern (HH:MM:SS.mmm)
            const timestampMatch = line.match(/^\d{2}:\d{2}:\d{2}\.\d{3}/);
            
            if (timestampMatch) {
                // If we have a previous entry, save it (even if it has no timestamp)
                if (currentEntry) {
                    logEntries.push(currentEntry.trim());
                }
                // Start a new entry with this line
                currentEntry = line;
                hasTimestamp = true;
            } else if (line.trim() !== '') {
                // This is a continuation of the previous entry (like stack trace)
                // Append it to current entry even if it doesn't have a timestamp
                currentEntry += '\n' + line;
            }
        }

        // Don't forget the last entry
        if (currentEntry) {
            logEntries.push(currentEntry.trim());
        }

        logger?.info(`[Logs] Logs fetched successfully: ${logEntries.length} entries from ${logFileName}`);

        return res.status(200).json(
            new ApiResponse(200, {
                entries: logEntries,
                total: logEntries.length,
                date: fileDate,
                file: logFileName
            }, 'Logs fetched successfully')
        );

    } catch (error) {
        logger?.error('[Logs] Failed to fetch logs:', {
            error: error.message,
            stack: error.stack
        });
        
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, 'Unable to fetch logs. Please try again.');
    }
});

export { getProjectConfiguration, getLogs };