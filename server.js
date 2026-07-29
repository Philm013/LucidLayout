/**
 * PNG Grid — local static file server
 *
 * Serves the static app. The Lucid REST API is called directly from the
 * browser (js/lucid-export.js) — Lucid's API supports CORS, so no
 * server-side proxy is needed for API requests.
 *
 * Usage:  node server.js   (then open http://localhost:3001)
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`PNG Grid server running at http://localhost:${PORT}`);
});

