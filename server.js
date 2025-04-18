// server.js - Node.js server using Socket.IO for a buzzer system with countdown and round tracking

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Data structures to track rooms and buzzer presses
const rooms = {};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Create a new room
  socket.on('create-room', () => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      hostId: socket.id,
      participants: {},
      buzzerState: 'standby', // 'standby', 'countdown', 'active', 'finished'
      buzzerPresses: [],
      countdownEndTime: null,
      rounds: [], // Store completed rounds
      currentRound: 1, // Track current round number
      nextParticipantNumber: 1 // Add a counter for participant numbers
    };
    
    socket.join(roomId);
    socket.emit('room-created', { roomId });
    console.log(`Room created: ${roomId} by host: ${socket.id}`);
  });

  // Join an existing room
  socket.on('join-room', ({ roomId }) => {
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'Room does not exist' });
      return;
    }

    socket.join(roomId);
    
    // Assign the next available participant number
    const participantNumber = rooms[roomId].nextParticipantNumber++;
    
    rooms[roomId].participants[socket.id] = {
      id: socket.id,
      name: `Player ${participantNumber}`, // Assign a name like "Player 1", "Player 2", etc.
      hasPressed: false,
      score: 0 // Track participant score
    };

    // Notify the host about the new participant
    socket.to(rooms[roomId].hostId).emit('participant-joined', {
      id: socket.id, 
      name: rooms[roomId].participants[socket.id].name
    });

    socket.emit('joined-room', { 
      roomId,
      isHost: false,
      participants: Object.values(rooms[roomId].participants),
      buzzerState: rooms[roomId].buzzerState,
      rounds: rooms[roomId].rounds, // Send round history
      currentRound: rooms[roomId].currentRound
    });

    console.log(`${rooms[roomId].participants[socket.id].name} joined room: ${roomId}`);
  });

  // Start countdown (host only)
  socket.on('start-countdown', ({ roomId, countdownSeconds }) => {
    if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) {
      return;
    }

    // Reset state for new round
    rooms[roomId].buzzerState = 'countdown';
    rooms[roomId].buzzerPresses = [];
    const endTime = Date.now() + (countdownSeconds * 1000);
    rooms[roomId].countdownEndTime = endTime;

    // Reset all participants' hasPressed flag
    for (const participantId in rooms[roomId].participants) {
      rooms[roomId].participants[participantId].hasPressed = false;
    }

    // Notify everyone in the room about the countdown
    io.to(roomId).emit('countdown-started', {
      buzzerState: 'countdown',
      countdownSeconds,
      endTime,
      currentRound: rooms[roomId].currentRound
    });

    console.log(`Countdown started in room ${roomId} for ${countdownSeconds} seconds (Round ${rooms[roomId].currentRound})`);

    // Schedule state change to active when countdown ends
    setTimeout(() => {
      if (rooms[roomId]) {
        rooms[roomId].buzzerState = 'active';
        io.to(roomId).emit('buzzer-active', {
          buzzerState: 'active'
        });
        console.log(`Buzzer now active in room ${roomId}`);
      }
    }, countdownSeconds * 1000);
  });

  // Handle buzzer press
  socket.on('buzz', ({ roomId, clientTimestamp }) => {
    if (!rooms[roomId] || rooms[roomId].buzzerState !== 'active') {
      return;
    }

    const participant = rooms[roomId].participants[socket.id];
    if (!participant || participant.hasPressed) return;

    // Mark participant as having pressed
    participant.hasPressed = true;
    
    // We'll use server timestamp for fairness but record client timestamp too
    const serverTimestamp = Date.now();
    
    // Calculate time from when buzzer became active
    const reactionTime = serverTimestamp - rooms[roomId].countdownEndTime;
    
    // Record the buzzer press
    const buzzerPress = {
      id: socket.id,
      name: participant.name,
      serverTimestamp,
      clientTimestamp,
      reactionTime
    };
    
    rooms[roomId].buzzerPresses.push(buzzerPress);
    
    // Sort buzzer presses by reaction time
    rooms[roomId].buzzerPresses.sort((a, b) => a.reactionTime - b.reactionTime);

    // Notify everyone in the room about the buzz
    io.to(roomId).emit('buzz-event', {
      id: socket.id,
      name: participant.name,
      buzzerPresses: rooms[roomId].buzzerPresses
    });

    // Notify just this participant about their buzz
    socket.emit('your-buzz-recorded', {
      reactionTime
    });

    console.log(`Buzz from ${participant.name} in room ${roomId} with reaction time ${reactionTime}ms`);
  });

  // End buzzer round (host only)
  socket.on('end-round', ({ roomId }) => {
    if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) {
      return;
    }

    rooms[roomId].buzzerState = 'finished';
    
    // Save the round results if there were any buzzes
    if (rooms[roomId].buzzerPresses.length > 0) {
      // Award points to the winner (first buzzer)
      const winnerId = rooms[roomId].buzzerPresses[0].id;
      if (rooms[roomId].participants[winnerId]) {
        rooms[roomId].participants[winnerId].score += 1;
      }
      
      // Store round results
      const roundResult = {
        roundNumber: rooms[roomId].currentRound,
        buzzerPresses: [...rooms[roomId].buzzerPresses],
        winner: {
          id: rooms[roomId].buzzerPresses[0].id,
          name: rooms[roomId].buzzerPresses[0].name,
          reactionTime: rooms[roomId].buzzerPresses[0].reactionTime
        },
        timestamp: Date.now()
      };
      
      rooms[roomId].rounds.push(roundResult);
    } else {
      // Store empty round result if no one buzzed
      const roundResult = {
        roundNumber: rooms[roomId].currentRound,
        buzzerPresses: [],
        winner: null,
        timestamp: Date.now()
      };
      
      rooms[roomId].rounds.push(roundResult);
    }

    // Get participant scores
    const scores = {};
    for (const id in rooms[roomId].participants) {
      scores[id] = {
        name: rooms[roomId].participants[id].name,
        score: rooms[roomId].participants[id].score
      };
    }

    // Notify everyone in the room
    io.to(roomId).emit('round-ended', {
      buzzerState: 'finished',
      buzzerPresses: rooms[roomId].buzzerPresses,
      rounds: rooms[roomId].rounds,
      scores: scores
    });

    console.log(`Round ${rooms[roomId].currentRound} ended in room ${roomId}`);
  });

  // Reset the buzzer (host only)
  socket.on('reset-buzzer', ({ roomId }) => {
    if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) {
      return;
    }

    rooms[roomId].buzzerState = 'standby';
    rooms[roomId].buzzerPresses = [];
    rooms[roomId].countdownEndTime = null;
    rooms[roomId].currentRound += 1; // Increment round number

    // Reset all participants' hasPressed flag
    for (const participantId in rooms[roomId].participants) {
      rooms[roomId].participants[participantId].hasPressed = false;
    }

    // Get participant scores
    const scores = {};
    for (const id in rooms[roomId].participants) {
      scores[id] = {
        name: rooms[roomId].participants[id].name,
        score: rooms[roomId].participants[id].score
      };
    }

    // Notify everyone in the room about the reset
    io.to(roomId).emit('buzzer-reset', {
      buzzerState: 'standby',
      buzzerPresses: [],
      currentRound: rooms[roomId].currentRound,
      rounds: rooms[roomId].rounds,
      scores: scores
    });

    console.log(`Buzzer reset in room ${roomId} for round ${rooms[roomId].currentRound}`);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    // Find if user was in any room
    for (const roomId in rooms) {
      // If user was a host
      if (rooms[roomId].hostId === socket.id) {
        // Notify all participants that the room is closing
        io.to(roomId).emit('room-closed', { message: 'Host has left the room' });
        delete rooms[roomId];
        console.log(`Room ${roomId} closed because host left`);
      } 
      // If user was a participant
      else if (rooms[roomId].participants[socket.id]) {
        const participantName = rooms[roomId].participants[socket.id].name;
        
        // Notify host that participant left
        io.to(rooms[roomId].hostId).emit('participant-left', { 
          id: socket.id, 
          name: participantName 
        });
        
        delete rooms[roomId].participants[socket.id];
        console.log(`${participantName} left room ${roomId}`);
      }
    }
    
    console.log('User disconnected:', socket.id);
  });
});

// Generate a simple 6-character room ID
function generateRoomId() {
  const chars = '0123456789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});