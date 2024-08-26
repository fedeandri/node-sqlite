import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCachedTest, getServerSpecs } from './database.js';

// Create equivalents for __dirname and __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3005;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/runTest', async (req, res) => {
    try {
        const result = await getCachedTest();
        res.json(result);
    } catch (error) {
        // console.error('Error in /api/runTest:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

app.get('/api/getSpecs', async (req, res) => {
    try {
        const specs = await getServerSpecs();
        res.json(specs);
    } catch (error) {
        // console.error('Error in /api/getSpecs:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
