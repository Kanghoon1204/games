import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());

// 정적 파일 서빙
const clientPath = path.resolve(__dirname, '../client');
console.log('Static files:', clientPath);
app.use(express.static(clientPath));

// 명시적 라우팅
app.get('/', (req, res) => res.sendFile(path.join(clientPath, 'index.html')));
app.get('/ulleung', (req, res) => res.redirect('/ulleung/room.html'));
app.get('/ulleung/', (req, res) => res.redirect('/ulleung/room.html'));

// 404 처리
app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(clientPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not Found' });
  }
});

// ─────────────────────────────────────────────────────────────
// 게임 로직
// ─────────────────────────────────────────────────────────────

const rooms = new Map();
const ROOM_TIMEOUT = 15 * 60 * 1000;
const INACTIVE_TIMEOUT = 60 * 60 * 1000;
const ITEMS = ['오징어', '독도새우', '호박', '명이나물'];
const randomItem = () => ITEMS[Math.floor(Math.random() * ITEMS.length)];

function generateRoomId(hostName) {
  const base = `${hostName}의방`;
  let candidate = base;
  let idx = 2;
  while (rooms.has(candidate)) {
    candidate = `${base}${idx++}`;
    if (idx > 99) return `${base}${Date.now()}`;
  }
  return candidate;
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimeout(room.timeout);
  clearTimeout(room.inactiveTimeout);
  rooms.delete(roomId);
  io.to(roomId).emit('room:deleted', { message: '방이 삭제되었습니다.' });
  console.log(`Room deleted: ${roomId}`);
}

function broadcastRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    if (!room.started && !room.gameOver) {
      list.push({
        id,
        hostName: room.hostName,
        playerCount: room.players.length,
        maxPlayers: 8,
        boardMode: room.boardMode,
        createdAt: room.createdAt
      });
    }
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  io.emit('rooms:list', list.slice(0, 20));
}

function resetInactiveTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimeout(room.inactiveTimeout);
  room.inactiveTimeout = setTimeout(() => {
    if (!room.gameOver) cleanupRoom(roomId);
    broadcastRoomList();
  }, INACTIVE_TIMEOUT);
}

function sanitizeRoom(room, forPlayer = null) {
  return {
    id: room.id,
    hostName: room.hostName,
    boardMode: room.boardMode,
    started: room.started,
    gameOver: room.gameOver,
    round: room.round,
    phase: room.phase,
    currentItem: room.currentItem,
    participants: room.participants,
    lastWinners: room.lastWinners,
    lastItem: room.lastItem,
    roundLogs: room.roundLogs.slice(-10),
    finalWinners: room.finalWinners,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      balance: p.name === forPlayer ? p.balance : null, // 본인만 잔액 공개
      hold: p.name === forPlayer ? p.hold : null,
      itemCount: (p.items || []).length,
      items: p.name === forPlayer ? p.items : null, // 본인만 아이템 공개
      readyPart: p.readyPart,
      readyBid: p.readyBid,
      willParticipate: p.willParticipate,
      isHost: p.name === room.hostName
    }))
  };
}

function checkWin(items) {
  if (!items || items.length === 0) return null;
  const count = {};
  items.forEach(it => count[it] = (count[it] || 0) + 1);
  if (items.length >= 5) return 'any5';
  if (Object.values(count).some(v => v >= 3)) return 'same3';
  if (new Set(items).size >= 4) return 'diff4';
  return null;
}

function resetRoundState(room) {
  room.phase = 'choose';
  room.participants = [];
  room.players.forEach(p => {
    p.willParticipate = null;
    p.readyPart = false;
    p.readyBid = false;
    p.bid = 0;
  });
}

function checkPhaseAdvance(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'choose') return;

  const allReady = room.players.every(p => p.readyPart);
  if (!allReady) return;

  const participants = room.players
    .filter(p => p.willParticipate === true)
    .map(p => p.name);

  room.participants = participants;

  if (!room.boardMode && !room.currentItem) {
    room.currentItem = randomItem();
  }

  if (participants.length === 0) {
    nextRound(roomId, [], room.currentItem);
  } else if (participants.length === 1) {
    settleSingleBidder(roomId, participants[0]);
  } else {
    room.phase = 'bid';
    broadcastToRoom(roomId);
  }
}

function checkBidSettle(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'bid') return;

  const bidders = room.players.filter(p => room.participants.includes(p.name));
  const allReady = bidders.every(p => p.readyBid);
  if (!allReady) return;

  settleAuction(roomId);
}

function settleAuction(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const item = room.currentItem;
  const bidders = room.players.filter(p => room.participants.includes(p.name));
  const holds = bidders.map(p => p.hold);
  const maxHold = Math.max(0, ...holds);
  const allZero = holds.every(h => h === 0);

  let winners = [];

  if (allZero) {
    winners = bidders.map(p => p.name);
    bidders.forEach(p => {
      p.balance += p.hold;
      p.hold = 0;
      p.items.push(item);
    });
  } else if (maxHold > 0) {
    winners = bidders.filter(p => p.hold === maxHold).map(p => p.name);
    bidders.forEach(p => {
      if (winners.includes(p.name)) {
        p.items.push(item);
      } else {
        p.balance += p.hold;
      }
      p.hold = 0;
    });
  }

  room.players.forEach(p => {
    if (!room.participants.includes(p.name)) {
      p.balance += p.hold;
      p.hold = 0;
    }
  });

  nextRound(roomId, winners, item);
}

function settleSingleBidder(roomId, winnerName) {
  const room = rooms.get(roomId);
  if (!room) return;

  const item = room.currentItem;
  const winner = room.players.find(p => p.name === winnerName);
  if (winner) {
    winner.balance += winner.hold;
    winner.hold = 0;
    winner.items.push(item);
  }

  room.players.forEach(p => {
    if (p.name !== winnerName) {
      p.balance += p.hold;
      p.hold = 0;
    }
  });

  nextRound(roomId, [winnerName], item);
}

function nextRound(roomId, winners, item) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.round++;
  room.lastWinners = winners;
  room.lastItem = item;

  room.roundLogs.push({
    round: room.round,
    item,
    participants: [...room.participants],
    winners
  });

  // 승리 체크
  const gameWinners = room.players
    .filter(p => checkWin(p.items))
    .map(p => p.name);

  if (gameWinners.length > 0) {
    room.gameOver = true;
    room.finalWinners = gameWinners;

    // 게임 종료 시 모든 정보 공개
    const finalRoom = {
      ...sanitizeRoom(room),
      players: room.players.map(p => ({
        ...p,
        balance: p.balance,
        items: p.items
      }))
    };

    io.to(roomId).emit('game:ended', {
      message: `게임 종료! 우승: ${gameWinners.join(', ')}`,
      winners: gameWinners,
      room: finalRoom
    });

    setTimeout(() => cleanupRoom(roomId), 30000);
    broadcastRoomList();
    return;
  }

  // 라운드 결과 전송 (개인별)
  room.players.forEach(p => {
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) {
      socket.emit('round:result', {
        round: room.round,
        item,
        winners,
        isWinner: winners.includes(p.name),
        wasParticipant: room.participants.includes(p.name),
        room: sanitizeRoom(room, p.name)
      });
    }
  });

  resetRoundState(room);
  room.currentItem = room.boardMode ? '' : randomItem();
  room.updatedAt = Date.now();
}

function broadcastToRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.players.forEach(p => {
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) {
      socket.emit('room:updated', sanitizeRoom(room, p.name));
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Socket.io 이벤트
// ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('rooms:get', () => {
    const list = [];
    for (const [id, room] of rooms) {
      if (!room.started && !room.gameOver) {
        list.push({
          id,
          hostName: room.hostName,
          playerCount: room.players.length,
          maxPlayers: 8,
          boardMode: room.boardMode
        });
      }
    }
    socket.emit('rooms:list', list);
  });

  socket.on('room:create', ({ hostName, boardMode }) => {
    if (!hostName?.trim()) {
      return socket.emit('error', { message: '닉네임을 입력하세요.' });
    }

    const name = hostName.trim().slice(0, 10);
    const roomId = generateRoomId(name);

    const room = {
      id: roomId,
      hostName: name,
      hostSocketId: socket.id,
      boardMode: boardMode === true,
      started: false,
      gameOver: false,
      players: [{
        id: 'P1',
        socketId: socket.id,
        name,
        balance: 1000000,
        hold: 0,
        bid: 0,
        items: [],
        willParticipate: null,
        readyPart: false,
        readyBid: false
      }],
      round: 0,
      phase: 'choose',
      currentItem: '',
      participants: [],
      lastWinners: [],
      lastItem: '',
      roundLogs: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = name;

    room.timeout = setTimeout(() => {
      if (!room.started) cleanupRoom(roomId);
      broadcastRoomList();
    }, ROOM_TIMEOUT);

    console.log(`Room created: ${roomId} by ${name}`);
    socket.emit('room:created', { roomId, room: sanitizeRoom(room, name) });
    broadcastRoomList();
  });

  socket.on('room:join', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', { message: '존재하지 않는 방입니다.' });

    const name = playerName?.trim().slice(0, 10);
    if (!name) return socket.emit('error', { message: '닉네임을 입력하세요.' });

    // 이미 있는 플레이어면 재연결
    const existing = room.players.find(p => p.name === name);
    if (existing) {
      existing.socketId = socket.id;
      socket.join(roomId);
      socket.roomId = roomId;
      socket.playerName = name;
      socket.emit('room:joined', { roomId, room: sanitizeRoom(room, name), playerName: name, reconnected: true });
      broadcastToRoom(roomId);
      return;
    }

    if (room.started) return socket.emit('error', { message: '이미 게임이 시작된 방입니다.' });
    if (room.players.length >= 8) return socket.emit('error', { message: '정원이 가득 찼습니다.' });

    room.players.push({
      id: `P${room.players.length + 1}`,
      socketId: socket.id,
      name,
      balance: 1000000,
      hold: 0,
      bid: 0,
      items: [],
      willParticipate: null,
      readyPart: false,
      readyBid: false
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = name;
    room.updatedAt = Date.now();

    console.log(`${name} joined ${roomId}`);
    socket.emit('room:joined', { roomId, room: sanitizeRoom(room, name), playerName: name });
    broadcastToRoom(roomId);
    broadcastRoomList();
  });

  socket.on('room:leave', () => handleLeave(socket));

  socket.on('game:start', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (socket.id !== room.hostSocketId) return socket.emit('error', { message: '방장만 시작할 수 있습니다.' });
    if (room.players.length < 3) return socket.emit('error', { message: '최소 3명이 필요합니다.' });

    room.started = true;
    room.phase = 'choose';
    room.round = 0;
    if (!room.boardMode) room.currentItem = randomItem();

    clearTimeout(room.timeout);
    resetInactiveTimeout(socket.roomId);

    console.log(`Game started: ${socket.roomId}`);

    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('game:started', sanitizeRoom(room, p.name));
    });

    broadcastRoomList();
  });

  socket.on('game:setItem', ({ item }) => {
    const room = rooms.get(socket.roomId);
    if (!room?.started || !room.boardMode) return;
    if (socket.id !== room.hostSocketId) return;

    resetRoundState(room);
    room.currentItem = item || '';
    room.updatedAt = Date.now();
    resetInactiveTimeout(socket.roomId);
    broadcastToRoom(socket.roomId);
  });

  socket.on('game:lockPart', ({ willParticipate }) => {
    const room = rooms.get(socket.roomId);
    if (!room?.started || room.gameOver || room.phase !== 'choose') return;
    if (room.boardMode && !room.currentItem) {
      return socket.emit('error', { message: '방장이 상품을 선택해야 합니다.' });
    }

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.readyPart) return;

    player.willParticipate = willParticipate === true;
    player.readyPart = true;
    if (!player.willParticipate) player.balance += 50000;

    room.updatedAt = Date.now();
    resetInactiveTimeout(socket.roomId);
    broadcastToRoom(socket.roomId);
    checkPhaseAdvance(socket.roomId);
  });

  socket.on('game:confirmBid', ({ amount }) => {
    const room = rooms.get(socket.roomId);
    if (!room?.started || room.gameOver || room.phase !== 'bid') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.readyBid || !room.participants.includes(player.name)) return;

    const maxBid = player.balance + player.hold;
    const bidAmount = Math.max(0, Math.min(Math.floor(amount / 10000) * 10000, maxBid));

    player.hold = bidAmount;
    player.bid = bidAmount;
    player.balance = maxBid - bidAmount;
    player.readyBid = true;

    room.updatedAt = Date.now();
    resetInactiveTimeout(socket.roomId);
    broadcastToRoom(socket.roomId);
    checkBidSettle(socket.roomId);
  });

  socket.on('game:cancelBid', () => {
    const room = rooms.get(socket.roomId);
    if (!room?.started || room.gameOver || room.phase !== 'bid') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.readyBid || !room.participants.includes(player.name)) return;

    player.balance += player.hold;
    player.hold = 0;
    player.bid = 0;
    player.readyBid = true;

    room.updatedAt = Date.now();
    resetInactiveTimeout(socket.roomId);
    broadcastToRoom(socket.roomId);
    checkBidSettle(socket.roomId);
  });

  socket.on('game:end', () => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostSocketId) return;

    room.gameOver = true;
    io.to(socket.roomId).emit('game:ended', {
      message: '방장이 게임을 종료했습니다.',
      room: sanitizeRoom(room)
    });
    setTimeout(() => cleanupRoom(socket.roomId), 5000);
    broadcastRoomList();
  });

  socket.on('room:delete', () => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostSocketId) return;
    cleanupRoom(socket.roomId);
    broadcastRoomList();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    // 연결 끊김 시 바로 제거하지 않고 30초 대기 (재연결 기회)
    const roomId = socket.roomId;
    const playerName = socket.playerName;

    setTimeout(() => {
      const room = rooms.get(roomId);
      if (!room) return;

      const player = room.players.find(p => p.name === playerName);
      if (player && player.socketId === socket.id) {
        // 여전히 재연결 안 됨 → 제거
        handleLeave(socket, true);
      }
    }, 30000);
  });

  function handleLeave(sock, silent = false) {
    const roomId = sock.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const idx = room.players.findIndex(p => p.socketId === sock.id);
    if (idx === -1) return;

    const wasHost = sock.id === room.hostSocketId;
    room.players.splice(idx, 1);
    sock.leave(roomId);

    if (wasHost || room.players.length === 0) {
      cleanupRoom(roomId);
    } else {
      // 새 방장 지정
      if (wasHost && room.players.length > 0) {
        room.hostSocketId = room.players[0].socketId;
        room.hostName = room.players[0].name;
      }
      broadcastToRoom(roomId);
    }
    broadcastRoomList();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Client path: ${clientPath}`);
});
