import jwt from "jsonwebtoken";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from '../models/user.models.js'

export const verifyJWT = asyncHandler(async (req, res, next) => {

    try {
       
        // Here, we receive the token either from cookies or from the Authorization Bearer header.
        const token =
            req.cookies?.accessToken ||
            req.headers.authorization?.replace(/^Bearer\s+/i, "");

        if (!token) {
            throw new ApiError(401, "Unauthorized request wrong token or token is empty");
        }

        const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

        const user = await User.findById(decodedToken?._id)

        if (!user) {
            // discussion about frontend here
            throw new ApiError(401, "Invalid Access Token")
        }

        req.user = user;
        next()
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid Access Token")
    }
})