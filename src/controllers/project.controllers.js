import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Project } from '../models/project.models.js';

const getProjectConfiguration = asyncHandler(async (req, res) => {
    // ✅ Read from URL query parameters
    const { corporate, webrtcId } = req.query;
    const projectCorporate = corporate || process.env.DEFAULT_PROJECT_CORPORATE || 'A2plus';

    // ✅ Get device fingerprint from headers
    const deviceFingerprint = req.headers['x-device-fingerprint'] || req.headers['X-Device-Fingerprint'] || req.cookies?.deviceFingerprint || null;

    // ✅ Set device fingerprint as HTTP-only cookie
    if (deviceFingerprint) {
        res.cookie('deviceFingerprint', deviceFingerprint, {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        });
    }

    const project = await Project.findOne({ corporate: projectCorporate }).lean();

    if (!project) {
        throw new ApiError(404, 'Project configuration not found');
    }

    // If webrtcId is provided, find and return only that specific WebRTC config
    if (webrtcId) {
        const webrtcConfig = project.webrtc?.find(
            (config) => config.webrtcId === webrtcId
        );

        if (!webrtcConfig) {
            throw new ApiError(404, `WebRTC configuration with ID '${webrtcId}' not found`);
        }

        return res.status(200).json(
            new ApiResponse(200, webrtcConfig, 'WebRTC configuration fetched successfully')
        );
    }

    // ❌ If webrtcId is NOT provided, return error (don't send full project)
    throw new ApiError(400, 'webrtcId query parameter is required');
});

export { getProjectConfiguration };