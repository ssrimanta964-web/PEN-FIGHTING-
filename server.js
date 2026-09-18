/**
 * Pen Fight Arena — Phase 2 + 2b multiplayer server
 * ---------------------------------------------------
 * Express + Socket.IO, with two kinds of state:
 *
 *   - PERSISTED (survives restarts, saved to server/data/*.json): each
 *     player's name, their shareable 6-character tag, their friend graph,
 *     and chat history between friends.
 *   - LIVE (in-memory only, resets on restart — that's fine): which socket
 *     a player is currently on, which room/match they're in, matchmaking
 *     queue, disconnect grace timers.
 *
 * DESIGN NOTE — physics sync:
 * The two clients never try to run physics in lockstep (that requires a
 * fixed timestep on both devices and drifts easily across real hardware).
 * Instead, whichever player takes a shot simulates it locally (exactly like
 * the existing VS Computer physics), records a keyframe trail as it plays
 * out, and reports the result here once it settles. This server relays that
 * report to the opponent, who replays the keyframes rather than re-simulating.
 * This server is authoritative for: identity, room membership, whose turn it
 * is, and match/round scoring. It is NOT running its own physics simulation
 * and is therefore trusting each shooter's reported outcome — a deliberate,
 * documented simplification for a free-tier hobby deployment, not a claim of
 * full anti-cheat. See README-PHASE2.md for how you'd harden this later.
 *
 * DESIGN NOTE — friends/chat persistence:
 * Saved as plain JSON files on local disk. Simple, zero-config, and
 * survives a server restart. It will NOT survive a redeploy on hosts with
 * ephemeral disks (see PHASE2B-README.md) — swapping this for a real
 * database later wouldn't change any of the event contracts below.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const DISCONNECT_GRACE_MS = 25000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 — avoids ambiguity when read aloud
const TAG_CHARS = ROOM_CODE_CHARS;
const QUICK_MATCH_POLL_MS = 400;
const MAX_CHAT_HISTORY = 200;
// Ranked stats are earned ONLY from real online matches (Quick Match / Private
// Rooms), never VS Computer — VS Computer runs entirely client-side, so the
// server has no way to verify those results and won't let them feed a
// leaderboard a player could otherwise just fake locally.
const XP_PER_WIN = 100;
const XP_PER_LOSS = 30;
const XP_PER_LEVEL = 150;
function levelForXp(xp){ return Math.floor(xp / XP_PER_LEVEL) + 1; }

/* ===================== PERSISTENCE ===================== */
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

function loadJSON(file, fallback){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveJSON(file, data){
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.error('Failed to save', file, e.message); }
}

// playerId -> { name, tag, token, createdAt } — persisted identity
const persistedPlayers = loadJSON(PLAYERS_FILE, {});
// token -> playerId, tag -> playerId — rebuilt from persistedPlayers on boot
const tokenToPlayerId = new Map();
const tagToPlayerId = new Map();
Object.entries(persistedPlayers).forEach(([pid, rec]) => {
  if (rec.token) tokenToPlayerId.set(rec.token, pid);
  if (rec.tag) tagToPlayerId.set(rec.tag, pid);
});

// playerId -> { friends:[playerId], incoming:[playerId], outgoing:[playerId] } — persisted friend graph
const friendsData = loadJSON(FRIENDS_FILE, {});
function getFriendsRecord(playerId){
  if (!friendsData[playerId]) friendsData[playerId] = { friends: [], incoming: [], outgoing: [] };
  return friendsData[playerId];
}

// pairKey -> [{from, text, ts}] — persisted chat history between two friends
const chatsData = loadJSON(CHATS_FILE, {});
function pairKey(a, b){ return [a, b].sort().join(':'); }

function newId(){ return crypto.randomBytes(9).toString('base64url'); }
function newRoomCode(){
  let code;
  do { code = Array.from({length:6}, () => ROOM_CODE_CHARS[Math.floor(Math.random()*ROOM_CODE_CHARS.length)]).join(''); }
  while (roomCodeToId.has(code));
  return code;
}
function newTag(){
  let tag;
  do { tag = Array.from({length:6}, () => TAG_CHARS[Math.floor(Math.random()*TAG_CHARS.length)]).join(''); }
  while (tagToPlayerId.has(tag));
  return tag;
}

/* ===================== HTTP ===================== */
function onlineCount(){
  let n = 0;
  for (const r of playerIdToPlayer.values()) if (r.online) n++;
  return n;
}
const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.get('/', (req, res) => {
  res.type('text/plain').send('Pen Fight Arena server is running. Rooms: ' + rooms.size + ' | Players online: ' + onlineCount());
});
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, players: onlineCount() }));
// Lightweight endpoint for the client's lobby "players online" badge — plain
// HTTP polling rather than a socket, so it works even for players who
// haven't identified/connected via Socket.IO yet (e.g. just looking at the menu).
app.get('/presence', (req, res) => res.json({ online: onlineCount() }));
// Ranked leaderboard — sourced only from persisted match stats (real online
// matches), sorted by XP. Players who've never played a real match are
// excluded rather than cluttering the list with all-zero rows.
app.get('/leaderboard', (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const list = Object.values(persistedPlayers)
    .filter(p => (p.matchesPlayed || 0) > 0)
    .map(p => ({ name: p.name, xp: p.xp || 0, level: levelForXp(p.xp || 0), wins: p.wins || 0, losses: p.losses || 0, matchesPlayed: p.matchesPlayed || 0 }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limit);
  res.json({ leaderboard: list });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] }
});

/* ===================== LIVE STATE ===================== */
// playerId -> { id, socketId, roomId, disconnectTimer, online } — resets on server restart, by design
const playerIdToPlayer = new Map();
// roomId -> Room
const rooms = new Map();
// code -> roomId
const roomCodeToId = new Map();
// playerId waiting for Quick Match (ordered)
const quickMatchQueue = [];

class Room {
  constructor(id, isPrivate, code, matchLength, targetSize){
    this.id = id;
    this.isPrivate = isPrivate;
    this.code = code || null;
    this.targetSize = [2,3,4].includes(targetSize) ? targetSize : 2;
    this.players = [];       // playerIds, join order, length <= targetSize — the room roster
    this.playerReady = {};   // playerId -> bool
    this.slots = { p1: null, p2: null };   // the CURRENTLY ACTIVE game's two participants (reused across bracket legs)
    this.scores = { p1: 0, p2: 0 };
    this.turn = null;                       // 'p1' | 'p2'
    this.roundStartFirst = 'p1';
    this.state = 'waiting';                 // waiting | countdown | in_progress | round_end | match_end
    this.createdAt = Date.now();
    this.rematch = { p1: false, p2: false };
    this.matchLength = [3,5,7].includes(matchLength) ? matchLength : 3;
    this.roundsToWin = Math.ceil(this.matchLength/2);
    this.bracket = null;    // built once all players are ready, only for targetSize > 2 — see buildBracket()
    this.champion = null;
  }
  otherSlot(slot){ return slot === 'p1' ? 'p2' : 'p1'; }
  slotFor(playerId){
    if (this.slots.p1 === playerId) return 'p1';
    if (this.slots.p2 === playerId) return 'p2';
    return null;
  }
  isFull(){ return this.players.length >= this.targetSize; }
}

function emitToPlayer(playerId, event, payload){
  const p = playerIdToPlayer.get(playerId);
  if (!p) return;
  io.to(p.socketId).emit(event, payload);
}
function emitToRoom(room, event, payload){
  if (room.slots.p1) emitToPlayer(room.slots.p1, event, payload);
  if (room.slots.p2) emitToPlayer(room.slots.p2, event, payload);
}
function opponentOf(room, playerId){
  const slot = room.slotFor(playerId);
  if (!slot) return null;
  const oppSlot = room.otherSlot(slot);
  return room.slots[oppSlot];
}
function publicName(playerId){
  const p = persistedPlayers[playerId];
  return p ? p.name : 'Player';
}
function isOnline(playerId){
  const r = playerIdToPlayer.get(playerId);
  return !!(r && r.online);
}
function statsSummary(playerId){
  const p = persistedPlayers[playerId];
  if (!p) return null;
  const xp = p.xp || 0;
  return {
    xp, level: levelForXp(xp), xpIntoLevel: xp % XP_PER_LEVEL, xpForNextLevel: XP_PER_LEVEL,
    wins: p.wins || 0, losses: p.losses || 0, matchesPlayed: p.matchesPlayed || 0
  };
}
function awardMatchResult(winnerId, loserId){
  const w = winnerId && persistedPlayers[winnerId];
  const l = loserId && persistedPlayers[loserId];
  if (w) { w.xp = (w.xp||0) + XP_PER_WIN; w.wins = (w.wins||0) + 1; w.matchesPlayed = (w.matchesPlayed||0) + 1; }
  if (l) { l.xp = (l.xp||0) + XP_PER_LOSS; l.losses = (l.losses||0) + 1; l.matchesPlayed = (l.matchesPlayed||0) + 1; }
  if (w || l) saveJSON(PLAYERS_FILE, persistedPlayers);
  if (winnerId) emitToPlayer(winnerId, 'stats:update', statsSummary(winnerId));
  if (loserId) emitToPlayer(loserId, 'stats:update', statsSummary(loserId));
}

function destroyRoom(roomId){
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.code) roomCodeToId.delete(room.code);
  rooms.delete(roomId);
}

function cleanupPlayerFromQueue(playerId){
  const idx = quickMatchQueue.indexOf(playerId);
  if (idx !== -1) quickMatchQueue.splice(idx, 1);
}

/* ===================== FRIENDS ===================== */
function friendSummary(playerId){
  const rec = persistedPlayers[playerId];
  return rec ? { playerId, name: rec.name, tag: rec.tag, online: isOnline(playerId), level: levelForXp(rec.xp||0) } : null;
}
function sendFriendsListUpdate(playerId){
  const rec = getFriendsRecord(playerId);
  const mine = persistedPlayers[playerId];
  emitToPlayer(playerId, 'friend:list_update', {
    friends: rec.friends.map(friendSummary).filter(Boolean),
    incoming: rec.incoming.map(friendSummary).filter(Boolean),
    outgoing: rec.outgoing.map(friendSummary).filter(Boolean),
    myTag: mine ? mine.tag : null
  });
}
function notifyFriendsOfStatus(playerId){
  const rec = getFriendsRecord(playerId);
  rec.friends.forEach(fid => { if (isOnline(fid)) sendFriendsListUpdate(fid); });
}
function acceptFriendRequest(playerId, fromPlayerId){
  const mine = getFriendsRecord(playerId);
  const theirs = getFriendsRecord(fromPlayerId);
  mine.incoming = mine.incoming.filter(id => id !== fromPlayerId);
  theirs.outgoing = theirs.outgoing.filter(id => id !== playerId);
  if (!mine.friends.includes(fromPlayerId)) mine.friends.push(fromPlayerId);
  if (!theirs.friends.includes(playerId)) theirs.friends.push(playerId);
  saveJSON(FRIENDS_FILE, friendsData);
  sendFriendsListUpdate(playerId);
  sendFriendsListUpdate(fromPlayerId);
}

/* ===================== QUICK MATCH PAIRING ===================== */
function tryPairQuickMatch(){
  while (quickMatchQueue.length >= 2) {
    const aId = quickMatchQueue.shift();
    const bId = quickMatchQueue.shift();
    const a = playerIdToPlayer.get(aId), b = playerIdToPlayer.get(bId);
    if (!a) { continue; } // a vanished; b stays dequeued too — re-enqueue b
    if (!b) { quickMatchQueue.unshift(aId); continue; }
    const room = new Room(newId(), false, null);
    room.slots.p1 = aId; room.slots.p2 = bId;
    rooms.set(room.id, room);
    a.roomId = room.id; b.roomId = room.id;
    emitToPlayer(aId, 'match:found', { roomId: room.id, youAre: 'p1', opponent: { name: publicName(bId) } });
    emitToPlayer(bId, 'match:found', { roomId: room.id, youAre: 'p2', opponent: { name: publicName(aId) } });
    startMatch(room); // both players are already "ready" by virtue of being queued — start immediately
  }
}
setInterval(tryPairQuickMatch, QUICK_MATCH_POLL_MS);

/* ===================== MATCH LIFECYCLE ===================== */
function startMatch(room){
  room.state = 'in_progress';
  room.scores = { p1: 0, p2: 0 };
  room.roundStartFirst = Math.random() < 0.5 ? 'p1' : 'p2';
  room.turn = room.roundStartFirst;
  room.rematch = { p1: false, p2: false };
  const bracketActive = isRealBracket(room);
  const legName = bracketActive ? room.bracket.legs[room.bracket.legIndex].name : null;
  const basePayload = { roomId: room.id, firstTurn: room.turn, matchLength: room.matchLength, isBracketLeg: bracketActive, legName };
  // Sent per-recipient (not via emitToRoom) because in a bracket, which slot
  // ('p1'/'p2') a given player occupies can change between legs — the client
  // must never assume/cache its own slot, it has to be told fresh every time.
  emitToPlayer(room.slots.p1, 'match:start', Object.assign({}, basePayload, { youAre: 'p1', opponentName: publicName(room.slots.p2) }));
  emitToPlayer(room.slots.p2, 'match:start', Object.assign({}, basePayload, { youAre: 'p2', opponentName: publicName(room.slots.p1) }));
}

function beginNextRound(room, startSlot){
  room.roundStartFirst = startSlot;
  room.turn = startSlot;
  room.state = 'in_progress';
  emitToRoom(room, 'round:start', { roomId: room.id, firstTurn: room.turn, scores: room.scores });
}

/* ===================== BRACKETS (rooms with more than 2 players) =====================
 * A room's "slots" (p1/p2) always represent whichever two players are in the
 * CURRENTLY ACTIVE game. For a 2-player room, that's just the room itself —
 * no bracket, identical to the original 1v1 behavior. For 3-4 players, a
 * bracket sequences up to 3 separate 1v1 games (semifinal(s), then a final)
 * through those same slots, one game at a time — the entire match engine
 * above (turns, rounds, scoring) is completely unaware this is happening and
 * needs no changes for it to work correctly.
 */
function isRealBracket(room){ return !!(room.bracket && room.bracket.legs.length > 1); }
function emitToRoomRoster(room, event, payload){
  room.players.forEach(pid => emitToPlayer(pid, event, payload));
}
function broadcastRoster(room){
  emitToRoomRoster(room, 'room:roster_update', {
    roomId: room.id, targetSize: room.targetSize,
    players: room.players.map(pid => ({ playerId: pid, name: publicName(pid), ready: !!room.playerReady[pid] }))
  });
}
function buildBracket(players){
  if (players.length === 2) {
    return { legIndex: 0, legs: [
      { name: 'Match', a: players[0], b: players[1], winner: null, state: 'pending', feedsLegIndex: null, feedsSlot: null }
    ]};
  }
  if (players.length === 3) {
    return { legIndex: 0, legs: [
      { name: 'Semifinal', a: players[0], b: players[1], winner: null, state: 'pending', feedsLegIndex: 1, feedsSlot: 'a' },
      { name: 'Final', a: null, b: players[2], winner: null, state: 'pending', feedsLegIndex: null, feedsSlot: null }
    ]};
  }
  return { legIndex: 0, legs: [
    { name: 'Semifinal 1', a: players[0], b: players[1], winner: null, state: 'pending', feedsLegIndex: 2, feedsSlot: 'a' },
    { name: 'Semifinal 2', a: players[2], b: players[3], winner: null, state: 'pending', feedsLegIndex: 2, feedsSlot: 'b' },
    { name: 'Final', a: null, b: null, winner: null, state: 'pending', feedsLegIndex: null, feedsSlot: null }
  ]};
}
function bracketSummary(bracket){
  return {
    legIndex: bracket.legIndex,
    legs: bracket.legs.map(leg => ({
      name: leg.name,
      aName: leg.a ? publicName(leg.a) : 'TBD',
      bName: leg.b ? publicName(leg.b) : 'TBD',
      winnerName: leg.winner ? publicName(leg.winner) : null,
      state: leg.state
    }))
  };
}
function broadcastTournamentUpdate(room){
  const summary = bracketSummary(room.bracket);
  const activeLeg = room.bracket.legs[room.bracket.legIndex];
  room.players.forEach(pid => {
    const amIActive = pid === activeLeg.a || pid === activeLeg.b;
    emitToPlayer(pid, 'tournament:update', { roomId: room.id, bracket: summary, targetSize: room.targetSize, amIActive });
  });
}
function startNextLeg(room){
  const leg = room.bracket.legs[room.bracket.legIndex];
  leg.state = 'active';
  room.slots.p1 = leg.a;
  room.slots.p2 = leg.b;
  if (isRealBracket(room)) broadcastTournamentUpdate(room);
  startMatch(room);
}
function advanceBracketAfterLeg(room, winnerId, loserId){
  const bracket = room.bracket;
  const leg = bracket.legs[bracket.legIndex];
  leg.winner = winnerId;
  leg.state = 'done';
  if (leg.feedsLegIndex !== null) bracket.legs[leg.feedsLegIndex][leg.feedsSlot] = winnerId;

  const nextIndex = bracket.legIndex + 1;
  if (nextIndex < bracket.legs.length) {
    bracket.legIndex = nextIndex;
    broadcastTournamentUpdate(room);
    setTimeout(() => { if (rooms.has(room.id)) startNextLeg(room); }, 2200);
  } else {
    room.champion = winnerId;
    room.state = 'match_end';
    broadcastTournamentUpdate(room);
    emitToRoomRoster(room, 'tournament:champion', { roomId: room.id, championPlayerId: winnerId, championName: publicName(winnerId) });
  }
}

/* ===================== SOCKET HANDLERS ===================== */
io.on('connection', (socket) => {

  socket.on('identify', (payload) => {
    payload = payload || {};
    const requestedToken = typeof payload.token === 'string' ? payload.token : null;
    let name = (typeof payload.name === 'string' ? payload.name : '').trim().slice(0, 18);

    let playerId = requestedToken ? tokenToPlayerId.get(requestedToken) : null;
    let persistedRec = playerId ? persistedPlayers[playerId] : null;

    if (playerId && persistedRec) {
      // resuming an existing identity (reload / reconnect)
      if (name) { persistedRec.name = name; saveJSON(PLAYERS_FILE, persistedPlayers); }
    } else {
      playerId = newId();
      const token = requestedToken || newId();
      const tag = newTag();
      persistedRec = { name: name || ('Guest' + Math.floor(1000 + Math.random()*9000)), tag, token, createdAt: Date.now() };
      persistedPlayers[playerId] = persistedRec;
      tokenToPlayerId.set(token, playerId);
      tagToPlayerId.set(tag, playerId);
      saveJSON(PLAYERS_FILE, persistedPlayers);
    }

    let record = playerIdToPlayer.get(playerId);
    if (record) {
      record.socketId = socket.id;
      record.online = true;
      if (record.disconnectTimer) { clearTimeout(record.disconnectTimer); record.disconnectTimer = null; }
    } else {
      record = { id: playerId, socketId: socket.id, roomId: null, disconnectTimer: null, online: true };
      playerIdToPlayer.set(playerId, record);
    }

    socket.data.playerId = playerId;
    socket.emit('identified', { playerId, token: persistedRec.token, name: persistedRec.name, tag: persistedRec.tag, stats: statsSummary(playerId) });

    sendFriendsListUpdate(playerId);
    notifyFriendsOfStatus(playerId);

    // rejoin room if we were mid-match when we dropped
    if (record.roomId && rooms.has(record.roomId)) {
      const room = rooms.get(record.roomId);
      const slot = room.slotFor(playerId);
      if (slot) {
        socket.join(room.id);
        const oppId = opponentOf(room, playerId);
        socket.emit('room:resume', {
          roomId: room.id, active: true, youAre: slot, scores: room.scores, turn: room.turn,
          state: room.state, matchLength: room.matchLength, targetSize: room.targetSize,
          opponent: { name: publicName(oppId) }
        });
        if (oppId) emitToPlayer(oppId, 'opponent:reconnected', {});
      } else if (room.players.includes(playerId)) {
        // waiting for their bracket leg to come up (or still in the pre-match lobby)
        socket.join(room.id);
        socket.emit('room:resume', {
          roomId: room.id, active: false, targetSize: room.targetSize, matchLength: room.matchLength,
          bracket: room.bracket ? bracketSummary(room.bracket) : null,
          players: room.players.map(pid => ({ playerId: pid, name: publicName(pid), ready: !!room.playerReady[pid] }))
        });
      }
    }
  });

  socket.on('quick_match:join', () => {
    const playerId = socket.data.playerId;
    if (!playerId) return socket.emit('error', { message: 'Identify first.' });
    if (!quickMatchQueue.includes(playerId)) quickMatchQueue.push(playerId);
    socket.emit('quick_match:searching', {});
  });

  socket.on('quick_match:cancel', () => {
    const playerId = socket.data.playerId;
    if (playerId) cleanupPlayerFromQueue(playerId);
  });

  socket.on('room:create', (payload) => {
    const playerId = socket.data.playerId;
    if (!playerId) return socket.emit('error', { message: 'Identify first.' });
    const code = newRoomCode();
    const requestedLength = payload && parseInt(payload.matchLength, 10);
    const requestedSize = payload && parseInt(payload.targetSize, 10);
    const room = new Room(newId(), true, code, requestedLength, requestedSize); // Room's constructor validates/defaults both
    room.players.push(playerId);
    room.playerReady[playerId] = false;
    rooms.set(room.id, room);
    roomCodeToId.set(code, room.id);
    playerIdToPlayer.get(playerId).roomId = room.id;
    socket.join(room.id);
    socket.emit('room:created', { roomId: room.id, code, matchLength: room.matchLength, targetSize: room.targetSize });
    broadcastRoster(room);
  });

  socket.on('room:join', (payload) => {
    const playerId = socket.data.playerId;
    if (!playerId) return socket.emit('error', { message: 'Identify first.' });
    const code = ((payload && payload.code) || '').toUpperCase().trim();
    const roomId = roomCodeToId.get(code);
    const room = roomId && rooms.get(roomId);
    if (!room) return socket.emit('room:error', { message: 'Room not found. Check the code and try again.' });
    if (room.isFull()) return socket.emit('room:error', { message: 'That room is already full.' });
    if (room.players.includes(playerId)) return socket.emit('room:error', { message: "You're already in this room." });

    room.players.push(playerId);
    room.playerReady[playerId] = false;
    playerIdToPlayer.get(playerId).roomId = room.id;
    socket.join(room.id);
    socket.emit('room:joined', {
      roomId: room.id, code: room.code, matchLength: room.matchLength, targetSize: room.targetSize,
      players: room.players.map(pid => ({ playerId: pid, name: publicName(pid) }))
    });
    broadcastRoster(room);
  });

  socket.on('room:leave', (payload) => {
    const playerId = socket.data.playerId;
    const roomId = payload && payload.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !playerId) return;
    socket.leave(room.id);
    const rec = playerIdToPlayer.get(playerId);
    if (rec) rec.roomId = null;

    const activeSlot = room.slotFor(playerId);
    const wasActivelyPlaying = activeSlot && (room.state === 'countdown' || room.state === 'in_progress' || room.state === 'round_end');
    if (wasActivelyPlaying) {
      const oppId = room.slots[room.otherSlot(activeSlot)];
      room.players = room.players.filter(pid => pid !== playerId);
      if (oppId) {
        emitToPlayer(oppId, 'opponent:left', { reason: 'left' });
        const oppRec = playerIdToPlayer.get(oppId);
        if (oppRec) oppRec.roomId = null;
        awardMatchResult(oppId, playerId);
        if (isRealBracket(room)) { advanceBracketAfterLeg(room, oppId, playerId); return; }
      }
      destroyRoom(room.id);
      return;
    }

    // not actively playing (still in the lobby, or waiting/eliminated in a tournament)
    room.players = room.players.filter(pid => pid !== playerId);
    delete room.playerReady[playerId];
    if (room.players.length === 0) { destroyRoom(room.id); return; }
    if (room.state === 'waiting') broadcastRoster(room);
    else emitToRoomRoster(room, 'room:player_left', { roomId: room.id, name: publicName(playerId) });
  });

  socket.on('player:ready', (payload) => {
    const playerId = socket.data.playerId;
    const room = payload && rooms.get(payload.roomId);
    if (!room || !playerId || !room.players.includes(playerId)) return;
    room.playerReady[playerId] = true;
    broadcastRoster(room);
    const allReady = room.isFull() && room.players.every(pid => room.playerReady[pid]);
    if (allReady && room.state === 'waiting') {
      room.bracket = buildBracket(room.players);
      startNextLeg(room);
    }
  });

  socket.on('shot:resolved', (payload) => {
    const playerId = socket.data.playerId;
    const room = payload && rooms.get(payload.roomId);
    if (!room || !playerId) return;
    const slot = room.slotFor(playerId);
    if (!slot) return;
    if (room.turn !== slot) return; // not your turn — ignore silently (defense in depth; UI already prevents this)

    const keyframes = Array.isArray(payload.keyframes) ? payload.keyframes.slice(0, 400) : [];
    const finalPositions = payload.finalPositions || {};
    const eliminated = payload.eliminated || { p1: false, p2: false };

    const oppId = opponentOf(room, playerId);
    if (oppId) {
      emitToPlayer(oppId, 'shot:opponent_resolved', { keyframes, finalPositions, eliminated, byPlayer: publicName(playerId) });
    }

    const p1Out = !!eliminated.p1, p2Out = !!eliminated.p2;
    if (p1Out || p2Out) {
      if (p1Out && p2Out) {
        // double elimination — replay the round, same starter, no score change
        room.state = 'round_end';
        emitToRoom(room, 'round:result', { roomId: room.id, doubleKO: true, scores: room.scores });
        setTimeout(() => { if (rooms.has(room.id)) beginNextRound(room, room.roundStartFirst); }, 1600);
        return;
      }
      const loserSlot = p1Out ? 'p1' : 'p2';
      const winnerSlot = room.otherSlot(loserSlot);
      room.scores[winnerSlot] += 1;
      room.state = 'round_end';
      const matchOver = room.scores[winnerSlot] >= room.roundsToWin;
      emitToRoom(room, 'round:result', { roomId: room.id, doubleKO: false, winnerSlot, scores: room.scores, matchOver });
      if (matchOver) {
        room.state = 'match_end';
        const winnerId = room.slots[winnerSlot], loserId = room.slots[loserSlot];
        awardMatchResult(winnerId, loserId);
        const bracketActive = isRealBracket(room);
        emitToRoom(room, 'match:end', {
          roomId: room.id, winnerSlot, scores: room.scores,
          isBracketLeg: bracketActive, legName: bracketActive ? room.bracket.legs[room.bracket.legIndex].name : null
        });
        if (bracketActive) advanceBracketAfterLeg(room, winnerId, loserId);
      } else {
        const nextStart = room.roundStartFirst === 'p1' ? 'p2' : 'p1';
        setTimeout(() => { if (rooms.has(room.id)) beginNextRound(room, nextStart); }, 1600);
      }
    } else {
      // no elimination — just pass the turn
      room.turn = room.otherSlot(slot);
      emitToRoom(room, 'turn:update', { roomId: room.id, turn: room.turn });
    }
  });

  socket.on('rematch:request', (payload) => {
    const playerId = socket.data.playerId;
    const room = payload && rooms.get(payload.roomId);
    if (!room || !playerId) return;
    const slot = room.slotFor(playerId);
    if (!slot) return;
    room.rematch[slot] = true;
    const oppSlot = room.otherSlot(slot);
    emitToPlayer(room.slots[oppSlot], 'rematch:opponent_wants', {});
    if (room.rematch.p1 && room.rematch.p2) {
      room.state = 'waiting';
      startMatch(room);
    }
  });

  /* ---- Friends ---- */
  socket.on('friend:add_request', (payload) => {
    const playerId = socket.data.playerId;
    if (!playerId) return;
    const tag = ((payload && payload.tag) || '').toUpperCase().trim();
    const targetId = tagToPlayerId.get(tag);
    if (!targetId) return socket.emit('friend:request_result', { ok: false, message: 'No player found with that tag.' });
    if (targetId === playerId) return socket.emit('friend:request_result', { ok: false, message: "That's your own tag." });

    const mine = getFriendsRecord(playerId);
    if (mine.friends.includes(targetId)) return socket.emit('friend:request_result', { ok: false, message: 'Already friends.' });
    if (mine.outgoing.includes(targetId)) return socket.emit('friend:request_result', { ok: false, message: 'Request already sent.' });

    if (mine.incoming.includes(targetId)) {
      // they'd already requested us — accept instead of creating a crossed request
      acceptFriendRequest(playerId, targetId);
      return socket.emit('friend:request_result', { ok: true, message: 'You had a pending request from them — accepted!' });
    }

    const theirs = getFriendsRecord(targetId);
    mine.outgoing.push(targetId);
    theirs.incoming.push(playerId);
    saveJSON(FRIENDS_FILE, friendsData);
    socket.emit('friend:request_result', { ok: true, message: 'Friend request sent.' });
    sendFriendsListUpdate(playerId);
    sendFriendsListUpdate(targetId);
    emitToPlayer(targetId, 'friend:request_received', { fromPlayerId: playerId, fromName: publicName(playerId) });
  });

  socket.on('friend:accept', (payload) => {
    const playerId = socket.data.playerId;
    const fromPlayerId = payload && payload.fromPlayerId;
    if (!playerId || !fromPlayerId) return;
    const mine = getFriendsRecord(playerId);
    if (!mine.incoming.includes(fromPlayerId)) return;
    acceptFriendRequest(playerId, fromPlayerId);
  });

  socket.on('friend:decline', (payload) => {
    const playerId = socket.data.playerId;
    const fromPlayerId = payload && payload.fromPlayerId;
    if (!playerId || !fromPlayerId) return;
    const mine = getFriendsRecord(playerId);
    const theirs = getFriendsRecord(fromPlayerId);
    mine.incoming = mine.incoming.filter(id => id !== fromPlayerId);
    theirs.outgoing = theirs.outgoing.filter(id => id !== playerId);
    saveJSON(FRIENDS_FILE, friendsData);
    sendFriendsListUpdate(playerId);
    sendFriendsListUpdate(fromPlayerId);
  });

  socket.on('friend:remove', (payload) => {
    const playerId = socket.data.playerId;
    const otherId = payload && payload.friendPlayerId;
    if (!playerId || !otherId) return;
    const mine = getFriendsRecord(playerId);
    const theirs = getFriendsRecord(otherId);
    mine.friends = mine.friends.filter(id => id !== otherId);
    theirs.friends = theirs.friends.filter(id => id !== playerId);
    saveJSON(FRIENDS_FILE, friendsData);
    sendFriendsListUpdate(playerId);
    sendFriendsListUpdate(otherId);
  });

  /* ---- Chat (friends only, works from the lobby or mid-match — same socket either way) ---- */
  socket.on('chat:send', (payload) => {
    const playerId = socket.data.playerId;
    if (!playerId) return;
    const toPlayerId = payload && payload.toPlayerId;
    const text = ((payload && payload.text) || '').toString().slice(0, 500).trim();
    if (!toPlayerId || !text) return;
    const mine = getFriendsRecord(playerId);
    if (!mine.friends.includes(toPlayerId)) return socket.emit('chat:send_ack', { ok: false, message: 'You are not friends with this player.' });

    const key = pairKey(playerId, toPlayerId);
    if (!chatsData[key]) chatsData[key] = [];
    const msg = { from: playerId, text, ts: Date.now() };
    chatsData[key].push(msg);
    if (chatsData[key].length > MAX_CHAT_HISTORY) chatsData[key] = chatsData[key].slice(-MAX_CHAT_HISTORY);
    saveJSON(CHATS_FILE, chatsData);

    socket.emit('chat:send_ack', { ok: true });
    emitToPlayer(playerId, 'chat:message', msg);   // echo to sender (handles multiple tabs/devices too)
    emitToPlayer(toPlayerId, 'chat:message', msg); // real-time delivery if they're online; otherwise it's waiting in history
  });

  socket.on('chat:history', (payload) => {
    const playerId = socket.data.playerId;
    const withPlayerId = payload && payload.withPlayerId;
    if (!playerId || !withPlayerId) return;
    const key = pairKey(playerId, withPlayerId);
    socket.emit('chat:history', { withPlayerId, messages: chatsData[key] || [] });
  });

  socket.on('disconnect', () => {
    const playerId = socket.data.playerId;
    if (!playerId) return;
    cleanupPlayerFromQueue(playerId);

    const record = playerIdToPlayer.get(playerId);
    if (record) record.online = false;
    notifyFriendsOfStatus(playerId);

    if (!record) return;
    const roomId = record.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const oppId = opponentOf(room, playerId);
    if (oppId) emitToPlayer(oppId, 'opponent:disconnected', { graceSeconds: DISCONNECT_GRACE_MS / 1000 });

    record.disconnectTimer = setTimeout(() => {
      // grace period expired without a reconnect — forfeit the match, but the
      // player's identity/token/friends are untouched: they can still come
      // back later and keep who they are, just not resume this abandoned match.
      const stillRoom = rooms.get(roomId);
      if (!stillRoom) return;
      const stillOppId = opponentOf(stillRoom, playerId);
      if (stillOppId) emitToPlayer(stillOppId, 'opponent:left', { reason: 'timeout' });
      if (stillOppId && (stillRoom.state === 'in_progress' || stillRoom.state === 'round_end')) {
        awardMatchResult(stillOppId, playerId); // forfeit win — the match was genuinely underway, not already decided or never started
        stillRoom.players = stillRoom.players.filter(pid => pid !== playerId);
        if (isRealBracket(stillRoom)) { advanceBracketAfterLeg(stillRoom, stillOppId, playerId); record.roomId = null; return; }
      }
      destroyRoom(roomId);
      record.roomId = null;
    }, DISCONNECT_GRACE_MS);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Pen Fight Arena server listening on port ${PORT}`);
  console.log(`CORS origin: ${CLIENT_ORIGIN}`);
});
