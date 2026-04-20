const axios = require('axios');
const yts = require('yt-search');

/**
 * Commande YouTube : Télécharge une vidéo depuis YouTube (Audio ou Vidéo HD).
 *
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg  - Le message reçu.
 * @param {string} type - 'audio' ou 'video'.
 */
const executeYouTube = async (sock, msg, type = 'video') => {
    const remoteJid = msg.key.remoteJid;
    const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || "";

    const query = textContent.trim().split(/\s+/).slice(1).join(' ');

    if (!query) {
        const cmdName = type === 'audio' ? 'play' : 'playvid';
        return await sock.sendMessage(
            remoteJid,
            { text: `❌ Veuillez fournir un nom de vidéo ou un lien YouTube.\nExemple : *?${cmdName} Burna Boy Last Last*` },
            { quoted: msg }
        );
    }

    try {
        // Signal de recherche
        try { await sock.sendMessage(remoteJid, { react: { text: "🔍", key: msg.key } }); } catch (e) {}

        // Recherche YouTube
        const searchResult = await yts(query);
        const video = searchResult.videos[0];

        if (!video) {
            throw new Error("Aucun résultat trouvé pour votre recherche.");
        }

        const url = video.url;
        const title = video.title;
        const duration = video.timestamp;
        const views = video.views.toLocaleString();
        const author = video.author.name;

        // Signal de téléchargement
        try { await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } }); } catch (e) {}

        const result = await fetchFromYTDown(url);

        if (!result || !result.medias) {
            throw new Error("Impossible de récupérer les données de la vidéo.");
        }

        if (type === 'audio') {
            const audioUrl = pickBestAudio(result.medias);
            if (!audioUrl) throw new Error("Format audio non trouvé.");

            await sock.sendMessage(
                remoteJid,
                {
                    audio: { url: audioUrl },
                    mimetype: 'audio/mpeg',
                    fileName: `${title}.mp3`
                },
                { quoted: msg }
            );
        } else {
            const videoUrl = pickBestVideo(result.medias);
            if (!videoUrl) throw new Error("Format vidéo HD non trouvé.");

            const caption = formatCaption(title, author, duration, views);

            await sock.sendMessage(
                remoteJid,
                {
                    video: { url: videoUrl },
                    caption: caption,
                    mimetype: 'video/mp4'
                },
                { quoted: msg }
            );
        }

        try { await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } }); } catch (e) {}

    } catch (error) {
        console.error('[YT] Erreur :', error.message);
        try { await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } }); } catch (e) {}
        await sock.sendMessage(
            remoteJid,
            { text: `❌ Échec du traitement.\n\nNote: ${error.message}` },
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
    params.append("token", "");

    try {
        const response = await axios.post(endpoint, params, {
            timeout: 45000,
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
    } catch (e) {
        return null;
    }
}

/**
 * Sélectionne la meilleure URL MP4 (HD de préférence).
 */
function pickBestVideo(medias) {
    const preferred = ['1080p', '720p', '480p', '360p'];

    for (const quality of preferred) {
        const match = medias.find(
            m => m.extension === 'mp4' && m.quality?.includes(quality) && m.url
        );
        if (match?.url) return match.url;
    }

    const anyMp4 = medias.find(m => m.extension === 'mp4' && m.url);
    return anyMp4?.url || null;
}

/**
 * Sélectionne la meilleure URL Audio.
 */
function pickBestAudio(medias) {
    const match = medias.find(m => (m.extension === 'mp3' || m.extension === 'm4a' || m.type === 'audio') && m.url);
    return match?.url || null;
}

/**
 * Formate la légende WhatsApp.
 */
function formatCaption(title, author, duration, views) {
    return (
        `╭───〔 🎬 *YOUTUBE PLAYER* 〕───⬣\n` +
        `│\n` +
        `│ 📌 *Titre* : ${title}\n` +
        `│ 👤 *Chaîne* : ${author}\n` +
        `│ ⏱️ *Durée* : ${duration}\n` +
        `│ 👁️ *Vues* : ${views}\n` +
        `│\n` +
        `│ 📥 _Téléchargé via JosiHack Bot_\n` +
        `╰──────────────⬣`
    );
}

module.exports = { executeYouTube };
