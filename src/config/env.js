import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(currentDirectory, '../../.env');

// This module is imported before any code reads process.env. ES modules are
// cached, so dotenv loads the file only once even when several modules import it.
dotenv.config({ path: envPath });

// Keep a safe local-development default while ensuring this value is always a
// string for every module that imports this configuration.
if (!process.env.CORS_ORIGIN?.trim()) {
  process.env.CORS_ORIGIN = 'http://localhost:5173';
}
