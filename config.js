module.exports = {
    // Command prefix
    prefix: "?",

    // List of owner numbers or IDs (LIDs)
    owners: ["22994403513", "95391760572570"],

    // Array of emojis the bot will randomly choose from to react to statuses
    reactionEmojis: ["🩷", "❤️", "💙", "🖤", "❤️", "🔥", "🤍", "💞", "💕", "💓", "💝", "❤️", "🔥", "🫶", "🙌", "🙂","👀", "🥺", "😎",],

    // Optional auto-reply message sent to the user when a status is reacted to.
    // Set to empty string "" to disable auto-reply.
    autoReplyMessage: "",

    // Set to true to automatically like your own posted statuses
    likeMyOwnStatus: true,

    // If whitelist is not empty, the bot will ONLY react to statuses from these numbers.
    // Format must be: "COUNTRY_CODE_NUMBER@s.whatsapp.net"
    // e.g., ["1234567890@s.whatsapp.net"]
    whitelist: [],

    // If blacklist is not empty, the bot will IGNORE statuses from these numbers.
    // Format must be exactly like whitelist items.
    blacklist: [],

    // Set to true to use Pairing Code instead of QR code for login
    usePairingCode: true,

    // Provide your phone number if using pairing code (e.g., "1234567890")
    // Include the country code but no '+' sign or spaces.
    phoneNumber: "22994403513",
    
    // Supabase credentials for remote auth state storage
    supabaseUrl: "https://qbqkdafuvmrogrxzemgd.supabase.co",
    supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFicWtkYWZ1dm1yb2dyeHplbWdkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NjQ2MTcsImV4cCI6MjA5MjQ0MDYxN30._52KajhYdg5yv17wvp7FPtnheOiqlgN4EFRTAgb7KVw",

    // Anti-Delete settings
    antiDeleteEnabled: false,
    antiDeleteChat: "22994403513@s.whatsapp.net", // Default destination for deleted messages

    // Global settings
    sendWelcomeMessage: true // Whether to send a message to yourself when the bot connects
};
