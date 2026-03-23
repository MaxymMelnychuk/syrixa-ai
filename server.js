
'use strict';

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const url      = require('url');
const { IncomingForm } = require('formidable');

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

const PORT  = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL   = process.env.OPENROUTER_MODEL   || 'openai/gpt-4o-mini';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

let rag = null;
try {
  rag = require('./rag');
} catch (e) {
  console.warn('⚠ RAG module not active or missing dependencies:', e.message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const rs   = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
    rs.pipe(res);
  });
}

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
      path:     '/api/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(body),
        'Authorization':   `Bearer ${API_KEY}`,
        'HTTP-Referer':    `http://localhost:${PORT}`,
        'X-Title':         'Syrixa AI Chat',
      },
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
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

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://openrouter.ai;");
}

const server = http.createServer(async (req, res) => {
  setCORSHeaders(res);
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const parsed  = url.parse(req.url, true);
  const pathname = parsed.pathname;

 
  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  if (pathname === '/api/upload' && req.method === 'POST') {
    const form = new IncomingForm({
      uploadDir: path.join(__dirname, 'uploads'),
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024 
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
      const raw  = await readBody(req);
      const body = JSON.parse(raw);

      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) {
        return sendJSON(res, 400, { error: 'No messages provided.' });
      }

      const documentId = body.documentId;
      let contextText = '';
      if (documentId && rag) {
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        if (lastUserMsg) {
          contextText = await rag.queryDocument(documentId, lastUserMsg.content);
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
    res.writeHead(403); res.end('Forbidden'); return;
  }

  serveStatic(req, res, filePath);
});

server.listen(PORT, () => {
  console.log(`\n✦ Syrixa AI Chat running at http://localhost:${PORT}\n`);
  if (!API_KEY || API_KEY === 'your-openrouter-api-key-here') {
    console.warn('⚠  WARNING: OPENROUTER_API_KEY is not set in .env!\n');
  }
});
