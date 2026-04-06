'use strict';

/**
 * Syrixa backend: plain Node HTTP server.
 *
 * Serves the static SPA (HTML/CSS/JS), accepts file uploads for RAG, and proxies chat
 * to OpenRouter. Keeping everything in one file keeps the project easy to read and
 * deploy without a framework.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { IncomingForm } = require('formidable');

/**
 * Loads `.env` into `process.env` if the file exists.
 * We do this manually so the app runs without extra dependencies like `dotenv`.
 */
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
})();

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

/** Max upload size for a single document (bytes). Keeps memory and abuse bounded. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** RAG module is optional at runtime if deps fail; chat still works without uploads. */
let rag = null;
try {
  rag = require('./rag');
} catch (e) {
  console.warn('⚠ RAG module not active or missing dependencies:', e.message);
}

/**
 * Reads the full request body as a UTF-8 string (used for JSON POST bodies).
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Lets browsers call the API from another origin during local dev or split hosting.
 */
function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Sends a JSON response with explicit length (helps some proxies and clients).
 *
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {object} obj
 */
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Streams a file from disk with the right Content-Type, or 404 if missing.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} filePath Resolved path under project root
 */
function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const rs = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
    rs.pipe(res);
  });
}

/**
 * Calls OpenRouter's chat completions API with the given message list (includes system).
 *
 * @param {{ role: string, content: string }[]} messages
 * @returns {Promise<string>} Assistant text only
 */
function callOpenRouter(messages) {
  return new Promise((resolve, reject) => {
    if (!API_KEY || API_KEY === 'your-openrouter-api-key-here') {
      return reject(new Error('OPENROUTER_API_KEY is not set. Please add it to your .env file.'));
    }

    const body = JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${API_KEY}`,
        'HTTP-Referer': `http://localhost:${PORT}`,
        'X-Title': 'Syrixa AI Chat',
      },
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            return reject(new Error(parsed.error.message || 'OpenRouter API error'));
          }
          const reply = parsed.choices?.[0]?.message?.content ?? '';
          resolve(reply.trim());
        } catch (e) {
          reject(new Error('Failed to parse OpenRouter response'));
        }
      });
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

/**
 * Baseline security headers for the static app and API responses.
 */
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://openrouter.ai;"
  );
}

const server = http.createServer(async (req, res) => {
  setCORSHeaders(res);
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  if (pathname === '/api/upload' && req.method === 'POST') {
    const form = new IncomingForm({
      uploadDir: path.join(__dirname, 'uploads'),
      keepExtensions: true,
      maxFileSize: MAX_UPLOAD_BYTES,
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        return sendJSON(res, 400, { error: 'Upload parsing failed' });
      }
      try {
        if (!rag) throw new Error('RAG module disabled or broken.');

        const fileField = files.document;
        const uploadedFile = Array.isArray(fileField) ? fileField[0] : fileField;

        if (!uploadedFile) throw new Error('No file uploaded under "document" field.');

        const documentId = await rag.processDocument(uploadedFile.filepath, uploadedFile.mimetype);

        fs.unlinkSync(uploadedFile.filepath);

        return sendJSON(res, 200, { documentId });
      } catch (e) {
        console.error('[Upload Error]', e.message);
        return sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJSON(res, 400, { error: 'Invalid JSON body.' });
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) {
        return sendJSON(res, 400, { error: 'No messages provided.' });
      }

      const documentId = body.documentId;
      let contextText = '';
      if (documentId && rag) {
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        if (lastUserMsg) {
          contextText = (await rag.queryDocument(documentId, lastUserMsg.content)) || '';
        }
      }

      let systemPrompt = `You are Syrixa, a friendly and intelligent AI assistant. 
You give clear, concise, and helpful answers. 
You have a warm and professional personality. 
Keep responses conversational and to the point unless asked for detail.`;

      if (contextText) {
        systemPrompt += `\n\n--- DOCUMENT CONTEXT ---\n${contextText}\n------------------------\nAnswer the user's questions utilizing the context above if relevant. If the context doesn't contain the answer, say so based on your own knowledge.`;
      }

      const fullMessages = [
        {
          role: 'system',
          content: systemPrompt,
        },
        ...messages,
      ];

      const reply = await callOpenRouter(fullMessages);
      return sendJSON(res, 200, { reply });
    } catch (err) {
      console.error('[API Error]', err.message);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    filePath = path.join(__dirname, pathname);
  }

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  serveStatic(req, res, filePath);
});

server.listen(PORT, () => {
  console.log(`\n✦ Syrixa AI Chat running at http://localhost:${PORT}\n`);
  if (!API_KEY || API_KEY === 'your-openrouter-api-key-here') {
    console.warn('⚠  WARNING: OPENROUTER_API_KEY is not set in .env!\n');
  }
});

/**
 * Stops accepting new connections and exits cleanly so Docker/Kubernetes can restart safely.
 */
function shutdown(signal) {
  console.log(`\n${signal} received, closing server…`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
