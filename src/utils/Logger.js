/* ------------------------------------------------------------------------------------
   Company Name:   ALMAwiz Technologies Pvt. Ltd.
   Description:    Simple ES6+ logger — module-level singleton, no class needed
   Copyright:      ©2024 ALMAwiz Technologies, All Rights Reserved.
   ------------------------------------------------------------------------------------ */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';

// Silence winston's internal listener stacking globally
EventEmitter.defaultMaxListeners = 0;

// ─── Config ───────────────────────────────────────────────────────────────────

const LOG_DIR   = path.join(process.cwd(), 'logs');
const MAX_SIZE  = '5m';
const MAX_FILES = '30d';
const DATE_PAT  = 'YYYY-MM-DD';
const LEVEL     = 'debug';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTimestamp() {
	const d  = new Date();
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	const ms = String(d.getMilliseconds()).padStart(3, '0');
	return `${hh}:${mm}:${ss}.${ms}`;
}

function formatArgs(args) {
	if (!args.length) return '';
	return args.map(arg => {
		if (arg === null)         return '<null>';
		if (arg === undefined)    return '<undefined>';
		if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
		if (typeof arg === 'object') {
			try { return JSON.stringify(arg); }
			catch { return '[Circular or Non-serializable Object]'; }
		}
		return String(arg);
	}).join(' ');
}

// ─── Transport factory ────────────────────────────────────────────────────────

const customFormat = winston.format.combine(
	winston.format.timestamp({ format: getTimestamp }),
	winston.format.printf(({ timestamp, level, message }) =>
		`${timestamp} ${level.toUpperCase()}: ${message}`
	)
);

function makeTransport(subdir, level) {
	const dir = path.join(LOG_DIR, subdir);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

	const transport = new DailyRotateFile({
		level,
		filename:    path.join(dir, `${subdir}-%DATE%.log`),
		datePattern: DATE_PAT,
		maxSize:     MAX_SIZE,
		maxFiles:    MAX_FILES,
		format:      customFormat,
	});

	transport.setMaxListeners(0); // no limit — winston legitimately stacks listeners
	return transport;
}

// ─── Winston instance (created once at module load) ───────────────────────────

const _winston = winston.createLogger({
	level:             LEVEL,
	format:            customFormat,
	transports:        [makeTransport('log', LEVEL), makeTransport('error', 'error')],
	exceptionHandlers: [makeTransport('exception', LEVEL)],
	exitOnError:       false,
});

// ─── Public API ───────────────────────────────────────────────────────────────

const logger = {
	error:   (...args) => _winston.error(formatArgs(args)),
	warn:    (...args) => _winston.warn(formatArgs(args)),
	info:    (...args) => _winston.info(formatArgs(args)),
	debug:   (...args) => _winston.debug(formatArgs(args)),
	verbose: (...args) => _winston.verbose(formatArgs(args)),
	silly:   (...args) => _winston.silly(formatArgs(args)),
};

export default logger;