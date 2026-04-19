const axios = require('axios');

/**
 * Commande YouTube : Télécharge une vidéo depuis YouTube.
 * Utilisant l'endpoint de ytdown.to (Wordpress aio-dl)
 *
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg  - Le message reçu.
 */
const executeYouTube = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || "";

    const url = textContent.trim().split(/\s+/).slice(1).join(' ');

    if (!url) {
        return await sock.sendMessage(
            remoteJid,
            { text: "❌ Veuillez fournir un lien YouTube.\nExemple : *?yt https://youtu.be/...*" },
            { quoted: msg }
        );
    }

    const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
    if (!ytRegex.test(url)) {
        return await sock.sendMessage(
            remoteJid,
            { text: "❌ Lien YouTube invalide." },
            { quoted: msg }
        );
    }

    try {
        console.log(`[YT] Traitement via API : ${url}`);
        
        // Signal de traitement
        try { await sock.sendMessage(remoteJid, { react: { text: "🕘", key: msg.key } }); } catch (e) {}

        const result = await fetchFromYTDown(url);

        if (!result || !result.medias) {
            throw new Error("Impossible de récupérer les données de la vidéo.");
        }

        const videoUrl = pickBestVideo(result.medias);
        
        if (!videoUrl) {
            throw new Error("Aucun format MP4 compatible trouvé.");
        }

        await sock.sendMessage(
            remoteJid,
            {
                video: { url: videoUrl },
                caption: formatCaption(result.title),
                mimetype: 'video/mp4'
            },
            { quoted: msg }
        );

        try { await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } }); } catch (e) {}

    } catch (error) {
        console.error('[YT] Erreur :', error.message);
        try { await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } }); } catch (e) {}
        await sock.sendMessage(
            remoteJid,
            { text: `❌ Échec du téléchargement.\n\nNote: ${error.message}` },
            { quoted: msg }
        );
    }
};

/**
 * Appelle l'endpoint interne de ytdown.to.
 */
async function fetchFromYTDown(videoUrl) {
    const endpoint = "https://app.ytdown.to/wp-json/aio-dl/video-data/";

    const params = new URLSearchParams();
    params.append("url", videoUrl);
    params.append("token", ""); // Token CSRF si nécessaire, vide par défaut

    const response = await axios.post(endpoint, params, {
        timeout: 30000,
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Referer": "https://app.ytdown.to/",
            "Origin":  "https://app.ytdown.to"
        }
    });

    const data = response.data;
    if (!data || !Array.isArray(data.medias) || data.medias.length === 0) {
        return null;
    }

    return data;
}

/**
 * Sélectionne la meilleure URL MP4 disponible.
 */
function pickBestVideo(medias) {
    const preferred = ['720p', '480p', '360p'];

    for (const quality of preferred) {
        const match = medias.find(
            m => m.extension === 'mp4' && m.quality?.includes(quality)
        );
        if (match?.url) return match.url;
    }

    const anyMp4 = medias.find(m => m.extension === 'mp4' && m.url);
    return anyMp4?.url || null;
}

/**
 * Formate la légende WhatsApp.
 */
function formatCaption(title = "Vidéo YouTube") {
    return (
        `╭───────◇\n` +
        `│ 🤖 *JOSIHACK YT-DL* 🤖\n` +
        `╰───────◇\n\n` +
        `📌 *Titre:* ${title}\n\n` +
        `> © JosiHack Bot BOY`
    );
}

module.exports = { executeYouTube };
