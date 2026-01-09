const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.io
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:4200", "http://localhost:4201", "https://mubanai.github.io/helpmate"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Enable CORS for Express
app.use(cors({
  origin: ["http://localhost:4200", "http://localhost:4201", "https://mubanai.github.io/helpmate"],
  credentials: true
}));

app.use(express.json());

// Store connected users and rooms
const users = new Map(); // socketId -> user info
const rooms = new Map(); // roomId -> Set of socketIds
const userRooms = new Map(); // userId -> Set of roomIds

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    users: users.size, 
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Get online users endpoint
app.get('/users', (req, res) => {
  const onlineUsers = Array.from(users.values()).map(user => ({
    id: user.id,
    name: user.name,
    isOnline: true,
    lastSeen: user.lastSeen
  }));
  res.json(onlineUsers);
});

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Handle user registration
  socket.on('register-user', (userData) => {
    const user = {
      id: userData.userId || uuidv4(),
      name: userData.name || `User_${socket.id.substring(0, 6)}`,
      socketId: socket.id,
      lastSeen: new Date(),
      isOnline: true
    };

    users.set(socket.id, user);
    
    // Join user to their personal room
    const personalRoom = `user_${user.id}`;
    socket.join(personalRoom);
    
    if (!rooms.has(personalRoom)) {
      rooms.set(personalRoom, new Set());
    }
    rooms.get(personalRoom).add(socket.id);

    // Track user rooms
    if (!userRooms.has(user.id)) {
      userRooms.set(user.id, new Set());
    }
    userRooms.get(user.id).add(personalRoom);

    console.log(`User registered: ${user.name} (${user.id})`);
    
    // Notify client of successful registration
    socket.emit('user-registered', {
      userId: user.id,
      name: user.name,
      personalRoom: personalRoom
    });

    // Broadcast user list update
    broadcastUserList();
  });

  // Handle joining rooms
  socket.on('join-room', (roomId, callback) => {
    try {
      socket.join(roomId);
      
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId).add(socket.id);

      const user = users.get(socket.id);
      if (user) {
        if (!userRooms.has(user.id)) {
          userRooms.set(user.id, new Set());
        }
        userRooms.get(user.id).add(roomId);
      }

      console.log(`Socket ${socket.id} joined room: ${roomId}`);
      
      if (callback) {
        callback({ success: true, roomId });
      }

      // Notify others in the room
      socket.to(roomId).emit('user-joined-room', {
        userId: user?.id,
        userName: user?.name,
        roomId
      });

    } catch (error) {
      console.error('Error joining room:', error);
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Handle leaving rooms
  socket.on('leave-room', (roomId, callback) => {
    try {
      socket.leave(roomId);
      
      if (rooms.has(roomId)) {
        rooms.get(roomId).delete(socket.id);
        if (rooms.get(roomId).size === 0) {
          rooms.delete(roomId);
        }
      }

      const user = users.get(socket.id);
      if (user && userRooms.has(user.id)) {
        userRooms.get(user.id).delete(roomId);
      }

      console.log(`Socket ${socket.id} left room: ${roomId}`);
      
      if (callback) {
        callback({ success: true });
      }

      // Notify others in the room
      socket.to(roomId).emit('user-left-room', {
        userId: user?.id,
        userName: user?.name,
        roomId
      });

    } catch (error) {
      console.error('Error leaving room:', error);
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Handle signaling messages (WebRTC)
  socket.on('signal', (signalData) => {
    try {
      const user = users.get(socket.id);
      if (!user) {
        console.error('Signal from unregistered user');
        return;
      }

      console.log(`Signal from ${user.name}: ${signalData.type} -> ${signalData.to}`);

      // Find target user's socket
      const targetUser = Array.from(users.values()).find(u => u.id === signalData.to);
      
      if (targetUser) {
        // Send signal to target user
        io.to(targetUser.socketId).emit('signal', {
          ...signalData,
          from: user.id,
          fromName: user.name,
          timestamp: new Date()
        });
        
        console.log(`Signal forwarded to ${targetUser.name}`);
      } else {
        console.log(`Target user ${signalData.to} not found or offline`);
        
        // Send error back to sender
        socket.emit('signal-error', {
          error: 'User not found or offline',
          targetUserId: signalData.to,
          originalSignal: signalData
        });
      }

    } catch (error) {
      console.error('Error handling signal:', error);
      socket.emit('signal-error', {
        error: error.message,
        originalSignal: signalData
      });
    }
  });

  // Handle chat messages
  socket.on('chat-message', (messageData) => {
    try {
      const user = users.get(socket.id);
      if (!user) {
        console.error('Message from unregistered user');
        return;
      }

      const message = {
        id: uuidv4(),
        senderId: user.id,
        senderName: user.name,
        recipientId: messageData.recipientId,
        content: messageData.content,
        timestamp: new Date(),
        type: messageData.type || 'text',
        deliveryStatus: 'sent'
      };

      console.log(`Message from ${user.name} to ${messageData.recipientId}: ${messageData.content}`);

      // Find target user and send message
      const targetUser = Array.from(users.values()).find(u => u.id === messageData.recipientId);
      
      if (targetUser) {
        // Send to target user
        io.to(targetUser.socketId).emit('chat-message', message);
        
        // Send delivery confirmation to sender
        socket.emit('message-delivered', {
          messageId: message.id,
          deliveredTo: targetUser.id,
          timestamp: new Date()
        });
        
        console.log(`Message delivered to ${targetUser.name}`);
      } else {
        console.log(`Target user ${messageData.recipientId} not found or offline`);
        
        // Send offline notification to sender
        socket.emit('message-offline', {
          messageId: message.id,
          recipientId: messageData.recipientId,
          timestamp: new Date()
        });
      }

    } catch (error) {
      console.error('Error handling chat message:', error);
      socket.emit('message-error', {
        error: error.message,
        originalMessage: messageData
      });
    }
  });

  // Handle typing indicators
  socket.on('typing', (typingData) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;

      // Find target user and send typing indicator
      const targetUser = Array.from(users.values()).find(u => u.id === typingData.recipientId);
      
      if (targetUser) {
        io.to(targetUser.socketId).emit('typing', {
          userId: user.id,
          userName: user.name,
          isTyping: typingData.isTyping,
          timestamp: new Date()
        });
      }

    } catch (error) {
      console.error('Error handling typing indicator:', error);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    try {
      const user = users.get(socket.id);
      
      if (user) {
        console.log(`User disconnected: ${user.name} (${user.id})`);
        
        // Update user status
        user.isOnline = false;
        user.lastSeen = new Date();
        
        // Clean up rooms
        if (userRooms.has(user.id)) {
          for (const roomId of userRooms.get(user.id)) {
            if (rooms.has(roomId)) {
              rooms.get(roomId).delete(socket.id);
              if (rooms.get(roomId).size === 0) {
                rooms.delete(roomId);
              }
            }
            
            // Notify others in the room
            socket.to(roomId).emit('user-left-room', {
              userId: user.id,
              userName: user.name,
              roomId
            });
          }
          userRooms.delete(user.id);
        }
        
        // Remove user after a delay (in case of reconnection)
        setTimeout(() => {
          users.delete(socket.id);
          broadcastUserList();
        }, 5000);
        
      } else {
        console.log(`Unknown client disconnected: ${socket.id}`);
      }

    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });

  // Send initial user list to new connection
  socket.emit('user-list', Array.from(users.values()).map(user => ({
    id: user.id,
    name: user.name,
    isOnline: user.isOnline,
    lastSeen: user.lastSeen
  })));
});

// Broadcast updated user list to all clients
function broadcastUserList() {
  const userList = Array.from(users.values()).map(user => ({
    id: user.id,
    name: user.name,
    isOnline: user.isOnline,
    lastSeen: user.lastSeen
  }));
  
  io.emit('user-list', userList);
}

// Cleanup inactive users periodically
setInterval(() => {
  const now = new Date();
  const inactiveThreshold = 5 * 60 * 1000; // 5 minutes
  
  for (const [socketId, user] of users.entries()) {
    if (!user.isOnline && (now - user.lastSeen) > inactiveThreshold) {
      users.delete(socketId);
      if (userRooms.has(user.id)) {
        userRooms.delete(user.id);
      }
    }
  }
}, 60000); // Run every minute

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`👥 Users endpoint: http://localhost:${PORT}/users`);
});