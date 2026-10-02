import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const certificatePath = path.join(appDirectory, 'russian-trusted-root-ca.pem');
const botProcess = spawn(process.execPath, [path.join(appDirectory, 'bot.js')], {
    env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || certificatePath,
    },
    stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => botProcess.kill(signal));
}

botProcess.on('error', (error) => {
    console.error('Failed to start bot process', error);
    process.exitCode = 1;
});

botProcess.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
});
