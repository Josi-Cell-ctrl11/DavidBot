const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const config = require('./config.js');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const useSupabaseAuthState = require('./supabaseAuth');
const express = require('express');
const antiDelete = require('./antidelete.js');
const tagAll = require('./tagall.js');
const screenshot = require('./screenshot.js');
const facebook = require('./facebook.js');
const hostCmd = require('./host.js');
const youtube = require('./youtube.js');
const pingCmd = require('./ping.js');



// --- HIDE LIBSIGNAL NOISE ---
const originalLog = console.log;
const originalError = console.error;
const noiseWords = [
    'Session error', 'Bad MAC', 'Closing session', 'prekey bundle', 'Failed to decrypt',
    'Decrypted message with closed session', 'Closing open session', 'Removing old closed session',
    '_chains', 'registrationId', 'currentRatchet', 'indexInfo', 'ephemeralKeyPair',
    'lastRemoteEphemeralKey', 'previousCounter', 'rootKey', 'baseKey', 'remoteIdentityKey',
    'SessionEntry', 'pendingPreKey', 'preKeyId', 'signedKeyId'
];
function isNoise(args) {
    try {
        const str = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        return noiseWords.some(w => str.includes(w));
    } catch (e) { return false; }
}
console.log = function (...args) { if (isNoise(args)) return; originalLog.apply(console, args); };
console.error = function (...args) { if (isNoise(args)) return; originalError.apply(console, args); };

// Setup memory cache to avoid performance/duplicate issues internally for Baileys
const msgRetryCounterCache = new NodeCache();

// --- STATE & CACHE ---
const reactedStatusCache = new Set();
const CACHE_MAX_SIZE = 1000;
const botStartTime = Math.floor(Date.now() / 1000);

let isActivelyLiking = true;
let fixedEmoji = "🤍";
let isViewOnly = false;
let activeSocket = null;

// Helper to check if a number is allowed based on whitelist and blacklist
function isAllowed(jid) {
    if (config.blacklist && config.blacklist.length > 0) {
        if (config.blacklist.includes(jid)) return false;
    }
    if (config.whitelist && config.whitelist.length > 0) {
        return config.whitelist.includes(jid);
    }
    return true;
}

async function connectToWhatsApp() {
    const supabase = createClient(config.supabaseUrl, config.supabaseKey);

    console.log('[INFO] Loading WhatsApp Session from Supabase Cloud...');
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_auth');

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[INFO] Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

    const logger = pino({ level: 'silent' });

    const socket = makeWASocket({
        version,
        logger,
        printQRInTerminal: !config.usePairingCode,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 120_000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5
    });

    activeSocket = socket;

    socket.ev.on('creds.update', saveCreds);

    // --- ANTI-DELETE LOGIC ---
    socket.ev.on('messages.update', (update) => {
        antiDelete.handleUpdate(socket, update);
    });

    // Handle pairing code
    if (config.usePairingCode && !state.creds.me) {
        if (!config.phoneNumber || config.phoneNumber === "1234567890") {
            console.error('[ERROR] phone number issues in config.js');
            process.exit(1);
        }

        setTimeout(async () => {
            try {
                const code = await socket.requestPairingCode(config.phoneNumber);
                console.log(`\n========================================`);
                console.log(`[ACTION REQUIRED] Your Pairing Code: ${code}`);
                console.log(`========================================\n`);
            } catch (err) {
                console.error('[ERROR] Failed to request pairing code:', err);
            }
        }, 3000);
    }

    let reconnectAttempts = 0;

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isConflict = statusCode === 440;
            const is401 = statusCode === 401;
            const shouldReconnect = !isLoggedOut;

            console.log('[INFO] Connection closed, code:', statusCode, '| Reconnecting:', shouldReconnect);

            if (shouldReconnect) {
                reconnectAttempts++;
                let baseDelay = 10_000;
                if (isConflict) baseDelay = 30_000;
                if (is401) baseDelay = 5_000;
                const backoff = Math.min(baseDelay * Math.pow(1.5, reconnectAttempts - 1), 120_000);
                const reason = isConflict ? ' (conflit)' : is401 ? ' (invalide, retry)' : '';
                console.log(`[INFO] Reconnexion dans ${Math.round(backoff / 1000)}s (tentative #${reconnectAttempts})${reason}...`);
                setTimeout(() => connectToWhatsApp(), backoff);
            } else {
                console.log('[INFO] Session déconnectée (loggedOut). Nettoyez Supabase.');
            }
        } else if (connection === 'open') {
            reconnectAttempts = 0;
            console.log('[INFO] Successfully connected to WhatsApp!');
            const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
            const welcomeMsg = `╭───〔 🤖 *JOSIHACK BOT* 〕───⬣\n` +
                `│ ߷ *Etat*       ➜ Connecté ✅\n` +
                `│ ߷ *Mode*       ➜ Auto-Like\n` +
                `╰──────────────⬣`;
            console.log(welcomeMsg);
            try {
                if (config.sendWelcomeMessage) {
                    await socket.sendMessage(botJid, { text: welcomeMsg });
                    console.log('[INFO] Système synchronisé.');
                }
            } catch (e) { }
        }
    });

    socket.ev.on('messages.upsert', async (m) => {
        try {
            // Capturer les messages pour l'Anti-Delete AVANT tout traitement
            await antiDelete.handleUpsert(socket, m);

            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant;

            // --- ANTI VUE UNIQUE ---
            let isViewOnce = false;
            let messageTypeStr = "Media";
            const viewOnceKey = Object.keys(msg.message || {}).find(k => k.toLowerCase().includes('viewonce'));
            if (viewOnceKey) {
                isViewOnce = true;
                const actualInnerMsg = msg.message[viewOnceKey]?.message;
                if (actualInnerMsg) messageTypeStr = Object.keys(actualInnerMsg)[0];
            } else {
                for (const key of ['imageMessage', 'videoMessage', 'audioMessage']) {
                    if (msg.message?.[key]?.viewOnce) {
                        isViewOnce = true;
                        messageTypeStr = key;
                        break;
                    }
                }
            }

            if (isViewOnce) {
                try {
                    const senderPhoneNumber = (participantJid || remoteJid).split('@')[0];
                    const ownerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
                    const caption = `👁️ *VUE UNIQUE DÉTECTÉE*\n👤 +${senderPhoneNumber}`;
                    if (messageTypeStr.includes('image')) await socket.sendMessage(ownerJid, { image: buffer, caption });
                    else if (messageTypeStr.includes('video')) await socket.sendMessage(ownerJid, { video: buffer, caption });
                    else if (messageTypeStr.includes('audio')) await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                } catch (e) { console.error("[ERROR] Anti-View-Once failed"); }
            }

            // --- FILTERS ---
            const isStatus = remoteJid === 'status@broadcast';

            // --- GRACE PERIOD FOR STATUSES (OFFLINE CATCH-UP) ---
            if (msg.messageTimestamp) {
                const msgTime = typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.toNumber ? msg.messageTimestamp.toNumber() : Number(msg.messageTimestamp);

                if (isStatus) {
                    // Pour les statuts, on accepte jusqu'à 30 minutes de retard
                    const thirtyMinutes = 30 * 60;
                    if (msgTime < (botStartTime - thirtyMinutes)) {
                        return;
                    }
                    // Log silencieux pour le catch-up des statuts si nécessaire
                } else {
                    // Pour les commandes normales, on ignore STRICTEMENT tout ce qui s'est passé quand le bot était éteint
                    if (msgTime < botStartTime) {
                        console.log(`[FILTER] Ignoré commande ancienne (${msg.key.id}) - Ecart: ${botStartTime - msgTime}s`);
                        return;
                    }
                }
            }

            if (!isStatus && m.type !== 'notify' && m.type !== 'append') return;

            const textContent = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                msg.message.documentMessage?.caption ||
                "";
            const textLower = textContent.trim().toLowerCase();
            const currentPrefix = config.prefix || "?";
            const isCmd = textLower.startsWith(currentPrefix);
            const cmd = isCmd ? textLower.slice(currentPrefix.length).split(/\s+/)[0] : '';
            const textArgs = isCmd ? textContent.slice(textContent.toLowerCase().indexOf(cmd) + cmd.length).trim() : '';

            // --- COMMANDS ---
            const senderJid = participantJid || remoteJid;
            const isOwner = msg.key.fromMe || (config.owners && config.owners.some(o => senderJid.includes(o)));

            if (isCmd) {
                console.log(`[DEBUG] Command detected: "${textContent}" from ${senderJid} (isOwner: ${isOwner})`);
                if (!isOwner) console.log(`[SECURITY] Command denied for ${senderJid}`);
            }

            if (isOwner && isCmd) {
                const targetChat = (isStatus || msg.key.fromMe) ? (socket.user.id.split(':')[0] + '@s.whatsapp.net') : remoteJid;

                if (cmd === 'josistatus') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') { isActivelyLiking = true; isViewOnly = false; }
                    else if (arg === 'off') isActivelyLiking = false;
                    
                    const statusText = `📊 *STATUS LIKES*\n` +
                        `- Auto-Like : ${isActivelyLiking ? "ON ✅" : "OFF ❌"}\n` +
                        `- Emoji Fixé : ${fixedEmoji || "Aléatoire 🎲"}`;
                    
                    await socket.sendMessage(targetChat, { text: statusText }, { quoted: msg });
                } else if (cmd === 'josiview') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        isViewOnly = true;
                        isActivelyLiking = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ON ✅` }, { quoted: msg });
                    } else if (arg === 'off') {
                        isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : OFF ❌` }, { quoted: msg });
                    } else if (arg === 'status') {
                        await socket.sendMessage(targetChat, { text: `📊 Status View-Only: ${isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    } else {
                        isViewOnly = !isViewOnly;
                        if (isViewOnly) isActivelyLiking = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ${isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    }
                } else if (cmd === 'josistatusuni') {
                    const arg = textLower.split(/\s+/)[1];
                    if (!arg) {
                        await socket.sendMessage(targetChat, { text: `${currentPrefix}josistatusuni <emoji> ou random` }, { quoted: msg });
                    } else if (arg === 'random') {
                        fixedEmoji = null;
                        await socket.sendMessage(targetChat, { text: `✅ Mode Aléatoire 🎲` }, { quoted: msg });
                    } else {
                        fixedEmoji = textContent.split(/\s+/)[1];
                        isActivelyLiking = true; isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `✅ Emoji fixé : ${fixedEmoji}` }, { quoted: msg });
                    }
                } else if (cmd === 'josiconnect') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        config.sendWelcomeMessage = true;
                        await socket.sendMessage(targetChat, { text: `✅ Message de connexion activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.sendWelcomeMessage = false;
                        await socket.sendMessage(targetChat, { text: `❌ Message de connexion désactivé.` }, { quoted: msg });
                    }
                } else if (cmd === 'setprefix') {
                    const newPrefix = textArgs.split(/\s+/)[0];
                    if (newPrefix) {
                        config.prefix = newPrefix;
                        const fs = require('fs');
                        let configStr = fs.readFileSync('./config.js', 'utf8');
                        configStr = configStr.replace(/prefix:\s*['"][^'"]*['"]/, `prefix: "${newPrefix}"`);
                        fs.writeFileSync('./config.js', configStr);
                        await socket.sendMessage(targetChat, { text: `✅ Préfixe changé pour '${newPrefix}'.` }, { quoted: msg });
                    } else {
                        await socket.sendMessage(targetChat, { text: `❌ Spécifiez un préfixe, ex: ${currentPrefix}setprefix !` }, { quoted: msg });
                    }
                } else if (cmd === 'tagall') {
                    await tagAll.executeTagAll(socket, msg);
                } else if (cmd === 'ss') {
                    await screenshot.executeScreenshot(socket, msg);
                } else if (cmd === 'fb' || cmd === 'facebook' || cmd === 'fbdl') {
                    await facebook.executeFacebook(socket, msg);
                } else if (cmd === 'yt' || cmd === 'youtube' || cmd === 'ytv') {
                    await youtube.executeYouTube(socket, msg);
                } else if (cmd === 'host') {
                    await hostCmd.executeHost(socket, msg, config);
                } else if (cmd === 'ping') {
                    await pingCmd.executePing(socket, msg);
                } else if (cmd === 'antidelete') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        config.antiDeleteEnabled = true;
                        await socket.sendMessage(targetChat, { text: `✅ Anti-Delete activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.antiDeleteEnabled = false;
                        await socket.sendMessage(targetChat, { text: `❌ Anti-Delete désactivé.` }, { quoted: msg });
                    } else if (arg === 'status') {
                        await socket.sendMessage(targetChat, { text: `📊 Status Anti-Delete: ${config.antiDeleteEnabled ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    }
                } else if (cmd === 'menu') {
                    const menuText = `🤖 *JOSIHACK BOT*

⚙️ *CONFIGURATION*
- Préfixe : ${currentPrefix}
- Owner : Josi_Hack
- Version : 1.0

🟢 *STATUS*
- ${currentPrefix}josistatus : on/off
- ${currentPrefix}josiconnect : on/off
- ${currentPrefix}josiview : on/off/status
- ${currentPrefix}josistatusuni : <emoji>/random

👥 *GROUPE*
- ${currentPrefix}tagall : <message>

⬇️ *DOWNLOADER*
- ${currentPrefix}ss : Capture d'écran
- ${currentPrefix}fb : Vidéo Facebook
- ${currentPrefix}yt : Vidéo YouTube

🖥️ *SYSTEM*
- ${currentPrefix}host : Infos Serveur
- ${currentPrefix}ping : Latence Bot

🛡️ *ANTI-DELETE*
- ${currentPrefix}antidelete : on/off/status

👁️ *VIEW ONCE*
- ${currentPrefix}vv : → envoyer ici
- ${currentPrefix}vv2 : → mon inbox
- ${currentPrefix}nice : → admin inbox

*© 2025 JOSIHACK by JOSI*`;
                    await socket.sendMessage(targetChat, { text: menuText }, { quoted: msg });
                }

                // --- DOWNLOADER COMMANDS ---
                const vCommands = ['vv', 'vv2', 'nice'];
                if (vCommands.includes(cmd)) {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;
                    if (!quoted) return await socket.sendMessage(remoteJid, { text: "❌ Répondez à une Vue Unique." }, { quoted: msg });

                    let mediaMsg = quoted;
                    let type = Object.keys(quoted)[0];
                    if (['viewOnceMessageV2', 'viewOnceMessage', 'viewOnceMessageV2Extension'].includes(type)) {
                        mediaMsg = quoted[type].message;
                        type = Object.keys(mediaMsg)[0];
                    }

                    // Reconstruire un faux message compatible Baileys
                    const fakeMsg = {
                        key: {
                            remoteJid: remoteJid,
                            id: contextInfo.stanzaId,
                            participant: contextInfo.participant || null
                        },
                        message: mediaMsg
                    };

                    try {
                        const buffer = await downloadMediaMessage(
                            fakeMsg,
                            'buffer', {},
                            { logger: pino({ level: 'silent' }) }
                        );
                        const ownerJid = (config.owners ? config.owners[0] : "") + '@s.whatsapp.net';
                        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';

                        let targetJid = remoteJid;
                        if (cmd === 'vv2') targetJid = botJid;
                        if (cmd === 'nice') targetJid = ownerJid;

                        if (type === 'imageMessage') await socket.sendMessage(targetJid, { image: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
                        else if (type === 'videoMessage') await socket.sendMessage(targetJid, { video: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
                        else if (type === 'audioMessage') await socket.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                    } catch (e) {
                        console.error("[ERROR] Download failed:", e.message);
                        await socket.sendMessage(remoteJid, { text: "❌ Erreur de téléchargement." }, { quoted: msg });
                    }
                }
            }

            // --- STATUS HANDLING ---
            if (isStatus) {
                if (!isActivelyLiking && !isViewOnly) return;
                const statusId = msg.key.id;
                if (reactedStatusCache.has(statusId)) return;

                reactedStatusCache.add(statusId);
                if (reactedStatusCache.size > CACHE_MAX_SIZE) reactedStatusCache.delete(reactedStatusCache.values().next().value);

                let senderJid = participantJid || msg.key.participant;
                if (msg.key.fromMe) {
                    if (!config.likeMyOwnStatus) return;
                    senderJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                }

                // On vérifie les listes blanche/noire uniquement pour les autres contacts
                if (!senderJid || (!msg.key.fromMe && !isAllowed(senderJid))) return;

                const senderPhoneNumber = senderJid.split('@')[0];
                const emojis = config.reactionEmojis || ["❤️"];
                const reactionEmojiToUse = fixedEmoji ? fixedEmoji : emojis[Math.floor(Math.random() * emojis.length)];

                const delayMs = Math.floor(Math.random() * 4000) + 2000;
                setTimeout(async () => {
                    try {
                        // Pour iPhone et pour la synchronisation des clés (évite "En attente de ce message")
                        // On simule une activité réelle avant de liker
                        await socket.sendPresenceUpdate('available', senderJid);
                        await socket.sendPresenceUpdate('composing', senderJid); 
                        
                        try {
                            // Marquage comme lu complet et forçage pour iPhone/Android
                            await socket.readMessages([msg]);
                            // Envoyer l'accusé de réception 'read' explicitement au flux status@broadcast
                            await socket.sendReceipt('status@broadcast', senderJid, [msg.key.id], 'read');
                        } catch (e) {
                            console.error(`[DEBUG-READ] Erreur lors du marquage comme lu:`, e.message);
                        }

                        await new Promise(r => setTimeout(r, 1000)); // Pause pour synchronisation

                        if (isViewOnly) {
                            console.log(`[VIEW] Statut de +${senderPhoneNumber} marqué comme VU ✅`);
                            await socket.sendPresenceUpdate('paused', senderJid);
                            return;
                        }

                        // MÉTHODE COMPATIBLE IPHONE (iOS)
                        await socket.sendMessage('status@broadcast', { 
                            react: { text: reactionEmojiToUse, key: msg.key } 
                        }, { 
                            statusJidList: [senderJid]
                        });
                        
                        console.log(`[LIKE] +${senderPhoneNumber} avec ${reactionEmojiToUse}`);

                        if (config.autoReplyMessage?.trim()) {
                            await socket.sendMessage(senderJid, { text: config.autoReplyMessage });
                        }
                        
                        await socket.sendPresenceUpdate('paused', senderJid);
                    } catch (err) { console.error(`[ERROR] Status handling +${senderPhoneNumber}:`, err.message); }
                }, delayMs);
            }
        } catch (error) { console.error('[ERROR] Upsert loop:', error.message); }
    });
}

// --- EXPRESS SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`[SERVER] Port ${PORT}`));

connectToWhatsApp().catch(err => console.log("[FATAL]", err));

// --- SHUTDOWN HANDLING ---
process.on('SIGTERM', async () => {
    console.log('[SIGTERM] Closing WebSocket...');
    try { if (activeSocket) activeSocket.ws.close(); } catch (e) { }
    process.exit(0);
});

process.on('SIGINT', async () => {
    try { if (activeSocket) activeSocket.ws.close(); } catch (e) { }
    process.exit(0);
});

// --- KEEP ALIVE ---
const RENDER_URL = "https://josihackbot.onrender.com";
setInterval(async () => {
    try { await fetch(RENDER_URL); } catch (e) { }
}, 5 * 60 * 1000);
