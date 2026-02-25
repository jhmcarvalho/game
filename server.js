const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const forge = require('node-forge');

const app = express();

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

console.log('Generating HTTPS certificate...');
const { key, cert } = generateCert();
const server = https.createServer({ key, cert }, app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '/')));

const players = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (data) => {
        // Initial state for the new player
        players[socket.id] = {
            x: 0,
            y: 0,
            sprite: 'down',
            name: data.name || `Player ${socket.id.substring(0, 4)}`
        };

        // Send current players to the new connection
        socket.emit('init', players);

        // Notify others about the new player
        socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });
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
