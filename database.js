import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import os from 'os';
import fs from 'fs';

let db;

async function initDatabase() {
    db = await open({
        filename: 'database.sqlite',
        driver: sqlite3.verbose().Database
    });

    // Enable Write-Ahead Logging for better concurrency and performance
    await db.run('PRAGMA journal_mode = WAL');
    // Set cache size to approximately 10MB (-10000 pages, where each page is 1KB)
    await db.run('PRAGMA cache_size = -10000');
    // Set synchronous mode to NORMAL for a balance between safety and performance
    await db.run('PRAGMA synchronous = NORMAL');
    // Store temporary tables and indices in memory instead of on disk
    await db.run('PRAGMA temp_store = MEMORY');
    // Set the maximum size of the memory-mapped I/O to approximately 1GB
    await db.run('PRAGMA mmap_size = 1000000000');

    await db.run('CREATE TABLE IF NOT EXISTS test_results_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, result TEXT NOT NULL, timestamp INTEGER NOT NULL)');
    await db.run('CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, content TEXT NOT NULL, test_session TEXT NOT NULL, timestamp INTEGER NOT NULL)');
}

async function getCachedTest() {
    try {
        await initDatabase();

        const cachedResult = await db.get('SELECT * FROM test_results_cache ORDER BY timestamp DESC LIMIT 1');

        if (cachedResult && (Date.now() / 1000 - cachedResult.timestamp < 300)) {
            return JSON.parse(cachedResult.result);
        }

        const testResult = await runTest();

        // Delete all older records
        await db.run('DELETE FROM test_results_cache');

        // Store the new result in the database
        await db.run('INSERT INTO test_results_cache (result, timestamp) VALUES (?, ?)', [JSON.stringify(testResult), Math.floor(Date.now() / 1000)]);

        return testResult;
    } catch (error) {
        throw error;
    }
}

async function runTest() {
    const startTime = Date.now();
    const maxDuration = 5000; // Maximum test duration in milliseconds
    const chunkSize = 10;
    let writes = 0;
    let failures = 0;
    const newRecords = [];

    const testSessionId = `test_${Date.now()}`;
    const currentTimestamp = Math.floor(Date.now() / 1000);

    const stmt = await db.prepare('INSERT INTO comments (author, content, test_session, timestamp) VALUES (?, ?, ?, ?)');

    while (Date.now() - startTime < maxDuration) {
        const values = [];
        for (let j = 0; j < chunkSize; j++) {
            values.push({
                author: Math.random().toString(36).substring(7),
                content: Math.random().toString(36).substring(7),
            });
        }

        await db.run('BEGIN TRANSACTION');
        for (const value of values) {
            try {
                const result = await stmt.run(value.author, value.content, testSessionId, currentTimestamp);
                newRecords.push(result.lastID);
                writes++;
            } catch (error) {
                failures++;
            }
        }
        await db.run('COMMIT');

        if (Date.now() - startTime >= maxDuration) {
            break;
        }
    }

    await stmt.finalize();

    const writeTime = (Date.now() - startTime) / 1000;
    const writesPerSecond = Math.round(writes / writeTime);

    const readStart = Date.now();
    const readSampleSize = Math.min(10000, newRecords.length);
    const readSample = newRecords.sort(() => 0.5 - Math.random()).slice(0, readSampleSize);
    const readStmt = await db.prepare('SELECT * FROM comments WHERE id = ?');
    for (const id of readSample) {
        await readStmt.get(id);
    }
    await readStmt.finalize();
    const readTime = (Date.now() - readStart) / 1000;
    const readsPerSecond = Math.round((readSampleSize / readTime) * (newRecords.length / readSampleSize));

    const total = await db.get('SELECT COUNT(*) as count FROM comments');
    const dbSizeInMb = fs.statSync('database.sqlite').size / (1024 * 1024);

    // Delete the records inserted during this test and comments older than 10 minutes
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    await db.run(`DELETE FROM comments WHERE test_session = ? OR timestamp < ?`, [testSessionId, tenMinutesAgo]);

    const totalDuration = (Date.now() - startTime) / 1000;

    return {
        dbSizeInMb: Math.round(dbSizeInMb * 100) / 100,
        failureRate: Math.round((failures / writes) * 10000) / 100,
        reads: readSampleSize,
        readsPerSecond,
        total: total.count,
        writes,
        writesPerSecond,
        writeTime: Math.round(writeTime * 100) / 100,
        duration: Math.round(totalDuration * 100) / 100,
    };
}

async function getServerSpecs() {
    const serverSpecs = {
        vCPUs: os.cpus().length,
        'CPU model': os.cpus()[0]?.model || 'Unknown',
        Platform: `${os.platform()}, ${os.arch()}, ${os.release()}`,
        'Total RAM': `${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB`,
        'CPU usage': 'Unknown',
        'Memory usage': 'Unknown',
    };

    const cpuUsage = os.loadavg()[0] / os.cpus().length;
    serverSpecs['CPU usage'] = `${Math.round(cpuUsage * 1000) / 10}%`;

    const usedMemory = os.totalmem() - os.freemem();
    serverSpecs['Memory usage'] = `${Math.round((usedMemory / os.totalmem()) * 1000) / 10}%`;

    return serverSpecs;
}

export {
    initDatabase,
    getCachedTest,
    getServerSpecs,
};
