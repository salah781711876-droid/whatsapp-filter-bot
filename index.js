/**
 * WhatsApp Filter Bot - VIP Edition V2 (Plug & Play)
 * 100% English Edition - Fixed Pairing Code & Session Issues
 * + Real-time reporting for numbers without WA (1-tap copy)
 * + Max Speed Restored (Batch 25 / 150ms)
 * + Anti-Crash & Anti-Hang System
 * + Anti-Duplicate Messages System
 */

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const TelegramBot = require('node-telegram-bot-api');
const pino = require('pino');
const express = require('express');
const fs = require('fs').promises;
const axios = require('axios');

// --- Bot Settings ---
const token = '8263135329:AAEgqXeB9CXI2kMPOWOCRWtnq8qwzxhyXEE'; 

// --- Express Server to keep the bot alive ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('WhatsApp Filter Bot is Running 🟢 (VIP Edition)'));
app.listen(port, () => console.log(`🌐 [SERVER] Server is now running on port: ${port}`));

const bot = new TelegramBot(token, { polling: true });

// ==========================================
// 🛡️ ANTI-CRASH SYSTEM
// ==========================================
bot.on('polling_error', (error) => {
    console.log(`⚠️ [Polling Warning]: ${error.code} - Bot is still running...`);
});
bot.on('error', (error) => {
    console.log(`⚠️ [Bot Error]: ${error.message}`);
});
process.on('unhandledRejection', (reason, promise) => {
    console.log('⚠️ [Unhandled Rejection]:', reason);
});
process.on('uncaughtException', (error) => {
    console.log('⚠️ [Uncaught Exception]:', error.message);
});

// ==========================================
// 🛡️ ANTI-DUPLICATE SYSTEM (يمنع تكرار الرسائل)
// ==========================================
const processedUpdates = new Set();
function isDuplicate(id) {
    if (processedUpdates.has(id)) return true;
    processedUpdates.add(id);
    if (processedUpdates.size > 1000) {
        const arr = Array.from(processedUpdates);
        processedUpdates.clear();
        arr.slice(500).forEach(val => processedUpdates.add(val));
    }
    return false;
}
// ==========================================

const sessionFolder = 'auth_session_bot';
let sock;

// --- User State Management ---
const userStates = new Map();

function getUserState(chatId) {
    if (!userStates.has(chatId)) {
        userStates.set(chatId, {
            queue: [],
            isProcessing: false,
            stopSignal: false,
            waitingForPair: false,
            notOnWa: []
        });
    }
    return userStates.get(chatId);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Initialize WhatsApp Connection ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Hide logs
        browser: Browsers.ubuntu('Chrome'), // Valid browser to bypass WhatsApp blocks
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log("✅ [WHATSAPP] Connected and ready to scan!");
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            
            if (reason === DisconnectReason.loggedOut) {
                console.log("🚪 [WHATSAPP] Logged out. Wiping session and restarting...");
                await fs.rm(sessionFolder, { recursive: true, force: true }).catch(() => {});
                startBot(); 
            } else {
                console.log(`♻️ [WHATSAPP] Reconnecting... (Reason Code: ${reason})`);
                setTimeout(startBot, 2000);
            }
        }
    });
}

// --- Logout Function ---
async function handleLogout(chatId) {
    if (sock?.ws?.isOpen && sock?.user) {
        bot.sendMessage(chatId, "⏳ *Logging out and unlinking number...*", { parse_mode: 'Markdown' });
        try {
            await Promise.race([
                sock.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
            ]);
            bot.sendMessage(chatId, "✅ *Successfully unlinked.*\nYou can link a new number now via /pair", { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, `❌ *Error during logout:*\n${err.message}`, { parse_mode: 'Markdown' });
        }
    } else {
        bot.sendMessage(chatId, "⚠️ *No active connection, but forcing session cleanup...*", { parse_mode: 'Markdown' });
        await fs.rm(sessionFolder, { recursive: true, force: true }).catch(() => {});
        startBot();
        bot.sendMessage(chatId, "✅ *Session wiped. You can now link a new number via /pair*", { parse_mode: 'Markdown' });
    }
}

// --- Fast Scan System ---
async function processQueue(chatId) {
    const state = getUserState(chatId);
    if (state.isProcessing) return;
    
    if (!sock?.ws?.isOpen) {
        bot.sendMessage(chatId, "❌ *Bot is not connected to WhatsApp.*\nLink a number first using the (🔗 Link WhatsApp) button.", { parse_mode: 'Markdown' });
        return;
    }

    state.isProcessing = true;
    state.stopSignal = false;
    state.notOnWa = [];
    
    let current = 0;
    let lastUpdateTime = Date.now();
    
    let statusMsg;
    try {
        statusMsg = await bot.sendMessage(chatId, `⏳ *Starting quick scan...* 🚀`, { parse_mode: 'Markdown' });
    } catch (e) {
        state.isProcessing = false;
        return;
    }

    // إرجاع السرعة القصوى (25 رقم في الدفعة)
    const BATCH_SIZE = 25; 

    while (state.queue.length > 0 && !state.stopSignal) {
        if (!sock?.ws?.isOpen) {
            await sleep(3000); // الانتظار إذا انقطع الاتصال فجأة
            continue; 
        }

        let total = current + state.queue.length;
        const batch = state.queue.splice(0, BATCH_SIZE);
        
        const promises = batch.map(async (number) => {
            const cleanNumber = number.replace(/[^0-9]/g, '');
            if (cleanNumber.length > 5) {
                try {
                    // مهلة 5 ثوانٍ فقط لمنع تعليق الكود بالكامل إذا لم يرد سيرفر واتساب
                    const result = await Promise.race([
                        sock.onWhatsApp(cleanNumber),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
                    ]);
                    
                    const waData = result?.[0];
                    if (!waData || !waData.exists) {
                        state.notOnWa.push(`+${cleanNumber}`);
                        bot.sendMessage(chatId, `❌ ليس على واتساب (اضغط للنسخ):\n\`+${cleanNumber}\``, { parse_mode: 'Markdown' }).catch(() => {});
                    }
                } catch (e) { 
                    // تجاهل الأخطاء بصمت للحفاظ على السرعة القصوى
                }
            }
        });

        await Promise.all(promises);
        current += batch.length;
        
        if (Date.now() - lastUpdateTime > 2000 || state.queue.length === 0) {
            const percent = Math.min(100, Math.floor((current / total) * 100));
            const progress = "🟩".repeat(Math.floor(percent / 10)) + "⬜".repeat(10 - Math.floor(percent / 10));
            
            await bot.editMessageText(
                `⚡ *Scan in progress...*\n\n📊 *Progress:* \n${progress} *${percent}%*\n\n✅ *Scanned:* ${current} of ${total}\n❌ *Numbers without WhatsApp:* ${state.notOnWa.length}`,
                { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
            ).catch(() => {});
            
            lastUpdateTime = Date.now();
        }
        
        // إرجاع التأخير السريع جداً كما كان (150 جزء من الثانية)
        await sleep(150); 
    }

    state.isProcessing = false;
    let finalTotal = current;

    if (state.stopSignal) {
        state.queue = []; 
        bot.sendMessage(chatId, "🛑 *Scan stopped manually.*", { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, "🏁 *Scan completed!* 🎉", { parse_mode: 'Markdown' });
    }

    if (state.notOnWa.length > 0) {
        const fileName = `results_${chatId}.txt`;
        await fs.writeFile(fileName, "Numbers without WhatsApp accounts:\n\n" + state.notOnWa.join('\n'));
        await bot.sendDocument(chatId, fileName, { 
            caption: `📈 *Total scanned:* ${finalTotal}\n❌ *Numbers without WhatsApp:* ${state.notOnWa.length}\n\nThe attached file contains all numbers without WhatsApp.`, 
            parse_mode: 'Markdown' 
        });
        await fs.unlink(fileName).catch(() => {});
    } else if (!state.stopSignal) {
        bot.sendMessage(chatId, "All sent numbers have active WhatsApp accounts.", { parse_mode: 'Markdown' });
    }
}

// --- Commands and Messages Handling ---
bot.setMyCommands([
    { command: 'start', description: '🏠 Main Menu' },
    { command: 'pair', description: '🔗 Link WhatsApp number' },
    { command: 'status', description: '📊 Connection Status' },
    { command: 'logout', description: '🚪 Logout' },
    { command: 'cancel', description: '🛑 Stop Scan' },
    { command: 'reset', description: '🔄 Reset Bot Session (Fix Bugs)' }
]);

bot.on('message', async (msg) => {
    // 🛑 تطبيق نظام منع التكرار 🛑
    if (isDuplicate(msg.message_id)) return;

    const chatId = msg.chat.id;
    const text = msg.text || msg.caption || '';
    const state = getUserState(chatId);

    // Commands Handling
    if (text === '/reset') {
        bot.sendMessage(chatId, "🔄 *Resetting session and clearing cache...*", { parse_mode: 'Markdown' });
        await fs.rm(sessionFolder, { recursive: true, force: true }).catch(() => {});
        startBot();
        bot.sendMessage(chatId, "✅ *System completely reset. Send /pair to link your number again.*", { parse_mode: 'Markdown' });
        return;
    }

    if (text === '/start') {
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "▶️ Start Scan", callback_data: 'start_scan' }],
                    [{ text: "🔗 Link WhatsApp", callback_data: 'pair_wa' }, { text: "🚪 Logout", callback_data: 'logout_wa' }],
                    [{ text: "📊 Connection Status", callback_data: 'status_wa' }, { text: "🛑 Stop Scan", callback_data: 'cancel_scan' }]
                ]
            }
        };
        bot.sendMessage(chatId, "👑 *Welcome to Auto Filter Bot (VIP)* 👑\n\nPlease select an action from the menu below:", { parse_mode: 'Markdown', ...opts });
        return;
    }

    if (text === '/pair') {
        if (sock?.ws?.isOpen && sock?.user) {
            bot.sendMessage(chatId, "⚠️ *You are already connected to a WhatsApp number.*\nUse /logout first if you want to change the number.", { parse_mode: 'Markdown' });
            return;
        }
        state.waitingForPair = true;
        bot.sendMessage(chatId, "📲 *Send the WhatsApp number now in international format*\n*(Example: 967712345678 or 201012345678)*\n\n⚠️ _Without + or leading zeros_", { parse_mode: 'Markdown' });
        return;
    }

    if (text === '/cancel') {
        state.stopSignal = true;
        bot.sendMessage(chatId, "🛑 *Stopping scan...*", { parse_mode: 'Markdown' });
        return;
    }
    
    if (text === '/status') {
        const status = sock?.ws?.isOpen ? `✅ *Status:* Connected\n📱 *Number:* +${sock.user?.id.split(':')[0]}` : "❌ *Status:* Disconnected";
        bot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
        return;
    }

    if (text === '/logout') {
        await handleLogout(chatId);
        return;
    }

    // Receiving Number for Pairing Code
    if (state.waitingForPair && !text.startsWith('/')) {
        state.waitingForPair = false;
        
        let phone = text.replace(/[^0-9]/g, '');
        if (phone.startsWith('00')) phone = phone.substring(2); 
        
        if (phone.length < 8) {
            bot.sendMessage(chatId, "❌ *Invalid number!* Please send a valid number in international format.", { parse_mode: 'Markdown' });
            return;
        }

        bot.sendMessage(chatId, `⏳ *Requesting pairing code for number:* \`${phone}\`...`, { parse_mode: 'Markdown' });
        
        try {
            await sleep(2500);
            let code = await Promise.race([
                sock.requestPairingCode(phone),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
            ]);
            code = code?.match(/.{1,4}/g)?.join('-') || code;
            
            bot.sendMessage(chatId, `✅ *Pairing code generated successfully!*\n\nاضغط على الكود للنسخ:\n\`${code}\`\n\n📌 *Activation steps:*\n1. Open WhatsApp on your phone.\n2. Go to Linked Devices.\n3. Select "Link a device".\n4. Select "Link with phone number instead".\n5. Enter the code above 👆`, { parse_mode: 'Markdown' });
        } catch
