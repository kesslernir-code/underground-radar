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

const server = http.createServer(async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve frontend
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), function(err, data) {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // GET /api/tasks
  if (req.method === 'GET' && req.url === '/api/tasks') {
    res.setHeader('Content-Type', 'application/json');
    var result = await supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: false });
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
          status: 'todo'
        }])
        .select()
        .single();
      if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
      res.writeHead(201);
      res.end(JSON.stringify(result.data));
    } catch(e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid request' }));
    }
    return;
  }

  // PATCH /api/tasks/:id
  var patchMatch = req.url.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'PATCH' && patchMatch) {
    res.setHeader('Content-Type', 'application/json');
    try {
      var body = JSON.parse(await readBody(req));
      var allowed = ['status', 'title', 'description', 'priority', 'due_date'];
      var updates = {};
      allowed.forEach(function(k) { if (body[k] !== undefined) updates[k] = body[k]; });
      var result = await supabase
        .from('tasks')
        .update(updates)
        .eq('id', patchMatch[1])
        .select()
        .single();
      if (result.error) { res.writeHead(500); res.end(JSON.stringify({ error: result.error.message })); return; }
      res.writeHead(200);
      res.end(JSON.stringify(result.data));
    } catch(e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid request' }));
    }
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
  console.log('Task manager running on port ' + PORT);
});
