// server.js - Backend for E-commerce Comparison App
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const app = express();
const ZENROWS_PORT = process.env.ZENROWS_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Create directory for scraped data
const outputDir = path.join(__dirname, 'scraped_data');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Created directory: ${outputDir}`);
}

// Cache for search results to reduce API calls
const searchCache = new Map();
const CACHE_EXPIRATION = 30 * 60 * 1000; // 30 minutes

// Search API endpoint
app.get('/api/search', async (req, res) => {
    try {
        const searchTerm = req.query.term;
        
        if (!searchTerm || searchTerm.trim() === '') {
            return res.status(400).json({ error: 'Search term is required' });
        }
        
        // Check if valid results exist in cache
        const cacheKey = searchTerm.toLowerCase().trim();
        if (searchCache.has(cacheKey)) {
            const cachedData = searchCache.get(cacheKey);
            const cacheAge = Date.now() - cachedData.timestamp;
            
            // Return cached results if they're still fresh
            if (cacheAge < CACHE_EXPIRATION) {
                console.log(`Returning cached results for "${searchTerm}"`);
                return res.json(cachedData.results);
            }
        }
        
        // Check for API key
        const { ZENROWS_API_KEY } = process.env;
        if (!ZENROWS_API_KEY) {
            return res.status(500).json({ error: 'ZenRows API key is not configured' });
        }
        
        console.log(`Searching for "${searchTerm}" on Jumia and Konga`);
        
        // Define the URLs to scrape
        const urlsToScrape = [
            {
                url: `https://www.jumia.com.ng/catalog/?q=${encodeURIComponent(searchTerm)}`,
                site: 'jumia',
                outputFile: path.join(outputDir, `jumia_${searchTerm}_${Date.now()}.json`)
            },
            {
                url: `https://www.konga.com/search?search=${encodeURIComponent(searchTerm)}`,
                site: 'konga',
                outputFile: path.join(outputDir, `konga_${searchTerm}_${Date.now()}.json`)
            }
        ];
        
        // Start the scraping with worker threads
        const results = await runScrapers(urlsToScrape, searchTerm, ZENROWS_API_KEY);
        
        // Store in cache
        searchCache.set(cacheKey, {
            timestamp: Date.now(),
            results: results
        });
        
        // Return the results
        res.json(results);
        
    } catch (error) {
        console.error('Error handling search request:', error);
        res.status(500).json({ error: 'An error occurred during search' });
    }
});

// Function to run scrapers using worker threads
function runScrapers(urlsToScrape, searchTerm, apiKey) {
    return new Promise((resolve, reject) => {
        const results = [];
        let completedWorkers = 0;
        
        for (const urlData of urlsToScrape) {
            // Create worker for each URL
            const worker = new Worker(__filename, {
                workerData: {
                    apiKey: apiKey,
                    urlData: urlData,
                    searchTerm: searchTerm
                }
            });
            
            worker.on('message', (message) => {
                if (message.type === 'result') {
                    results.push(message.data);
                }
                console.log(message.log);
            });
            
            worker.on('error', (error) => {
                console.error(`Worker error for ${urlData.site}:`, error);
            });
            
            worker.on('exit', (code) => {
                completedWorkers++;
                
                if (completedWorkers === urlsToScrape.length) {
                    resolve(results);
                }
            });
        }
    });
}

// Worker thread code
if (!isMainThread) {
    const { apiKey, urlData, searchTerm } = workerData;
    
    // Function to scrape a URL
    async function scrapeUrl() {
        try {
            parentPort.postMessage({ type: 'log', log: `Worker started for ${urlData.site}` });
            
            const response = await axios({
                url: 'https://api.zenrows.com/v1/',
                method: 'GET',
                params: {
                    'url': urlData.url,
                    'apikey': apiKey,
                    'wait': '5000',
                    'response_type': 'markdown'
                }
            });
            
            if (response.status === 200) {
                parentPort.postMessage({ type: 'log', log: `Successfully scraped ${urlData.site}` });
                
                const result = {
                    source: urlData.site,
                    searchTerm: searchTerm,
                    timestamp: new Date().toISOString(),
                    data: response.data
                };
                
                // Save to individual file
                fs.writeFileSync(urlData.outputFile, JSON.stringify(result, null, 2));
                parentPort.postMessage({ 
                    type: 'log', 
                    log: `Data for ${urlData.site} saved to ${urlData.outputFile}` 
                });
                
                // Send result back to main thread
                parentPort.postMessage({ type: 'result', data: result });
                
                return true;
            } else {
                parentPort.postMessage({ 
                    type: 'log', 
                    log: `Error: Received status code ${response.status} for ${urlData.site}` 
                });
                
                const errorResult = {
                    source: urlData.site,
                    searchTerm: searchTerm,
                    timestamp: new Date().toISOString(),
                    error: `Status code: ${response.status}`
                };
                
                parentPort.postMessage({ type: 'result', data: errorResult });
                
                return false;
            }
        } catch (error) {
            parentPort.postMessage({ 
                type: 'log', 
                log: `Error scraping ${urlData.site}: ${error.message}` 
            });
            
            // Send error result
            const errorResult = {
                source: urlData.site,
                searchTerm: searchTerm,
                timestamp: new Date().toISOString(),
                error: {
                    message: error.message,
                    code: error.code
                }
            };
            
            parentPort.postMessage({ type: 'result', data: errorResult });
            
            return false;
        }
    }
    
    // Execute scraping in the worker
    scrapeUrl()
        .then(() => {
            parentPort.postMessage({ type: 'log', log: `Worker for ${urlData.site} completed` });
        })
        .catch(error => {
            parentPort.postMessage({ 
                type: 'log', 
                log: `Worker for ${urlData.site} failed: ${error.message}` 
            });
        });
}

// Start server only in main thread
if (isMainThread) {
    app.listen(ZENROWS_PORT, () => {
        console.log(`E-commerce comparison server running on ZENROWS_PORT ${ZENROWS_PORT}`);
        console.log(`Access the API at http://localhost:${ZENROWS_PORT}/api/search?term=smartphone`);
    });
}