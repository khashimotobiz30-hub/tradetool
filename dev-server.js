#!/usr/bin/env node
// ============================================================
// dev-server.js — ローカル開発サーバー (vercel dev 代替)
//
// 役割:
//   GET /api/stock  → api/stock.js ハンドラを呼ぶ
//   その他          → 静的ファイルを serve する
//
// 使い方: node dev-server.js [port]
// ============================================================
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// --- API ハンドラを読み込む ---
const analyzeHandler = require('./api/analyze');

// --- Vercel 風の res ラッパー ---
function makeVercelRes(nodeRes) {
  return {
    _status: 200,
    status(s) { this._status = s; return this; },
    json(body) {
      const payload = JSON.stringify(body);
      nodeRes.writeHead(this._status, {
        'Content-Type':  'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      nodeRes.end(payload);
    },
  };
}

// --- POST リクエストの JSON ボディを読み取る ---
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// --- 静的ファイル配信 ---
function serveStatic(req, res) {
  let filePath = path.join(ROOT, req.url === '/' ? '/index.html' : req.url);
  // クエリストリングを除去
  filePath = filePath.split('?')[0];

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`404 Not Found: ${req.url}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// --- メインサーバー ---
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${req.method} ${url}`);

  // /api/analyze ルーティング (POST + JSON ボディパース)
  if (url === '/api/analyze') {
    const vercelRes = makeVercelRes(res);
    try {
      const body = await readJsonBody(req);
      await analyzeHandler({ method: req.method, url: req.url, body }, vercelRes);
    } catch (err) {
      console.error('[dev-server] /api/analyze error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'InternalServerError', message: err.message }));
    }
    return;
  }

  // 静的ファイル
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n🚀 dev-server 起動 → http://localhost:${PORT}`);
  console.log(`   /api/analyze → api/analyze.js (OpenAI 画面解析)`);
  console.log(`   その他       → 静的ファイル配信\n`);
});
