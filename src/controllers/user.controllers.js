import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { User } from '../models/user.models.js';
import jwt from 'jsonwebtoken'
import logger from '../utils/Logger.js';

const generateAcessAndRefreshToken = async (userId) => {
    try {
        const user = await User.findById(userId)
        const refreshToken = await user.generateRefreshToken()
        const accessToken = await user.generateAccessToken()
        user.refreshToken = refreshToken
        await user.save({ validateBeforeSave: false })

        return { accessToken, refreshToken }
    }
    catch (error) {
        logger?.error('[Auth] Failed to generate tokens:', {
            error: error.message,
            stack: error.stack,
            userId: userId?.toString()
        });
        throw new ApiError(500, "Something went wrong while generating refresh and access token")
    }
}

const registerUser = asyncHandler(async (req, res) => {
    try {
        const { email, password, firstName, lastName, gender, age } = req.body;

        // Log registration attempt
        logger?.info('[Auth] Registration attempt:', {
            email,
            firstName,
            lastName,
            hasPassword: !!password
        });

        if ([email, password, firstName, lastName].some(field => !field || field.trim() === "")) {
            throw new ApiError(400, "All fields are required");
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            throw new ApiError(409, "User with this email already exists");
        }

        const user = await User.create({
            email,
            password,
            firstName,
            lastName,
            gender: gender || "prefer-not",
            age: age || 18
        });

        const createdUser = await User.findById(user._id).select("-password -refreshToken");
        if (!createdUser) {
            throw new ApiError(500, "Something went wrong while registering user");
        }

        logger?.info(`[Auth] User registered successfully: ${createdUser._id}`);
        return res.status(201).json(new ApiResponse(201, createdUser, "User registered successfully"));
    } catch (error) {
        logger?.error('[Auth] Registration failed:', {
            error: error.message,
            stack: error.stack,
            email: req.body?.email
        });
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Unable to register. Please try again."
        });
    }
});

const loginUser = asyncHandler(async (req, res) => {
    try {
        const { email, password } = req.body;

        // Log login attempt
        logger?.info('[Auth] Login attempt:', {
            email,
            hasPassword: !!password
        });

        if (!email || !password) {
            throw new ApiError(400, "Email and password are required");
        }

        const user = await User.findOne({ email }).select("+password");
        if (!user) {
            throw new ApiError(401, "Invalid email or password");
        }

        const isPasswordValid = await user.isPasswordCorrect(password);
        if (!isPasswordValid) {
            throw new ApiError(401, "Invalid email or password");
        }

        const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);

        const loggedInUser = await User.findById(user._id).select("-password -refreshToken");

        const isProduction = process.env.NODE_ENV === "production";

        const options = {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? "none" : "lax",
            path: "/",
        };

        logger?.info(`[Auth] User logged in successfully: ${user._id}`);
        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", refreshToken, options)
            .json(new ApiResponse(200, { user: loggedInUser }, "User logged in successfully"));
    } catch (error) {
        logger?.error('[Auth] Login failed:', {
            error: error.message,
            stack: error.stack,
            email: req.body?.email
        });
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Unable to login. Please try again."
        });
    }
});

const logoutUser = asyncHandler(async (req, res) => {
    try {
        // Log logout attempt
        logger?.info('[Auth] Logout attempt:', {
            userId: req.user?._id?.toString()
        });

        await User.findByIdAndUpdate(
            req.user._id,
            { $unset: { refreshToken: 1 } },
            { returnDocument: 'after' }
        );

        const isProduction = process.env.NODE_ENV === "production";

        const options = {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? "none" : "lax",
            path: "/",
        };

        logger?.info(`[Auth] User logged out successfully: ${req.user?._id}`);
        return res
            .status(200)
            .clearCookie("accessToken", options)
            .clearCookie("refreshToken", options)
            .json(new ApiResponse(200, {}, "User logged out successfully"));
    } catch (error) {
        logger?.error('[Auth] Logout failed:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?._id?.toString()
        });
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Unable to logout. Please try again."
        });
    }
});

const refreshAccessToken = asyncHandler(async (req, res) => {
    try {
        const incomingRefreshToken = req.cookies?.refreshToken || req.body.refreshToken;

        // Log refresh attempt
        logger?.info('[Auth] Token refresh attempt:', {
            hasRefreshToken: !!incomingRefreshToken,
            fromCookie: !!req.cookies?.refreshToken,
            fromBody: !!req.body?.refreshToken
        });

        if (!incomingRefreshToken) {
            throw new ApiError(401, "Unauthorized request - no refresh token");
        }

        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        );

        const user = await User.findById(decodedToken?._id).select("+refreshToken");
        if (!user) {
            throw new ApiError(401, "Invalid refresh token");
        }

        if (incomingRefreshToken !== user.refreshToken) {
            throw new ApiError(401, "Refresh token is expired or invalid");
        }

        const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);

        const isProduction = process.env.NODE_ENV === "production";

        const options = {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? "none" : "lax",
            path: "/",
        };

        logger?.info(`[Auth] Token refreshed successfully: ${user._id}`);
        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", refreshToken, options)
            .json(new ApiResponse(200, { accessToken: true, refreshToken: true }, "Access token refreshed successfully"));
    } catch (error) {
        logger?.error('[Auth] Token refresh failed:', {
            error: error.message,
            stack: error.stack
        });
        return res.status(error.statusCode || 401).json({
            success: false,
            message: error.message || "Unable to refresh session. Please login again."
        });
    }
});

const getCurrentUser = asyncHandler(async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select("-password -refreshToken");
        
        logger?.info(`[Auth] Current user fetched: ${req.user._id}`);
        return res
            .status(200)
            .json(new ApiResponse(200, user, "Current user fetched successfully"));
    } catch (error) {
        logger?.error('[Auth] Failed to fetch current user:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?._id?.toString()
        });
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Unable to fetch user details. Please try again."
        });
    }
});

const updateAccountDetails = asyncHandler(async (req, res) => {
    try {
        const { firstName, lastName, email, age } = req.body;

        // Log update attempt with what fields are being updated
        logger?.info('[Auth] Account update attempt:', {
            userId: req.user?._id?.toString(),
            fieldsToUpdate: Object.keys(req.body),
            firstName,
            lastName,
            email,
            age
        });

        const updateFields = {};
        if (firstName) updateFields.firstName = firstName;
        if (lastName) updateFields.lastName = lastName;
        if (email) updateFields.email = email;
        if (age) updateFields.age = age;

        if (Object.keys(updateFields).length === 0) {
            throw new ApiError(400, "No fields provided for update");
        }

        const user = await User.findByIdAndUpdate(
            req.user?._id,
            { $set: updateFields },
            { returnDocument: 'after', runValidators: true }
        ).select("-password -refreshToken");

        if (!user) {
            throw new ApiError(404, "User not found");
        }

        logger?.info(`[Auth] Account updated successfully: ${user._id}`);
        return res
            .status(200)
            .json(new ApiResponse(200, user, "Account details updated successfully"));
    } catch (error) {
        logger?.error('[Auth] Failed to update account:', {
            error: error.message,
            stack: error.stack,
            userId: req.user?._id?.toString(),
            fieldsAttempted: Object.keys(req.body || {})
        });
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Unable to update account. Please try again."
        });
    }
});

export { registerUser, loginUser, logoutUser, refreshAccessToken, getCurrentUser, updateAccountDetails };