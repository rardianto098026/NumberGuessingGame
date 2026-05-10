const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory room store ────────────────────────────────────────────────────
const rooms = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function createPlayer(id, username) {
  return { id, username, score: 0, attemptsLeft: 7, eliminated: false, roundScores: [] };
}

function getPoints(attempts) {
  const map = { 1: 10, 2: 8, 3: 6, 4: 4 };
  return map[attempts] ?? 2;
}

function getSetguessPoints(totalGuesses) {
  if (totalGuesses <= 1)  return 10;
  if (totalGuesses <= 3)  return 8;
  if (totalGuesses <= 5)  return 6;
  if (totalGuesses <= 8)  return 4;
  return 2;
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.eliminated && room.turnOrder.includes(p.id));
}

function clearPlayerTimer(room, playerId) {
  if (room.timers[playerId]) { clearTimeout(room.timers[playerId]); delete room.timers[playerId]; }
}

function clearAllTimers(room) {
  Object.values(room.timers).forEach(t => clearTimeout(t));
  room.timers = {};
  if (room.nextRoundTimer) { clearTimeout(room.nextRoundTimer); room.nextRoundTimer = null; }
  if (room.gameEndTimer)   { clearTimeout(room.gameEndTimer);   room.gameEndTimer = null; }
  if (room.settingTimer)   { clearTimeout(room.settingTimer);   room.settingTimer = null; }
}

function resetRoom(room) {
  clearAllTimers(room);
  room.state = 'lobby';
  room.currentRound = 0;
  room.guessHistory = [];
  room.secretNumber = null;
  room.currentTurnIndex = 0;
  room.turnOrder = [];
  room.playerSecrets = {};
  room.numbersSetBy = [];
  room.roundGuessCount = {};
  room.players.forEach(p => {
    p.score = 0; p.roundScores = []; p.attemptsLeft = room.config.maxAttempts; p.eliminated = false;
  });
}

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('+ Connected:', socket.id);

  // ── Create Room ──────────────────────────────────────────────────────────────
  socket.on('create_room', ({ username }) => {
    const name = (username || '').trim();
    if (!name) { socket.emit('error', { message: 'Username tidak boleh kosong!' }); return; }

    const roomCode = generateRoomCode();
    const player   = createPlayer(socket.id, name);

    rooms[roomCode] = {
      code: roomCode, host: socket.id, players: [player],
      config: { min: 1, max: 100, maxAttempts: 7, totalRounds: 3, gameMode: 'classic' },
      state: 'lobby', currentRound: 0, currentTurnIndex: 0,
      secretNumber: null, guessHistory: [], turnOrder: [],
      timers: {}, nextRoundTimer: null, gameEndTimer: null,
      // Set & Guess extras
      playerSecrets: {}, numbersSetBy: [], settingTimer: null, roundGuessCount: {},
    };

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.emit('room_created', {
      roomCode, players: rooms[roomCode].players, config: rooms[roomCode].config,
      isHost: true, hostId: socket.id,
    });
  });

  // ── Join Room ────────────────────────────────────────────────────────────────
  socket.on('join_room', ({ username, roomCode }) => {
    const name = (username || '').trim();
    const code = (roomCode || '').toUpperCase().trim();
    if (!name) { socket.emit('error', { message: 'Username tidak boleh kosong!' }); return; }

    const room = rooms[code];
    if (!room)                { socket.emit('error', { message: `Room "${code}" tidak ditemukan!` }); return; }
    if (room.state !== 'lobby') { socket.emit('error', { message: 'Game sudah berjalan!' }); return; }
    if (room.players.some(p => p.username.toLowerCase() === name.toLowerCase())) {
      socket.emit('error', { message: 'Username sudah digunakan di room ini!' }); return;
    }

    const player = createPlayer(socket.id, name);
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;

    socket.emit('room_joined', {
      roomCode: code, players: room.players, config: room.config,
      isHost: false, hostId: room.host,
    });
    io.to(code).emit('player_joined', { players: room.players, newPlayer: player.username });
  });

  // ── Update Config ────────────────────────────────────────────────────────────
  socket.on('update_config', ({ roomCode, config }) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id || room.state !== 'lobby') return;

    const min         = Math.max(1,     Math.min(9999,  parseInt(config.min)         || 1));
    const max         = Math.max(2,     Math.min(10000, parseInt(config.max)         || 100));
    const maxAttempts = Math.max(1,     Math.min(20,    parseInt(config.maxAttempts) || 7));
    const totalRounds = Math.max(1,     Math.min(10,    parseInt(config.totalRounds) || 3));
    const gameMode    = config.gameMode === 'setguess' ? 'setguess' : 'classic';

    if (min >= max) { socket.emit('error', { message: 'Nilai min harus lebih kecil dari max!' }); return; }
    room.config = { min, max, maxAttempts, totalRounds, gameMode };
    io.to(roomCode).emit('config_updated', { config: room.config });
  });

  // ── Start Game ───────────────────────────────────────────────────────────────
  socket.on('start_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id || room.state !== 'lobby') return;
    if (room.players.length < 2) { socket.emit('error', { message: 'Butuh minimal 2 pemain!' }); return; }

    room.state = 'playing';
    room.currentRound = 1;
    room.turnOrder = room.players.map(p => p.id);
    room.players.forEach(p => { p.score = 0; p.roundScores = []; });

    io.to(roomCode).emit('game_started', {
      config: room.config, players: room.players,
      turnOrder: room.turnOrder.map(id => room.players.find(p => p.id === id)?.username),
    });

    setTimeout(() => startRound(roomCode), 1200);
  });

  // ── Set Secret Number (Set & Guess mode) ─────────────────────────────────────
  socket.on('set_number', ({ roomCode, number }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'setting') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || room.numbersSetBy.includes(socket.id)) return;

    const num = parseInt(number);
    if (isNaN(num) || num < room.config.min || num > room.config.max) {
      socket.emit('error', { message: `Angka harus antara ${room.config.min}–${room.config.max}!` }); return;
    }

    room.playerSecrets[socket.id] = num;
    room.numbersSetBy.push(socket.id);

    socket.emit('number_set_confirmed');
    io.to(roomCode).emit('number_setting_progress', {
      set: room.numbersSetBy.length, total: room.players.length,
    });

    if (room.numbersSetBy.length === room.players.length) {
      startSetguessGuessingPhase(roomCode);
    }
  });

  // ── Submit Guess ─────────────────────────────────────────────────────────────
  socket.on('submit_guess', ({ roomCode, guess, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;

    const currentPlayerId = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== currentPlayerId) { socket.emit('error', { message: 'Bukan giliran kamu!' }); return; }

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;

    const guessNum = parseInt(guess);
    if (isNaN(guessNum)) { socket.emit('error', { message: 'Masukkan angka yang valid!' }); return; }
    if (guessNum < room.config.min || guessNum > room.config.max) {
      socket.emit('error', { message: `Angka harus antara ${room.config.min}–${room.config.max}!` }); return;
    }

    clearPlayerTimer(room, socket.id);

    // ── Set & Guess mode ─────────────────────────────────────
    if (room.config.gameMode === 'setguess') {
      const target = room.players.find(p => p.id === targetPlayerId && p.id !== socket.id);
      if (!target) { socket.emit('error', { message: 'Pilih lawan yang valid!' }); return; }

      const targetSecret = room.playerSecrets[targetPlayerId];
      room.roundGuessCount[socket.id] = (room.roundGuessCount[socket.id] || 0) + 1;

      let hint, correct = false, points = 0;
      if (guessNum < targetSecret)      hint = '🔼 Terlalu rendah!';
      else if (guessNum > targetSecret) hint = '🔽 Terlalu tinggi!';
      else {
        hint = '✅ BENAR!';
        correct = true;
        points  = getSetguessPoints(room.roundGuessCount[socket.id]);
        player.score += points;
        player.roundScores.push(points);
      }

      room.guessHistory.push({
        player: player.username, playerId: player.id,
        target: target.username, targetId: target.id,
        guess: guessNum, hint, correct, points,
      });

      io.to(roomCode).emit('guess_result', {
        playerId: player.id, player: player.username,
        targetId: target.id, target: target.username,
        guess: guessNum, hint, correct, points,
        attemptsLeft: null,
        players: room.players, guessHistory: room.guessHistory,
        mode: 'setguess',
      });

      if (correct) endRound(roomCode, player, false);
      else advanceTurn(roomCode);

    // ── Classic mode ─────────────────────────────────────────
    } else {
      player.attemptsLeft--;
      const attemptsUsed = room.config.maxAttempts - player.attemptsLeft;

      let hint, correct = false, points = 0;
      if (guessNum < room.secretNumber)      hint = '🔼 Terlalu rendah!';
      else if (guessNum > room.secretNumber) hint = '🔽 Terlalu tinggi!';
      else {
        hint = '✅ BENAR!';
        correct = true;
        points  = getPoints(attemptsUsed);
        player.score += points;
        player.roundScores.push(points);
      }

      if (!correct && player.attemptsLeft <= 0) player.eliminated = true;

      room.guessHistory.push({ player: player.username, playerId: player.id, guess: guessNum, hint, correct, points });

      io.to(roomCode).emit('guess_result', {
        playerId: player.id, player: player.username,
        guess: guessNum, hint, correct, points,
        attemptsLeft: player.attemptsLeft, eliminated: player.eliminated,
        players: room.players, guessHistory: room.guessHistory,
        mode: 'classic',
      });

      if (correct) endRound(roomCode, player, false);
      else {
        if (getActivePlayers(room).length === 0) endRound(roomCode, null, true);
        else advanceTurn(roomCode);
      }
    }
  });

  // ── Play Again ───────────────────────────────────────────────────────────────
  socket.on('play_again', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id || room.state !== 'ended') return;
    resetRoom(room);
    io.to(roomCode).emit('game_reset', { players: room.players, config: room.config, hostId: room.host });
  });

  // ── Leave / Disconnect ───────────────────────────────────────────────────────
  socket.on('leave_room', ({ roomCode }) => { handleLeave(socket, roomCode); socket.data.roomCode = null; });
  socket.on('disconnect', () => {
    if (socket.data.roomCode) handleLeave(socket, socket.data.roomCode);
    console.log('- Disconnected:', socket.id);
  });
});

// ─── Game Logic ───────────────────────────────────────────────────────────────
function startRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  room.guessHistory     = [];
  room.currentTurnIndex = 0;
  room.turnOrder        = room.players.map(p => p.id);
  room.roundGuessCount  = {};
  room.players.forEach(p => { p.attemptsLeft = room.config.maxAttempts; p.eliminated = false; });

  if (room.config.gameMode === 'setguess') {
    startNumberSettingPhase(roomCode);
  } else {
    room.secretNumber = Math.floor(Math.random() * (room.config.max - room.config.min + 1)) + room.config.min;
    console.log(`[${roomCode}] Classic round ${room.currentRound} — secret: ${room.secretNumber}`);

    io.to(roomCode).emit('round_started', {
      round: room.currentRound, totalRounds: room.config.totalRounds,
      config: room.config, players: room.players,
      turnOrder: room.turnOrder.map(id => room.players.find(p => p.id === id)?.username).filter(Boolean),
      mode: 'classic',
    });
    sendTurn(roomCode);
  }
}

function startNumberSettingPhase(roomCode) {
  const room = rooms[roomCode];
  room.state       = 'setting';
  room.playerSecrets = {};
  room.numbersSetBy  = [];

  console.log(`[${roomCode}] SetGuess round ${room.currentRound} — number setting phase`);

  io.to(roomCode).emit('number_setting_phase', {
    round: room.currentRound, totalRounds: room.config.totalRounds,
    config: room.config, players: room.players, timeLimit: 30,
  });

  // Auto-assign random number to players who haven't set after 30s
  room.settingTimer = setTimeout(() => {
    const r = rooms[roomCode];
    if (!r || r.state !== 'setting') return;
    r.players.forEach(p => {
      if (!r.numbersSetBy.includes(p.id)) {
        r.playerSecrets[p.id] = Math.floor(Math.random() * (r.config.max - r.config.min + 1)) + r.config.min;
        r.numbersSetBy.push(p.id);
      }
    });
    io.to(roomCode).emit('number_setting_progress', { set: r.players.length, total: r.players.length, autoSet: true });
    startSetguessGuessingPhase(roomCode);
  }, 30000);
}

function startSetguessGuessingPhase(roomCode) {
  const room = rooms[roomCode];
  if (room.settingTimer) { clearTimeout(room.settingTimer); room.settingTimer = null; }

  room.state            = 'playing';
  room.currentTurnIndex = 0;
  room.turnOrder        = room.players.map(p => p.id);
  room.players.forEach(p => { p.attemptsLeft = room.config.maxAttempts; p.eliminated = false; });

  console.log(`[${roomCode}] SetGuess round ${room.currentRound} — guessing phase`);

  io.to(roomCode).emit('round_started', {
    round: room.currentRound, totalRounds: room.config.totalRounds,
    config: room.config, players: room.players,
    turnOrder: room.turnOrder.map(id => room.players.find(p => p.id === id)?.username).filter(Boolean),
    mode: 'setguess',
  });

  sendTurn(roomCode);
}

function sendTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  let checked = 0;
  while (checked < room.turnOrder.length) {
    const pid = room.turnOrder[room.currentTurnIndex];
    const p   = room.players.find(p => p.id === pid);
    if (p && !p.eliminated) break;
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
    checked++;
  }
  if (checked >= room.turnOrder.length) { endRound(roomCode, null, true); return; }

  const currentPlayerId = room.turnOrder[room.currentTurnIndex];
  const currentPlayer   = room.players.find(p => p.id === currentPlayerId);

  // Build target list for setguess mode
  const targets = room.config.gameMode === 'setguess'
    ? room.players.filter(p => p.id !== currentPlayerId).map(p => ({ id: p.id, username: p.username }))
    : [];

  io.to(roomCode).emit('turn_changed', {
    currentPlayerId, currentPlayer: currentPlayer.username,
    attemptsLeft: currentPlayer.attemptsLeft, targets,
  });

  const playerSocket = io.sockets.sockets.get(currentPlayerId);
  if (playerSocket) playerSocket.emit('your_turn', { attemptsLeft: currentPlayer.attemptsLeft, targets });

  clearPlayerTimer(room, currentPlayerId);
  room.timers[currentPlayerId] = setTimeout(() => {
    const r = rooms[roomCode];
    if (!r || r.state !== 'playing') return;
    if (r.turnOrder[r.currentTurnIndex] !== currentPlayerId) return;
    const cp = r.players.find(p => p.id === currentPlayerId);
    if (!cp || cp.eliminated) return;
    io.to(roomCode).emit('turn_timeout', { player: cp.username });
    advanceTurn(roomCode);
  }, 30000);
}

function advanceTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;
  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
  // In setguess mode, no elimination — always advance
  if (room.config.gameMode !== 'setguess' && getActivePlayers(room).length === 0) {
    endRound(roomCode, null, true); return;
  }
  sendTurn(roomCode);
}

function endRound(roomCode, winner, isDraw) {
  const room = rooms[roomCode];
  if (!room) return;
  clearAllTimers(room);
  room.state = 'playing'; // back to playing (was 'setting' possibly)

  room.players.forEach(p => {
    while (p.roundScores.length < room.currentRound) p.roundScores.push(0);
  });

  const sorted = [...room.players].sort((a, b) => b.score - a.score);

  // In setguess, reveal the secret numbers
  const secretsReveal = room.config.gameMode === 'setguess'
    ? room.players.map(p => ({ id: p.id, username: p.username, secret: room.playerSecrets[p.id] }))
    : null;

  io.to(roomCode).emit('round_ended', {
    round: room.currentRound, totalRounds: room.config.totalRounds,
    winner: winner ? winner.username : null, isDraw,
    secretNumber: room.secretNumber, secretsReveal,
    players: sorted, guessHistory: room.guessHistory,
    mode: room.config.gameMode,
  });

  if (room.currentRound >= room.config.totalRounds) {
    room.gameEndTimer = setTimeout(() => endGame(roomCode), 4000);
  } else {
    room.currentRound++;
    room.nextRoundTimer = setTimeout(() => startRound(roomCode), 5500);
  }
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.state = 'ended';
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  io.to(roomCode).emit('game_ended', { finalScores: sorted, winner: sorted[0]?.username || 'Tidak ada' });
}

function handleLeave(socket, roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const idx = room.players.findIndex(p => p.id === socket.id);
  if (idx === -1) return;

  const leaving = room.players[idx];
  room.players.splice(idx, 1);
  socket.leave(roomCode);
  clearPlayerTimer(room, socket.id);

  if (room.players.length === 0) { clearAllTimers(room); delete rooms[roomCode]; return; }

  if (room.host === socket.id) {
    room.host = room.players[0].id;
    io.to(roomCode).emit('host_changed', { newHostId: room.players[0].id, newHost: room.players[0].username });
  }

  io.to(roomCode).emit('player_left', { players: room.players, leftPlayer: leaving.username });

  // Handle setting phase disconnect
  if (room.state === 'setting') {
    if (!room.numbersSetBy.includes(socket.id)) {
      // Auto-assign random number for disconnected player
      room.playerSecrets[socket.id] = Math.floor(Math.random() * (room.config.max - room.config.min + 1)) + room.config.min;
      room.numbersSetBy.push(socket.id);
    }
    if (room.numbersSetBy.filter(id => room.players.find(p => p.id === id)).length >= room.players.length) {
      startSetguessGuessingPhase(roomCode);
    }
    return;
  }

  if (room.state === 'playing') {
    if (room.players.length < 2) {
      clearAllTimers(room);
      io.to(roomCode).emit('game_aborted', { message: 'Game berakhir — pemain tidak cukup.' });
      room.state = 'lobby'; return;
    }

    const turnIdx        = room.turnOrder.indexOf(socket.id);
    const wasCurrentTurn = room.turnOrder[room.currentTurnIndex] === socket.id;
    room.turnOrder       = room.turnOrder.filter(id => id !== socket.id);

    if (wasCurrentTurn) {
      if (room.currentTurnIndex >= room.turnOrder.length) room.currentTurnIndex = 0;
      if (room.config.gameMode !== 'setguess' && getActivePlayers(room).length === 0) endRound(roomCode, null, true);
      else sendTurn(roomCode);
    } else {
      if (turnIdx < room.currentTurnIndex) room.currentTurnIndex = Math.max(0, room.currentTurnIndex - 1);
      if (room.config.gameMode !== 'setguess' && getActivePlayers(room).length === 0) endRound(roomCode, null, true);
    }
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Higher or Lower — http://localhost:${PORT}`));
