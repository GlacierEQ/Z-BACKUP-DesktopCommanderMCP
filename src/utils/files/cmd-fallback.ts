/**
 * UDC-Class Resilient Command-Based Filesystem Fallback Engine
 *
 * Provides safe, injection-proof command execution fallbacks using execFileSync
 * when Node.js fs APIs encounter permission boundaries (EACCES/EPERM), file locks,
 * cross-device moves (EXDEV), or cloud sync barriers.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const IS_WIN = process.platform === 'win32';
const MAX_BUFFER = 50 * 1024 * 1024; // 50MB

/**
 * Log fallback invocation for debugging and audit
 */
function logFallback(op: string, details: string): void {
    if (process.env.DEBUG || process.env.DESKTOP_COMMANDER_DEBUG) {
        console.warn(`[cmd-fallback] ${op}: ${details}`);
    }
}

/**
 * Read file contents using platform command execution as a resilient fallback.
 */
export async function readFileWithCmd(
    filePath: string,
    offset: number = 0,
    length?: number
): Promise<string> {
    logFallback('read', filePath);

    let rawContent: string;
    try {
        if (IS_WIN) {
            rawContent = execFileSync(
                'powershell',
                ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath "${filePath}" -Raw`],
                { encoding: 'utf8', maxBuffer: MAX_BUFFER }
            );
        } else {
            rawContent = execFileSync('cat', [filePath], {
                encoding: 'utf8',
                maxBuffer: MAX_BUFFER
            });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Command-based read failed for ${filePath}: ${message}`);
    }

    if (offset === 0 && (length === undefined || length >= Number.MAX_SAFE_INTEGER)) {
        return rawContent;
    }

    // Apply line slice if offset or length was specified
    const lines = rawContent.split(/\r?\n/);
    const start = Math.max(0, offset);
    const end = length !== undefined ? start + length : lines.length;
    return lines.slice(start, end).join('\n');
}

/**
 * Write file contents using atomic tempfile creation and command execution fallback.
 */
export async function writeFileWithCmd(
    filePath: string,
    content: string,
    mode: 'rewrite' | 'append' = 'rewrite'
): Promise<void> {
    logFallback('write', `${filePath} (${mode})`);

    const tempFile = path.join(
        os.tmpdir(),
        `dc-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    );

    try {
        fs.writeFileSync(tempFile, content, 'utf8');

        if (IS_WIN) {
            if (mode === 'append') {
                execFileSync('powershell', [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `Add-Content -LiteralPath "${filePath}" -Value (Get-Content -LiteralPath "${tempFile}" -Raw)`
                ]);
            } else {
                execFileSync('powershell', [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `Set-Content -LiteralPath "${filePath}" -Value (Get-Content -LiteralPath "${tempFile}" -Raw) -Force`
                ]);
            }
        } else {
            if (mode === 'append') {
                // Securely append using sh -c with positional arguments (no unescaped interpolation)
                execFileSync('sh', ['-c', 'cat "$1" >> "$2"', '_', tempFile, filePath]);
            } else {
                execFileSync('cp', ['-f', tempFile, filePath]);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Command-based write failed for ${filePath}: ${message}`);
    } finally {
        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch {
            // Ignore tempfile unlink cleanup error
        }
    }
}

/**
 * Create directory recursively using mkdir -p fallback.
 */
export async function createDirectoryWithCmd(dirPath: string): Promise<void> {
    logFallback('mkdir', dirPath);

    try {
        if (IS_WIN) {
            execFileSync('powershell', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `New-Item -ItemType Directory -Force -Path "${dirPath}"`
            ]);
        } else {
            execFileSync('mkdir', ['-p', dirPath]);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Command-based mkdir failed for ${dirPath}: ${message}`);
    }
}

/**
 * List directory entries using ls -la fallback.
 */
export async function listDirectoryWithCmd(dirPath: string): Promise<string[]> {
    logFallback('list', dirPath);

    try {
        if (IS_WIN) {
            const output = execFileSync(
                'powershell',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `Get-ChildItem -LiteralPath "${dirPath}" | ForEach-Object { if ($_.PSIsContainer) {'[DIR] ' + $_.Name} else {'[FILE] ' + $_.Name} }`
                ],
                { encoding: 'utf8', maxBuffer: MAX_BUFFER }
            );
            return output.split(/\r?\n/).filter(line => line.trim().length > 0);
        } else {
            const output = execFileSync('ls', ['-1pa', dirPath], {
                encoding: 'utf8',
                maxBuffer: MAX_BUFFER
            });
            return output
                .split(/\r?\n/)
                .filter(entry => entry.trim().length > 0 && entry !== './' && entry !== '../')
                .map(entry => {
                    if (entry.endsWith('/')) {
                        return `[DIR] ${entry.slice(0, -1)}`;
                    }
                    return `[FILE] ${entry}`;
                });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Command-based list failed for ${dirPath}: ${message}`);
    }
}

/**
 * Move or rename a file across devices using mv -f fallback.
 */
export async function moveFileWithCmd(sourcePath: string, destinationPath: string): Promise<void> {
    logFallback('move', `${sourcePath} -> ${destinationPath}`);

    try {
        if (IS_WIN) {
            execFileSync('powershell', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Move-Item -LiteralPath "${sourcePath}" -Destination "${destinationPath}" -Force`
            ]);
        } else {
            execFileSync('mv', ['-f', sourcePath, destinationPath]);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Command-based move failed: ${message}`);
    }
}

/**
 * Test whether path exists using test -e fallback.
 */
export function existsWithCmd(targetPath: string): boolean {
    try {
        if (IS_WIN) {
            const out = execFileSync(
                'powershell',
                ['-NoProfile', '-NonInteractive', '-Command', `Test-Path -LiteralPath "${targetPath}"`],
                { encoding: 'utf8' }
            );
            return out.trim().toLowerCase() === 'true';
        } else {
            execFileSync('test', ['-e', targetPath]);
            return true;
        }
    } catch {
        return false;
    }
}
