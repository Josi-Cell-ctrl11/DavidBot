const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const config = require('./config.js');
const useSupabaseAuthState = require('./supabaseAuth');

// --- UTILS & LOGS ---
const originalLog = console.log;
const originalError = console.error;
const noiseWords = [
    'Session error', 'Bad MAC', 'Closing session', 'prekey bundle', 'Failed to decrypt',
    'Decrypted message with closed session', 'Closing open session', 'Removing old closed session',
    '_chains', 'registrationId', 'currentRatchet', 'indexInfo', 'ephemeralKeyPair',
    'lastRemoteEphemeralKey', 'previousCounter', 'rootKey', 'baseKey', 'remoteIdentityKey'
];

function isNoise(args) {
    try {
        const str = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        return noiseWords.some(w => str.includes(w));
    } catch(e) { return false; }
}
console.log = (...args) => { if(!isNoise(args)) originalLog.apply(console, args); };
console.error = (...args) => { if(!isNoise(args)) originalError.apply(console, args); };

// --- GLOBAL STATE ---
const state = {
    isActivelyLiking: true,
    isViewOnly: false,
    isAntiDeleteActive: true,
    fixedEmoji: null,
    botStartTime: Math.floor(Date.now() / 1000),
    reconnectAttempts: 0,
    prefix: config.prefix || '?',
    activeSocket: null,
    statusCache: new Set(),
    messageCache: new NodeCache({ stdTTL: 3600, checkperiod: 600 }), // Cache de 1h pour l'anti-delete
    CACHE_MAX_SIZE: 1000,
    stats: {
        totalLikes: 0,
        totalDeletes: 0,
        totalViewOnce: 0,
        startTime: Date.now()
    }
};

const msgRetryCounterCache = new NodeCache();

// --- HELPERS ---
function isAllowed(jid) {
    if (config.blacklist?.includes(jid)) return false;
    if (config.whitelist?.length > 0) return config.whitelist.includes(jid);
    return true;
}

const getJid = (socket) => socket.user.id.split(':')[0] + '@s.whatsapp.net';

// --- HANDLERS ---

async function handleViewOnce(socket, msg) {
    try {
        const viewOnceKey = Object.keys(msg.message || {}).find(k => k.toLowerCase().includes('viewonce'));
        let isViewOnce = !!viewOnceKey;
        let messageTypeStr = "Media";

        if (viewOnceKey) {
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

        if (!isViewOnce) return;

        const participantJid = msg.key.participant || msg.key.remoteJid;
        const senderPhoneNumber = participantJid.split('@')[0];
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { 
            logger: pino({ level: 'silent' }), 
            reuploadRequest: socket.updateMediaMessage 
        });

        const caption = `👁️ *VUE UNIQUE DÉTECTÉE*\n👤 +${senderPhoneNumber}`;
        const ownerJid = getJid(socket);

        if (messageTypeStr.includes('image')) await socket.sendMessage(ownerJid, { image: buffer, caption });
        else if (messageTypeStr.includes('video')) await socket.sendMessage(ownerJid, { video: buffer, caption });
        else if (messageTypeStr.includes('audio')) await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
        
        state.stats.totalViewOnce++;
    } catch (e) {
        console.error("[ERROR] Anti-View-Once failed:", e.message);
    }
}

async function handleCommands(socket, msg) {
    const remoteJid = msg.key.remoteJid;
    const participantJid = msg.key.participant || remoteJid;
    const isOwner = msg.key.fromMe || (config.ownerNumber && participantJid.startsWith(config.ownerNumber));
    
    if (!isOwner) return;

    const textContent = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const textLower = textContent.trim().toLowerCase();
    const prefix = state.prefix;

    if (!textLower.startsWith(prefix)) return;
    
    const cmd = textLower.slice(prefix.length).split(/\s+/)[0];
    const args = textLower.slice(prefix.length).split(/\s+/).slice(1);
    const targetChat = (remoteJid === 'status@broadcast' || msg.key.fromMe) ? getJid(socket) : remoteJid;

    if (cmd === 'josistatus') {
        const arg = args[0];
        if (arg === 'on') { state.isActivelyLiking = true; state.isViewOnly = false; }
        else if (arg === 'off') state.isActivelyLiking = false;
        await socket.sendMessage(targetChat, { text: `[SYSTEM] Likes Auto : ${state.isActivelyLiking ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
    } 
    else if (cmd === 'josiview') {
        const arg = args[0];
        if (arg === 'on') { state.isViewOnly = true; state.isActivelyLiking = false; }
        else if (arg === 'off') state.isViewOnly = false;
        else state.isViewOnly = !state.isViewOnly;
        if (state.isViewOnly) state.isActivelyLiking = false;
        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ${state.isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
    } 
    else if (cmd === 'antidelete') {
        const arg = args[0];
        if (arg === 'on') state.isAntiDeleteActive = true;
        else if (arg === 'off') state.isAntiDeleteActive = false;
        else state.isAntiDeleteActive = !state.isAntiDeleteActive;
        await socket.sendMessage(targetChat, { text: `[SYSTEM] Anti-Delete : ${state.isAntiDeleteActive ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
    }
    else if (cmd === 'josistatusuni') {
        const arg = args[0];
        if (!arg) {
            await socket.sendMessage(targetChat, { text: `${prefix}josistatusuni <emoji> ou random` }, { quoted: msg });
        } else if (arg === 'random') {
            state.fixedEmoji = null;
            await socket.sendMessage(targetChat, { text: `✅ Mode Aléatoire 🎲` }, { quoted: msg });
        } else {
            state.fixedEmoji = args[0];
            state.isActivelyLiking = true; state.isViewOnly = false;
            await socket.sendMessage(targetChat, { text: `✅ Emoji fixé : ${state.fixedEmoji}` }, { quoted: msg });
        }
    } 
    else if (cmd === 'setprefix') {
        const newPrefix = args[0];
        if (!newPrefix) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un nouveau préfixe.` }, { quoted: msg });
        state.prefix = newPrefix;
        await socket.sendMessage(targetChat, { text: `✅ Préfixe mis à jour : *${newPrefix}*` }, { quoted: msg });
    }
    else if (cmd === 'menu') {
        const menuText = `╭───〔 🤖 *JOSIHACK BOT* 〕───⬣\n` +
                         `│\n` +
                         `│ 📢 *GÉRER LES STATUS*\n` +
                         `│ ߷ ${prefix}josistatus on/off\n` +
                         `│ ߷ ${prefix}josiview on/off\n` +
                         `│ ߷ ${prefix}josistatusuni <emoji>/random\n` +
                         `│\n` +
                         `│ 🛡️ *SÉCURITÉ*\n` +
                         `│ ߷ ${prefix}antidelete on/off\n` +
                         `│\n` +
                         `│ 👁️ *VUE UNIQUE (ANTI-VV)*\n` +
                         `│ ߷ ${prefix}vv (reply) ➜ chat actuel\n` +
                         `│ ߷ ${prefix}vv2 (reply) ➜ mon inbox\n` +
                         `│ ߷ ${prefix}ok (reply) ➜ admin inbox\n` +
                         `│\n` +
                         `│ 📊 *SYSTÈME*\n` +
                         `│ ߷ ${prefix}stats ➜ voir les compteurs\n` +
                         `│ ߷ ${prefix}host ➜ infos hébergement\n` +
                         `│ ߷ ${prefix}setprefix <prefix> ➜ changer le prefix\n` +
                         `│\n` +
                         `╰──────────────⬣`;
        await socket.sendMessage(targetChat, { text: menuText }, { quoted: msg });
    }
    else if (cmd === 'stats') {
        const uptime = Date.now() - state.stats.startTime;
        const hours = Math.floor(uptime / (1000 * 60 * 60));
        const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
        
        const statsText = `╭───〔 📊 *STATISTIQUES* 〕───⬣\n` +
                          `│\n` +
                          `│ ⏱️ *Uptime* : ${hours}h ${minutes}m\n` +
                          `│ ❤️ *Likes*  : ${state.stats.totalLikes}\n` +
                          `│ 🗑️ *Suppr.* : ${state.stats.totalDeletes}\n` +
                          `│ 👁️ *VV Cap.* : ${state.stats.totalViewOnce}\n` +
                          `│\n` +
                          `╰──────────────⬣`;
        await socket.sendMessage(targetChat, { text: statsText }, { quoted: msg });
    }
    else if (cmd === 'host') {
        const os = require('os');
        const platform = os.platform();
        const arch = os.arch();
        const cpuCount = os.cpus().length;
        const freeMem = Math.round(os.freemem() / (1024 * 1024));
        const totalMem = Math.round(os.totalmem() / (1024 * 1024));

        const hostText = `╭───〔 🖥️ *HÉBERGEMENT* 〕───⬣\n` +
                         `│\n` +
                         `│ 📂 *OS*      : ${platform} (${arch})\n` +
                         `│ ⚙️ *CPUs*    : ${cpuCount} cœurs\n` +
                         `│ 🧠 *RAM*     : ${totalMem - freeMem}/${totalMem} MB\n` +
                         `│ 🌐 *Server*  : Express (Port ${process.env.PORT || 3000})\n` +
                         `│ 🚀 *URL*     : https://josihackbot.onrender.com\n` +
                         `│\n` +
                         `╰──────────────⬣`;
        await socket.sendMessage(targetChat, { text: hostText }, { quoted: msg });
    }
    
    // Downloaders
    const vCommands = ['vv', 'vv2', 'ok'];
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

        const fakeMsg = {
            key: { remoteJid, id: contextInfo.stanzaId, participant: contextInfo.participant || null },
            message: mediaMsg
        };

        try {
            const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            let targetJid = remoteJid;
            if (textLower === '?vv2') targetJid = getJid(socket);
            if (textLower === '?ok') targetJid = config.ownerNumber + '@s.whatsapp.net';

            if (type === 'imageMessage') await socket.sendMessage(targetJid, { image: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
            else if (type === 'videoMessage') await socket.sendMessage(targetJid, { video: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
            else if (type === 'audioMessage') await socket.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
        } catch (e) {
            await socket.sendMessage(remoteJid, { text: "❌ Erreur de téléchargement." }, { quoted: msg });
        }
    }
}

async function handleStatus(socket, msg) {
    if (!state.isActivelyLiking && !state.isViewOnly) return;
    
    const statusId = msg.key.id;
    if (state.statusCache.has(statusId)) return;
    
    state.statusCache.add(statusId);
    if (state.statusCache.size > state.CACHE_MAX_SIZE) {
        state.statusCache.delete(state.statusCache.values().next().value);
    }

    let senderJid = msg.key.participant || msg.key.remoteJid;
    if (msg.key.fromMe) {
        if (!config.likeMyOwnStatus) return;
        senderJid = getJid(socket);
    }
    
    if (!senderJid || (!msg.key.fromMe && !isAllowed(senderJid))) return;

    const delayMs = Math.floor(Math.random() * 4000) + 2000;
    setTimeout(async () => {
        try {
            // Marquage comme lu systématique
            try { 
                await socket.readMessages([msg.key]); 
                // Pour iPhone et certaines versions récentes, envoyer aussi un accusé de réception 'read' explicite
                await socket.sendReceipt(msg.key.remoteJid, msg.key.participant, [msg.key.id], 'read');
            } catch(e) {
                try {
                    // Méthode alternative via flux status@broadcast
                    await socket.sendReceipt('status@broadcast', msg.key.participant, [msg.key.id], 'read');
                } catch(e2) {}
            }

            // Si on est en mode View-Only, on s'arrête ici après avoir marqué comme lu
            if (state.isViewOnly) {
                console.log(`[VIEW] Statut de +${senderJid.split('@')[0]} vu`);
                return;
            }

            // Sinon on procède au Like
            if (!state.isActivelyLiking) return;
            
            const reactionEmoji = state.fixedEmoji || config.reactionEmojis[Math.floor(Math.random() * config.reactionEmojis.length)];
            
            await socket.sendMessage(msg.key.remoteJid, { 
                react: { 
                    text: reactionEmoji, 
                    key: msg.key 
                } 
            });
            
            if (config.autoReplyMessage?.trim()) {
                await socket.sendMessage(senderJid, { text: config.autoReplyMessage });
            }
            state.stats.totalLikes++;
            console.log(`[LIKE] +${senderJid.split('@')[0]} avec ${reactionEmoji}`);
        } catch (err) {
            console.error(`[ERROR] Status handling +${senderJid.split('@')[0]}:`, err.message);
        }
    }, delayMs);
}

// --- MAIN ---

async function connectToWhatsApp() {
    const supabase = createClient(config.supabaseUrl, config.supabaseKey);
    const { state: authState, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_auth');
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: !config.usePairingCode,
        auth: {
            creds: authState.creds,
            keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' }))
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 120_000
    });

    state.activeSocket = socket;

    // Pairing code
    if (config.usePairingCode && !authState.creds.me) {
        setTimeout(async () => {
            try {
                const code = await socket.requestPairingCode(config.phoneNumber);
                console.log(`\n[ACTION REQUIRED] Your Pairing Code: ${code}\n`);
            } catch (err) { console.error('[ERROR] Pairing code failed:', err); }
        }, 3000);
    }

    socket.ev.on('creds.update', saveCreds);

    // --- ANTI-DELETE LOGIC ---
    socket.ev.on('messages.update', async (updates) => {
        if (!state.isAntiDeleteActive) return;
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) { // type 0 = REVOKE (suppression)
                const deletedMsgId = update.update.protocolMessage.key.id;
                const cachedMsg = state.messageCache.get(deletedMsgId);

                if (cachedMsg) {
                    const remoteJid = cachedMsg.key.remoteJid;
                    const participant = cachedMsg.key.participant || remoteJid;
                    const senderName = cachedMsg.pushName || "Inconnu";
                    const ownerJid = getJid(socket);

                    const infoText = `🗑️ *MESSAGE SUPPRIMÉ DÉTECTÉ*\n👤 *De:* ${senderName} (+${participant.split('@')[0]})\n📍 *Chat:* ${remoteJid.endsWith('@g.us') ? 'Groupe' : 'Privé'}`;
                    
                    try {
                        await socket.sendMessage(ownerJid, { text: infoText });
                        // Transférer le message original (le contenu supprimé)
                        await socket.copyNForward(ownerJid, cachedMsg, false);
                        state.stats.totalDeletes++;
                    } catch (e) {
                        console.error("[ERROR] Anti-Delete forward failed:", e.message);
                    }
                }
            }
        }
    });

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                state.reconnectAttempts++;
                const backoff = Math.min(10000 * Math.pow(1.5, state.reconnectAttempts - 1), 120000);
                setTimeout(() => connectToWhatsApp(), backoff);
            }
        } else if (connection === 'open') {
            state.reconnectAttempts = 0;
            const welcomeMsg = `╭───〔 🤖 *JOSIHACK BOT* 〕───⬣\n│ Etat : Connecté ✅\n╰──────────────⬣`;
            console.log(welcomeMsg);
            try { await socket.sendMessage(getJid(socket), { text: welcomeMsg }); } catch(e) {}

            // --- DAILY REPORT JOB ---
            // On lance un rapport toutes les 24 heures
            setInterval(async () => {
                const uptime = Date.now() - state.stats.startTime;
                const hours = Math.floor(uptime / (1000 * 60 * 60));
                
                const reportText = `📅 *RAPPORT JOURNALIER JOSIHACK*\n\n` +
                                   `L'activité de ces dernières 24h :\n\n` +
                                   `❤️ *Likes Status:* ${state.stats.totalLikes}\n` +
                                   `🗑️ *Messages Supprimés:* ${state.stats.totalDeletes}\n` +
                                   `👁️ *Vues Uniques Capturées:* ${state.stats.totalViewOnce}\n\n` +
                                   `⏱️ *Temps total de service:* ${hours} heures`;
                
                try {
                    await socket.sendMessage(getJid(socket), { text: reportText });
                } catch (e) {
                    console.error("[ERROR] Daily report failed:", e.message);
                }
            }, 24 * 60 * 60 * 1000);
        }
    });

    socket.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;
        if (msg.messageTimestamp < state.botStartTime) return;

        const remoteJid = msg.key.remoteJid;
        
        // Mise en cache pour l'anti-delete (sauf si c'est un message système ou de statut)
        if (remoteJid !== 'status@broadcast' && !msg.message.protocolMessage) {
            state.messageCache.set(msg.key.id, msg);
        }
        
        // Anti-View-Once
        await handleViewOnce(socket, msg);

        // Commands
        await handleCommands(socket, msg);

        // Status
        if (remoteJid === 'status@broadcast') {
            await handleStatus(socket, msg);
        }
    });
}

// --- SERVER ---
const app = express();
app.get('/', (req, res) => res.status(200).send('OK'));
app.listen(process.env.PORT || 3000, '0.0.0.0');

connectToWhatsApp().catch(err => console.error("[FATAL]", err));

// --- CLEAN EXIT ---
const shutdown = () => {
    if (state.activeSocket) state.activeSocket.ws.close();
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep alive
setInterval(() => {
    fetch("https://josihackbot.onrender.com").catch(() => {});
}, 5 * 60 * 1000);
