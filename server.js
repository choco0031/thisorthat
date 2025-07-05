const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    // Mobile optimization settings
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Game state storage
const lobbies = new Map();
const gameStates = new Map();
const disconnectedPlayers = new Map();

// Load topics from file
let thisOrThatTopics = [];
try {
    const topicsContent = fs.readFileSync('topics.txt', 'utf8');
    thisOrThatTopics = topicsContent.split('\n')
        .map(topic => topic.trim())
        .filter(topic => topic.length > 0)
        .map(topic => {
            const [option1, option2] = topic.split(',').map(opt => opt.trim());
            return { option1, option2 };
        })
        .filter(topic => topic.option1 && topic.option2);
    console.log(`Loaded ${thisOrThatTopics.length} this or that topics`);
} catch (error) {
    console.error('Error loading topics.txt:', error);
    thisOrThatTopics = [
        { option1: "Apple", option2: "Banana" },
        { option1: "Pizza", option2: "Burger" },
        { option1: "Coffee", option2: "Tea" },
        { option1: "Beach", option2: "Mountains" },
        { option1: "Summer", option2: "Winter" },
        { option1: "Cats", option2: "Dogs" },
        { option1: "Morning person", option2: "Night owl" },
        { option1: "Sweet", option2: "Savory" },
        { option1: "Book", option2: "Movie" },
        { option1: "City", option2: "Countryside" },
        { option1: "Music", option2: "Podcast" },
        { option1: "Hot weather", option2: "Cold weather" },
        { option1: "Instagram", option2: "TikTok" },
        { option1: "Netflix", option2: "YouTube" },
        { option1: "Android", option2: "iPhone" }
    ];
}

// Helper function to generate lobby codes
function generateLobbyCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Helper function to sync game state to a player
function syncGameStateToPlayer(socketId, code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return;
    
    socket.emit('sync-game-state', {
        gameState: {
            phase: gameState.phase,
            roundNumber: gameState.roundNumber,
            currentTopic: gameState.currentTopic,
            timer: gameState.timer,
            scores: gameState.scores,
            voteResults: gameState.voteResults
        },
        lobby: lobby,
        userVote: gameState.votes[socket.username]
    });
}

// API Routes
app.post('/api/lobby/create', (req, res) => {
    const { username } = req.body;
    
    if (!username || username.length < 2) {
        return res.status(400).json({ error: 'Username must be at least 2 characters' });
    }
    
    const code = generateLobbyCode();
    const lobby = {
        code,
        host: username,
        participants: [{ username, isHost: true, connected: true }],
        createdAt: new Date(),
        gameStarted: false
    };
    
    lobbies.set(code, lobby);
    
    res.json({ code, lobby });
});

app.post('/api/lobby/join', (req, res) => {
    const { code, username } = req.body;
    
    if (!code || !username) {
        return res.status(400).json({ error: 'Code and username are required' });
    }
    
    const lobby = lobbies.get(code);
    if (!lobby) {
        return res.status(404).json({ error: 'Lobby not found' });
    }
    
    // Check if this is a reconnection
    const existingParticipant = lobby.participants.find(p => p.username === username);
    if (existingParticipant) {
        existingParticipant.connected = true;
        return res.json({ lobby, reconnection: true });
    }
    
    // Add new participant
    lobby.participants.push({ username, isHost: false, connected: true });
    
    // If game is active, initialize score for new player
    const gameState = gameStates.get(code);
    if (gameState) {
        gameState.scores[username] = 0;
    }
    
    res.json({ lobby });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('join-lobby', (data) => {
        const { code, username } = data;
        socket.join(code);
        socket.username = username;
        socket.lobbyCode = code;
        
        const lobby = lobbies.get(code);
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                participant.connected = true;
            }
            
            const gameState = gameStates.get(code);
            if (gameState && gameState.phase !== 'waiting') {
                setTimeout(() => {
                    syncGameStateToPlayer(socket.id, code);
                }, 1000);
            }
            
            io.to(code).emit('lobby-updated', lobby);
        }
    });
    
    socket.on('leave-lobby', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby) {
            if (gameState && gameState.phase !== 'waiting') {
                const participant = lobby.participants.find(p => p.username === username);
                if (participant) {
                    participant.connected = false;
                    disconnectedPlayers.set(username, { code, timestamp: Date.now() });
                }
                io.to(code).emit('lobby-updated', lobby);
            } else {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                
                if (lobby.participants.length === 0 || username === lobby.host) {
                    lobbies.delete(code);
                    gameStates.delete(code);
                    io.to(code).emit('lobby-closed');
                } else {
                    io.to(code).emit('lobby-updated', lobby);
                }
            }
        }
        
        socket.leave(code);
    });
    
    socket.on('start-game', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        
        if (lobby && lobby.host === username && lobby.participants.length >= 2) {
            lobby.gameStarted = true;
            
            const gameState = {
                phase: 'discussion',
                roundNumber: 1,
                totalRounds: 20,
                currentTopic: null,
                votes: {},
                scores: {},
                usedTopics: [],
                timer: 90,
                timerInterval: null,
                voteResults: { option1: 0, option2: 0 }
            };
            
            // Initialize scores
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            gameStates.set(code, gameState);
            
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 2000);
        }
    });
    
    socket.on('cast-vote', (data) => {
        const { code, username, vote } = data;
        const gameState = gameStates.get(code);
        
        if (gameState && gameState.phase === 'voting') {
            gameState.votes[username] = vote;
            
            const lobby = lobbies.get(code);
            const connectedPlayers = lobby.participants.filter(p => p.connected);
            const votedPlayers = Object.keys(gameState.votes);
            
            if (votedPlayers.length >= connectedPlayers.length) {
                if (gameState.timerInterval) {
                    clearInterval(gameState.timerInterval);
                }
                setTimeout(() => {
                    calculateResults(code);
                }, 1000);
            }
        }
    });
    
    socket.on('request-sync', (data) => {
        const { code } = data;
        syncGameStateToPlayer(socket.id, code);
    });
    
    socket.on('restart-game', (data) => {
        const { code } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby && gameState && socket.username === lobby.host) {
            gameState.phase = 'discussion';
            gameState.roundNumber = 1;
            gameState.currentTopic = null;
            gameState.votes = {};
            gameState.usedTopics = [];
            gameState.timer = 90;
            gameState.voteResults = { option1: 0, option2: 0 };
            
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            if (gameState.timerInterval) {
                clearInterval(gameState.timerInterval);
            }
            
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 2000);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.lobbyCode && socket.username) {
            const lobby = lobbies.get(socket.lobbyCode);
            const gameState = gameStates.get(socket.lobbyCode);
            
            if (lobby) {
                const participant = lobby.participants.find(p => p.username === socket.username);
                
                if (participant) {
                    if (gameState && gameState.phase !== 'waiting') {
                        participant.connected = false;
                        disconnectedPlayers.set(socket.username, { 
                            code: socket.lobbyCode, 
                            timestamp: Date.now() 
                        });
                        io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                    } else {
                        lobby.participants = lobby.participants.filter(p => p.username !== socket.username);
                        
                        if (lobby.participants.length === 0 || socket.username === lobby.host) {
                            if (gameState && gameState.timerInterval) {
                                clearInterval(gameState.timerInterval);
                            }
                            
                            lobbies.delete(socket.lobbyCode);
                            gameStates.delete(socket.lobbyCode);
                            io.to(socket.lobbyCode).emit('lobby-closed');
                        } else {
                            io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                        }
                    }
                }
            }
        }
    });
});

// Clean up old disconnected players
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
    disconnectedPlayers.forEach((data, username) => {
        if (now - data.timestamp > timeout) {
            const lobby = lobbies.get(data.code);
            if (lobby) {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                io.to(data.code).emit('lobby-updated', lobby);
            }
            disconnectedPlayers.delete(username);
        }
    });
}, 60000);

// Game logic functions
function startDiscussionPhase(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Select a random topic that hasn't been used
    const availableTopics = thisOrThatTopics.filter((topic, index) => 
        !gameState.usedTopics.includes(index)
    );
    
    if (availableTopics.length === 0) {
        endGame(code);
        return;
    }
    
    const randomIndex = Math.floor(Math.random() * availableTopics.length);
    const selectedTopic = availableTopics[randomIndex];
    const originalIndex = thisOrThatTopics.indexOf(selectedTopic);
    
    gameState.currentTopic = selectedTopic;
    gameState.usedTopics.push(originalIndex);
    gameState.phase = 'discussion';
    gameState.votes = {};
    gameState.timer = 90;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('topic-selected', { topic: selectedTopic });
    io.to(code).emit('game-phase-update', {
        phase: 'discussion',
        roundNumber: gameState.roundNumber
    });
    
    startTimer(code, 90, () => {
        startVotingPhase(code);
    });
}

function startVotingPhase(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'voting';
    gameState.timer = 30;
    
    io.to(code).emit('game-phase-update', { phase: 'voting' });
    
    startTimer(code, 30, () => {
        calculateResults(code);
    });
}

function calculateResults(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Count votes (only from connected players)
    const voteResults = { option1: 0, option2: 0 };
    
    lobby.participants.forEach(participant => {
        if (participant.connected) {
            const vote = gameState.votes[participant.username];
            if (vote === 'option1') {
                voteResults.option1++;
            } else if (vote === 'option2') {
                voteResults.option2++;
            }
        }
    });
    
    gameState.voteResults = { ...voteResults };
    
    // Determine majority and award points
    const totalVotes = voteResults.option1 + voteResults.option2;
    let majorityOption = null;
    
    if (voteResults.option1 > voteResults.option2) {
        majorityOption = 'option1';
    } else if (voteResults.option2 > voteResults.option1) {
        majorityOption = 'option2';
    }
    // If equal, no one gets points
    
    // Award points to majority voters
    if (majorityOption) {
        lobby.participants.forEach(participant => {
            if (gameState.votes[participant.username] === majorityOption) {
                gameState.scores[participant.username] += 1;
            }
        });
    }
    
    gameState.phase = 'results';
    
    io.to(code).emit('game-phase-update', { phase: 'results' });
    io.to(code).emit('round-results', {
        votes: voteResults,
        majorityOption: majorityOption,
        topic: gameState.currentTopic
    });
    
    setTimeout(() => {
        showScoreboard(code);
    }, 5000);
}

function showScoreboard(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'scoreboard';
    
    io.to(code).emit('game-phase-update', { phase: 'scoreboard' });
    io.to(code).emit('scoreboard-update', { scores: gameState.scores });
    
    setTimeout(() => {
        gameState.roundNumber++;
        
        if (gameState.roundNumber > gameState.totalRounds || gameState.usedTopics.length >= thisOrThatTopics.length) {
            endGame(code);
        } else {
            gameState.phase = 'waiting';
            io.to(code).emit('game-phase-update', { phase: 'waiting' });
            
            setTimeout(() => {
                startDiscussionPhase(code);
            }, 3000);
        }
    }, 5000);
}

function endGame(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('game-ended', {
        finalScores: gameState.scores
    });
}

function startTimer(code, seconds, callback) {
    const gameState = gameStates.get(code);
    if (!gameState) return;
    
    gameState.timer = seconds;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    gameState.timerInterval = setInterval(() => {
        gameState.timer--;
        io.to(code).emit('game-timer', { timeRemaining: gameState.timer });
        
        if (gameState.timer <= 0) {
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
            callback();
        }
    }, 1000);
}

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Make sure to create a topics.txt file with "this or that" options (one per line, separated by comma)');
});
