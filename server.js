require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() { resolve(body); });
    req.on('error', reject);
  });
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="100" fill="#0a0a0a"/>
  <rect x="40" y="40" width="432" height="432" rx="72" fill="#111111"/>
  <text x="256" y="200" text-anchor="middle" font-family="sans-serif" font-size="80" font-weight="300" fill="#888">kessler</text>
  <text x="256" y="290" text-anchor="middle" font-family="sans-serif" font-size="80" font-weight="700" fill="#c8ff00">task</text>
  <polyline points="156,360 220,424 356,300" fill="none" stroke="#c8ff00" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const MANIFEST = JSON.stringify({
  name: "Kessler Task",
  short_name: "Tasks",
  description: "Personal task manager",
  start_url: "/",
  display: "standalone",
  background_color: "#0a0a0a",
  theme_color: "#0a0a0a",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }
  ]
});

const server = http.createServer(async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Frontend
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), function(err, data) {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // PWA assets
  if (req.method === 'GET' && req.url === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public,max-age=86400' });
    res.end(ICON_SVG);
    return;
  }
  if (req.method === 'GET' && req.url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(MANIFEST);
    return;
  }

  // GET /api/projects
  if (req.method === 'GET' && req.url === '/api/projects') {
    res.setHeader('Content-Type', 'application/json');
    var result = await supabase.from('projects').select('*').order('created_at', { ascending: true });
    if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
    res.writeHead(200);
    res.end(JSON.stringify(result.data));
    return;
  }

  // POST /api/projects
  if (req.method === 'POST' && req.url === '/api/projects') {
    res.setHeader('Content-Type', 'application/json');
    try {
      var body = JSON.parse(await readBody(req));
      if (!body.name) { res.writeHead(400); res.end(JSON.stringify({ error: 'name required' })); return; }
      var result = await supabase.from('projects').insert([{ name: body.name }]).select().single();
      if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
      res.writeHead(201);
      res.end(JSON.stringify(result.data));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid request' })); }
    return;
  }

  // DELETE /api/projects/:id
  var projDeleteMatch = req.url.match(/^\/api\/projects\/([^/]+)$/);
  if (req.method === 'DELETE' && projDeleteMatch) {
    res.setHeader('Content-Type', 'application/json');
    var result = await supabase.from('projects').delete().eq('id', projDeleteMatch[1]);
    if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // GET /api/tasks
  if (req.method === 'GET' && req.url.startsWith('/api/tasks') && !req.url.match(/^\/api\/tasks\/[^/]+$/)) {
    res.setHeader('Content-Type', 'application/json');
    var urlObj = new URL(req.url, 'http://localhost');
    var projectId = urlObj.searchParams.get('project_id');
    var query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (projectId && projectId !== 'all') query = query.eq('project_id', projectId);
    var result = await query;
    if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
    res.writeHead(200);
    res.end(JSON.stringify(result.data));
    return;
  }

  // POST /api/tasks
  if (req.method === 'POST' && req.url === '/api/tasks') {
    res.setHeader('Content-Type', 'application/json');
    try {
      var body = JSON.parse(await readBody(req));
      if (!body.title) { res.writeHead(400); res.end(JSON.stringify({ error: 'title required' })); return; }
      var result = await supabase
        .from('tasks')
        .insert([{
          title: body.title,
          description: body.description || null,
          priority: body.priority || 'normal',
          due_date: body.due_date || null,
          project_id: body.project_id || null,
          status: 'todo'
        }])
        .select()
        .single();
      if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
      res.writeHead(201);
      res.end(JSON.stringify(result.data));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid request' })); }
    return;
  }

  // PATCH /api/tasks/:id
  var patchMatch = req.url.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'PATCH' && patchMatch) {
    res.setHeader('Content-Type', 'application/json');
    try {
      var body = JSON.parse(await readBody(req));
      var allowed = ['status', 'title', 'description', 'priority', 'due_date', 'project_id'];
      var updates = {};
      allowed.forEach(function(k) { if (body[k] !== undefined) updates[k] = body[k]; });
      var result = await supabase.from('tasks').update(updates).eq('id', patchMatch[1]).select().single();
      if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
      res.writeHead(200);
      res.end(JSON.stringify(result.data));
    } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid request' })); }
    return;
  }

  // DELETE /api/tasks/:id
  var deleteMatch = req.url.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    res.setHeader('Content-Type', 'application/json');
    var result = await supabase.from('tasks').delete().eq('id', deleteMatch[1]);
    if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

var PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  console.log('Kessler Task running on port ' + PORT);
});
