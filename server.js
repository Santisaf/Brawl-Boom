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
const BASE_EXPLOSION_RADIUS = 130;
const MIN_DAMAGE = 0;
const MAX_DAMAGE = 50;

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
        this.matchStartTime = null;
        this.bot = null;
        this.botSpawning = false;

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
            this.matchStartTime = Date.now();
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

    spawnBot() {
        if (this.bot || !this.gameStarted) return;

        // Spawn centered if possible
        let spawnX = GAME_WIDTH / 2;
        let spawnY = GAME_HEIGHT / 2;

        const isSafe = (x, y) => {
            // Check obstacles
            for (const obs of this.obstacles) {
                if (x > obs.x - obs.w && x < obs.x + obs.w && y > obs.y - obs.h && y < obs.y + obs.h) return false;
            }
            // Check bombs
            for (const b of this.bombs) {
                if (Math.sqrt((x - b.x) ** 2 + (y - b.y) ** 2) < 80) return false;
            }
            return true;
        };

        if (!isSafe(spawnX, spawnY)) {
            // Find nearby safe spot
            let found = false;
            for (let r = 50; r < 400 && !found; r += 50) {
                for (let ang = 0; ang < Math.PI * 2 && !found; ang += Math.PI / 4) {
                    let tx = spawnX + Math.cos(ang) * r;
                    let ty = spawnY + Math.sin(ang) * r;
                    if (isSafe(tx, ty)) {
                        spawnX = tx;
                        spawnY = ty;
                        found = true;
                    }
                }
            }
        }

        this.bot = {
            id: 'bot_' + Date.now(),
            username: 'BOT_TACTICO',
            x: spawnX,
            y: spawnY,
            hp: 100,
            rotation: 0,
            speed: BASE_PLAYER_SPEED * 0.9,
            range: BASE_EXPLOSION_RADIUS,
            activeBombs: 0,
            maxBombs: 2,
            powerups: {},
            multiBombTimers: [],
            aiTimer: 0,
            moveDir: { x: 0, y: 0 },
            isBot: true
        };
    }

    updateBot(now, delta) {
        if (!this.bot) return;
        const bot = this.bot;

        if (now > bot.aiTimer) {
            bot.aiTimer = now + Math.random() * 400 + 200;

            // Find target (closest player)
            let closestPlayer = null;
            let minDist = Infinity;
            for (const pId in this.players) {
                const p = this.players[pId];
                const d = Math.sqrt((bot.x - p.x) ** 2 + (bot.y - p.y) ** 2);
                if (d < minDist) {
                    minDist = d;
                    closestPlayer = p;
                }
            }

            if (closestPlayer) {
                const angle = Math.atan2(closestPlayer.y - bot.y, closestPlayer.x - bot.x);
                bot.moveDir.x = Math.cos(angle);
                bot.moveDir.y = Math.sin(angle);

                // Place bomb if close
                if (minDist < 400 && bot.activeBombs < bot.maxBombs) {
                    if (Math.random() < 0.65) {
                        this.placeBomb(bot, 0.3 + Math.random() * 0.5);
                    }
                }
            }
        }

        // Avoid bombs
        for (const b of this.bombs) {
            const d = Math.sqrt((bot.x - b.x) ** 2 + (bot.y - b.y) ** 2);
            if (d < 180) {
                const angle = Math.atan2(bot.y - b.y, bot.x - b.x);
                bot.moveDir.x = Math.cos(angle);
                bot.moveDir.y = Math.sin(angle);
            }
        }

        // Avoid obstacles (simple repulsion)
        for (const obs of this.obstacles) {
            const dx = bot.x - obs.x;
            const dy = bot.y - obs.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 60) {
                bot.moveDir.x += dx / dist * 0.5;
                bot.moveDir.y += dy / dist * 0.5;
            }
        }

        let nextX = bot.x + bot.moveDir.x * bot.speed;
        let nextY = bot.y + bot.moveDir.y * bot.speed;

        // Wall collision
        if (nextX < 30 || nextX > GAME_WIDTH - 30) {
            bot.moveDir.x *= -1;
            bot.aiTimer = 0; // Force redirection
        }
        if (nextY < 30 || nextY > GAME_HEIGHT - 30) {
            bot.moveDir.y *= -1;
            bot.aiTimer = 0; // Force redirection
        }

        bot.x += bot.moveDir.x * bot.speed;
        bot.y += bot.moveDir.y * bot.speed;

        // Player Collision & Contact Damage
        for (const pId in this.players) {
            const p = this.players[pId];
            const dist = Math.sqrt((bot.x - p.x) ** 2 + (bot.y - p.y) ** 2);
            if (dist < 40) {
                // DEAL DAMAGE
                if (now > (bot.lastMeleeHit || 0)) {
                    p.hp -= 5; // Melee damage
                    bot.lastMeleeHit = now + 1000; // 1 sec cooldown per player
                }

                // KNOCKBACK (Elastic PUSH)
                let angle = Math.atan2(bot.y - p.y, bot.x - p.x);
                if (dist < 1) angle = Math.random() * Math.PI * 2;

                const pushDist = (40 - dist) / 2 + 2;

                // Push Bot
                bot.x += Math.cos(angle) * pushDist;
                bot.y += Math.sin(angle) * pushDist;

                // Push Player (Inverse)
                p.x -= Math.cos(angle) * pushDist;
                p.y -= Math.sin(angle) * pushDist;

                // POST-PUSH: Resolve obstacle collisions and BOUNDS
                this.resolveEntityObstacles(bot);
                this.resolveEntityObstacles(p);

                // Bounds clamp after bot push
                p.x = Math.max(30, Math.min(GAME_WIDTH - 30, p.x));
                p.y = Math.max(30, Math.min(GAME_HEIGHT - 30, p.y));
                bot.x = Math.max(30, Math.min(GAME_WIDTH - 30, bot.x));
                bot.y = Math.max(30, Math.min(GAME_HEIGHT - 30, bot.y));
            }
        }

        bot.x = Math.max(30, Math.min(GAME_WIDTH - 30, bot.x));
        bot.y = Math.max(30, Math.min(GAME_HEIGHT - 30, bot.y));

        if (bot.moveDir.x !== 0 || bot.moveDir.y !== 0) {
            bot.rotation = Math.atan2(bot.moveDir.y, bot.moveDir.x) + Math.PI / 2;
        }
    }

    update() {
        if (!this.gameStarted) return;

        const now = Date.now();
        const delta = 1000 / 60;

        // Spawn bot after 1 minute
        if (!this.bot && this.matchStartTime && (now - this.matchStartTime > 60000)) {
            this.spawnBot();
        }

        if (this.bot) {
            this.updateBot(now, delta);
        }

        // Player vs Player collision (Online)
        const playerIds = Object.keys(this.players);
        if (playerIds.length === 2) {
            const p1 = this.players[playerIds[0]];
            const p2 = this.players[playerIds[1]];
            const dist = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
            if (dist < 40) {
                // DEAL DAMAGE TO BOTH
                if (now > (this.lastPlayerMeleeHit || 0)) {
                    p1.hp -= 5;
                    p2.hp -= 5;
                    this.lastPlayerMeleeHit = now + 1000;
                    if (p1.hp <= 0 || p2.hp <= 0) this.endGame();
                }

                // KNOCKBACK (Elastic PUSH)
                let angle = Math.atan2(p1.y - p2.y, p1.x - p2.x);
                if (dist < 1) angle = Math.random() * Math.PI * 2;
                const pushDist = (40 - dist) / 2 + 2;

                p1.x += Math.cos(angle) * pushDist;
                p1.y += Math.sin(angle) * pushDist;
                p2.x -= Math.cos(angle) * pushDist;
                p2.y -= Math.sin(angle) * pushDist;

                // POST-PUSH: Resolve obstacle collisions so they don't get stuck
                this.resolveEntityObstacles(p1);
                this.resolveEntityObstacles(p2);

                // Bounds sync
                p1.x = Math.max(30, Math.min(GAME_WIDTH - 30, p1.x));
                p1.y = Math.max(30, Math.min(GAME_HEIGHT - 30, p1.y));
                p2.x = Math.max(30, Math.min(GAME_WIDTH - 30, p2.x));
                p2.y = Math.max(30, Math.min(GAME_HEIGHT - 30, p2.y));
            }
        }

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
            timeLeft: this.timeLeft,
            bot: this.bot
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
            if (!exploded && this.bot) {
                if (Math.sqrt((this.bot.x - tb.x) ** 2 + (this.bot.y - tb.y) ** 2) < BASE_EXPLOSION_RADIUS / 2) {
                    exploded = true;
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
            // Bot powerup collision
            if (this.bot && this.powerups[i]) {
                const b = this.bot;
                if (Math.sqrt((b.x - this.powerups[i].x) ** 2 + (b.y - this.powerups[i].y) ** 2) < 35) {
                    if (this.powerups[i].type === 'HEALTH') b.hp = Math.min(100, b.hp + 30);
                    this.powerups.splice(i, 1);
                }
            }
        }
    }

    incrementTrophies(dbId, delta) {
        supabase.rpc('increment_trophies', { user_id: dbId, delta }).then(() => { });
    }

    resolveEntityObstacles(ent) {
        const pRadius = 20;
        for (const obs of this.obstacles) {
            if (ent.x + pRadius > obs.x - obs.w / 2 && ent.x - pRadius < obs.x + obs.w / 2 &&
                ent.y + pRadius > obs.y - obs.h / 2 && ent.y - pRadius < obs.y + obs.h / 2) {

                // Entity is inside obstacle - Push it out to the nearest edge
                const distLeft = (ent.x + pRadius) - (obs.x - obs.w / 2);
                const distRight = (obs.x + obs.w / 2) - (ent.x - pRadius);
                const distTop = (ent.y + pRadius) - (obs.y - obs.h / 2);
                const distBottom = (obs.y + obs.h / 2) - (ent.y - pRadius);

                const min = Math.min(distLeft, distRight, distTop, distBottom);

                // Before applying, check if it pushes out of bounds. 
                // If it does, we take the second best option.
                let pushX = 0, pushY = 0;
                if (min === distLeft) pushX = -distLeft;
                else if (min === distRight) pushX = distRight;
                else if (min === distTop) pushY = -distTop;
                else if (min === distBottom) pushY = distBottom;

                // Safety check: is the new position out of bounds?
                if (ent.x + pushX < 30 || ent.x + pushX > GAME_WIDTH - 30 ||
                    ent.y + pushY < 30 || ent.y + pushY > GAME_HEIGHT - 30) {
                    // If it is, tries to push to the center of the arena instead
                    const angToCenter = Math.atan2(GAME_HEIGHT / 2 - ent.y, GAME_WIDTH / 2 - ent.x);
                    ent.x += Math.cos(angToCenter) * 10;
                    ent.y += Math.sin(angToCenter) * 10;
                } else {
                    ent.x += pushX;
                    ent.y += pushY;
                }
            }
        }
    }

    explode(bomb) {
        const owner = bomb.ownerId === this.bot?.id ? this.bot : this.players[bomb.ownerId];
        if (owner) {
            owner.activeBombs = Math.max(0, owner.activeBombs - 1);
        }

        io.to(this.id).emit('explosion', { x: bomb.x, y: bomb.y, range: bomb.range });

        // Damage Players
        Object.values(this.players).forEach(p => {
            const dist = Math.sqrt((p.x - bomb.x) ** 2 + (p.y - bomb.y) ** 2);
            if (dist < bomb.range && !p.isInvulnerable) {
                p.hp -= MIN_DAMAGE + (MAX_DAMAGE - MIN_DAMAGE) * (1 - dist / bomb.range);
                if (p.hp <= 0) this.endGame();
            }
        });
        if (this.bot) {
            const b = this.bot;
            const dist = Math.sqrt((b.x - bomb.x) ** 2 + (b.y - bomb.y) ** 2);
            if (dist < bomb.range) {
                b.hp -= MIN_DAMAGE + (MAX_DAMAGE - MIN_DAMAGE) * (1 - dist / bomb.range);
                if (b.hp <= 0) {
                    this.spawnPowerup(b.x, b.y);
                    this.bot = null;
                }
            }
        }
        const powerupsToExplode = [];
        for (let j = this.powerups.length - 1; j >= 0; j--) {
            const pw = this.powerups[j];
            if (!pw) continue;
            const d = Math.sqrt((pw.x - bomb.x) ** 2 + (pw.y - bomb.y) ** 2);
            if (d < bomb.range) {
                powerupsToExplode.push(this.powerups.splice(j, 1)[0]);
            }
        }
        powerupsToExplode.forEach(pw => {
            this.explode({ x: pw.x, y: pw.y, range: bomb.range * 0.7, ownerId: null });
        });
        this.obstacles = this.obstacles.filter(obs => {
            if (Math.sqrt((obs.x - bomb.x) ** 2 + (obs.y - bomb.y) ** 2) < bomb.range + 30) {
                obs.hp -= 20;
                if (obs.hp <= 0) { this.spawnPowerup(obs.x, obs.y); return false; }
            }
            return true;
        });
        const trapsToExplode = [];
        for (let i = this.trapBombs.length - 1; i >= 0; i--) {
            const tb = this.trapBombs[i];
            if (!tb) continue;
            const d = Math.sqrt((tb.x - bomb.x) ** 2 + (tb.y - bomb.y) ** 2);
            if (d < bomb.range) {
                trapsToExplode.push(this.trapBombs.splice(i, 1)[0]);
            }
        }
        trapsToExplode.forEach(tb => {
            this.explode({ x: tb.x, y: tb.y, range: BASE_EXPLOSION_RADIUS, ownerId: null });
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
