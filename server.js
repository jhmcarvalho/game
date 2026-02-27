require('dotenv').config({ override: true });
const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const forge = require('node-forge');

const http = require('http');

const app = express();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// Generate a self-signed certificate using node-forge (SHA-256 + SAN, compatible with modern browsers)
function generateCert() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '0.0.0.0' }] }
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert)
    };
}

let server;
if (IS_PRODUCTION) {
    console.log('Running in PRODUCTION mode (HTTP)...');
    server = http.createServer(app);
} else {
    console.log('Running in LOCAL mode (HTTPS)...');
    const { key, cert } = generateCert();
    server = https.createServer({ key, cert }, app);
}

const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '/')));
app.use(express.json());

// Collision editor save endpoint
const fs = require('fs');
app.post('/api/save-collisions', (req, res) => {
    const { collisions } = req.body;
    if (!Array.isArray(collisions)) return res.status(400).json({ error: 'Invalid data' });
    const content = `const collisions = [${collisions.join(', ')}]`;
    fs.writeFileSync(path.join(__dirname, 'data/collisions.js'), content);
    res.json({ ok: true, count: collisions.length });
});

// --- Authentication Routes ---

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
        }

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ error: 'E-mail já cadastrado' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                profile: {
                    create: {
                        name,
                        sprite: 'playerDown'
                    }
                }
            },
            include: { profile: true }
        });

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ token, user: { id: user.id, email: user.email, profile: user.profile } });
    } catch (error) {
        console.error('Erro no registro:', error);
        res.status(500).json({ error: 'Erro interno ao registrar usuário' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await prisma.user.findUnique({
            where: { email },
            include: { profile: true }
        });

        if (!user || !user.password) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, profile: user.profile } });
    } catch (error) {
        console.error('--- LOGIN ERROR ---');
        console.error('Message:', error.message);
        console.error('Code:', error.code);
        if (error.clientVersion) console.error('Prisma Version:', error.clientVersion);
        res.status(500).json({ error: 'Erro interno ao fazer login' });
    }
});

app.patch('/api/auth/profile', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Não autorizado' });

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { sprite, name } = req.body;

        const updatedProfile = await prisma.profile.update({
            where: { userId: decoded.userId },
            data: {
                sprite: sprite || undefined,
                name: name || undefined
            }
        });

        res.json({ profile: updatedProfile });
    } catch (error) {
        console.error('Erro ao atualizar perfil:', error);
        res.status(401).json({ error: 'Token inválido' });
    }
});

const players = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (data) => {
        players[socket.id] = {
            id: socket.id,
            x: 0,
            y: 0,
            sprite: data.sprite || 'playerDown',
            name: data.name || `Player ${socket.id.substring(0, 4)}`
        };
        console.log(`Player ${socket.id} joined as ${players[socket.id].name} with sprite ${players[socket.id].sprite}`);
        socket.emit('init', players);
        socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });
    });

    socket.on('updateSprite', ({ sprite }) => {
        if (players[socket.id]) {
            players[socket.id].sprite = sprite;
            socket.broadcast.emit('playerMove', {
                id: socket.id,
                x: players[socket.id].x,
                y: players[socket.id].y,
                sprite: 'down' // Force redraw with new sprite base
            });
        }
    });

    socket.on('chatMessage', (data) => {
        if (players[socket.id]) {
            const messageData = {
                name: players[socket.id].name,
                message: data.message,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            io.emit('chatMessage', messageData);
        }
    });

    socket.on('playerMove', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].sprite = data.sprite;
            socket.broadcast.emit('playerMove', { id: socket.id, x: data.x, y: data.y, sprite: data.sprite });
        }
    });

    // WebRTC Signaling
    socket.on('signal', (data) => {
        // data should contain { to: recipientId, signal: webRTCData }
        if (io.sockets.sockets.get(data.to)) {
            io.to(data.to).emit('signal', {
                from: socket.id,
                signal: data.signal
            });
        }
    });

    // Screen Share Signaling
    socket.on('screen-signal', (data) => {
        if (data.to) {
            // Targeted message (offer, answer, ice)
            io.to(data.to).emit('screen-signal', { ...data, from: socket.id });
        } else {
            // Broadcast (start, stop)
            socket.broadcast.emit('screen-signal', { ...data, from: socket.id });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
