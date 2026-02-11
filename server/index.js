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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// 정적 파일 서빙 (client 폴더)
app.use(express.static(path.join(__dirname, '../client')));

// 방 저장소
const rooms = new Map();

// 15분 후 미시작 방 자동 삭제
const ROOM_TIMEOUT = 15 * 60 * 1000;
// 1시간 후 비활성 방 삭제
const INACTIVE_TIMEOUT = 60 * 60 * 1000;

function generateRoomId(hostName) {
  const base = `${hostName}의 방`;
  let candidate = base;
  let idx = 2;
  while (rooms.has(candidate)) {
    candidate = `${base} ${idx++}`;
    if (idx > 99) return `${base} ${Date.now()}`;
  }
  return candidate;
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    if (room.timeout) clearTimeout(room.timeout);
    if (room.inactiveTimeout) clearTimeout(room.inactiveTimeout);
    rooms.delete(roomId);
    io.to(roomId).emit('room:deleted', { message: '방이 삭제되었습니다.' });
  }
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
  if (room.inactiveTimeout) clearTimeout(room.inactiveTimeout);
  room.inactiveTimeout = setTimeout(() => {
    if (!room.gameOver) {
      cleanupRoom(roomId);
      broadcastRoomList();
    }
  }, INACTIVE_TIMEOUT);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // 방 목록 요청
  socket.on('rooms:get', () => {
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
    socket.emit('rooms:list', list.slice(0, 20));
  });

  // 방 생성
  socket.on('room:create', ({ hostName, boardMode }) => {
    if (!hostName || hostName.trim().length === 0) {
      socket.emit('error', { message: '닉네임을 입력하세요.' });
      return;
    }

    const roomId = generateRoomId(hostName.trim());
    const room = {
      id: roomId,
      hostName: hostName.trim(),
      hostSocketId: socket.id,
      boardMode: boardMode === true,
      started: false,
      gameOver: false,
      players: [{
        id: 'P1',
        socketId: socket.id,
        name: hostName.trim(),
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
    socket.playerName = hostName.trim();

    // 15분 타이머
    room.timeout = setTimeout(() => {
      if (!room.started) {
        cleanupRoom(roomId);
        broadcastRoomList();
      }
    }, ROOM_TIMEOUT);

    socket.emit('room:created', { roomId, room: sanitizeRoom(room) });
    broadcastRoomList();
  });

  // 방 참가
  socket.on('room:join', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: '존재하지 않는 방입니다.' });
      return;
    }
    if (room.started) {
      socket.emit('error', { message: '이미 게임이 시작된 방입니다.' });
      return;
    }
    if (room.players.length >= 8) {
      socket.emit('error', { message: '정원이 가득 찼습니다.' });
      return;
    }
    if (room.players.some(p => p.name === playerName.trim())) {
      socket.emit('error', { message: '같은 닉네임이 이미 있습니다.' });
      return;
    }

    const player = {
      id: `P${room.players.length + 1}`,
      socketId: socket.id,
      name: playerName.trim(),
      balance: 1000000,
      hold: 0,
      bid: 0,
      items: [],
      willParticipate: null,
      readyPart: false,
      readyBid: false
    };

    room.players.push(player);
    room.updatedAt = Date.now();
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName.trim();

    socket.emit('room:joined', { roomId, room: sanitizeRoom(room), playerName: playerName.trim() });
    io.to(roomId).emit('room:updated', sanitizeRoom(room));
    broadcastRoomList();
  });

  // 방 나가기
  socket.on('room:leave', () => {
    handleLeave(socket);
  });

  // 게임 시작
  socket.on('game:start', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (socket.id !== room.hostSocketId) {
      socket.emit('error', { message: '방장만 시작할 수 있습니다.' });
      return;
    }
    if (room.players.length < 3) {
      socket.emit('error', { message: '최소 3명이 필요합니다.' });
      return;
    }

    room.started = true;
    room.phase = 'choose';
    room.round = 0;
    room.updatedAt = Date.now();

    // 웹 전용 모드면 자동으로 아이템 설정
    if (!room.boardMode) {
      room.currentItem = randomItem();
    }

    if (room.timeout) clearTimeout(room.timeout);
    resetInactiveTimeout(socket.roomId);

    io.to(socket.roomId).emit('game:started', sanitizeRoom(room));
    broadcastRoomList();
  });

  // 방장: 상품 설정 (보드게임 모드)
  socket.on('game:setItem', ({ item }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.started) return;
    if (socket.id !== room.hostSocketId) return;
    if (!room.boardMode) return;

    // 상품 변경 시 라운드 리셋
    resetRoundState(room);
    room.currentItem = item || '';
    room.updatedAt = Date.now();
    resetInactiveTimeout(socket.roomId);

    io.to(socket.roomId).emit('room:updated', sanitizeRoom(room));
  });

  // 응찰 확정
  socket.on('game:lockPart', ({ willParticipate }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.started || room.gameOver) return;
    if (room.phase !== 'choose') return;

    // 보드게임 모드에서 상품 없으면 불가
    if (room.boardMode && !room.currentItem) {
      socket.emit('error', { message: '방장이 상품을 선택해야 합니다.' });
      return;
    }

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.readyPart) return;

    player.willParticipate = willParticipate === true;
    player.readyPart = true;

    // 불응찰 보너스
    if (!player.willParticipate) {
      player.balance += 50000;
    }

    room.updatedAt = Date.now();
    resetInactiveTimeout(socket.roomId);

    io.to(socket.roomId).emit('room:updated', sanitizeRoom(room));

    // 모두 확정했는지 체크
    checkPhaseAdvance(socket.roomId);
  });

  // 입찰 확정
  socket.on('game:confirmBid', ({ amount }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.started || room.gameOver) return;
    if (room.phase !== 'bid') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.readyBid) return;
    if (!room.participants.includes(player.name)) return;

    const maxBid = player.balance + player.hold;
    const bidAmount = Math.max(0, Math.min(Math.floor(amount / 10000) * 10000, maxBid));

    player.hold = bidAmount;
    player.bid = bidAmount;
    player.balance = maxBid - bidAmount;
    player.readyBid = true;

    room.updatedAt = Date.now();
    resetInactiveTimeout(socket.roomId);

    io.to(socket.roomId).emit('room:updated', sanitizeRoom(room));

    checkBidSettle(socket.roomId);
  });

  // 입찰 취소 (0원 입찰)
  socket.on('game:cancelBid', () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.started || room.gameOver) return;
    if (room.phase !== 'bid') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.readyBid) return;
    if (!room.participants.includes(player.name)) return;

    player.balance += player.hold;
    player.hold = 0;
    player.bid = 0;
    player.readyBid = true;

    room.updatedAt = Date.now();
    resetInactiveTimeout(socket.roomId);

    io.to(socket.roomId).emit('room:updated', sanitizeRoom(room));

    checkBidSettle(socket.roomId);
  });

  // 게임 종료 (방장)
  socket.on('game:end', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;

    room.gameOver = true;
    room.updatedAt = Date.now();

    io.to(socket.roomId).emit('game:ended', {
      message: '게임이 종료되었습니다.',
      room: sanitizeRoom(room)
    });

    // 5초 후 방 삭제
    setTimeout(() => cleanupRoom(socket.roomId), 5000);
    broadcastRoomList();
  });

  // 방 삭제 (방장)
  socket.on('room:delete', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;

    cleanupRoom(socket.roomId);
    broadcastRoomList();
  });

  // 연결 해제
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    handleLeave(socket);
  });
});

function handleLeave(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
  if (playerIdx === -1) return;

  room.players.splice(playerIdx, 1);
  room.updatedAt = Date.now();
  socket.leave(roomId);

  // 방장이 나가면 방 삭제
  if (socket.id === room.hostSocketId || room.players.length === 0) {
    cleanupRoom(roomId);
  } else {
    io.to(roomId).emit('room:updated', sanitizeRoom(room));
  }

  broadcastRoomList();
}

// 응찰 확정 후 phase 전환 체크
function checkPhaseAdvance(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'choose') return;

  const allReady = room.players.every(p => p.readyPart);
  if (!allReady) return;

  const participants = room.players
    .filter(p => p.willParticipate === true)
    .map(p => p.name);

  room.participants = participants;

  // 웹 전용 모드에서 상품 자동 설정
  if (!room.boardMode && !room.currentItem) {
    room.currentItem = randomItem();
  }

  if (participants.length === 0) {
    // 모두 불응찰 → 다음 라운드
    nextRound(roomId, [], room.currentItem);
  } else if (participants.length === 1) {
    // 단독 응찰 → 0원 낙찰
    settleSingleBidder(roomId, participants[0]);
  } else {
    // 입찰 단계로
    room.phase = 'bid';
    io.to(roomId).emit('room:updated', sanitizeRoom(room));
  }
}

// 입찰 완료 체크
function checkBidSettle(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'bid') return;

  const bidders = room.players.filter(p => room.participants.includes(p.name));
  const allReady = bidders.every(p => p.readyBid);
  if (!allReady) return;

  settleAuction(roomId);
}

// 경매 정산
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
    // 모두 0원 → 전원 낙찰
    winners = bidders.map(p => p.name);
    bidders.forEach(p => {
      p.balance += p.hold;
      p.hold = 0;
      p.items.push(item);
    });
  } else if (maxHold > 0) {
    // 최고가 입찰자 낙찰
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

  // 비응찰자 hold 환불 (안전장치)
  room.players.forEach(p => {
    if (!room.participants.includes(p.name)) {
      p.balance += p.hold;
      p.hold = 0;
    }
  });

  nextRound(roomId, winners, item);
}

// 단독 응찰자 처리
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

  // 다른 플레이어 hold 환불
  room.players.forEach(p => {
    if (p.name !== winnerName) {
      p.balance += p.hold;
      p.hold = 0;
    }
  });

  nextRound(roomId, [winnerName], item);
}

// 다음 라운드
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
  if (room.roundLogs.length > 30) room.roundLogs.shift();

  // 승리 조건 체크
  const gameWinners = [];
  room.players.forEach(p => {
    const reason = checkWin(p.items);
    if (reason) gameWinners.push(p.name);
  });

  if (gameWinners.length > 0) {
    room.gameOver = true;
    room.finalWinners = gameWinners;
    io.to(roomId).emit('game:ended', {
      message: `게임 종료! 우승: ${gameWinners.join(', ')}`,
      winners: gameWinners,
      room: sanitizeRoom(room)
    });
    setTimeout(() => cleanupRoom(roomId), 10000);
    broadcastRoomList();
    return;
  }

  // 라운드 초기화
  resetRoundState(room);
  room.currentItem = room.boardMode ? '' : randomItem();

  io.to(roomId).emit('round:result', {
    round: room.round,
    item,
    winners,
    room: sanitizeRoom(room)
  });
}

function resetRoundState(room) {
  room.phase = 'choose';
  room.participants = [];
  room.players.forEach(p => {
    p.willParticipate = null;
    p.readyPart = false;
    p.readyBid = false;
    p.bid = 0;
    // hold는 유지 (이전 라운드에서 환불 처리됨)
  });
}

// 승리 조건 체크
function checkWin(items) {
  if (!items || items.length === 0) return null;
  const count = {};
  items.forEach(it => count[it] = (count[it] || 0) + 1);

  if (items.length >= 5) return 'any5';
  if (Object.values(count).some(v => v >= 3)) return 'same3';
  if (new Set(items).size >= 4) return 'diff4';
  return null;
}

// 랜덤 아이템
const ITEMS = ['오징어', '독도새우', '호박', '명이나물'];
function randomItem() {
  return ITEMS[Math.floor(Math.random() * ITEMS.length)];
}

// 클라이언트에 보낼 때 민감정보 제거
function sanitizeRoom(room) {
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
    roundLogs: room.roundLogs,
    finalWinners: room.finalWinners,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      balance: p.balance,
      hold: p.hold,
      items: p.items,
      willParticipate: p.willParticipate,
      readyPart: p.readyPart,
      readyBid: p.readyBid
    }))
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
