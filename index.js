const socket = io();
const canvas = document.querySelector('canvas');
const c = canvas.getContext('2d')
canvas.width = 1900
canvas.height = 920

const collisionsMap = []
for (let i = 0; i < collisions.length; i += 70) {
    collisionsMap.push(collisions.slice(i, 70 + i))
}

const boundaries = []
const offset = {
    x: -1263,
    y: -480
}

collisionsMap.forEach((row, i) => {
    row.forEach((symbol, j) => {
        if (symbol === 1025)
            boundaries.push(new Boundary({
                position: {
                    x: j * Boundary.width + offset.x,
                    y: i * Boundary.height + offset.y
                }
            }))

    })
})

const image = new Image()
image.src = './img/map.png'

const foregroundImage = new Image()
foregroundImage.src = './img/foregroundObjects.png'

const playerDownImage = new Image()
playerDownImage.src = './img/playerDown.png'

const playerUpImage = new Image()
playerUpImage.src = './img/playerUp.png'

const playerLeftImage = new Image()
playerLeftImage.src = './img/playerLeft.png'

const playerRightImage = new Image()
playerRightImage.src = './img/playerRight.png'

const player = new Sprite({
    position: {
        x: canvas.width / 2 - 192 / 4 / 2,
        y: canvas.height / 2 - 68 / 2
    },
    image: playerDownImage,
    frames: {
        max: 4
    },
    sprites: {
        up: playerUpImage,
        left: playerLeftImage,
        right: playerRightImage,
        down: playerDownImage
    },
    name: '' // Will be set on join
})

const remotePlayers = {}

const background = new Sprite({
    position: {
        x: offset.x,
        y: offset.y
    },
    image: image
})

const foreground = new Sprite({
    position: {
        x: offset.x,
        y: offset.y
    },
    image: foregroundImage
})

const keys = {
    w: { pressed: false },
    a: { pressed: false },
    s: { pressed: false },
    d: { pressed: false }
}
const pressedKeys = []

const movables = [background, ...boundaries, foreground]

function rectangularCollision({ rectangle1, rectangle2 }) {
    return (
        rectangle1.position.x + rectangle1.width >= rectangle2.position.x &&
        rectangle1.position.x <= rectangle2.position.x + rectangle2.width &&
        rectangle1.position.y <= rectangle2.position.y &&
        rectangle1.position.y + 68 >= rectangle2.position.y
    )
}

socket.on('init', (players) => {
    Object.keys(players).forEach(id => {
        if (id !== socket.id) {
            remotePlayers[id] = new Sprite({
                position: { x: players[id].x + background.position.x, y: players[id].y + background.position.y },
                image: playerDownImage,
                frames: { max: 4 },
                sprites: {
                    up: playerUpImage,
                    left: playerLeftImage,
                    right: playerRightImage,
                    down: playerDownImage
                },
                name: players[id].name
            })
        }
    })
})

socket.on('newPlayer', ({ id, player: p }) => {
    remotePlayers[id] = new Sprite({
        position: { x: p.x + background.position.x, y: p.y + background.position.y },
        image: playerDownImage,
        frames: { max: 4 },
        sprites: {
            up: playerUpImage,
            left: playerLeftImage,
            right: playerRightImage,
            down: playerDownImage
        },
        name: p.name
    })
})

socket.on('playerMove', ({ id, x, y, sprite }) => {
    if (remotePlayers[id]) {
        remotePlayers[id].position.x = x + background.position.x
        remotePlayers[id].position.y = y + background.position.y
        remotePlayers[id].image = remotePlayers[id].sprites[sprite]
        remotePlayers[id].moving = true
    }
})

socket.on('playerDisconnected', (id) => {
    delete remotePlayers[id]
    if (peers[id]) {
        peers[id].close()
        delete peers[id]
        const card = document.getElementById(`card-${id}`)
        if (card) card.remove()
    }

    // Screen share cleanup
    if (screenPeers[id]) {
        closeScreenPeer(id)
    }
    if (currentSharerId === id) {
        document.getElementById('screen-share-container').style.display = 'none'
        document.getElementById('screen-share-video').srcObject = null
        document.getElementById('watch-screen').style.display = 'none'
        currentSharerId = null
    }
})

// WebRTC Setup
let localStream = null
const peers = {}
const PROXIMITY_THRESHOLD = 150 // pixels

async function getLocalStream() {
    if (localStream) return localStream
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        console.log('Microphone and Camera access granted')
        const myVideo = document.getElementById('my-video')
        if (myVideo) myVideo.srcObject = localStream
        return localStream
    } catch (err) {
        console.error('Error getting media stream:', err)
        // Fallback to audio only if video fails (e.g. no webcam)
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true })
            console.log('Microphone access granted (Video failed)')
            return localStream
        } catch (e) {
            console.error('Error getting audio stream:', e)
            return null
        }
    }
}

document.getElementById('start-btn').addEventListener('click', () => {
    const nameInput = document.getElementById('player-name-input')
    const playerName = nameInput.value.trim() || 'Desconhecido'
    player.name = playerName
    document.getElementById('setup-overlay').style.display = 'none'
    socket.emit('join', { name: playerName })
    getLocalStream() // Pre-request permissions
})

// UI Toggles
document.getElementById('toggle-mic').addEventListener('click', (e) => {
    if (!localStream) return
    const audioTrack = localStream.getAudioTracks()[0]
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        e.target.textContent = audioTrack.enabled ? '🎙️ Mute' : '🔇 Unmute'
        e.target.classList.toggle('off', !audioTrack.enabled)
    }
})

document.getElementById('toggle-cam').addEventListener('click', (e) => {
    if (!localStream) return
    const videoTrack = localStream.getVideoTracks()[0]
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled
        e.target.textContent = videoTrack.enabled ? '📷 Hide Cam' : '🎥 Show Cam'
        e.target.classList.toggle('off', !videoTrack.enabled)
        document.getElementById('local-video-preview').style.display = videoTrack.enabled ? 'block' : 'none'
    }
})

// ====== SCREEN SHARING (dedicated peer connections) ======
let screenStream = null
let isScreenSharing = false
const screenPeers = {} // separate peer connections just for screen share
let currentSharerId = null // track who is sharing on the remote side

// Relay screen share signaling through socket
function emitScreen(type, data) {
    socket.emit('screen-signal', { type, ...data })
}

socket.on('screen-signal', async ({ type, from, to, sdp, candidate, sharing }) => {
    if (type === 'start') {
        // Someone started sharing - track it but don't show UI yet (wait for proximity/video)
        currentSharerId = from
        // Update label with name if we have it
        const name = remotePlayers[from] ? remotePlayers[from].name : from.substring(0, 4)
        document.getElementById('screen-share-label').textContent = `🖥️ ${name} compartilhando tela`
        // Create our receiving peer connection
        createScreenReceiver(from)
    } else if (type === 'stop') {
        if (currentSharerId === from) {
            document.getElementById('screen-share-container').style.display = 'none'
            document.getElementById('screen-share-video').srcObject = null
            document.getElementById('watch-screen').style.display = 'none'
            currentSharerId = null
        }
        closeScreenPeer(from)
    } else if (type === 'offer') {
        if (!screenPeers[from]) createScreenReceiver(from)
        const pc = screenPeers[from]
        await pc.setRemoteDescription(new RTCSessionDescription(sdp))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        emitScreen('answer', { to: from, sdp: pc.localDescription })
    } else if (type === 'answer') {
        const pc = screenPeers[to] || screenPeers[from]
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp))
    } else if (type === 'ice') {
        const pc = screenPeers[from]
        if (pc && candidate) {
            try { await pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch (e) { }
        }
    }
})

function createScreenReceiver(fromId) {
    if (screenPeers[fromId]) return screenPeers[fromId]
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    screenPeers[fromId] = pc
    pc.onicecandidate = (e) => {
        if (e.candidate) emitScreen('ice', { to: fromId, candidate: e.candidate })
    }
    pc.ontrack = (event) => {
        console.log('Screen share track received from', fromId)
        currentSharerId = fromId
        const container = document.getElementById('screen-share-container')
        const label = document.getElementById('screen-share-label')
        const video = document.getElementById('screen-share-video')

        const name = remotePlayers[fromId] ? remotePlayers[fromId].name : fromId.substring(0, 4)
        container.style.display = 'block'
        document.getElementById('watch-screen').style.display = 'none'
        label.textContent = `🖥️ ${name} compartilhando tela`
        video.srcObject = event.streams[0] || new MediaStream([event.track])
        video.play().catch(e => console.warn('Screen video autoplay blocked:', e))
    }
    return pc
}

async function createScreenSender(toId) {
    if (screenPeers[toId]) closeScreenPeer(toId)
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    screenPeers[toId] = pc
    pc.onicecandidate = (e) => {
        if (e.candidate) emitScreen('ice', { to: toId, candidate: e.candidate })
    }
    // Add screen tracks
    screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream))
    // Create offer
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    emitScreen('offer', { to: toId, sdp: pc.localDescription })
}

function closeScreenPeer(peerId) {
    if (screenPeers[peerId]) {
        screenPeers[peerId].close()
        delete screenPeers[peerId]
    }
}

document.getElementById('toggle-screen').addEventListener('click', async (e) => {
    if (isScreenSharing) {
        stopScreenSharing()
        return
    }
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        isScreenSharing = true
        e.target.textContent = '🖥️ Stop Sharing'
        e.target.classList.add('active')

        // Show local preview
        document.getElementById('screen-share-video').srcObject = screenStream
        document.getElementById('screen-share-container').style.display = 'block'
        document.getElementById('screen-share-label').textContent = '🖥️ Você está compartilhando sua tela'

        // Notify all in-range peers that sharing started
        emitScreen('start', {})

        // Open a dedicated sender connection to each peer currently connected
        for (const peerId of Object.keys(peers)) {
            await createScreenSender(peerId)
        }

        screenStream.getVideoTracks()[0].onended = () => stopScreenSharing()
    } catch (err) {
        console.error('Error starting screen share:', err)
    }
})

async function stopScreenSharing() {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop())
        screenStream = null
    }
    isScreenSharing = false
    document.getElementById('toggle-screen').textContent = '🖥️ Share Screen'
    document.getElementById('toggle-screen').classList.remove('active')
    document.getElementById('screen-share-container').style.display = 'none'
    document.getElementById('screen-share-video').srcObject = null
    // Close all screen peer connections
    Object.keys(screenPeers).forEach(id => closeScreenPeer(id))
    emitScreen('stop', {})
}

document.getElementById('screen-share-close').addEventListener('click', () => {
    document.getElementById('screen-share-container').style.display = 'none'
    if (currentSharerId) {
        document.getElementById('watch-screen').style.display = 'inline-block'
    }
})

document.getElementById('watch-screen').addEventListener('click', () => {
    if (currentSharerId) {
        document.getElementById('screen-share-container').style.display = 'block'
        document.getElementById('watch-screen').style.display = 'none'
    }
})

async function createPeerConnection(remoteId, isOfferer) {
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })

    peers[remoteId] = pc

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { to: remoteId, signal: { candidate: event.candidate } })
        }
    }

    pc.ontrack = (event) => {
        console.log(`Recebida track de ${remoteId}:`, event.track.kind)
        const remoteStream = event.streams[0] || new MediaStream([event.track])

        // Normal track handling (webcam/audio) — goes to video card
        let container = document.getElementById('video-container')
        let card = document.getElementById(`card-${remoteId}`)

        if (!card) {
            card = document.createElement('div')
            card.id = `card-${remoteId}`
            card.className = 'remote-video-card'

            const video = document.createElement('video')
            video.id = `video-${remoteId}`
            video.autoplay = true
            video.playsinline = true

            const label = document.createElement('div')
            label.className = 'player-label'
            label.textContent = remotePlayers[remoteId] ? remotePlayers[remoteId].name : `Player ${remoteId.substring(0, 4)}`

            card.appendChild(video)
            card.appendChild(label)
            container.appendChild(card)
        }

        const video = document.getElementById(`video-${remoteId}`)
        if (video.srcObject !== remoteStream) {
            video.srcObject = remoteStream
        }
        video.play().catch(e => {
            console.warn(`Autoplay bloqueado para ${remoteId}:`, e)
        })
    }

    const stream = await getLocalStream()
    if (stream) {
        stream.getTracks().forEach(track => pc.addTrack(track, stream))
    }

    // If we are currently screen sharing, open a new dedicated screen sender to this peer too
    if (isScreenSharing && screenStream) {
        createScreenSender(remoteId)
    }

    if (isOfferer) {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        socket.emit('signal', { to: remoteId, signal: { sdp: pc.localDescription } })
    }

    return pc
}

socket.on('signal', async ({ from, signal }) => {
    console.log(`Recebido sinal de ${from}:`, signal.sdp ? `SDP (${signal.sdp.type})` : 'ICE Candidate')
    let pc = peers[from]
    if (!pc) {
        console.log(`Criando nova conexão para sinal de ${from}`)
        pc = await createPeerConnection(from, false)
    }

    if (signal.sdp) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
            if (pc.remoteDescription.type === 'offer') {
                const answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                socket.emit('signal', { to: from, signal: { sdp: pc.localDescription } })
                console.log(`Resposta enviada para ${from}`)
            }
        } catch (e) {
            console.error(`Erro ao processar SDP de ${from}:`, e)
        }
    } else if (signal.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
        } catch (e) {
            console.error(`Erro ao adicionar ICE candidate de ${from}:`, e)
        }
    }
})

function getDistance(p1, p2) {
    const dx = p1.x - p2.x
    const dy = p1.y - p2.y
    return Math.sqrt(dx * dx + dy * dy)
}

function animate() {
    window.requestAnimationFrame(animate)
    background.draw()
    boundaries.forEach((boundary) => {
        boundary.draw()
    })

    player.draw()

    // Draw communication aura for the local player
    c.beginPath()
    c.arc(player.position.x + player.width / 2, player.position.y + player.height / 2, PROXIMITY_THRESHOLD, 0, Math.PI * 2)
    c.fillStyle = 'rgba(0, 255, 0, 0.15)'
    c.fill()
    c.strokeStyle = 'rgba(0, 255, 0, 0.5)'
    c.stroke()
    c.closePath()

    const myWorldPos = {
        x: player.position.x - background.position.x,
        y: player.position.y - background.position.y
    }

    Object.keys(remotePlayers).forEach(id => {
        const rp = remotePlayers[id]
        rp.draw()

        // Proximity Logic
        const rpWorldPos = {
            x: rp.position.x - background.position.x,
            y: rp.position.y - background.position.y
        }
        const dist = getDistance(myWorldPos, rpWorldPos)

        if (dist < PROXIMITY_THRESHOLD) {
            // Tie-breaker: only one peer initiates (the one with 'higher' ID)
            if (!peers[id] && socket.id > id) {
                console.log(`Perto de ${id}, iniciando chamada (sou iniciador)...`)
                createPeerConnection(id, true)
            }

            // Draw aura for remote player in range
            c.beginPath()
            c.arc(rp.position.x + rp.width / 2, rp.position.y + rp.height / 2, 50, 0, Math.PI * 2)
            c.fillStyle = 'rgba(0, 255, 0, 0.2)'
            c.fill()
            c.closePath()

            // Visual feedback: Hearing label
            c.fillStyle = 'white'
            c.font = '16px Arial'
            c.fillText('🔊 Calling...', rp.position.x, rp.position.y - 10)
        } else {
            if (peers[id] || screenPeers[id]) {
                console.log(`Afastou-se de ${id}, fechando conexões. (peers: ${!!peers[id]}, screenPeers: ${!!screenPeers[id]})`)

                if (peers[id]) {
                    const pc = peers[id]
                    pc.onicecandidate = null
                    pc.ontrack = null
                    pc.getSenders().forEach(sender => pc.removeTrack(sender))
                    pc.close()
                    delete peers[id]
                }

                // Screen share peer cleanup
                if (screenPeers[id]) {
                    console.log(`Fechando screenPeer para ${id}`)
                    closeScreenPeer(id)
                }

                const card = document.getElementById(`card-${id}`)
                if (card) card.remove()
            }

            // Always clear UI if the sharer is far away, regardless of peer state
            if (currentSharerId === id) {
                console.log(`Limpando UI de compartilhamento (sharer ${id} está longe)`)
                document.getElementById('screen-share-container').style.display = 'none'
                document.getElementById('screen-share-video').srcObject = null
                document.getElementById('watch-screen').style.display = 'none'
                currentSharerId = null
            }
        }
    })

    if (Object.keys(peers).length > 0) {
        c.fillStyle = 'lime'
        c.font = '20px Arial'
        c.fillText('🎙️ Voice Chat Active', 20, 40)
    }

    foreground.draw()

    let moving = false
    player.moving = false

    const localPos = {
        x: player.position.x - background.position.x,
        y: player.position.y - background.position.y
    }

    const currentDirection = pressedKeys.length > 0 ? pressedKeys[pressedKeys.length - 1] : null

    if (currentDirection === 'w') {
        player.moving = true
        player.image = player.sprites.up
        for (let i = 0; i < boundaries.length; i++) {
            const boundary = boundaries[i]
            if (
                rectangularCollision({
                    rectangle1: player,
                    rectangle2: {
                        ...boundary,
                        position: {
                            x: boundary.position.x,
                            y: boundary.position.y + 5
                        }
                    }
                })
            ) {
                player.moving = false
                break
            }
        }
        if (player.moving) {
            movables.forEach((movable) => {
                movable.position.y += 5
            })
            Object.values(remotePlayers).forEach(rp => {
                rp.position.y += 5
            })
            moving = true
        }
    } else if (currentDirection === 'a') {
        player.moving = true
        player.image = player.sprites.left
        for (let i = 0; i < boundaries.length; i++) {
            const boundary = boundaries[i]
            if (
                rectangularCollision({
                    rectangle1: player,
                    rectangle2: {
                        ...boundary, position: {
                            x: boundary.position.x + 5,
                            y: boundary.position.y
                        }
                    }
                })
            ) {
                player.moving = false
                break
            }
        }
        if (player.moving) {
            movables.forEach((movable) => {
                movable.position.x += 5
            })
            Object.values(remotePlayers).forEach(rp => {
                rp.position.x += 5
            })
            moving = true
        }
    } else if (currentDirection === 's') {
        player.moving = true
        player.image = player.sprites.down
        for (let i = 0; i < boundaries.length; i++) {
            const boundary = boundaries[i]
            if (
                rectangularCollision({
                    rectangle1: player,
                    rectangle2: {
                        ...boundary, position: {
                            x: boundary.position.x,
                            y: boundary.position.y - 5
                        }
                    }
                })
            ) {
                player.moving = false
                break
            }
        }
        if (player.moving) {
            movables.forEach((movable) => {
                movable.position.y -= 5
            })
            Object.values(remotePlayers).forEach(rp => {
                rp.position.y -= 5
            })
            moving = true
        }
    } else if (currentDirection === 'd') {
        player.moving = true
        player.image = player.sprites.right
        for (let i = 0; i < boundaries.length; i++) {
            const boundary = boundaries[i]
            if (
                rectangularCollision({
                    rectangle1: player,
                    rectangle2: {
                        ...boundary, position: {
                            x: boundary.position.x - 5,
                            y: boundary.position.y
                        }
                    }
                })
            ) {
                player.moving = false
                break
            }
        }
        if (player.moving) {
            movables.forEach((movable) => {
                movable.position.x -= 5
            })
            Object.values(remotePlayers).forEach(rp => {
                rp.position.x -= 5
            })
            moving = true
        }
    }

    if (moving) {
        socket.emit('playerMove', {
            x: player.position.x - background.position.x,
            y: player.position.y - background.position.y,
            sprite: currentDirection === 'w' ? 'up' : currentDirection === 'a' ? 'left' : currentDirection === 's' ? 'down' : 'right'
        })
    }
}
animate()

window.addEventListener('keydown', (e) => {
    if (['w', 'a', 's', 'd'].includes(e.key) && !pressedKeys.includes(e.key)) {
        keys[e.key].pressed = true
        pressedKeys.push(e.key)
    }
})

window.addEventListener('keyup', (e) => {
    if (['w', 'a', 's', 'd'].includes(e.key)) {
        keys[e.key].pressed = false
        const index = pressedKeys.indexOf(e.key)
        if (index > -1) pressedKeys.splice(index, 1)
    }
})
