import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from '@maxhub/max-bot-api';
import bwipjs from 'bwip-js';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('Не задан BOT_TOKEN в файле .env');

const bot = new Bot(token);
const generatedCodeMessages = new Map();
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const ocrCacheDirectory = path.join(os.tmpdir(), 'max-screenshot-ocr-cache');
let ocrWorkerPromise;

function readMessageId(value) {
    if (value == null) return null;
    if (typeof value === 'number' || typeof value === 'string') return Number(value) || String(value);
    if (typeof value === 'object') {
        if (typeof value.message_id !== 'undefined') return Number(value.message_id) || String(value.message_id);
        if (typeof value.id !== 'undefined') return Number(value.id) || String(value.id);
        if (typeof value.mid !== 'undefined') return Number(value.mid) || String(value.mid);
        if (value.body && typeof value.body.mid !== 'undefined') return Number(value.body.mid) || String(value.body.mid);
    }
    return null;
}

function readChatId(value) {
    if (value == null) return null;
    if (typeof value === 'number' || typeof value === 'string') return Number(value) || String(value);
    if (typeof value === 'object') {
        if (typeof value.chat_id !== 'undefined') return Number(value.chat_id) || String(value.chat_id);
        if (value.chat && typeof value.chat.chat_id !== 'undefined') return Number(value.chat.chat_id) || String(value.chat.chat_id);
        if (value.recipient && typeof value.recipient.chat_id !== 'undefined') return Number(value.recipient.chat_id) || String(value.recipient.chat_id);
    }
    return null;
}

function normalizeDeleteReaction(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return false;
    const direct = new Set(['🗑', '🗑️', '❌', '🚫', '⛔']);
    if (direct.has(raw)) return true;
    const normalized = raw
        .normalize('NFKC')
        .replace(/[\u200D\uFE0F\s_\-]+/g, '')
        .replace(/[^a-zA-ZА-Яа-я0-9]/g, '')
        .toLowerCase();
    return ['trash', 'delete', 'remove', 'bin', 'cancel', 'удалить', 'deletebin', 'removebin'].includes(normalized);
}

function extractReactionInfo(update) {
    const payload = update?.reaction ?? update?.message_reaction ?? update?.reaction_data ?? null;
    const reactionValue = payload && typeof payload === 'object' ? payload : null;

    const messageId = readMessageId(update?.message_id)
        ?? readMessageId(update?.message?.body?.mid)
        ?? readMessageId(update?.message?.mid)
        ?? readMessageId(reactionValue?.message_id)
        ?? null;

    const chatId = readChatId(update?.chat_id)
        ?? readChatId(update?.message?.recipient?.chat_id)
        ?? readChatId(reactionValue?.chat_id)
        ?? null;

    const reactionText = reactionValue?.emoji
        ?? reactionValue?.type
        ?? reactionValue?.value
        ?? reactionValue?.name
        ?? update?.emoji
        ?? update?.reaction
        ?? null;

    return { messageId, chatId, reactionText };
}

function trackGeneratedMessage(ctx, generatedMessage) {
    const chatId = readChatId(ctx?.chatId) ?? readChatId(ctx?.update?.chat_id) ?? readChatId(ctx?.message?.recipient?.chat_id);
    const messageId = readMessageId(generatedMessage?.message_id)
        ?? readMessageId(generatedMessage?.id)
        ?? readMessageId(generatedMessage?.mid)
        ?? readMessageId(generatedMessage?.body?.mid)
        ?? readMessageId(ctx?.messageId);

    if (!chatId || !messageId) return;
    generatedCodeMessages.set(`${chatId}:${messageId}`, { chatId, messageId });
}

function parseCommand(text) {
    const match = String(text || '').trim().match(/^\/([a-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    return { name: match[1].toLowerCase(), argument: match[2] || '' };
}

function normalizeCodeToken(value, fromOcr = false) {
    const token = String(value || '')
        .replace(/[\s\-_]+/g, '')
        .toLowerCase();
    if (!fromOcr) return token;

    const confusedPrefix = token.match(/^(11|1i|i1|il|li|ll)(?=\d)/);
    if (!confusedPrefix) return token;

    const digits = token.slice(2);
    if (confusedPrefix[1] === '11' && /^\d{4}$/.test(digits)) return `ii1${digits}`;
    return `ii${digits}`;
}

function extractIdentifiers(text, fromOcr = false) {
    const identifiers = new Set();
    const patterns = [/(?:^|[^a-z0-9%])((?:%301%[a-z0-9._%-]+|(?:bx|cl|ii|us)[\s-]*[a-z0-9][a-z0-9._%-]{2,}))(?![a-z0-9%])/gi];
    if (fromOcr) patterns.push(/(?:^|[^a-z0-9%])((?:11|1i|i1|il|li|ll)[\s-]*\d[a-z0-9._%-]{2,})(?![a-z0-9%])/gi);

    for (const pattern of patterns) {
        for (const match of String(text || '').matchAll(pattern)) {
            const token = normalizeCodeToken(match[1], fromOcr);
            if (token) identifiers.add(token);
        }
    }

    return [...identifiers];
}

function findImageUrl(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) return value.url;
    for (const child of Object.values(value)) {
        const result = findImageUrl(child);
        if (result) return result;
    }
    return null;
}

function findImageUrls(attachments) {
    if (!Array.isArray(attachments)) return [];
    return [...new Set(attachments
        .filter((attachment) => attachment && ['image', 'photo'].includes(attachment.type))
        .map(findImageUrl)
        .filter(Boolean))];
}

async function getOcrWorker() {
    if (!ocrWorkerPromise) {
        ocrWorkerPromise = (async() => {
            await mkdir(ocrCacheDirectory, { recursive: true });
            return createWorker(['eng', 'rus'], 1, {
                cachePath: ocrCacheDirectory,
            });
        })();
    }

    try {
        return await ocrWorkerPromise;
    } catch (error) {
        ocrWorkerPromise = null;
        throw error;
    }
}

async function recognizeImage(imageUrl) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);

    const imageBuffer = Buffer.from(await response.arrayBuffer());
    const preparedImage = await sharp(imageBuffer)
        .rotate()
        .resize({ width: 2400, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .png()
        .toBuffer();
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(preparedImage);
    return String(data.text || '').trim();
}

async function generateQr(value) {
    return QRCode.toBuffer(value, {
        type: 'png',
        width: 600,
        margin: 3,
        errorCorrectionLevel: 'M',
        color: { dark: '#111111', light: '#FFFFFF' },
    });
}

async function generateBarcode(value) {
    return bwipjs.toBuffer({
        bcid: 'code128',
        text: value,
        scale: 3,
        height: 22,
        includetext: true,
        textxalign: 'center',
        padding: 18,
        backgroundcolor: 'FFFFFF',
    });
}

async function replyWithQrs(ctx, values, replyText) {
    const uniqueValues = [...new Set(values)].slice(0, 10);
    const attachments = [];

    for (const value of uniqueValues) {
        const image = await generateQr(value);
        const attachment = await bot.api.uploadImage({ source: image });
        attachments.push(attachment.toJson());
    }

    if (!attachments.length) return;
    const response = await ctx.reply(replyText, { attachments });
    trackGeneratedMessage(ctx, response);
}

async function replyWithQr(ctx, text) {
    const value = String(text || '').trim();
    if (!value) {
        await ctx.reply('Укажите текст после команды. Например: /qr bx838833');
        return;
    }
    if (value.length > 1500) {
        await ctx.reply('Текст слишком длинный для QR-кода. Максимум: 1500 символов.');
        return;
    }

    await replyWithQrs(ctx, [value], 'QR-код для переданного текста.');
}

async function replyWithText(ctx, text) {
    const value = String(text || '').trim();
    if (!value) {
        await ctx.reply('На изображении не удалось распознать текст.');
        return;
    }

    for (let offset = 0; offset < value.length; offset += 3500) {
        await ctx.reply(value.slice(offset, offset + 3500));
    }
}

async function processImage(ctx, imageUrl, fallbackText = '') {
    const recognizedText = await recognizeImage(imageUrl);
    const identifiers = [...new Set([
        ...extractIdentifiers(recognizedText, true),
        ...extractIdentifiers(fallbackText),
    ])];
    const outputText = recognizedText || 'На изображении не удалось распознать текст.';

    if (!identifiers.length) {
        await replyWithText(ctx, outputText);
        return;
    }

    if (outputText.length <= 2400) {
        await replyWithQrs(ctx, identifiers, `Распознанный текст:\n${outputText}\n\nQR для: ${identifiers.join(', ')}`);
        return;
    }

    await replyWithText(ctx, outputText);
    await replyWithQrs(ctx, identifiers, `QR для распознанных кодов: ${identifiers.join(', ')}`);
}

async function replyWithBarcode(ctx, text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) {
        await ctx.reply('Укажите текст после команды. Например: /barcode bx838833');
        return;
    }
    if (value.length > 180) {
        await ctx.reply('Текст слишком длинный для Code128. Максимум: 180 символов.');
        return;
    }
    if (/[^\x20-\x7e]/.test(value)) {
        await ctx.reply('Code128 поддерживает только ASCII-текст. Уберите кириллицу и специальные символы.');
        return;
    }

    const image = await generateBarcode(value);
    const attachment = await bot.api.uploadImage({ source: image });
    const response = await ctx.reply(`Штрихкод Code128 для текста: ${value}`, {
        attachments: [attachment.toJson()],
    });
    trackGeneratedMessage(ctx, response);
}

const helpText = [
    'Пришлите скриншот: бот вернёт распознанный текст и создаст QR для кодов bx, cl, ii, us и %301%.',
    'Команды: /read, /qr <текст> и /barcode <текст>.',
].join('\n');

function redactErrorText(value) {
    return String(value || '')
        .replace(/(BOT_TOKEN|authorization|access[_ -]?token)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
        .slice(0, 3000);
}

function reportError(scope, error) {
    const details = error && typeof error === 'object' ? error : { message: error };
    console.error(`[${new Date().toISOString()}] ${scope}`, {
        name: details.name || 'Error',
        message: redactErrorText(details.message),
        code: details.code,
        stderr: details.stderr ? redactErrorText(details.stderr) : undefined,
        stack: details.stack ? redactErrorText(details.stack) : undefined,
    });
}

function getUserErrorMessage(error) {
    const message = error && typeof error === 'object' ? String(error.message || '') : String(error || '');
    if (message.includes('Image download failed')) {
        return 'Не удалось загрузить изображение из MAX. Отправьте его ещё раз.';
    }
    if (/unsupported image format|Input buffer contains/i.test(message)) {
        return 'Формат изображения не поддерживается. Отправьте PNG, JPG или WEBP.';
    }
    return 'Не удалось распознать текст или создать код. Попробуйте ещё раз.';
}

async function replySafely(ctx, text) {
    if (!ctx || typeof ctx.reply !== 'function') return;
    try {
        await ctx.reply(text);
    } catch (error) {
        reportError('error-reply-failed', error);
    }
}

bot.on('message_created', async(ctx) => {
    try {
        const messageBody = ctx.message?.body || {};
        const userText = String(messageBody.text || '').trim();
        const command = parseCommand(userText);
        const imageUrls = findImageUrls(messageBody.attachments);

        if (command && (command.name === 'start' || command.name === 'help')) {
            await ctx.reply(helpText);
            return;
        }

        if (imageUrls.length) {
            for (const [index, imageUrl] of imageUrls.entries()) {
                try {
                    await processImage(ctx, imageUrl, command?.argument || '');
                } catch (error) {
                    reportError(`image-processing-${index + 1}`, error);
                    await replySafely(ctx, getUserErrorMessage(error));
                }
            }
            return;
        }

        if (command?.name === 'read') {
            await ctx.reply('Отправьте скриншот, и я верну распознанный текст.');
            return;
        }

        if (command?.name === 'qr') {
            await replyWithQr(ctx, command.argument);
            return;
        }

        if (command?.name === 'barcode') {
            await replyWithBarcode(ctx, command.argument);
            return;
        }

        if (command) {
            await ctx.reply('Команда не распознана. Напишите /help.');
            return;
        }

        const identifiers = extractIdentifiers(userText);
        if (identifiers.length) {
            await replyWithQrs(ctx, identifiers, `Найдены коды: ${identifiers.join(', ')}`);
            return;
        }

        await ctx.reply(helpText);
    } catch (error) {
        reportError('message-processing', error);
        await replySafely(ctx, getUserErrorMessage(error));
    }
});

bot.on((update) => {
    if (!update || typeof update !== 'object') return false;
    const reactionInfo = extractReactionInfo(update);
    return Boolean(reactionInfo.messageId && reactionInfo.chatId && reactionInfo.reactionText);
}, async(ctx) => {
    const reactionInfo = extractReactionInfo(ctx.update);
    if (!reactionInfo.messageId || !reactionInfo.chatId) return;
    if (!normalizeDeleteReaction(reactionInfo.reactionText)) return;

    const key = `${reactionInfo.chatId}:${reactionInfo.messageId}`;
    if (!generatedCodeMessages.has(key)) return;

    try {
        await ctx.api.deleteMessage(reactionInfo.messageId, { chat_id: reactionInfo.chatId });
        generatedCodeMessages.delete(key);
    } catch (error) {
        reportError('delete-generated-code', error);
    }
});

bot.catch(async(error, ctx) => {
    reportError('bot-framework', error);
    await replySafely(ctx, getUserErrorMessage(error));
});

async function shutdown(signal) {
    console.log(`Stopping bot (${signal})`);
    bot.stopPolling();
    if (ocrWorkerPromise) {
        try {
            const worker = await ocrWorkerPromise;
            await worker.terminate();
            ocrWorkerPromise = null;
        } catch (error) {
            reportError('ocr-worker-shutdown', error);
        }
    }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('unhandledRejection', (error) => {
    reportError('unhandled-rejection', error);
    void shutdown('unhandledRejection').finally(() => process.exit(1));
});
process.once('uncaughtException', (error) => {
    reportError('uncaught-exception', error);
    void shutdown('uncaughtException').finally(() => process.exit(1));
});

bot.api.setMyCommands([
    { name: 'start', description: 'Информация о боте' },
    { name: 'help', description: 'Список команд' },
    { name: 'read', description: 'Распознать текст на скриншоте' },
    { name: 'qr', description: 'Создать QR-код из текста' },
    { name: 'barcode', description: 'Создать штрихкод Code128' },
]).catch((error) => reportError('command-registration', error));

bot.start().catch((error) => {
    reportError('bot-startup', error);
    process.exitCode = 1;
});
console.log('MAX image reader bot started');