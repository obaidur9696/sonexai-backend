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
        logger.error('Failed to generate user access and refresh tokens', error, { userId: userId.toString() });
        throw new ApiError(500, "Something went wrong while generating refresh and access token")
    }
}

const registerUser = asyncHandler(async (req, res) => {
    try {
        const { email, password, firstName, lastName, gender, age } = req.body;

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

        logger.info('User registered successfully', { userId: createdUser._id.toString() });
        return res.status(201).json(new ApiResponse(201, createdUser, "User registered successfully"));
    } catch (error) {
        logger.error('User registration failed', error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Internal Server Error"
        });
    }
});

const loginUser = asyncHandler(async (req, res) => {
    try {
        const { email, password } = req.body;

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

        logger.info('User logged in successfully', { userId: user._id.toString() });
        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", refreshToken, options)
            .json(new ApiResponse(200, { user: loggedInUser }, "User logged in successfully"));
    } catch (error) {
        logger.error('User login failed', error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Internal Server Error"
        });
    }
});

const logoutUser = asyncHandler(async (req, res) => {
    try {
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

        logger.info('User logged out successfully', { userId: req.user?._id?.toString() });
        return res
            .status(200)
            .clearCookie("accessToken", options)
            .clearCookie("refreshToken", options)
            .json(new ApiResponse(200, {}, "User logged out successfully"));
    } catch (error) {
        logger.error('User logout failed', error, { userId: req.user?._id?.toString() });
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Internal Server Error"
        });
    }
});

const refreshAccessToken = asyncHandler(async (req, res) => {
    try {
        const incomingRefreshToken = req.cookies?.refreshToken || req.body.refreshToken;

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

        logger.info('User access token refreshed successfully', { userId: user._id.toString() });
        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", refreshToken, options)
            .json(new ApiResponse(200, { accessToken: true, refreshToken: true }, "Access token refreshed successfully"));
    } catch (error) {
        logger.error('User access token refresh failed', error);
        return res.status(error.statusCode || 401).json({
            success: false,
            message: error.message || "Invalid refresh token"
        });
    }
});

const getCurrentUser = asyncHandler(async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select("-password -refreshToken");
        logger.info('Current user fetched successfully', { userId: req.user._id.toString() });
        return res
            .status(200)
            .json(new ApiResponse(200, user, "Current user fetched successfully"));
    } catch (error) {
        logger.error('Failed to fetch current user', error, { userId: req.user?._id?.toString() });
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Internal Server Error"
        });
    }
});

const updateAccountDetails = asyncHandler(async (req, res) => {
    try {
        const { firstName, lastName, email, age } = req.body;

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

        logger.info('Account details updated successfully', { userId: user._id.toString() });
        return res
            .status(200)
            .json(new ApiResponse(200, user, "Account details updated successfully"));
    } catch (error) {
        logger.error('Failed to update account details', error, { userId: req.user?._id?.toString() });
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Internal Server Error"
        });
    }
});

export { registerUser, loginUser, logoutUser, refreshAccessToken, getCurrentUser, updateAccountDetails };
