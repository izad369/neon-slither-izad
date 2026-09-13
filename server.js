// Neon Slither — authoritative multiplayer server
//
// This server owns the entire game world. Every phone that connects only
// ever sends "here's the direction I want to go" and receives back "here's
// what the whole arena looks like right now" — the server decides who ate
// what, who died, and where everything is.
//
// This version also includes:
//   - a simple account system (register/login, stored in users.json)
//   - a lobby/matchmaking queue before joining the live arena
//   - per-run skin selection tied to a player's best score

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'users.json');

// ================================================================
//  ACCOUNTS
// ================================================================
function loadUsers(){
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for(const key of Object.keys(data)){ if(!Array.isArray(data[key].friends)) data[key].friends = []; }
    return data;
  }
  catch { return {}; }
}
function saveUsers(users){
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function hashPassword(password, salt){
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}
function makeToken(){
  return crypto.randomBytes(24).toString('hex');
}

let users = loadUsers();
const tokens = new Map(); // token -> username (in-memory; cleared on restart)

// ---------------- chat / friends support ----------------
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
function loadMessages(){
  try { return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveMessages(m){
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(m, null, 2));
}
let messages = loadMessages();
function conversationKey(a, b){ return [a,b].sort().join('|'); }

// username(lowercased) -> socket, used for chat presence/delivery. This is
// a lightweight "social" connection, separate from being in a live arena.
const onlineUsers = new Map();

function readJsonBody(req){
  return new Promise((resolve, reject)=>{
    let body = '';
    req.on('data', chunk=>{ body += chunk; if(body.length > 1e6) req.destroy(); });
    req.on('end', ()=>{ try { resolve(body ? JSON.parse(body) : {}); } catch(e){ reject(e); } });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname){
  res.setHeader('Content-Type', 'application/json');

  if(pathname === '/api/register' && req.method === 'POST'){
    const { username, password } = await readJsonBody(req);
    if(!username || !password || username.length < 3 || password.length < 4){
      res.writeHead(400); res.end(JSON.stringify({ error:'Username needs 3+ chars, password 4+ chars.' })); return;
    }
    const key = username.toLowerCase();
    if(users[key]){ res.writeHead(409); res.end(JSON.stringify({ error:'That username is taken.' })); return; }
    const salt = crypto.randomBytes(16).toString('hex');
    users[key] = { username, salt, hash: hashPassword(password, salt), bestScore: 0, skin: 'classic', friends: [] };
    saveUsers(users);
    const token = makeToken();
    tokens.set(token, key);
    res.writeHead(200); res.end(JSON.stringify({ token, username, bestScore:0, skin:'classic' }));
    return;
  }

  if(pathname === '/api/login' && req.method === 'POST'){
    const { username, password } = await readJsonBody(req);
    const key = (username||'').toLowerCase();
    const u = users[key];
    if(!u || hashPassword(password||'', u.salt) !== u.hash){
      res.writeHead(401); res.end(JSON.stringify({ error:'Wrong username or password.' })); return;
    }
    const token = makeToken();
    tokens.set(token, key);
    res.writeHead(200); res.end(JSON.stringify({ token, username:u.username, bestScore:u.bestScore, skin:u.skin }));
    return;
  }

  if(pathname === '/api/profile' && req.method === 'POST'){
    const { token } = await readJsonBody(req);
    const key = tokens.get(token);
    const u = key && users[key];
    if(!u){ res.writeHead(401); res.end(JSON.stringify({ error:'Session expired, please log in again.' })); return; }
    res.writeHead(200); res.end(JSON.stringify({ username:u.username, bestScore:u.bestScore, skin:u.skin }));
    return;
  }

  if(pathname === '/api/set-skin' && req.method === 'POST'){
    const { token, skin } = await readJsonBody(req);
    const key = tokens.get(token);
    const u = key && users[key];
    if(!u){ res.writeHead(401); res.end(JSON.stringify({ error:'Not logged in.' })); return; }
    u.skin = skin; saveUsers(users);
    res.writeHead(200); res.end(JSON.stringify({ ok:true }));
    return;
  }

  if(pathname === '/api/search-users' && req.method === 'POST'){
    const { token, query } = await readJsonBody(req);
    const key = tokens.get(token);
    const me = key && users[key];
    if(!me){ res.writeHead(401); res.end(JSON.stringify({ error:'Not logged in.' })); return; }
    const q = (query||'').toLowerCase().trim();
    if(q.length < 2){ res.writeHead(200); res.end(JSON.stringify({ results:[] })); return; }
    const results = Object.keys(users)
      .filter(k => k !== key && k.includes(q))
      .slice(0, 15)
      .map(k => ({ username: users[k].username, online: onlineUsers.has(k), isFriend: me.friends.includes(k) }));
    res.writeHead(200); res.end(JSON.stringify({ results }));
    return;
  }

  if(pathname === '/api/friends/list' && req.method === 'POST'){
    const { token } = await readJsonBody(req);
    const key = tokens.get(token);
    const me = key && users[key];
    if(!me){ res.writeHead(401); res.end(JSON.stringify({ error:'Not logged in.' })); return; }
    const list = me.friends.map(fk => {
      const f = users[fk];
      return f ? { username: f.username, online: onlineUsers.has(fk) } : null;
    }).filter(Boolean);
    res.writeHead(200); res.end(JSON.stringify({ friends: list }));
    return;
  }

  if(pathname === '/api/friends/add' && req.method === 'POST'){
    const { token, target } = await readJsonBody(req);
    const key = tokens.get(token);
    const me = key && users[key];
    if(!me){ res.writeHead(401); res.end(JSON.stringify({ error:'Not logged in.' })); return; }
    const targetKey = (target||'').toLowerCase().trim();
    const targetUser = users[targetKey];
    if(!targetUser){ res.writeHead(404); res.end(JSON.stringify({ error:'No player with that username.' })); return; }
    if(targetKey === key){ res.writeHead(400); res.end(JSON.stringify({ error:"You can't add yourself." })); return; }
    if(!me.friends.includes(targetKey)) me.friends.push(targetKey);
    if(!targetUser.friends.includes(key)) targetUser.friends.push(key);
    saveUsers(users);
    res.writeHead(200); res.end(JSON.stringify({ ok:true, username: targetUser.username }));
    return;
  }

  if(pathname === '/api/chat/history' && req.method === 'POST'){
    const { token, withUser } = await readJsonBody(req);
    const key = tokens.get(token);
    const me = key && users[key];
    if(!me){ res.writeHead(401); res.end(JSON.stringify({ error:'Not logged in.' })); return; }
    const otherKey = (withUser||'').toLowerCase().trim();
    if(!me.friends.includes(otherKey)){ res.writeHead(403); res.end(JSON.stringify({ error:'Not friends with that player.' })); return; }
    const convo = conversationKey(key, otherKey);
    const history = messages[convo] || [];
    res.writeHead(200); res.end(JSON.stringify({ messages: history.slice(-50) }));
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error:'Not found' }));
}

function recordScoreForToken(token, score){
  const key = tokens.get(token);
  if(!key) return;
  const u = users[key];
  if(u && score > u.bestScore){
    u.bestScore = score;
    saveUsers(users);
  }
}

// ================================================================
//  ARENA (same simulation as before, now with client-chosen colors)
// ================================================================
const WORLD_SIZE = 4000;
const FOOD_TARGET = 260;
const BASE_SPEED = 160;
const BOOST_SPEED = 280;
const TURN_RATE = 3.2;
const SEG_SPACING = 9;
const START_LENGTH = 60;
const HEAD_RADIUS = 11;
const GROWTH_PER_FOOD = 6;
const BOOST_DRAIN_PER_SEC = 4;
const TICK_RATE = 30;
const DEFAULT_COLORS = ['#4fd6ff','#ff5da2','#7cff8f','#ffd23f','#b48bff','#ff8a4f'];

let players = new Map();
let food = [];
let nextFoodId = 1;

function rand(a,b){ return a + Math.random()*(b-a); }
function dist(x1,y1,x2,y2){ return Math.hypot(x1-x2, y1-y2); }

function spawnFood(n){
  for(let i=0;i<n;i++){
    food.push({
      id: nextFoodId++,
      x: rand(-WORLD_SIZE/2+50, WORLD_SIZE/2-50),
      y: rand(-WORLD_SIZE/2+50, WORLD_SIZE/2-50),
      r: rand(4,7),
      color: DEFAULT_COLORS[Math.floor(Math.random()*DEFAULT_COLORS.length)]
    });
  }
}
spawnFood(FOOD_TARGET);

function scatterFoodFromDeath(pathPoints, count){
  for(let i=0;i<count;i++){
    const p = pathPoints[Math.floor(rand(0, pathPoints.length))];
    if(!p) continue;
    food.push({ id: nextFoodId++, x: p.x+rand(-20,20), y: p.y+rand(-20,20), r: rand(5,9),
      color: DEFAULT_COLORS[Math.floor(Math.random()*DEFAULT_COLORS.length)] });
  }
}

function makePlayer(id, name, color, socket, token){
  const startX = rand(-500,500), startY = rand(-500,500);
  const angle = rand(0, Math.PI*2);
  return {
    id, name:(name||'Player').slice(0,16), socket, token,
    path:[{x:startX,y:startY}], angle, targetAngle:angle,
    length: START_LENGTH, boosting:false, alive:true,
    color: color || DEFAULT_COLORS[Math.floor(Math.random()*DEFAULT_COLORS.length)]
  };
}

function segmentsFor(p){
  const segs = []; let travelled = 0, need = p.length;
  segs.push(p.path[0]);
  for(let i=1;i<p.path.length && travelled < need; i++){
    const a=p.path[i-1], b=p.path[i];
    travelled += dist(a.x,a.y,b.x,b.y);
    if(travelled >= segs.length*SEG_SPACING) segs.push(b);
  }
  return segs;
}

function killPlayer(p){
  p.alive = false;
  const segs = segmentsFor(p);
  scatterFoodFromDeath(segs, Math.min(40, Math.floor(p.length/6)));
  if(p.token) recordScoreForToken(p.token, Math.floor(p.length));
  if(p.socket && p.socket.readyState === 1){
    p.socket.send(JSON.stringify({ type:'dead', score: Math.floor(p.length) }));
  }
}

function tick(dt){
  if(food.length < FOOD_TARGET) spawnFood(Math.min(6, FOOD_TARGET-food.length));

  for(const p of players.values()){
    if(!p.alive) continue;
    let diff = ((p.targetAngle - p.angle + Math.PI*3) % (Math.PI*2)) - Math.PI;
    const maxTurn = TURN_RATE*dt;
    p.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));

    const speed = (p.boosting && p.length > START_LENGTH*0.7) ? BOOST_SPEED : BASE_SPEED;
    if(p.boosting && p.length > START_LENGTH*0.7){
      p.length = Math.max(START_LENGTH*0.6, p.length - BOOST_DRAIN_PER_SEC*dt);
      if(Math.random() < 0.25) scatterFoodFromDeath([p.path[0]], 1);
    }

    const head = p.path[0];
    const nx = head.x + Math.cos(p.angle)*speed*dt;
    const ny = head.y + Math.sin(p.angle)*speed*dt;
    p.path.unshift({x:nx,y:ny});
    const maxPathLen = Math.ceil((p.length/SEG_SPACING)*1.4) + 20;
    if(p.path.length > maxPathLen) p.path.length = maxPathLen;

    if(Math.abs(nx) > WORLD_SIZE/2 || Math.abs(ny) > WORLD_SIZE/2){ killPlayer(p); continue; }
  }

  for(const p of players.values()){
    if(!p.alive) continue;
    const head = p.path[0];
    for(let i=food.length-1;i>=0;i--){
      const f = food[i];
      if(dist(head.x,head.y,f.x,f.y) < HEAD_RADIUS+f.r){ food.splice(i,1); p.length += GROWTH_PER_FOOD; }
    }
  }

  const alivePlayers = [...players.values()].filter(p=>p.alive);
  const segCache = new Map();
  for(const p of alivePlayers) segCache.set(p.id, segmentsFor(p));
  for(const p of alivePlayers){
    const head = p.path[0];
    for(const other of alivePlayers){
      if(other.id === p.id) continue;
      const segs = segCache.get(other.id);
      for(let i=1;i<segs.length;i++){
        if(dist(head.x,head.y,segs[i].x,segs[i].y) < HEAD_RADIUS*1.1){ killPlayer(p); break; }
      }
      if(!p.alive) break;
    }
  }
}

function broadcastState(){
  const alive = [...players.values()].filter(p=>p.alive);
  const leaderboard = alive.slice().sort((a,b)=>b.length-a.length).slice(0,5)
    .map(p=>({ name:p.name, score:Math.floor(p.length) }));

  // pre-compute each player's full segment list once — the previous version
  // re-sent this AND the entire (up to 260-item) food array to EVERY socket
  // on every tick uncropped, which is what was causing the lag online
  const publicPlayersFull = alive.map(p=>({
    id:p.id, name:p.name, color:p.color,
    segs: segmentsFor(p).map(s=>({x:Math.round(s.x), y:Math.round(s.y)})),
    length: Math.floor(p.length),
    _headX: p.path[0].x, _headY: p.path[0].y
  }));

  // nothing further than this could plausibly be visible to a given player,
  // so there's no reason to spend bytes sending it to them specifically
  const VIEW_RADIUS = 1500;

  for(const me of players.values()){
    if(!(me.socket && me.socket.readyState === 1)) continue;
    const head = me.path[0];

    const nearFood = [];
    for(const f of food){
      if(Math.abs(f.x-head.x) < VIEW_RADIUS && Math.abs(f.y-head.y) < VIEW_RADIUS){
        nearFood.push({ x:Math.round(f.x), y:Math.round(f.y), r:f.r, c:f.color });
      }
    }

    const players_ = publicPlayersFull.map(p=>{
      if(p.id === me.id) return { id:p.id, name:p.name, color:p.color, segs:p.segs, length:p.length };
      const near = Math.abs(p._headX-head.x) < VIEW_RADIUS*1.4 && Math.abs(p._headY-head.y) < VIEW_RADIUS*1.4;
      return { id:p.id, name:p.name, color:p.color, length:p.length,
        segs: near ? p.segs : (p.segs[0] ? [p.segs[0]] : []) };
    });

    const payload = JSON.stringify({ type:'state', players:players_, food:nearFood, leaderboard, worldSize: WORLD_SIZE });
    me.socket.send(payload);
  }
}

let lastTick = Date.now();
setInterval(()=>{
  const now = Date.now();
  const dt = Math.min((now-lastTick)/1000, 0.1);
  lastTick = now;
  tick(dt);
  broadcastState();
}, 1000/TICK_RATE);

// ================================================================
//  LOBBY / MATCHMAKING
// ================================================================
const LOBBY_THRESHOLD = 2;   // start as soon as this many are waiting together
const LOBBY_MAX_WAIT = 12000; // ...but never make a lone player wait longer than this
let waiting = new Map(); // socket -> { joinedAt, timer }

function broadcastLobbyCount(){
  const count = waiting.size;
  for(const socket of waiting.keys()){
    if(socket.readyState === 1) socket.send(JSON.stringify({ type:'lobby-count', count }));
  }
}

function tryStartLobby(){
  if(waiting.size >= LOBBY_THRESHOLD){
    for(const [socket, info] of waiting){
      clearTimeout(info.timer);
      if(socket.readyState === 1) socket.send(JSON.stringify({ type:'lobby-start' }));
    }
    waiting.clear();
  }
}

// ================================================================
//  STATIC FILE + API SERVER
// ================================================================
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
const server = http.createServer((req,res)=>{
  const u = new URL(req.url, `http://${req.headers.host}`);
  if(u.pathname.startsWith('/api/')){
    handleApi(req, res, u.pathname).catch(()=>{ res.writeHead(500); res.end('{"error":"server error"}'); });
    return;
  }
  let filePath = u.pathname === '/' ? '/index.html' : u.pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if(!filePath.startsWith(PUBLIC_DIR)){ res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err,data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path:'/ws' });
wss.on('connection', (socket)=>{
  let id = null;          // this connection's live-arena player id (if any)
  let socialKey = null;   // this connection's logged-in username key (if any)

  socket.on('message', (raw)=>{
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if(msg.type === 'lobby-join'){
      const timer = setTimeout(()=>{
        if(waiting.has(socket)){
          waiting.delete(socket);
          if(socket.readyState === 1) socket.send(JSON.stringify({ type:'lobby-start' }));
        }
      }, LOBBY_MAX_WAIT);
      waiting.set(socket, { joinedAt: Date.now(), timer });
      broadcastLobbyCount();
      tryStartLobby();

    } else if(msg.type === 'lobby-leave'){
      const info = waiting.get(socket);
      if(info) clearTimeout(info.timer);
      waiting.delete(socket);
      broadcastLobbyCount();

    } else if(msg.type === 'join'){
      const info = waiting.get(socket);
      if(info) clearTimeout(info.timer);
      waiting.delete(socket);

      id = 'p'+Math.random().toString(36).slice(2,9);
      const p = makePlayer(id, msg.name, msg.color, socket, msg.token);
      players.set(id, p);
      socket.send(JSON.stringify({ type:'welcome', id, color:p.color, worldSize: WORLD_SIZE }));

    } else if(msg.type === 'input' && id && players.has(id)){
      const p = players.get(id);
      if(typeof msg.angle === 'number') p.targetAngle = msg.angle;
      p.boosting = !!msg.boost;

    } else if(msg.type === 'respawn' && id && players.has(id)){
      const old = players.get(id);
      players.set(id, makePlayer(id, old.name, old.color, socket, old.token));

    // ---------------- social presence (for chat) ----------------
    } else if(msg.type === 'social-hello'){
      const key = tokens.get(msg.token);
      if(!key) return;
      socialKey = key;
      onlineUsers.set(key, socket);

    // ---------------- text chat ----------------
    } else if(msg.type === 'chat-send'){
      const key = tokens.get(msg.token);
      const me = key && users[key];
      const otherKey = (msg.to||'').toLowerCase().trim();
      if(!me || !me.friends.includes(otherKey)) return;
      const convo = conversationKey(key, otherKey);
      const entry = { from: me.username, text: String(msg.text||'').slice(0,500), ts: Date.now() };
      if(!messages[convo]) messages[convo] = [];
      messages[convo].push(entry);
      if(messages[convo].length > 200) messages[convo] = messages[convo].slice(-200);
      saveMessages(messages);
      socket.send(JSON.stringify({ type:'chat-sent', to:otherKey, entry }));
      const otherSocket = onlineUsers.get(otherKey);
      if(otherSocket && otherSocket.readyState === 1){
        otherSocket.send(JSON.stringify({ type:'chat-incoming', from:key, entry }));
      }

    // ---------------- voice chat signaling relay (arena players only) ----------------
    } else if((msg.type === 'voice-offer' || msg.type === 'voice-answer' || msg.type === 'voice-ice') && id){
      const target = players.get(msg.targetId);
      if(target && target.socket && target.socket.readyState === 1){
        target.socket.send(JSON.stringify({ ...msg, fromId: id }));
      }
    } else if(msg.type === 'voice-leave' && id){
      for(const [pid, p] of players){
        if(pid !== id && p.socket && p.socket.readyState === 1){
          p.socket.send(JSON.stringify({ type:'voice-peer-left', fromId: id }));
        }
      }
    }
  });

  socket.on('close', ()=>{
    if(id){
      players.delete(id);
      for(const [pid, p] of players){
        if(p.socket && p.socket.readyState === 1){
          p.socket.send(JSON.stringify({ type:'voice-peer-left', fromId: id }));
        }
      }
    }
    const info = waiting.get(socket);
    if(info){ clearTimeout(info.timer); waiting.delete(socket); broadcastLobbyCount(); }
    if(socialKey && onlineUsers.get(socialKey) === socket) onlineUsers.delete(socialKey);
  });
});

server.listen(PORT, ()=>{
  console.log('Neon Slither server running on port', PORT);
});

// ================================================================
//  KEEP-ALIVE SELF-PING
// ================================================================
// Render's free tier spins a web service down after ~15 minutes with no
// incoming HTTP traffic. Pinging our own public URL periodically counts
// as real incoming traffic and resets that timer, so the server (and the
// arena inside it) stays awake. RENDER_EXTERNAL_URL is set automatically
// by Render — this does nothing when run anywhere else (like locally).
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if(SELF_URL){
  setInterval(()=>{
    fetch(SELF_URL).catch(()=>{ /* a missed ping isn't a big deal, it just tries again next time */ });
  }, 1000*60*10); // every 10 minutes — comfortably under the ~15 minute spin-down window
  console.log('Self-ping keep-alive enabled for', SELF_URL);
}
