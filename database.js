import Database from 'better-sqlite3';
import os from 'os';
import fs from 'fs';

let db;
const databaseFile = 'database.sqlite';
const maxCacheSeconds = 300;
const maxSecondsPerTest = 3;

function initDatabase() {
    db = new Database(databaseFile);

    // Enable Write-Ahead Logging for better concurrency and performance
    db.pragma('journal_mode = WAL');
    // Increase cache size to approximately 100MB (-25000 pages, where each page is 4KB)
    db.pragma('cache_size = -25000');
    // Set synchronous mode to NORMAL for a balance between safety and performance
    // Set synchronous mode to FULL for maximum durability at the cost of performance
    db.pragma('synchronous = NORMAL');
    // Store temporary tables and indices in memory instead of on disk
    db.pragma('temp_store = MEMORY');
    // Set the maximum size of the memory-mapped I/O to approximately 1GB
    db.pragma('mmap_size = 1000000000');
    // Enable foreign key constraints for data integrity
    db.pragma('foreign_keys = true');
    // Set a busy timeout of 5 seconds to wait if the database is locked
    db.pragma('busy_timeout = 5000');
    // Enable incremental vacuuming to reclaim unused space and keep the database file size optimized
    db.pragma('auto_vacuum = INCREMENTAL');

    // Use STRICT on table creation for better data integrity
    db.exec(`
        CREATE TABLE IF NOT EXISTS test_results_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            result TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        ) STRICT
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_test_results_cache_timestamp ON test_results_cache (timestamp)`);

    db.exec(`
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author TEXT NOT NULL,
            content TEXT NOT NULL,
            test_session TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        ) STRICT
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_timestamp ON comments (timestamp)`);
}

// Not necessary with "PRAGMA auto_vacuum = INCREMENTAL" enabled
// function performIncrementalVacuum() {
//     try {
//         // reclaims unused space and keeps the database file size optimized 
//         db.pragma('incremental_vacuum');
//     } catch (error) {
//         console.error('Error during incremental vacuum:', error);
//     }
// }

function getCachedTest() {
    try {
        initDatabase();

        const cachedResult = db.prepare('SELECT * FROM test_results_cache ORDER BY timestamp DESC LIMIT 1').get();

        if (cachedResult && (Date.now() / 1000 - cachedResult.timestamp < maxCacheSeconds)) {
            return JSON.parse(cachedResult.result);
        }

        const testResult = runTest();

        // Delete all older records
        db.prepare('DELETE FROM test_results_cache').run();

        // Store the new result in the database
        db.prepare('INSERT INTO test_results_cache (result, timestamp) VALUES (?, ?)').run(JSON.stringify(testResult), Math.floor(Date.now() / 1000));

        return testResult;
    } catch (error) {
        throw error;
    }
}

function runTest() {
    const maxDuration = maxSecondsPerTest; // Maximum test duration in seconds
    const chunkSize = 100;
    const testSessionId = `test_${Date.now()}`;
    const currentTimestamp = Math.floor(Date.now() / 1000);

    // Prepare statements
    const insertStmt = db.prepare('INSERT INTO comments (author, content, test_session, timestamp) VALUES (?, ?, ?, ?)');
    const selectStmt = db.prepare('SELECT * FROM comments WHERE id = ?');
    const updateStmt = db.prepare('UPDATE comments SET content = ? WHERE id = ?');
    const deleteStmt = db.prepare('DELETE FROM comments WHERE id = ?');

    // Write test
    const writeStart = Date.now() / 1000;
    let writes = 0;
    const newRecords = [];
    while ((Date.now() / 1000) - writeStart < maxDuration) {
        db.transaction(() => {
            for (let j = 0; j < chunkSize; j++) {
                const author = Math.random().toString(36).substring(2, 2 + Math.floor(Math.random() * 16) + 5);
                const content = Math.random().toString(36).substring(2, 2 + Math.floor(Math.random() * 91) + 10);
                const result = insertStmt.run(author, content, testSessionId, currentTimestamp);
                newRecords.push(result.lastInsertRowid);
                writes++;
            }
        })();
    }
    const writeTime = (Date.now() / 1000) - writeStart;
    const writesPerSecond = Math.round(writes / writeTime);

    // Read test
    const readStart = Date.now() / 1000;
    let reads = 0;
    let readDuration = 0;
    while (readDuration < maxDuration) {
        const id = newRecords[Math.floor(Math.random() * newRecords.length)];
        selectStmt.get(id);
        reads++;
        readDuration = (Date.now() / 1000) - readStart;
    }
    const readsPerSecond = Math.round(reads / readDuration);

    // Update test
    const updateStart = Date.now() / 1000;
    let updates = 0;
    let updateDuration = 0;
    while (updateDuration < maxDuration) {
        const id = newRecords[Math.floor(Math.random() * newRecords.length)];
        const newContent = Math.random().toString(36).substring(2, 2 + Math.floor(Math.random() * 91) + 10);
        updateStmt.run(newContent, id);
        updates++;
        updateDuration = (Date.now() / 1000) - updateStart;
    }
    const updatesPerSecond = Math.round(updates / updateDuration);

    // Delete test
    const deleteStart = Date.now() / 1000;
    let deletes = 0;
    let deleteDuration = 0;
    while (deleteDuration < maxDuration && newRecords.length > 0) {
        const id = newRecords.pop();
        deleteStmt.run(id);
        deletes++;
        deleteDuration = (Date.now() / 1000) - deleteStart;
    }
    const deletesPerSecond = Math.round(deletes / deleteDuration);

    // Clean up remaining test data
    db.prepare('DELETE FROM comments WHERE test_session = ?').run(testSessionId);

    const dbSizeInMb = Math.round(fs.statSync(databaseFile).size / (1024 * 1024) * 100) / 100;

    const totalOperations = writes + reads + updates + deletes;
    const operationsPerSecond = Math.round(totalOperations / (maxDuration * 4)); // Multiply by 4 because there are 4 test phases

    return {
        dbSizeInMb,
        totalOperations,
        operationsPerSecond,
        writes,
        writesPerSecond,
        reads,
        readsPerSecond,
        updates,
        updatesPerSecond,
        deletes,
        deletesPerSecond,
        duration: Math.round((Date.now() / 1000 - writeStart) * 100) / 100,
    };
}

function getServerSpecs() {
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
