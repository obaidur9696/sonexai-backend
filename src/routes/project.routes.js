import express from 'express';
import { getProjectConfiguration } from '../controllers/project.controllers.js';

const router = express.Router();

router.get('/configuration', getProjectConfiguration);

export default router;