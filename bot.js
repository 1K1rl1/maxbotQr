import 'dotenv/config';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Bot } from '@maxhub/max-bot-api';
import bwipjs from 'bwip-js';
import QRCode from 'qrcode';
import sharp from 'sharp';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('Не задан BOT_TOKEN в файле .env');

const bot = new Bot(token);
const execFileAsync = promisify(execFile);
const appDirectory = path.dirname(fileURLToPath(
    import.meta.url));
const paddlePython = process.env.PADDLE_PYTHON || 'py';
const paddleArgs = process.env.PADDLE_PYTHON ? [] : ['-3.12'];
const imageTempDirectory = path.join(os.tmpdir(), 'max-image-reader-bot');
const trackedGeneratedMessages = new Map();

function normalizeReactionValue(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/[\u200D\uFE0F\s_-]+/g, '')
        .replace(/[^a-zA-ZА-Яа-я0-9]/g, '')
        .toLowerCase();
}

function isDeleteReaction(value) {
    const reaction = String(value ?? '').trim();
    if (!reaction) return false;
    const directReactionSet = new Set(['🗑', '🗑️', '❌', '🚫', '⛔']);
    if (directReactionSet.has(reaction)) return true;

    const normalized = normalizeReactionValue(reaction);
    return ['trash', 'delete', 'remove', 'bin', 'cancel', 'удалить', 'deletebin', 'removebin'].includes(normalized);
}

function readMessageIdFromObject(value) {
    if (!value || typeof value !== 'object') return undefined;
    if (typeof value.message_id === 'number' || typeof value.message_id === 'string') return Number(value.message_id) || String(value.message_id);
    if (typeof value.id === 'number' || typeof value.id === 'string') return Number(value.id) || String(value.id);
    if (typeof value.mid === 'number' || typeof value.mid === 'string') return Number(value.mid) || String(value.mid);
    if (value.body && typeof value.body.mid !== 'undefined') return Number(value.body.mid) || String(value.body.mid);
    if (value.message && typeof value.message.body?.mid !== 'undefined') return Number(value.message.body.mid) || String(value.message.body.mid);
    return undefined;
}

function readChatIdFromObject(value) {
    if (!value || typeof value !== 'object') return undefined;
    if (typeof value.chat_id === 'number' || typeof value.chat_id === 'string') return Number(value.chat_id) || String(value.chat_id);
    if (value.chat && typeof value.chat.chat_id !== 'undefined') return Number(value.chat.chat_id) || String(value.chat.chat_id);
    if (value.chat && typeof value.chat.id !== 'undefined') return Number(value.chat.id) || String(value.chat.id);
    if (value.recipient && typeof value.recipient.chat_id !== 'undefined') return Number(value.recipient.chat_id) || String(value.recipient.chat_id);
    if (value.message && value.message.recipient && typeof value.message.recipient.chat_id !== 'undefined') return Number(value.message.recipient.chat_id) || String(value.message.recipient.chat_id);
    return undefined;
}

function extractReactionInfo(update) {
    const subject = update?.reaction ?? update?.message_reaction ?? update?.reaction_data ?? update?.data?.reaction ?? null;
    const reactionValue = subject && typeof subject === 'object' ? subject : null;

    const messageId = readMessageIdFromObject(update) ?? readMessageIdFromObject(reactionValue) ?? readMessageIdFromObject(update?.message) ?? null;
    const chatId = readChatIdFromObject(update) ?? readChatIdFromObject(reactionValue) ?? readChatIdFromObject(update?.message) ?? null;

    const rawEmoji =
        reactionValue?.emoji ??
        reactionValue?.type ??
        reactionValue?.value ??
        reactionValue?.name ??
        update?.emoji ??
        update?.reaction ??
        update?.reaction_emoji ??
        update?.reaction_type ??
        null;

    return {
        messageId,
        chatId,
        reaction: rawEmoji,
    };
}

function trackGeneratedMessage(ctx, messageLike) {
    const chatId = ctx?.chatId ?? readChatIdFromObject(ctx?.update) ?? readChatIdFromObject(ctx?.message);
    const messageId = readMessageIdFromObject(messageLike) ?? readMessageIdFromObject(ctx?.message) ?? ctx?.messageId;
    if (!chatId || !messageId) return;
    trackedGeneratedMessages.set(`${chatId}:${messageId}`, { chatId, messageId });
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
        .filter((attachment) => attachment && (attachment.type === 'image' || attachment.type === 'photo' || !attachment.type))
        .map(findImageUrl)
        .filter(Boolean))];
}

async function prepareImageForOcr(imageUrl) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`MAX image download failed: ${response.status}`);

    return sharp(Buffer.from(await response.arrayBuffer()))
        .rotate()
        .resize({ width: 2400, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .png()
        .toBuffer();
}

async function runPaddleOcr(imageBuffer) {
    const imagePath = path.join(imageTempDirectory, `paddle-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    await mkdir(imageTempDirectory, { recursive: true });
    await writeFile(imagePath, imageBuffer);

    try {
        const { stdout } = await execFileAsync(
            paddlePython, [...paddleArgs, path.join(appDirectory, 'paddle_ocr.py'), imagePath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        );
        return parseOcrJson(stdout);
    } finally {
        await rm(imagePath, { force: true });
    }
}

function parseOcrJson(output) {
    const marker = /\{\s*"text"\s*:/g;
    const starts = [...output.matchAll(marker)].map((match) => match.index).reverse();

    for (const start of starts) {
        let depth = 0;
        let insideString = false;
        let escaped = false;

        for (let index = start; index < output.length; index += 1) {
            const character = output[index];
            if (insideString) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') insideString = false;
                continue;
            }
            if (character === '"') insideString = true;
            else if (character === '{') depth += 1;
            else if (character === '}') {
                depth -= 1;
                if (depth === 0) {
                    try {
                        const result = JSON.parse(output.slice(start, index + 1));
                        if (typeof result.text === 'string' && Array.isArray(result.words)) return result;
                    } catch {
                        break;
                    }
                }
            }
        }
    }

    throw new Error('OCR returned no valid JSON object');
}

async function recognizeImage(imageUrl) {
    const prepared = await prepareImageForOcr(imageUrl);
    const result = await runPaddleOcr(prepared);
    return formatRecognizedText(result);
}

function cleanLine(value) {
    return String(value || '')
        .replace(/[|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatRecognizedText(data) {
    const words = (data.words || [])
        .filter((word) => word && word.text && word.text.trim())
        .map((word) => ({
            text: cleanLine(word.text),
            left: Number(word.bbox ? word.bbox.x0 : 0) || 0,
            right: Number(word.bbox ? word.bbox.x1 : 0) || 0,
            top: Number(word.bbox ? word.bbox.y0 : 0) || 0,
            bottom: Number(word.bbox ? word.bbox.y1 : 0) || 0,
        }))
        .sort((first, second) => first.top - second.top || first.left - second.left);

    if (!words.length) return String(data.text || '').trim();

    const lines = [];
    for (const word of words) {
        const line = lines.at(-1);
        const lastWord = line ? line.words[line.words.length - 1] : null;
        const lineBottom = lastWord && Number.isFinite(lastWord.bottom) ? lastWord.bottom : -Infinity;
        const lineHeight = lastWord ? lastWord.bottom - lastWord.top : 0;
        const sameLine = line && word.top <= lineBottom + Math.max(12, lineHeight * 0.6);
        if (sameLine) line.words.push(word);
        else lines.push({ words: [word] });
    }

    return lines
        .map(({ words: lineWords }) => lineWords
            .sort((first, second) => first.left - second.left)
            .map((word) => word.text)
            .filter(Boolean)
            .join(' '))
        .map(cleanLine)
        .filter(Boolean)
        .join('\n') || String(data.text || '').trim();
}

function extractIdentifiers(text) {
    const identifiers = new Set();
    const pattern = /(?:^|[^a-z0-9])((?:(?:bx|cl|ii|us)[\s-]*\d(?:[\s-]*\d){3,}|(?:bx|cl|ii|us)[\s-]*[a-z0-9]{3,}|%301%[a-z0-9%._-]+))(?![a-z0-9])/gi;

    for (const match of String(text || '').matchAll(pattern)) {
        identifiers.add(match[1].replace(/[\s-]/g, '').toLowerCase());
    }

    return [...identifiers];
}

function parseCommand(text) {
    const match = String(text || '').trim().match(/^\/([a-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    return { name: match[1].toLowerCase(), argument: match[2] || '' };
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

async function generateCodeImage(value, mode) {
    if (mode === 'qr') return generateQr(value);
    return generateBarcode(value);
}

async function replyWithCodes(ctx, identifiers, mode = 'qr', recognizedText = '') {
    const values = [...new Set(String(Array.isArray(identifiers) ? identifiers.join(' ') : identifiers || '')
            .match(/(?:bx|cl|ii|us|%301%)[\w%._-]+/gi) || [])]
        .map((value) => String(value).replace(/[\s-]+/g, '').toLowerCase())
        .filter(Boolean)
        .slice(0, 10);

    if (!values.length) return;

    const attachments = [];
    for (const identifier of values) {
        const image = await generateCodeImage(identifier, mode);
        const attachment = await bot.api.uploadImage({ source: image });
        attachments.push(attachment.toJson());
    }

    const safeText = String(recognizedText || '').trim();
    const messageText = safeText && safeText.length <= 3500 ?
        safeText :
        safeText ?
        `${safeText.slice(0, 1200)}${safeText.length > 1200 ? '…' : ''}` :
        `Найдено: ${values.join(', ')}`;

    const response = await ctx.reply(messageText, { attachments });
    trackGeneratedMessage(ctx, response);
}

async function replyWithCodeForText(ctx, text, mode) {
    const value = String(text || '').trim();
    const maxLength = mode === 'barcode' ? 180 : 1500;
    if (!value) {
        await ctx.reply(`Напишите текст после команды. Например: /${mode === 'barcode' ? 'barcode' : 'qr'} bx838833`);
        return;
    }
    if (value.length > maxLength) {
        await ctx.reply(`Текст слишком длинный для этого формата. Максимум: ${maxLength} символов.`);
        return;
    }
    if (mode === 'barcode' && /[^\x20-\x7E]/.test(value)) {
        await ctx.reply('Code128 поддерживает только латинские символы и цифры. Для кириллицы используйте /qr.');
        return;
    }

    const codeValue = mode === 'barcode' ? value.replace(/\s+/g, ' ') : value;
    const image = await generateCodeImage(codeValue, mode);
    const attachment = await bot.api.uploadImage({ source: image });
    const label = mode === 'barcode' ? 'Code128' : 'QR-код';
    const response = await ctx.reply(`${label} для переданного текста`, { attachments: [attachment.toJson()] });
    trackGeneratedMessage(ctx, response);
}

async function replyWithText(ctx, text) {
    const lines = String(text || '').split('\n');
    let chunk = '';

    for (const line of lines) {
        if (chunk.length + line.length + 1 > 3500 && chunk) {
            await ctx.reply(chunk);
            chunk = '';
        }
        chunk += `${chunk ? '\n' : ''}${line}`;
    }

    if (chunk) await ctx.reply(chunk);
}

async function processImage(ctx, imageUrl, mode = 'qr', fallbackText = '', prefix = '') {
    const recognizedText = await recognizeImage(imageUrl);
    const outputText = `${prefix}${recognizedText}`;
    const identifiers = [...new Set([
        ...extractIdentifiers(recognizedText),
        ...extractIdentifiers(fallbackText),
    ])];

    if (identifiers.length) {
        await replyWithCodes(ctx, identifiers, mode, outputText || 'Текст на изображении не распознан.');
        return;
    }

    await replyWithText(ctx, outputText || 'Текст на изображении не распознан.');
}

const helpText = [
    'Пришлите фото для распознавания текста.',
    'Коды bx…, cl…, ii…, us… и %301%… автоматически создают QR-код.',
    'Команды: /read, /qr <весь текст>, /barcode <весь текст>. /code — псевдоним /qr.',
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
    const code = error && typeof error === 'object' ? error.code : undefined;
    const message = error && typeof error === 'object' ? String(error.message || '') : String(error || '');

    if (code === 'ENOENT' || message.includes('paddle_ocr.py')) {
        return 'Не найден Python или OCR-адаптер. Проверьте Python 3.12 и настройку PADDLE_PYTHON.';
    }
    if (message.includes('MAX image download failed')) {
        return 'Не удалось загрузить изображение из MAX. Отправьте его ещё раз.';
    }
    if (message.includes('OCR returned no valid JSON object') || message.includes('OCR returned no JSON result')) {
        return 'Сервис распознавания вернул некорректный ответ. Попробуйте отправить изображение ещё раз.';
    }
    if (/unsupported image format|Input buffer contains/i.test(message)) {
        return 'Формат изображения не поддерживается. Отправьте PNG, JPG или WEBP.';
    }
    return 'Не удалось обработать сообщение. Попробуйте ещё раз или отправьте изображение в формате PNG/JPG.';
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
        const messageBody = ctx.message && ctx.message.body ? ctx.message.body : {};
        const imageUrls = findImageUrls(messageBody.attachments);
        const userText = String(messageBody.text || '').trim();
        const command = parseCommand(userText);

        if (command && (command.name === 'start' || command.name === 'help')) {
            await ctx.reply(helpText);
            return;
        }

        const commandModes = { qr: 'qr', code: 'qr', barcode: 'barcode' };
        if (command && !['read', ...Object.keys(commandModes)].includes(command.name)) {
            await ctx.reply('Команда не распознана. Напишите /help.');
            return;
        }

        const mode = commandModes[command ? command.name : ''] || 'qr';
        const commandArgument = command ? command.argument || '' : '';
        const textToCheck = command ? commandArgument : userText;
        const identifiers = extractIdentifiers(textToCheck);

        if (imageUrls.length) {
            for (const [index, imageUrl] of imageUrls.entries()) {
                const prefix = imageUrls.length > 1 ? `Изображение ${index + 1} из ${imageUrls.length}\n` : '';
                try {
                    await processImage(ctx, imageUrl, mode, command ? '' : userText, prefix);
                } catch (error) {
                    reportError(`image-processing-${index + 1}`, error);
                    await replySafely(ctx, getUserErrorMessage(error));
                }
            }
            return;
        }

        if (command && ['qr', 'code', 'barcode'].includes(command.name)) {
            await replyWithCodeForText(ctx, commandArgument, mode);
            return;
        }

        if (identifiers.length) {
            await replyWithCodes(ctx, identifiers, mode);
            return;
        }

        if (command && command.name === 'read') {
            await ctx.reply('Пришлите изображение, и я распознаю весь текст.');
            return;
        }
        if (command && command.name !== 'read') {
            await ctx.reply(`Укажите код после команды. Например: /${command.name} bx838833`);
            return;
        }

        await ctx.reply(helpText);
    } catch (error) {
        reportError('message-processing', error);
        await replySafely(ctx, getUserErrorMessage(error));
    }
});

bot.on((update) => /reaction/i.test(String(update?.update_type || '')), async(ctx) => {
    const reactionInfo = extractReactionInfo(ctx.update);
    if (!reactionInfo.messageId || !reactionInfo.chatId) return;
    if (!isDeleteReaction(reactionInfo.reaction)) return;

    const key = `${reactionInfo.chatId}:${reactionInfo.messageId}`;
    if (!trackedGeneratedMessages.has(key)) return;

    try {
        await ctx.api.deleteMessage(reactionInfo.messageId, { chat_id: reactionInfo.chatId });
        trackedGeneratedMessages.delete(key);
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
    try {
        await rm(imageTempDirectory, { recursive: true, force: true });
    } catch (error) {
        reportError('temporary-file-cleanup', error);
    } finally {
        bot.stopPolling();
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
    { name: 'read', description: 'Распознать текст на фото' },
    { name: 'qr', description: 'Создать QR-код' },
    { name: 'barcode', description: 'Создать штрихкод Code128' },
    { name: 'code', description: 'Создать QR-код из текста' },
]).catch((error) => reportError('command-registration', error));

bot.start().catch((error) => {
    reportError('bot-startup', error);
    process.exitCode = 1;
});
console.log('MAX image reader bot started');