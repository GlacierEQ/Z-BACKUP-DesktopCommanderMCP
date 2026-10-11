/**
 * Test suite for UDC-heritage command-based filesystem fallbacks
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    readFileWithCmd,
    writeFileWithCmd,
    createDirectoryWithCmd,
    listDirectoryWithCmd,
    moveFileWithCmd,
    existsWithCmd
} from '../dist/utils/files/cmd-fallback.js';
import { readFile, writeFile, createDirectory, listDirectory, moveFile } from '../dist/tools/filesystem.js';

async function runTests() {
    console.log('--- Running cmd-fallback unit tests ---');
    const testDir = path.join(os.tmpdir(), `dc-cmd-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
        // Test 1: writeFileWithCmd (rewrite)
        const testFile = path.join(testDir, 'test-write.txt');
        await writeFileWithCmd(testFile, 'Hello from UDC cmd write\nLine 2\nLine 3');
        assert.strictEqual(fs.existsSync(testFile), true, 'File should exist after writeFileWithCmd');
        console.log('✓ writeFileWithCmd (rewrite) passed');

        // Test 2: readFileWithCmd (full read)
        const content = await readFileWithCmd(testFile);
        assert.ok(content.includes('Hello from UDC cmd write'), 'Content should match');
        console.log('✓ readFileWithCmd (full) passed');

        // Test 3: readFileWithCmd (with offset and length)
        const sliced = await readFileWithCmd(testFile, 1, 1);
        assert.strictEqual(sliced, 'Line 2', 'Sliced content should match offset/length');
        console.log('✓ readFileWithCmd (sliced) passed');

        // Test 4: writeFileWithCmd (append)
        await writeFileWithCmd(testFile, '\nLine 4 appended', 'append');
        const appendedContent = await readFileWithCmd(testFile);
        assert.ok(appendedContent.includes('Line 4 appended'), 'Appended line should be present');
        console.log('✓ writeFileWithCmd (append) passed');

        // Test 5: createDirectoryWithCmd
        const subDir = path.join(testDir, 'nested', 'deep', 'dir');
        await createDirectoryWithCmd(subDir);
        assert.strictEqual(fs.existsSync(subDir), true, 'Nested directory should exist');
        console.log('✓ createDirectoryWithCmd passed');

        // Test 6: listDirectoryWithCmd
        const listed = await listDirectoryWithCmd(testDir);
        assert.ok(listed.some(entry => entry.includes('test-write.txt')), 'Listing should include test-write.txt');
        assert.ok(listed.some(entry => entry.includes('nested')), 'Listing should include nested dir');
        console.log('✓ listDirectoryWithCmd passed');

        // Test 7: moveFileWithCmd
        const destFile = path.join(subDir, 'moved-test.txt');
        await moveFileWithCmd(testFile, destFile);
        assert.strictEqual(fs.existsSync(testFile), false, 'Source should no longer exist');
        assert.strictEqual(fs.existsSync(destFile), true, 'Destination should exist');
        console.log('✓ moveFileWithCmd passed');

        // Test 8: existsWithCmd
        assert.strictEqual(existsWithCmd(destFile), true, 'existsWithCmd should return true for existing file');
        assert.strictEqual(existsWithCmd(path.join(testDir, 'non-existent-xyz.txt')), false, 'existsWithCmd should return false for missing file');
        console.log('✓ existsWithCmd passed');

        // Test 9: Integration through filesystem.ts high-level functions
        const highLevelDir = path.join(testDir, 'high-level');
        await createDirectory(highLevelDir);
        const highLevelFile = path.join(highLevelDir, 'high-level.txt');
        await writeFile(highLevelFile, 'High-level filesystem abstraction test');
        const readBack = await readFile(highLevelFile);
        assert.ok(readBack.content.includes('High-level filesystem abstraction test'), 'High-level read should match');
        console.log('✓ filesystem.ts high-level integration passed');

        console.log('\nAll 9 cmd-fallback tests PASSED successfully!');
    } finally {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
