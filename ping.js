/**
 * Commande Ping : Calcule la latence du bot.
 * 
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg - Le message reçu.
 */
const executePing = async (sock, msg) => {
    const start = Date.now();
    
    // On envoie un message temporaire
    const { key } = await sock.sendMessage(msg.key.remoteJid, { text: "Pinging..." }, { quoted: msg });
    
    const end = Date.now();
    const latency = end - start;

    // Mise à jour du message avec la latence
    await sock.sendMessage(msg.key.remoteJid, { 
        text: `🏓 *Pong !*\n\n📡 Latence : *${latency}ms*`,
        edit: key 
    });
};

module.exports = { executePing };
