const { downloadMediaMessage, generateForwardMessageContent, generateWAMessageFromContent } = require('@whiskeysockets/baileys');
const config = require('./config.js');
const pino = require('pino');

let messageCache = new Map();
const CACHE_LIMIT = 5000;

/**
 * Fonction interne pour signaler une suppression.
 */
const reportRevocation = async (sock, deletedId) => {
    if (!config.antiDeleteEnabled) return;

    const cached = messageCache.get(deletedId);
    if (cached) {
        try {
            const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const destination = config.antiDeleteChat || botJid;
            const sender = cached.from.split('@')[0];
            const senderName = cached.pushName || sender;
            const chatName = cached.chat.endsWith('@g.us') ? "Groupe" : (cached.chat === 'status@broadcast' ? "Statut" : "Privé");
            const time = new Date(cached.timestamp * 1000).toLocaleString('fr-FR');

            const infoText = `━━━━❪ ❌ *MESSAGE SUPPRIMÉ* ❫━━━━\n` +
                           `📸 *Type:* ${chatName} supprimé\n` +
                           `👤 *Auteur:* ${senderName} (+${sender})\n` +
                           `📍 *Source:* ${chatName === 'Statut' ? 'Statut de ' + senderName : chatName} (+${sender})\n` +
                           `⏰ *Heure:* ${time}\n` +
                           `━━━━━━━━━━━━━━━━━━━━`; // Contenu sera la légende

            // Si on a un média en buffer, on l'envoie avec la légende
            if (cached.mediaBuffer && cached.mediaType) {
                const messageOptions = { caption: infoText };
                if (cached.mediaType.startsWith('image')) {
                    messageOptions.image = cached.mediaBuffer;
                } else if (cached.mediaType.startsWith('video')) {
                    messageOptions.video = cached.mediaBuffer;
                } else if (cached.mediaType.startsWith('audio')) {
                    messageOptions.audio = cached.mediaBuffer;
                    messageOptions.mimetype = 'audio/mpeg';
                    messageOptions.ptt = true; // Pour les vocaux
                } else {
                    // Fallback pour d'autres types de médias si nécessaire
                    await sock.sendMessage(destination, { text: infoText + `\n💬 *Contenu:* ${cached.content}` });
                    return;
                }
                await sock.sendMessage(destination, messageOptions);
            } else {
                // Sinon, on envoie juste le texte d'info avec le contenu textuel
                await sock.sendMessage(destination, { text: infoText + `\n💬 *Contenu:* ${cached.content}` });
            }
            
            console.log(`[ANTIDELETE] Rapport envoyé pour ${deletedId}`);
            // On ne supprime pas du cache immédiatement pour gérer les doublons d'events
        } catch (e) {
            console.error("[ANTIDELETE] Send error:", e);
        }
    }
};

/**
 * Stocke les messages entrants dans le cache.
 */
const handleUpsert = async (sock, m) => {
    try {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        const from = msg.key.remoteJid;

        // Ignorer les statuts
        if (from === 'status@broadcast') return;

        // Détection de suppression directe (ProtocolMessage)
        const protocolMsg = msg.message.protocolMessage;
        if (protocolMsg) {
            if (protocolMsg.type === 3 || protocolMsg.type === 0) {
                const deletedId = protocolMsg.key.id;
                console.log(`[ANTIDELETE] Suppression détectée: ${deletedId}`);
                await reportRevocation(sock, deletedId);
                return;
            }
        }

        const id = msg.key.id;
        const participant = msg.key.participant || from;
        
        let content = "";
        let mediaBuffer = null;
        let mediaType = null;

        const type = Object.keys(msg.message)[0];
        
        if (type === 'conversation') {
            content = msg.message.conversation;
        } else if (type === 'extendedTextMessage') {
            content = msg.message.extendedTextMessage.text;
        } else if (type === 'imageMessage') {
            content = msg.message.imageMessage.caption ? `[Image] ${msg.message.imageMessage.caption}` : "[Image]";
            // Ne télécharger le média que si anti-delete est activé
            if (config.antiDeleteEnabled) {
                mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                mediaType = 'image';
            }
        } else if (type === 'videoMessage') {
            content = msg.message.videoMessage.caption ? `[Vidéo] ${msg.message.videoMessage.caption}` : "[Vidéo]";
            if (config.antiDeleteEnabled) {
                mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                mediaType = 'video';
            }
        } else if (type === 'audioMessage') {
            content = "[Audio/Vocal]";
            if (config.antiDeleteEnabled) {
                mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                mediaType = 'audio';
            }
        } else if (type === 'stickerMessage') {
            content = "[Sticker]";
        } else if (type === 'documentMessage') {
            content = `[Document] ${msg.message.documentMessage.fileName || ""}`;
        } else if (type === 'viewOnceMessage' || type === 'viewOnceMessageV2') {
            const innerType = Object.keys(msg.message[type].message)[0];
            content = `[Vue Unique - ${innerType}]`;
        } else {
            content = `[${type}]`;
        }

        messageCache.set(id, {
            from: participant,
            pushName: msg.pushName || "",
            chat: from,
            content,
            timestamp: msg.messageTimestamp,
            id,
            fullMessage: msg,
            mediaBuffer,
            mediaType
        });

        if (messageCache.size > CACHE_LIMIT) {
            const oldestKey = messageCache.keys().next().value;
            messageCache.delete(oldestKey);
        }
    } catch (e) {
        console.error("[ANTIDELETE] Cache error:", e);
    }
};

/**
 * Détecte les messages supprimés dans l'event update.
 */
const handleUpdate = async (sock, updates) => {
    for (const update of updates) {
        const protocolMsg = update.update?.message?.protocolMessage || update.message?.protocolMessage;
        const isRevoke = (protocolMsg && (protocolMsg.type === 3 || protocolMsg.type === 0)) || 
                         update.update?.messageStubType === 68 || 
                         update.update?.messageStubType === 69;

        if (isRevoke) {
            const deletedId = protocolMsg ? protocolMsg.key.id : update.key.id;
            await reportRevocation(sock, deletedId);
        }
    }
};

module.exports = {
    handleUpsert,
    handleUpdate
};
