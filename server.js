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
    HEALTH: { duration: 0 },
    INVIS: { duration: 6000 },
    NO_BOMB: { duration: 5000 },
    FREEZE: { duration: 3000 },
    SLOW: { duration: 6000 },
    REVERSE: { duration: 7000 },
    HOMING: { duration: 0 }
};

// Game State
const rooms = {};

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = {}; // socketId -> data
        this.bombs = [];
        this.powerups = [];
        this.trapBombs = [];
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
            isCharging: false,
            homingBombs: 0
        };

        socket.join(this.id);

        if (Object.keys(this.players).length === 2) {
            this.gameStarted = true;
            // Generate and sync obstacles
            this.obstacles = this.createLevelObstacles();
            this.trapBombs = this.createLevelTrapBombs();

            // Send matchFound to both players with obstacles and trapBombs
            Object.values(this.players).forEach(p => {
                const playerSocket = io.sockets.sockets.get(p.id);
                if (playerSocket) {
                    playerSocket.emit('matchFound', {
                        roomId: this.id,
                        players: this.players,
                        obstacles: this.obstacles,
                        trapBombs: this.trapBombs
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
        const targetCount = 30;
        const maxAttempts = 200;

        for (let i = 0; i < targetCount; i++) {
            let foundSpot = false;
            let attempt = 0;
            while (!foundSpot && attempt < maxAttempts) {
                attempt++;
                const w = 50;
                const h = 50;
                const x = Math.floor(Math.random() * (GAME_WIDTH - 301)) + 150;
                const y = Math.floor(Math.random() * (GAME_HEIGHT - 161)) + 80;

                // Distance to players
                const distP1 = Math.sqrt((x - 100) ** 2 + (y - 400) ** 2);
                const distP2 = Math.sqrt((x - 1500) ** 2 + (y - 400) ** 2);
                if (distP1 < 120 || distP2 < 120) continue;

                // Overlap check
                let overlap = false;
                for (const o of obs) {
                    if (x + w / 2 + 10 > o.x - o.w / 2 && x - w / 2 - 10 < o.x + o.w / 2 &&
                        y + h / 2 + 10 > o.y - o.h / 2 && y - h / 2 - 10 < o.y + o.h / 2) {
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

    createLevelTrapBombs() {
        const traps = [];
        const count = 10;
        const maxAttempts = 200;

        for (let i = 0; i < count; i++) {
            let found = false;
            let attempt = 0;
            while (!found && attempt < maxAttempts) {
                attempt++;
                const x = Math.floor(Math.random() * (GAME_WIDTH - 200)) + 100;
                const y = Math.floor(Math.random() * (GAME_HEIGHT - 200)) + 100;

                // Check distance to players
                const distP1 = Math.sqrt((x - 100) ** 2 + (y - 400) ** 2);
                const distP2 = Math.sqrt((x - 1500) ** 2 + (y - 400) ** 2);
                if (distP1 < 200 || distP2 < 200) continue;

                // Check obstacles
                let onObs = false;
                for (const o of this.obstacles) {
                    if (x > o.x - o.w / 2 - 30 && x < o.x + o.w / 2 + 30 &&
                        y > o.y - o.h / 2 - 30 && y < o.y + o.h / 2 + 30) {
                        onObs = true; break;
                    }
                }
                if (onObs) continue;

                if (traps.some(t => Math.sqrt((t.x - x) ** 2 + (t.y - y) ** 2) < 100)) continue;

                traps.push({ id: Date.now() + i + Math.random(), x, y });
                found = true;
            }
        }
        return traps;
    }

    handleInput(socketId, input) {
        const p = this.players[socketId];
        if (!p || !this.gameStarted) return;

        let dx = 0, dy = 0;
        const isReversed = p.powerups['REVERSE'];
        if (input.up) isReversed ? dy += 1 : dy -= 1;
        if (input.down) isReversed ? dy -= 1 : dy += 1;
        if (input.left) isReversed ? dx += 1 : dx -= 1;
        if (input.right) isReversed ? dx -= 1 : dx += 1;

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

        // Bounds
        p.x = Math.max(30, Math.min(GAME_WIDTH - 30, p.x));
        p.y = Math.max(30, Math.min(GAME_HEIGHT - 30, p.y));

        if (input.bomb && p.activeBombs < p.maxBombs && !p.powerups['NO_BOMB']) {
            p.isCharging = true;
            p.bombCharge = Math.min(1000, (p.bombCharge || 0) + 18);
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

        const minSpeed = 0.1;
        const maxSpeed = (player.range / BOMB_TIMER) * 3.5;
        const launchSpeed = minSpeed + (maxSpeed - minSpeed) * chargeFactor;

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
            explodeTime: now + (player.homingBombs > 0 ? 5000 : BOMB_TIMER),
            startTime: now,
            homing: player.homingBombs > 0
        };
        if (player.homingBombs > 0) player.homingBombs--;
        this.bombs.push(bomb);
        player.activeBombs++;
    }

    update() {
        if (!this.gameStarted) return;

        const now = Date.now();
        const delta = 1000 / 60;

        // Update Bombs
        this.bombs = this.bombs.filter(b => {
            if (now >= b.explodeTime) {
                this.explode(b);
                return false;
            }

            // Powerup impact
            for (let j = this.powerups.length - 1; j >= 0; j--) {
                const pw = this.powerups[j];
                const d = Math.sqrt((b.x - pw.x) ** 2 + (b.y - pw.y) ** 2);
                if (d < 25) {
                    this.explode({ x: pw.x, y: pw.y, range: b.range * 0.7, ownerId: null });
                    this.powerups.splice(j, 1);
                    this.explode(b);
                    return false;
                }
            }

            // Trap impact
            for (let j = this.trapBombs.length - 1; j >= 0; j--) {
                const tb = this.trapBombs[j];
                const d = Math.sqrt((b.x - tb.x) ** 2 + (b.y - tb.y) ** 2);
                if (d < 25) {
                    this.explode({ x: tb.x, y: tb.y, range: BASE_EXPLOSION_RADIUS, ownerId: null });
                    this.trapBombs.splice(j, 1);
                    this.explode(b);
                    return false;
                }
            }

            // Movement
            if (b.homing) {
                const targetId = Object.keys(this.players).find(id => id !== b.ownerId);
                const target = this.players[targetId];
                if (target) {
                    const angle = Math.atan2(target.y - b.y, target.x - b.x);
                    const steerFactor = 0.08;
                    b.vx += (Math.cos(angle) * 0.5 - b.vx) * steerFactor;
                    b.vy += (Math.sin(angle) * 0.5 - b.vy) * steerFactor;
                    if (Math.sqrt((target.x - b.x) ** 2 + (target.y - b.y) ** 2) < 30) {
                        this.explode(b);
                        return false;
                    }
                }
            }

            b.x += b.vx * delta;
            b.y += b.vy * delta;

            if (b.x < 15 || b.x > GAME_WIDTH - 15) b.vx *= -1;
            if (b.y < 15 || b.y > GAME_HEIGHT - 15) b.vy *= -1;

            const flightTime = b.explodeTime - b.startTime;
            const elapsed = now - b.startTime;
            const t = elapsed / flightTime;
            const isHigh = t > 0.25 && t < 0.75;

            if (!isHigh) {
                for (const obs of this.obstacles) {
                    if (b.x + 8 > obs.x - obs.w / 2 && b.x - 8 < obs.x + obs.w / 2 &&
                        b.y + 8 > obs.y - obs.h / 2 && b.y - 8 < obs.y + obs.h / 2) {
                        if (Math.abs(b.x - obs.x) / obs.w > Math.abs(b.y - obs.y) / obs.h) b.vx *= -1;
                        else b.vy *= -1;
                        break;
                    }
                }
            }

            return true;
        });

        Object.values(this.players).forEach(p => this.updatePlayer(p, now));
        this.checkTrapProximity();
        this.checkPowerupCollisions(now);

        io.to(this.id).emit('serverUpdate', {
            players: this.players,
            bombs: this.bombs,
            powerups: this.powerups,
            obstacles: this.obstacles,
            trapBombs: this.trapBombs,
            timeLeft: this.timeLeft
        });
    }

    updatePlayer(player, now) {
        player.speed = BASE_PLAYER_SPEED;
        player.range = BASE_EXPLOSION_RADIUS;
        player.maxBombs = 1;
        player.isInvulnerable = false;
        player.multiBombTimers = player.multiBombTimers.filter(expiry => now < expiry);
        player.maxBombs += player.multiBombTimers.length;
        Object.keys(player.powerups).forEach(type => {
            if (now < player.powerups[type]) {
                if (type === 'SPEED') player.speed = BASE_PLAYER_SPEED * 1.6;
                if (type === 'RANGE') player.range = BASE_EXPLOSION_RADIUS * 1.5;
                if (type === 'SHIELD') player.isInvulnerable = true;
                if (type === 'FREEZE') player.speed = 0;
                if (type === 'SLOW') player.speed = BASE_PLAYER_SPEED * 0.5;
            } else delete player.powerups[type];
        });
    }

    spawnPowerup(atX, atY) {
        const types = Object.keys(POWERUP_TYPES);
        const type = types[Math.floor(Math.random() * types.length)];
        const x = atX !== undefined ? atX : Math.floor(Math.random() * (GAME_WIDTH - 120)) + 60;
        const y = atY !== undefined ? atY : Math.floor(Math.random() * (GAME_HEIGHT - 120)) + 60;
        this.powerups.push({ id: Date.now() + Math.random(), x, y, type });
    }

    checkTrapProximity() {
        for (let i = this.trapBombs.length - 1; i >= 0; i--) {
            const tb = this.trapBombs[i];
            let exploded = false;
            for (const pId in this.players) {
                const p = this.players[pId];
                if (Math.sqrt((p.x - tb.x) ** 2 + (p.y - tb.y) ** 2) < BASE_EXPLOSION_RADIUS / 2) {
                    exploded = true; break;
                }
            }
            if (exploded) {
                const { x, y } = tb;
                this.trapBombs.splice(i, 1);
                this.explode({ x, y, range: BASE_EXPLOSION_RADIUS, ownerId: null });
            }
        }
    }

    checkPowerupCollisions(now) {
        for (let i = this.powerups.length - 1; i >= 0; i--) {
            const pw = this.powerups[i];
            for (const pId in this.players) {
                const p = this.players[pId];
                if (Math.sqrt((p.x - pw.x) ** 2 + (p.y - pw.y) ** 2) < 35) {
                    const opponent = Object.values(this.players).find(pl => pl.id !== pId);
                    if (pw.type === 'HEALTH') p.hp = Math.min(100, p.hp + 30);
                    else if (pw.type === 'MULTI_BOMB') p.multiBombTimers.push(now + POWERUP_TYPES.MULTI_BOMB.duration);
                    else if (pw.type === 'HOMING') p.homingBombs = (p.homingBombs || 0) + 1;
                    else if (['INVIS', 'SPEED', 'RANGE', 'SHIELD'].includes(pw.type)) p.powerups[pw.type] = now + POWERUP_TYPES[pw.type].duration;
                    else if (opponent) opponent.powerups[pw.type] = now + POWERUP_TYPES[pw.type].duration;
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
        Object.values(this.players).forEach(p => {
            const dist = Math.sqrt((p.x - bomb.x) ** 2 + (p.y - bomb.y) ** 2);
            if (dist < bomb.range && !p.isInvulnerable) {
                p.hp -= MIN_DAMAGE + (MAX_DAMAGE - MIN_DAMAGE) * (1 - dist / bomb.range);
                if (p.hp <= 0) this.endGame();
            }
        });
        for (let j = this.powerups.length - 1; j >= 0; j--) {
            const pw = this.powerups[j];
            if (Math.sqrt((pw.x - bomb.x) ** 2 + (pw.y - bomb.y) ** 2) < bomb.range) {
                this.powerups.splice(j, 1);
                this.explode({ x: pw.x, y: pw.y, range: bomb.range * 0.7, ownerId: null });
            }
        }
        this.obstacles = this.obstacles.filter(obs => {
            if (Math.sqrt((obs.x - bomb.x) ** 2 + (obs.y - bomb.y) ** 2) < bomb.range + 30) {
                obs.hp -= 20;
                if (obs.hp <= 0) { this.spawnPowerup(obs.x, obs.y); return false; }
            }
            return true;
        });
        for (let i = this.trapBombs.length - 1; i >= 0; i--) {
            const tb = this.trapBombs[i];
            if (Math.sqrt((tb.x - bomb.x) ** 2 + (tb.y - bomb.y) ** 2) < bomb.range) {
                const { x, y } = tb;
                this.trapBombs.splice(i, 1);
                this.explode({ x, y, range: BASE_EXPLOSION_RADIUS, ownerId: null });
            }
        }
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
        const trophyChanges = {};
        if (p1 && p2 && winnerId !== null) {
            let s1 = winnerId === p1.id ? 1 : 0;
            let s2 = 1 - s1;
            const exp1 = 1 / (1 + Math.pow(10, (p2.trophies - p1.trophies) / 400));
            const exp2 = 1 / (1 + Math.pow(10, (p1.trophies - p2.trophies) / 400));
            const d1 = Math.round(32 * (s1 - exp1));
            const d2 = Math.round(32 * (s2 - exp2));
            trophyChanges[p1.id] = d1;
            trophyChanges[p2.id] = d2;
            supabase.rpc('increment_trophies', { user_id: p1.dbId, delta: d1 }).then(() => { });
            supabase.rpc('increment_trophies', { user_id: p2.dbId, delta: d2 }).then(() => { });
            p1.trophies += d1;
            p2.trophies += d2;
        } else if (p1 && p2) {
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
