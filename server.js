// server.js - Node.js server using Socket.IO for a buzzer system with countdown and round tracking

const DISCONNECT_GRACE_PERIOD = 0; // 60 seconds before actually removing participant

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
const disconnectedParticipants = {}; // Store disconnected participants by room

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // New handler for participants rejoining
  socket.on('rejoin-room', ({ roomId, participantId }) => {
    console.log(`Attempt to rejoin room ${roomId} with ID ${participantId}`);
    
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'Room does not exist' });
      return;
    }
    
    // Check if this was a participant that was in disconnect grace period
    if (disconnectedParticipants[roomId] && 
        disconnectedParticipants[roomId][participantId]) {
      
      // Clear the timeout that would have removed them
      clearTimeout(disconnectedParticipants[roomId][participantId].timeoutId);
      delete disconnectedParticipants[roomId][participantId];
      
      // Restore their previous data
      const participantData = rooms[roomId].participants[participantId];
      
      if (participantData) {
        // Update the socket ID but keep their participant ID and data
        participantData.socketId = socket.id;
        socket.join(roomId);
        
        // Send the current state to the rejoined participant
        socket.emit('rejoined-room', { 
          roomId,
          isHost: rooms[roomId].hostId === participantId,
          participants: Object.values(rooms[roomId].participants),
          buzzerState: rooms[roomId].buzzerState,
          rounds: rooms[roomId].rounds,
          currentRound: rooms[roomId].currentRound,
          participantId: participantId,
          playerNum: parseInt(participantData.name) // Send back their player number
        });
        
        // Let the host know they're back
        socket.to(rooms[roomId].hostId).emit('participant-rejoined', {
          id: participantId,
          name: participantData.name
        });
        
        console.log(`Player ${participantData.name} rejoined room: ${roomId}`);
      } else {
        socket.emit('error', { message: 'Could not find your previous session' });
      }
    } else {
      socket.emit('error', { message: 'Session expired or not found' });
    }
  });
  
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
      playerNumbers: [] // Track taken player numbers
    };
    
    socket.join(roomId);
    socket.emit('room-created', { roomId });
    console.log(`Room created: ${roomId} by host: ${socket.id}`);
  });

  // Join an existing room with player number
  socket.on('join-room', ({ roomId, playerNum }) => {
    if (!rooms[roomId]) {
      socket.emit('join-error', { message: 'Room does not exist' });
      return;
    }
    
    // Validate the player number
    if (isNaN(playerNum) || playerNum < 1 || playerNum > 50) {
      socket.emit('join-error', { message: 'Player number must be between 1 and 50' });
      return;
    }
    
    // Check if the player number is already taken
    if (rooms[roomId].playerNumbers.includes(playerNum)) {
      socket.emit('join-error', { message: `Player number ${playerNum} is already taken` });
      return;
    }
    
    // Add the player number to the taken list
    rooms[roomId].playerNumbers.push(playerNum);
    
    // Create participant
    const participantId = socket.id;
    rooms[roomId].participants[participantId] = {
      id: participantId,
      socketId: socket.id,
      name: playerNum.toString(), // Store the player number as the name
      hasPressed: false,
      score: 0
    };
    
    socket.join(roomId);
    
    // Notify the host about the new participant
    socket.to(rooms[roomId].hostId).emit('participant-joined', {
      id: participantId, 
      name: playerNum.toString()
    });
    
    socket.emit('joined-room', { 
      roomId,
      isHost: false,
      participants: Object.values(rooms[roomId].participants),
      buzzerState: rooms[roomId].buzzerState,
      rounds: rooms[roomId].rounds,
      currentRound: rooms[roomId].currentRound,
      playerNum: playerNum
    });
    
    console.log(`Player ${playerNum} joined room: ${roomId}`);
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

    console.log(`Buzz from Player ${participant.name} in room ${roomId} with reaction time ${reactionTime}ms`);
  });

  // End buzzer round (host only)
  socket.on('end-round', ({ roomId }) => {
    if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) {
      return;
    }
  
    // First, handle the round ending functionality
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
  
    // Notify everyone about the round ending
    io.to(roomId).emit('round-ended', {
      buzzerState: 'finished',
      buzzerPresses: rooms[roomId].buzzerPresses,
      rounds: rooms[roomId].rounds,
      scores: scores
    });
  
    console.log(`Round ${rooms[roomId].currentRound} ended in room ${roomId}`);
  
    // Now automatically reset for the next round (combining reset-buzzer functionality)
    rooms[roomId].buzzerState = 'standby';
    rooms[roomId].buzzerPresses = [];
    rooms[roomId].countdownEndTime = null;
    rooms[roomId].currentRound += 1; // Increment round number
  
    // Reset all participants' hasPressed flag
    for (const participantId in rooms[roomId].participants) {
      rooms[roomId].participants[participantId].hasPressed = false;
    }
  
    // Notify everyone about the reset for next round
    io.to(roomId).emit('buzzer-reset', {
      buzzerState: 'standby',
      buzzerPresses: [],
      currentRound: rooms[roomId].currentRound,
      rounds: rooms[roomId].rounds,
      scores: scores
    });
  
    console.log(`Buzzer reset in room ${roomId} for round ${rooms[roomId].currentRound}`);
  });

// Update the disconnect handler in server.js

// Handle disconnection
socket.on('disconnect', () => {
  // Find if user was in any room
  for (const roomId in rooms) {
    // If user was a host
    if (rooms[roomId].hostId === socket.id) {
      // For hosts, we close the room
      // Notify all participants that the room is closing
      io.to(roomId).emit('room-closed', { message: 'Host has left the room' });
      delete rooms[roomId];
      
      // Also clean up any disconnected participants for this room
      if (disconnectedParticipants[roomId]) {
        delete disconnectedParticipants[roomId];
      }
      
      console.log(`Room ${roomId} closed because host left`);
    } 
    // If user was a participant
    else if (rooms[roomId].participants[socket.id]) {
      const participant = rooms[roomId].participants[socket.id];
      const participantName = participant.name;
      const participantId = socket.id;
      
      // Instead of immediately removing them, put them in the disconnected list
      if (!disconnectedParticipants[roomId]) {
        disconnectedParticipants[roomId] = {};
      }
      
      // Set a timeout to remove them after the grace period
      const timeoutId = setTimeout(() => {
        // Only if they're still disconnected after the grace period
        if (disconnectedParticipants[roomId] && 
            disconnectedParticipants[roomId][participantId]) {
          
          // Remove their player number from the taken list
          const playerNum = parseInt(participantName);
          const index = rooms[roomId].playerNumbers.indexOf(playerNum);
          if (index !== -1) {
            rooms[roomId].playerNumbers.splice(index, 1);
          }
          
          // Notify host that participant left permanently
          io.to(rooms[roomId].hostId).emit('participant-left', { 
            id: participantId, 
            name: participantName 
          });
          
          // Remove them from the room
          delete rooms[roomId].participants[participantId];
          delete disconnectedParticipants[roomId][participantId];
          
          console.log(`Player ${participantName} permanently left room ${roomId} after grace period`);
        }
      }, DISCONNECT_GRACE_PERIOD);
      
      // Store their info for potential reconnection
      disconnectedParticipants[roomId][participantId] = {
        timeoutId: timeoutId,
        disconnectTime: Date.now(),
        playerNumber: parseInt(participantName) // Store the player number explicitly
      };
      
      // Notify host that participant disconnected (but might return)
      io.to(rooms[roomId].hostId).emit('participant-disconnected', { 
        id: participantId, 
        name: participantName 
      });
      
      console.log(`Player ${participantName} temporarily disconnected from room ${roomId}`);
    }
  }

  console.log('User disconnected:', socket.id);
});
});

// Generate a simple 6-character room ID
function generateRoomId() {
  const chars = '012345789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});