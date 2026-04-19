const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const config = require('./config.js');
const pino = require('pino');

let messageCache = new Map();
const CACHE_LIMIT = 2000;

/**
 * Fonction interne pour signaler une suppression.
 */
const reportRevocation = async (sock, deletedId) => {
    if (!config.antiDeleteEnabled) {
        console.log(`[ANTIDELETE] Suppression ignorée (ID: ${deletedId}) car l'option est sur OFF.`);
        return;
    }

    const cached = messageCache.get(deletedId);
    if (cached) {
        try {
            const destination = config.antiDeleteChat || (sock.user.id.split(':')[0] + '@s.whatsapp.net');
            const sender = cached.from.split('@')[0];
            const chatName = cached.chat.endsWith('@g.us') ? "Groupe" : "Privé";
            const time = new Date(cached.timestamp * 1000).toLocaleString('fr-FR');

            const infoText = `╭───〔 ❌ *MESSAGE SUPPRIMÉ* 〕───⬣\n` +
                           `│ 👤 *De:* +${sender}\n` +
                           `│ 📍 *Type:* ${chatName}\n` +
                           `│ ⏰ *Heure:* ${time}\n` +
                           `╰──────────────⬣`;

            await sock.sendMessage(destination, { text: infoText });
            
            // Si on a le message complet en cache, on le transfère
            if (cached.fullMessage) {
                await sock.copyNForward(destination, cached.fullMessage, false);
            } else {
                // Sinon on envoie juste le texte qu'on avait capturé
                await sock.sendMessage(destination, { text: `💬 *Contenu:* ${cached.content}` });
            }
            
            console.log(`[ANTIDELETE] Rapport envoyé pour ${deletedId}`);
            messageCache.delete(deletedId);
        } catch (e) {
            console.error("[ANTIDELETE] Send error:", e);
        }
    } else {
        console.log(`[ANTIDELETE] Message ${deletedId} supprimé mais absent du cache.`);
    }
};

/**
 * Stocke les messages entrants dans le cache.
 */
const handleUpsert = async (sock, m) => {
    try {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

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
        const from = msg.key.remoteJid;
        const participant = msg.key.participant || from;
        
        let content = "";
        const type = Object.keys(msg.message)[0];
        
        // On capture le contenu textuel pour le résumé
        if (type === 'conversation') {
            content = msg.message.conversation;
        } else if (type === 'extendedTextMessage') {
            content = msg.message.extendedTextMessage.text;
        } else if (type === 'imageMessage') {
            content = msg.message.imageMessage.caption ? `[Image] ${msg.message.imageMessage.caption}` : "[Image]";
        } else if (type === 'videoMessage') {
            content = msg.message.videoMessage.caption ? `[Vidéo] ${msg.message.videoMessage.caption}` : "[Vidéo]";
        } else if (type === 'audioMessage') {
            content = "[Audio/Vocal]";
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

        // On stocke le message complet pour pouvoir le copier/transférer plus tard
        messageCache.set(id, {
            from: participant,
            chat: from,
            content: content,
            timestamp: msg.messageTimestamp,
            id: id,
            fullMessage: msg // On garde l'objet complet
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
