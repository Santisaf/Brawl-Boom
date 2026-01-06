require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.static(path.join(__dirname, 'standalone')));
app.use(express.json());

// Auth Routes
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });

    const hash = bcrypt.hashSync(password, 10);

    const { data, error } = await supabase
        .from('users')
        .insert([{ username, password: hash }])
        .select();

    if (error) {
        return res.status(400).json({ error: "Username already exists or error" });
    }

    res.json({ id: data[0].id, username: data[0].username, trophies: 500 });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .single();

    if (error || !user) return res.status(400).json({ error: "User not found" });

    if (bcrypt.compareSync(password, user.password)) {
        res.json({ id: user.id, username: user.username, trophies: user.trophies });
    } else {
        res.status(400).json({ error: "Invalid password" });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    const { data, error } = await supabase
        .from('users')
        .select('username, trophies')
        .order('trophies', { ascending: false })
        .limit(10);

    if (error) return res.status(500).json({ error: "Failed to fetch leaderboard" });
    res.json(data);
});

// Game Constants (matching standalone)
const GAME_WIDTH = 1600; // Updated for 1600x800 arena
const GAME_HEIGHT = 800;
const BASE_PLAYER_SPEED = 4;
const BOMB_TIMER = 1000;
const BASE_EXPLOSION_RADIUS = 120;
const MIN_DAMAGE = 10;
const MAX_DAMAGE = 40;

const POWERUP_TYPES = {
    SPEED: { duration: 8000 },
    RANGE: { duration: 10000 },
    MULTI_BOMB: { duration: 10000 },
    SHIELD: { duration: 8000 },
    HEALTH: { duration: 0 }
};

// Game State
const rooms = {};

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = {}; // socketId -> data
        this.bombs = [];
        this.powerups = [];
        this.nextPowerupTime = Infinity; // Desactivar spawn aleatorio
        this.gameStarted = false;
        this.timeLeft = 120;

        this.loop = setInterval(() => this.update(), 1000 / 60);
    }

    addPlayer(socket, user) {
        const count = Object.keys(this.players).length;
        if (count >= 2) return false;

        const x = count === 0 ? 100 : 1500;
        const y = 400;

        this.players[socket.id] = {
            id: socket.id,
            dbId: user.dbId, // Database ID
            username: user.username || `Player ${count + 1}`,
            trophies: user.trophies || 500,
            x: x,
            y: y,
            hp: 100,
            rotation: count === 0 ? Math.PI / 2 : -Math.PI / 2,
            activeBombs: 0,
            maxBombs: 1,
            speed: BASE_PLAYER_SPEED,
            range: BASE_EXPLOSION_RADIUS,
            isInvulnerable: false,
            powerups: {},
            multiBombTimers: [],
            bombCharge: 0,
            isCharging: false
        };

        socket.join(this.id);

        if (Object.keys(this.players).length === 2) {
            this.gameStarted = true;
            // Generate and sync obstacles
            this.obstacles = this.createLevelObstacles();

            // Send matchFound to both players with obstacles
            Object.values(this.players).forEach(p => {
                const playerSocket = io.sockets.sockets.get(p.id);
                if (playerSocket) {
                    playerSocket.emit('matchFound', {
                        roomId: this.id,
                        players: this.players,
                        obstacles: this.obstacles
                    });
                }
            });
        } else {
            socket.emit('waitingForOpponent');
        }

        return true;
    }

    createLevelObstacles() {
        const obs = [];
        const targetCount = 16;
        const maxAttempts = 100;

        for (let i = 0; i < targetCount; i++) {
            let foundSpot = false;
            let attempt = 0;
            while (!foundSpot && attempt < maxAttempts) {
                attempt++;
                const w = 60;
                const h = 60;
                const x = Math.floor(Math.random() * (GAME_WIDTH - 301)) + 150;
                const y = Math.floor(Math.random() * (GAME_HEIGHT - 301)) + 150;

                // Distance to players
                const distP1 = Math.sqrt((x - 100) ** 2 + (y - 400) ** 2);
                const distP2 = Math.sqrt((x - 1500) ** 2 + (y - 400) ** 2);
                if (distP1 < 150 || distP2 < 150) continue;

                // Overlap check
                let overlap = false;
                for (const o of obs) {
                    if (x + w / 2 + 15 > o.x - o.w / 2 && x - w / 2 - 15 < o.x + o.w / 2 &&
                        y + h / 2 + 15 > o.y - o.h / 2 && y - h / 2 - 15 < o.y + o.h / 2) {
                        overlap = true;
                        break;
                    }
                }

                if (!overlap) {
                    obs.push({ id: i, x, y, w, h, hp: 75 });
                    foundSpot = true;
                }
            }
        }
        return obs;
    }

    handleInput(socketId, input) {
        const p = this.players[socketId];
        if (!p || !this.gameStarted) return;

        let dx = 0, dy = 0;
        if (input.up) dy -= 1;
        if (input.down) dy += 1;
        if (input.left) dx -= 1;
        if (input.right) dx += 1;

        if (dx !== 0 || dy !== 0) {
            const len = Math.sqrt(dx * dx + dy * dy);
            dx /= len;
            dy /= len;

            let nextX = p.x + dx * p.speed;
            let nextY = p.y + dy * p.speed;

            // Player vs Obstacle Collision
            let canMoveX = true;
            let canMoveY = true;
            const pRadius = 20;

            for (const obs of this.obstacles) {
                if (nextX + pRadius > obs.x - obs.w / 2 && nextX - pRadius < obs.x + obs.w / 2 &&
                    p.y + pRadius > obs.y - obs.h / 2 && p.y - pRadius < obs.y + obs.h / 2) {
                    canMoveX = false;
                }
                if (p.x + pRadius > obs.x - obs.w / 2 && p.x - pRadius < obs.x + obs.w / 2 &&
                    nextY + pRadius > obs.y - obs.h / 2 && nextY - pRadius < obs.y + obs.h / 2) {
                    canMoveY = false;
                }
            }

            if (canMoveX) p.x = nextX;
            if (canMoveY) p.y = nextY;
            p.rotation = Math.atan2(dy, dx) + Math.PI / 2;
        }

        // Bounds - Clamp BEFORE placing bomb to match visual position
        p.x = Math.max(30, Math.min(GAME_WIDTH - 30, p.x));
        p.y = Math.max(30, Math.min(GAME_HEIGHT - 30, p.y));

        if (input.bomb && p.activeBombs < p.maxBombs) {
            p.isCharging = true;
            p.bombCharge = Math.min(1000, (p.bombCharge || 0) + 18); // Incrementar carga
        } else {
            if (p.isCharging) {
                this.placeBomb(p, p.bombCharge / 1000);
                p.bombCharge = 0;
                p.isCharging = false;
            }
        }
    }

    placeBomb(player, chargeFactor = 0.5) {
        const now = Date.now();
        const launchAngle = player.rotation - Math.PI / 2;

        // Carga mínima de 0.1, máxima escalada por rango
        const minSpeed = 0.1;
        const maxSpeed = (player.range / BOMB_TIMER) * 3.5;
        const launchSpeed = minSpeed + (maxSpeed - minSpeed) * chargeFactor;

        // Offset calculation to match visual held bomb (21, -8)
        const offX = 21;
        const offY = -8;
        const cos = Math.cos(player.rotation);
        const sin = Math.sin(player.rotation);
        const startX = player.x + (offX * cos - offY * sin);
        const startY = player.y + (offX * sin + offY * cos);

        const bomb = {
            id: now + Math.random(),
            x: startX,
            y: startY,
            vx: Math.cos(launchAngle) * launchSpeed,
            vy: Math.sin(launchAngle) * launchSpeed,
            ownerId: player.id,
            range: player.range,
            explodeTime: now + BOMB_TIMER,
            startTime: now // Pass startTime to client for perfect arc effect
        };
        this.bombs.push(bomb);
        player.activeBombs++;
    }

    update() {
        if (!this.gameStarted) return;

        const now = Date.now();

        // Update Bombs
        const delta = 1000 / 60;
        this.bombs = this.bombs.filter(b => {
            if (now >= b.explodeTime) {
                this.explode(b);
                return false;
            }

            // Movement
            b.x += b.vx * delta;
            b.y += b.vy * delta;

            // Bounce (simple wall)
            if (b.x < 15 || b.x > GAME_WIDTH - 15) b.vx *= -1;
            if (b.y < 15 || b.y > GAME_HEIGHT - 15) b.vy *= -1;

            // Bounce (obstacles)
            for (const obs of this.obstacles) {
                if (b.x + 8 > obs.x - obs.w / 2 && b.x - 8 < obs.x + obs.w / 2 &&
                    b.y + 8 > obs.y - obs.h / 2 && b.y - 8 < obs.y + obs.h / 2) {
                    if (Math.abs(b.x - obs.x) / obs.w > Math.abs(b.y - obs.y) / obs.h) b.vx *= -1;
                    else b.vy *= -1;
                    break;
                }
            }

            return true;
        });

        // Update Powerups - Disabled periodic spawn
        /*
        if (now > this.nextPowerupTime) {
            this.spawnPowerup();
            this.nextPowerupTime = now + Math.random() * 4000 + 8000; // 8-12s
        }
        */

        // Update Players (Timers)
        Object.values(this.players).forEach(p => this.updatePlayer(p, now));

        // Check Powerup Collisions
        this.checkPowerupCollisions(now);

        // Broadcast State
        io.to(this.id).emit('serverUpdate', {
            players: this.players,
            bombs: this.bombs,
            powerups: this.powerups,
            obstacles: this.obstacles, // Include obstacles in the update
            timeLeft: this.timeLeft
        });
    }

    updatePlayer(player, now) {
        player.speed = BASE_PLAYER_SPEED;
        player.range = BASE_EXPLOSION_RADIUS;
        player.maxBombs = 1;
        player.isInvulnerable = false;

        // Multi-bomb timers
        player.multiBombTimers = player.multiBombTimers.filter(expiry => now < expiry);
        player.maxBombs += player.multiBombTimers.length;

        // Other powerups
        Object.keys(player.powerups).forEach(type => {
            if (now < player.powerups[type]) {
                if (type === 'SPEED') player.speed = BASE_PLAYER_SPEED * 1.6;
                if (type === 'RANGE') player.range = BASE_EXPLOSION_RADIUS * 1.5;
                if (type === 'SHIELD') player.isInvulnerable = true;
            } else {
                delete player.powerups[type];
            }
        });
    }

    spawnPowerup(atX, atY) {
        const types = Object.keys(POWERUP_TYPES);
        const type = types[Math.floor(Math.random() * types.length)];
        const x = atX !== undefined ? atX : Math.floor(Math.random() * (GAME_WIDTH - 120)) + 60;
        const y = atY !== undefined ? atY : Math.floor(Math.random() * (GAME_HEIGHT - 120)) + 60;
        this.powerups.push({ id: Date.now() + Math.random(), x, y, type });
    }

    checkPowerupCollisions(now) {
        for (let i = this.powerups.length - 1; i >= 0; i--) {
            const pw = this.powerups[i];
            for (const pId in this.players) {
                const p = this.players[pId];
                const dist = Math.sqrt((p.x - pw.x) ** 2 + (p.y - pw.y) ** 2);
                if (dist < 35) {
                    if (pw.type === 'HEALTH') {
                        p.hp = Math.min(100, p.hp + 30);
                    } else if (pw.type === 'MULTI_BOMB') {
                        p.multiBombTimers.push(now + POWERUP_TYPES.MULTI_BOMB.duration);
                    } else {
                        p.powerups[pw.type] = now + POWERUP_TYPES[pw.type].duration;
                    }
                    this.powerups.splice(i, 1);
                    break;
                }
            }
        }
    }

    explode(bomb) {
        const owner = this.players[bomb.ownerId];
        if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);

        io.to(this.id).emit('explosion', { x: bomb.x, y: bomb.y, range: bomb.range });

        // Damage players
        Object.values(this.players).forEach(p => {
            const dist = Math.sqrt((p.x - bomb.x) ** 2 + (p.y - bomb.y) ** 2);
            if (dist < bomb.range && !p.isInvulnerable) {
                const dmg = MIN_DAMAGE + (MAX_DAMAGE - MIN_DAMAGE) * (1 - dist / bomb.range);
                p.hp -= dmg;
                if (p.hp <= 0) this.endGame();
            }
        });

        // Damage obstacles
        this.obstacles = this.obstacles.filter(obs => {
            const dist = Math.sqrt((obs.x - bomb.x) ** 2 + (obs.y - bomb.y) ** 2);
            if (dist < bomb.range + 30) {
                obs.hp -= 20;
                if (obs.hp <= 0) {
                    this.spawnPowerup(obs.x, obs.y);
                    return false;
                }
            }
            return true;
        });
    }

    endGame() {
        this.gameStarted = false;

        let winnerId = null;
        let p1 = null, p2 = null;
        const playersArr = Object.values(this.players);

        if (playersArr.length === 2) {
            p1 = playersArr[0];
            p2 = playersArr[1];
            if (p1.hp > p2.hp) winnerId = p1.id;
            else if (p2.hp > p1.hp) winnerId = p2.id;
        }

        // ELO Calculation
        const K = 32;
        const trophyChanges = {}; // socketId -> delta

        if (p1 && p2 && winnerId !== null) {
            // Determine actual scores
            let s1 = 0.5, s2 = 0.5;
            if (winnerId === p1.id) { s1 = 1; s2 = 0; }
            else { s1 = 0; s2 = 1; }

            // Calculate Expected
            const expected1 = 1 / (1 + Math.pow(10, (p2.trophies - p1.trophies) / 400));
            const expected2 = 1 / (1 + Math.pow(10, (p1.trophies - p2.trophies) / 400));

            const delta1 = Math.round(K * (s1 - expected1));
            const delta2 = Math.round(K * (s2 - expected2));

            trophyChanges[p1.id] = delta1;
            trophyChanges[p2.id] = delta2;

            // Update DB (Supabase)
            supabase.rpc('increment_trophies', { user_id: p1.dbId, delta: delta1 }).then(() => { });
            supabase.rpc('increment_trophies', { user_id: p2.dbId, delta: delta2 }).then(() => { });

            // Update local state for UI
            p1.trophies += delta1;
            p2.trophies += delta2;
        } else if (p1 && p2) {
            // Draw - No change usually, or small
            trophyChanges[p1.id] = 0;
            trophyChanges[p2.id] = 0;
        }

        io.to(this.id).emit('gameOver', {
            players: this.players,
            winnerId: winnerId,
            reason: 'FINISHED',
            trophyChanges: trophyChanges
        });

        clearInterval(this.loop);
        delete rooms[this.id];
    }
}

// Socket Logic
let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    socket.on('identify', async (userData) => {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', userData.id)
            .single();

        if (user) {
            socket.user = {
                dbId: user.id,
                username: user.username,
                trophies: user.trophies
            };
            socket.emit('identified', { trophies: user.trophies });
        }
    });

    socket.on('findMatch', () => {
        if (!socket.user) {
            socket.emit('authError', "Must be logged in to play online");
            return;
        }

        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const roomId = 'room_' + Date.now();
            const room = new GameRoom(roomId);
            rooms[roomId] = room;

            room.addPlayer(waitingPlayer, waitingPlayer.user);
            room.addPlayer(socket, socket.user);

            waitingPlayer = null;
        } else {
            waitingPlayer = socket;
            socket.emit('waitingForOpponent');
        }
    });

    socket.on('playerInput', (input) => {
        // Find room by socket
        for (const roomId in rooms) {
            if (rooms[roomId].players[socket.id]) {
                rooms[roomId].handleInput(socket.id, input);
                break;
            }
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }

        // Find room by socket
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.players[socket.id]) {
                if (room.gameStarted) {
                    // Match the player who left to notify the other
                    const quitter = room.players[socket.id];
                    const winnerId = Object.keys(room.players).find(id => id !== socket.id);
                    const winner = room.players[winnerId];

                    if (winner) {
                        // Calculate Forfeit Logic (Loser loses 20, Winner gains 10 fixed)
                        // Or use standard ELO treating it as a loss
                        // Simple fixed penalty for disconnect
                        const penalty = -30;
                        const reward = 15;

                        // Update DB (Supabase)
                        if (quitter && quitter.dbId) {
                            supabase.rpc('increment_trophies', { user_id: quitter.dbId, delta: penalty }).then(() => { });
                        }
                        if (winner.dbId) {
                            supabase.rpc('increment_trophies', { user_id: winner.dbId, delta: reward }).then(() => { });
                        }

                        const changes = {};
                        changes[winnerId] = reward;

                        io.to(roomId).emit('gameOver', {
                            players: room.players,
                            winnerId: winnerId,
                            reason: 'OPPONENT_LEFT',
                            trophyChanges: changes
                        });
                    }

                    room.gameStarted = false;
                    clearInterval(room.loop);
                    delete rooms[roomId];
                } else {
                    // Just clean up
                    delete room.players[socket.id];
                    if (Object.keys(room.players).length === 0) {
                        clearInterval(room.loop);
                        delete rooms[roomId];
                    }
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Brawl Boom Server running on http://localhost:${PORT}`);
});
